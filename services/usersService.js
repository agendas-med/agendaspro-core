const functions = require("../utils/functions");
const bcrypt = require('bcrypt');
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const jwt = require('jsonwebtoken');
const { getJwtSecret, ACCESS_TOKEN_TTL } = require("../config/jwt");
const { sha256, randomToken } = require("../utils/crypto");
const { TERMS_VERSION } = require("../config/legal");

const AUTH_FAILED = "Falha na autenticação";
const SESSION_INVALID = "Sessão inválida ou expirada. Faça login novamente.";
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 30;
// Renovação de um access token ainda válido (contrato legado do /check_jwt) é limitada a
// 7 dias desde o login; depois disso só com refresh token.
const SLIDING_LIMIT_SEC = 7 * 24 * 60 * 60;
const RESET_TOKEN_MINUTES = 15;

function signAccessToken(user, origIat) {
    return jwt.sign(
        { id: user.id, email: user.email, name: user.name, orig_iat: origIat || Math.floor(Date.now() / 1000) },
        getJwtSecret(),
        { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256' }
    );
}

function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (c) => "\\" + c);
}

async function insertRefreshToken(user_id, family_id, query) {
    const token = randomToken(32);
    const run = query || ((sql, params) => functions.executeSql(sql, params));
    const result = await run(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES (?, ?, ?, NOW() + INTERVAL ? DAY)`,
        [user_id, family_id || randomToken(16), sha256(token), REFRESH_TTL_DAYS]
    );
    return { token, id: result.insertId };
}

// Sessão emitida antes da última troca de senha não vale mais.
async function assertSessionNotStale(user_id, origIat) {
    const rows = await functions.executeSql(`SELECT id, email, name, UNIX_TIMESTAMP(password_changed_at) AS changed FROM users WHERE id = ?`, [user_id]);
    if (!rows.length) throw SESSION_INVALID;
    if (rows[0].changed && origIat && Number(origIat) < Number(rows[0].changed)) throw SESSION_INVALID;
    return rows[0];
}

let usersService = {
    // Grava também a prova de aceite: instante, versão vigente dos Termos e IP de origem.
    register: async function (name, email, password, ip = null) {
        const hash = await bcrypt.hash(password, 10);
        try {
            const results = await functions.executeSql(`INSERT INTO users (name, email, password, terms_accepted_at, terms_version, terms_accept_ip) VALUES (?, ?, ?, NOW(), ?, ?)`, [name, email, hash, TERMS_VERSION, ip]);
            return { id: results.insertId, email: email };
        } catch (error) {
            if (error && error.code === 'ER_DUP_ENTRY') throw "Este email já está cadastrado.";
            throw error;
        }
    },
    // Retorna { jwtToken, id, refreshToken }. jwtToken/id mantêm o contrato antigo.
    login: async function (email, password) {
        const results = await functions.executeSql(`SELECT id, email, name, password FROM users WHERE email = ?`, [email]);
        if (results.length < 1 || !results[0].password) throw AUTH_FAILED;
        const valid = await bcrypt.compare(password, results[0].password).catch(() => false);
        if (!valid) throw AUTH_FAILED;
        const refresh = await insertRefreshToken(results[0].id);
        return { jwtToken: signAccessToken(results[0]), id: results[0].id, refreshToken: refresh.token };
    },
    googleLogin: async function (user_id) {
        const results = await functions.executeSql(`SELECT id, email, name FROM users WHERE id = ?`, [user_id]);
        if (!results.length) throw AUTH_FAILED;
        const refresh = await insertRefreshToken(user_id);
        return { token: signAccessToken(results[0]), refreshToken: refresh.token };
    },
    // Rotação: o refresh token apresentado é revogado e substituído. Reuso de um token já
    // revogado indica vazamento: toda a família (sessão) é revogada.
    refresh: async function (refreshToken) {
        if (typeof refreshToken !== 'string' || refreshToken.length < 20) throw SESSION_INVALID;
        const outcome = await functions.executeTransaction(async (query) => {
            const rows = await query(
                `SELECT id, user_id, family_id, revoked_at, expires_at < NOW() AS expired FROM refresh_tokens WHERE token_hash = ? FOR UPDATE`,
                [sha256(refreshToken)]
            );
            if (!rows.length) return { error: SESSION_INVALID };
            const current = rows[0];
            if (current.revoked_at) {
                await query(`UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE family_id = ?`, [current.family_id]);
                return { error: SESSION_INVALID, reuse: true };
            }
            if (current.expired) return { error: SESSION_INVALID };
            const users = await query(`SELECT id, email, name FROM users WHERE id = ?`, [current.user_id]);
            if (!users.length) return { error: SESSION_INVALID };
            const next = await insertRefreshToken(current.user_id, current.family_id, query);
            await query(`UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = ? WHERE id = ?`, [next.id, current.id]);
            return { user: users[0], refreshToken: next.token };
        });
        if (outcome.reuse) console.warn("[auth] Reuso de refresh token detectado; sessão revogada.");
        if (outcome.error) throw outcome.error;
        return { jwtToken: signAccessToken(outcome.user), refreshToken: outcome.refreshToken };
    },
    // Logout: revoga a sessão do refresh token informado (se for do usuário) ou todas.
    logout: async function (user_id, refreshToken) {
        if (typeof refreshToken === 'string' && refreshToken) {
            await functions.executeSql(
                `UPDATE refresh_tokens r JOIN (SELECT family_id FROM refresh_tokens WHERE token_hash = ? AND user_id = ?) f ON f.family_id = r.family_id SET r.revoked_at = COALESCE(r.revoked_at, NOW())`,
                [sha256(refreshToken), user_id]
            );
            return;
        }
        await this.revokeAllSessions(user_id);
    },
    revokeAllSessions: function (user_id, query) {
        const run = query || ((sql, params) => functions.executeSql(sql, params));
        return run(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL`, [user_id]);
    },
    // Contrato legado: { token: "Bearer <jwt>" } -> novo access token, apenas se o atual
    // ainda for válido (não renova mais tokens expirados). Com refresh_token, rotaciona.
    checkJwt: async function (tokenParam, refreshToken) {
        if (refreshToken) return this.refresh(refreshToken);
        if (typeof tokenParam !== 'string' || !tokenParam.startsWith("Bearer ")) throw "Token mal formatado";
        let decoded;
        try {
            decoded = jwt.verify(tokenParam.slice(7), getJwtSecret(), { algorithms: ['HS256'] });
        } catch (err) {
            throw SESSION_INVALID;
        }
        if (!Number.isInteger(decoded.id)) throw SESSION_INVALID;
        const origIat = decoded.orig_iat || decoded.iat;
        if (Math.floor(Date.now() / 1000) - origIat > SLIDING_LIMIT_SEC) throw SESSION_INVALID;
        const user = await assertSessionNotStale(decoded.id, origIat);
        return { jwtToken: signAccessToken(user, origIat) };
    },
    returnUser: function (user_id, company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(`SELECT company_id FROM company_members WHERE user_id = ?`, [user_id]).then((companies) => {
                const memberOf = companies.map((c) => Number(c.company_id));
                company_id = Number(company_id);
                // Só considera a empresa do header se o usuário for membro dela.
                if (!memberOf.includes(company_id)) company_id = memberOf.length ? memberOf[0] : null;

                functions.executeSql(
                    `
                        SELECT
                            u.id, u.name, u.email, u.url_photo, u.tel, u.zip_code, u.address, u.city, u.state,
                            (SELECT MAX(ccr.permission) FROM config_company_roles ccr INNER JOIN config_users_roles cur ON cur.role_id = ccr.id WHERE ccr.company_id = ? AND cur.user_id = ?) AS permission
                        FROM
                            users u
                        WHERE
                            u.id = ?
                    `, [company_id, user_id, user_id], !clearCache, 60
                ).then((results) => {
                    if (!results.length) return reject("Usuário não encontrado");
                    this.returnUserCompanies(user_id).then((results2) => {
                        resolve({
                            id: results[0].id,
                            name: results[0].name,
                            email: results[0].email,
                            url_photo: results[0].url_photo,
                            tel: results[0].tel,
                            zip_code: results[0].zip_code,
                            address: results[0].address,
                            city: results[0].city,
                            state: results[0].state,
                            country: results[0].country,
                            companies: results2,
                            permission: results[0].permission
                        });
                    }).catch(reject);
                }).catch(reject);
            }).catch(reject);
        })
    },
    returnUserCompanies: function (user_id, clearCache = false) {
        return functions.executeSql(`SELECT company_id FROM company_members WHERE user_id = ?`, [user_id], !clearCache, 60)
            .then((results) => results.map((r) => r.company_id));
    },
    enterCompany: function (user_id, company_id) {
        return functions.executeSql(`INSERT INTO company_members (user_id, company_id) VALUES (?, ?)`, [user_id, company_id]).then(() => {
            this.returnUser(user_id, company_id, true).catch(() => {});
        });
    },
    insertRole: function (user_id, role_id) {
        return functions.executeSql(`INSERT INTO config_users_roles (user_id, role_id) VALUES (?, ?)`, [user_id, role_id]).then(() => undefined);
    },
    // Busca apenas entre membros da mesma empresa, com campos mínimos. Curingas do LIKE
    // digitados pelo usuário são tratados como texto ("***" não lista mais todo mundo).
    findUser: function (searchString, company_id) {
        const term = `%${escapeLike(String(searchString || "").trim())}%`;
        return functions.executeSql(
            `
                SELECT u.id, u.name, u.email, u.url_photo
                FROM users u
                INNER JOIN company_members cm ON cm.user_id = u.id AND cm.company_id = ?
                WHERE u.name LIKE ? OR u.email LIKE ?
                ORDER BY u.name
                LIMIT 20
            `, [company_id, term, term]
        );
    },
    checkIfUserExists: function (email) {
        return functions.executeSql(`SELECT id, name, email FROM users WHERE email = ?`, [email])
            .then((results) => ({ exist: results.length > 0, user: results[0] }));
    },
    // Colunas explícitas: nunca devolver asaas_api_key ao cliente.
    returnCompanies: function (user_id) {
        return functions.executeSql(
            `
                SELECT
                    c.id, c.name, c.address, c.city, c.state, c.business_type, c.zip_code, c.document,
                    c.email, c.phone, c.address_number, c.complement, c.asaas_wallet_id, c.asaas_status
                FROM
                    companies c
                INNER JOIN
                    company_members cm ON cm.company_id = c.id
                WHERE
                    cm.user_id = ?
            `, [user_id]
        );
    },
    changeProfile: function (user_id, company_id, address, city, state, tel, zip_code) {
        return functions.executeSql(
            `UPDATE users SET address = ?, city = ?, state = ?, tel = ?, zip_code = ? WHERE id = ?`,
            [address, city, state, tel, zip_code, user_id]
        ).then((results) => {
            this.returnUser(user_id, company_id, true).catch(() => {});
            return { affectedRows: results.affectedRows };
        });
    },
    // Resposta idêntica exista ou não o email (sem enumeração de contas). Só o hash do token persiste.
    requestResetPassword: async function (email) {
        const users = await functions.executeSql(`SELECT id, name FROM users WHERE email = ?`, [email]);
        if (!users.length) return;
        const token = randomToken(32);
        await functions.executeSql(`UPDATE password_requests SET confirm_date = NOW() WHERE user_id = ? AND confirm_date IS NULL`, [users[0].id]);
        await functions.executeSql(`INSERT INTO password_requests (user_id, token_hash) VALUES (?, ?)`, [users[0].id, sha256(token)]);

        const link = process.env.URL_SITE + "/redefinir-senha?token=" + token;
        const now = new Date();
        const pad = (n) => (n < 10 ? "0" + n : String(n));
        const requestDate = `${now.getDate()}/${now.getMonth() + 1}/${now.getFullYear()} às ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const emailHtml = emailTemplates.resetPassword(users[0].name, email, requestDate, link);
        await sendEmails.sendEmail(emailHtml, "Redefinição de senha solicitada", process.env.USER_EMAIL, email);
    },
    checkTokenValidity: async function (token, query, forUpdate = false) {
        if (typeof token !== 'string' || !token) throw "Token inválido";
        const run = query || ((sql, params) => functions.executeSql(sql, params));
        const results = await run(
            `SELECT id, user_id FROM password_requests WHERE token_hash = ? AND request_date > NOW() - INTERVAL ? MINUTE AND confirm_date IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
            [sha256(token), RESET_TOKEN_MINUTES]
        );
        if (!results.length) throw "Token inválido";
        return results[0];
    },
    // Troca de senha: uso único do token, marca password_changed_at e revoga todas as sessões.
    resetPassword: async function (token, password) {
        const hash = await bcrypt.hash(password, 10);
        await functions.executeTransaction(async (query) => {
            const request = await this.checkTokenValidity(token, query, true);
            await query(`UPDATE users SET password = ?, password_changed_at = NOW() WHERE id = ?`, [hash, request.user_id]);
            await query(`UPDATE password_requests SET confirm_date = NOW() WHERE id = ?`, [request.id]);
            await this.revokeAllSessions(request.user_id, query);
        });
    }
}

module.exports = usersService;
