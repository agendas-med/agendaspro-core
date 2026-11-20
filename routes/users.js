const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _usersService = require("../services/usersService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");
const rateLimit = require("../middleware/rateLimit");
const { sendError } = require("../middleware/errorHandler");
const axios = require("axios");
const { TERMS_VERSION } = require("../config/legal");

const schemas = validate.schemas.users;
// Erros de negócio (strings) seguem em texto puro, como antes; internos viram 500 genérico.
const fail = (req, res, status = 500) => (error) => sendError(req, res, error, status, { text: typeof error === 'string' });
const ok = (res, message, data, method) => res.status(200).send(functions.createResponse(message, data ?? null, method, 200));
const byEmail = (prefix) => (req) => `${prefix}:${String(req.body?.email || '').toLowerCase().slice(0, 255)}`;

router.post("/register", rateLimit({ key: 'register', windowSec: 3600, max: 10 }), validate.validateRequest(schemas.register), (req, res) => {
    _usersService.register(req.body.name, req.body.email, req.body.password, req.ip)
        .then((results) => ok(res, "Usuário criado com sucesso", results, "POST"))
        .catch(fail(req, res, 409));
});

// returnObj: { jwtToken, id, refreshToken } (refreshToken é novo e opcional para o front).
router.post("/login", rateLimit({ key: byEmail('login'), windowSec: 900, max: 10 }), validate.validateRequest(schemas.login), (req, res) => {
    _usersService.login(req.body.email, req.body.password)
        .then((results) => ok(res, "Usuario autenticado com sucesso", results, "POST"))
        .catch(fail(req, res, 401));
});

router.post("/google-login", rateLimit({ key: 'google-login', windowSec: 900, max: 20 }), validate.validateRequest(schemas.googleLogin), async (req, res) => {
    try {
        const { data } = await axios.post("https://oauth2.googleapis.com/token", null, {
            params: {
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                // Fluxo de código por popup (GIS/vue3-google-login) exige o valor fixo "postmessage".
                redirect_uri: process.env.GOOGLE_LOGIN_REDIRECT_URI || "postmessage",
                grant_type: "authorization_code",
                code: req.body.token
            },
            timeout: 10000
        });

        const { data: userInfo } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${data.access_token}` },
            timeout: 10000
        });

        const results = await functions.executeSql(`SELECT id FROM users WHERE code = ?`, [userInfo.id]);
        let userId = results[0]?.id;

        if (!userId) {
            try {
                // Login com Google não tem checkbox: o aceite é o texto da tela. Gravado só na criação da conta.
                const insertedUser = await functions.executeSql(
                    `INSERT INTO users (code, name, email, url_photo, terms_accepted_at, terms_version, terms_accept_ip) VALUES (?, ?, ?, ?, NOW(), ?, ?)`,
                    [userInfo.id, userInfo.given_name || userInfo.name || "Usuário", userInfo.email, userInfo.picture, TERMS_VERSION, req.ip]
                );
                userId = insertedUser.insertId;
            } catch (error) {
                if (error.code == "ER_DUP_ENTRY") return res.status(409).send("Email do google inválido");
                throw error;
            }
        }

        const session = await _usersService.googleLogin(userId);
        return ok(res, "Usuário autenticado com sucesso", { user: userId, token: session.token, refreshToken: session.refreshToken }, "POST");
    } catch (error) {
        if (error?.response?.status === 400 || error?.response?.status === 401) return res.status(401).send("Falha na autenticação com o Google");
        return sendError(req, res, error);
    }
});

router.get("/", login, (req, res) => {
    _usersService.returnUser(req.usuario.id, req.headers['selected-company'])
        .then((results) => ok(res, "Retorno do usuário", results, "GET"))
        .catch(fail(req, res));
});

router.get("/return_companies", login, (req, res) => {
    _usersService.returnCompanies(req.usuario.id)
        .then((results) => ok(res, "Retorno das empresas do usuário", results, "GET"))
        .catch(fail(req, res));
});

// Legado: { token: "Bearer <jwt>" } renova só um access token ainda válido.
// Novo: { refresh_token } rotaciona a sessão e devolve { newToken, refreshToken }.
router.post("/check_jwt", rateLimit({ key: 'check-jwt', windowSec: 900, max: 120 }), validate.validateRequest(schemas.checkJwt), (req, res) => {
    _usersService.checkJwt(req.body.token, req.body.refresh_token)
        .then((results) => ok(res, "Token válido e foi renovado", { newToken: results.jwtToken, ...(results.refreshToken ? { refreshToken: results.refreshToken } : {}) }, "POST"))
        .catch(fail(req, res, 401));
});

router.post("/refresh", rateLimit({ key: 'refresh', windowSec: 900, max: 120 }), validate.validateRequest(schemas.refresh), (req, res) => {
    _usersService.refresh(req.body.refresh_token)
        .then((results) => ok(res, "Sessão renovada", results, "POST"))
        .catch(fail(req, res, 401));
});

// Sem refresh_token no corpo, encerra todas as sessões do usuário.
router.post("/logout", login, validate.validateRequest(schemas.logout), (req, res) => {
    _usersService.logout(req.usuario.id, req.body.refresh_token)
        .then(() => ok(res, "Sessão encerrada", null, "POST"))
        .catch(fail(req, res));
});

router.post("/find", login, validate.validateCompanyAccess, validate.validateRequest(schemas.find), (req, res) => {
    _usersService.findUser(req.body.search_string, req.companyId)
        .then((results) => ok(res, "Usuário encontrado", results, "POST"))
        .catch(fail(req, res));
});

router.post("/change-profile", login, validate.validateRequest(schemas.change_profile), (req, res) => {
    _usersService.changeProfile(req.usuario.id, req.headers['selected-company'], req.body.address, req.body.city, req.body.state, req.body.tel, req.body.zip_code)
        .then((results) => ok(res, "Perfil atualizado com sucesso", results, "POST"))
        .catch(fail(req, res));
});

// Resposta igual exista ou não a conta.
router.post("/request-reset-password", rateLimit({ key: byEmail('reset'), windowSec: 900, max: 5 }), validate.validateRequest(schemas.requestResetPassword), (req, res) => {
    _usersService.requestResetPassword(req.body.email)
        .then(() => ok(res, "Email para redefinição de senha enviado", null, "GET"))
        .catch(fail(req, res));
});

router.post("/check-token-validity", rateLimit({ key: 'reset-token', windowSec: 900, max: 30 }), validate.validateRequest(schemas.checkResetToken), (req, res) => {
    _usersService.checkTokenValidity(req.body.token)
        .then(() => ok(res, "Token válido", null, "POST"))
        .catch(fail(req, res, 401));
});

router.post("/reset-password", rateLimit({ key: 'reset-token', windowSec: 900, max: 30 }), validate.validateRequest(schemas.resetPassword), (req, res) => {
    _usersService.resetPassword(req.body.token, req.body.password)
        .then(() => ok(res, "Senha alterada com sucesso", null, "POST"))
        .catch(fail(req, res, 400));
});

module.exports = router;
