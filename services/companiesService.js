const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const _usersService = require("./usersService");
const _asaasService = require("./asaasService");
const { encrypt, decrypt, sha256, randomToken } = require("../utils/crypto");
const { decryptKey } = require("./asaasKeys");
const { HttpError } = require("../middleware/errorHandler");

const MEASUREMENT_UNITS = {
  1: "unidade",
  2: "pessoa",
  3: "peca",
  4: "hora",
  5: "sessao",
  6: "m2",
  7: "km",
};

let companiesService = {
  returnCompany: function (company_id, user_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        c.id,
                        c.name,
                        c.address,
                        c.zip_code,
                        business_type,
                        city,
                        state,
                        c.asaas_status
                    FROM
                        companies c
                    INNER JOIN
                        company_members cm ON cm.company_id = c.id
                    WHERE
                        c.id = ? AND cm.user_id = ?                         
                `,
          [company_id, user_id],
          !clearCache,
          60,
        )
        .then((results) => {
          this.returnCompanyConfigurations(company_id, clearCache).then(
            (results2) => {
              this.returnCompanyRoles(company_id, clearCache).then(
                (results3) => {
                  this.returnCompanyServices(company_id, clearCache).then(
                    (results4) => {
                      this.returnCompanyProducts(company_id, clearCache).then(
                        (results5) => {
                          let company = {
                            id: results[0]?.id || null,
                            name: results[0]?.name || "",
                            address: results[0]?.address || "",
                            zip_code: results[0]?.zip_code || "",
                            business_type: results[0]?.business_type || "",
                            city: results[0]?.city || "",
                            state: results[0]?.state || "",
                            asaas_status: results[0]?.asaas_status || 'UNCONFIGURED',
                            configurations: results2,
                            roles: results3,
                            services: results4,
                            products: results5,
                          };

                          if (company.id != null) {
                            resolve(company);
                          } else {
                            reject("Empresa não encontrada");
                          }
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnBusinessTypes: function () {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        *
                    FROM
                        business_types                       
                `,
          [],
          true,
          120,
        )
        .then((results) => {
          resolve(results);
        });
    });
  },
  createRole: function (company_id, name, permission, default_role = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    INSERT INTO
                        config_company_roles
                        (company_id, name, permission, default_role)   
                    VALUES
                        (?, ?, ?, ?)                 
                `,
          [company_id, name, permission, default_role ? 1 : 0],
        )
        .then((results) => {
          if (results.affectedRows == 0) {
            reject("Ocorreu um erro ao criar o cargo");
          }

          this.returnCompanyRoles(company_id, true);
          resolve(results.insertId);
        });
    });
  },
  excludeRole: async function (company_id, role_id) {
    // O cargo precisa ser desta empresa antes de qualquer consulta/remoção.
    await this.assertRoleInCompany(role_id, company_id);
    const assigned = await functions.executeSql(`SELECT 1 FROM config_users_roles WHERE role_id = ? LIMIT 1`, [role_id]);
    if (assigned.length > 0) throw "Você não pode excluir um cargo que ja está atribuído a alguém";
    const results = await functions.executeSql(
      `DELETE FROM config_company_roles WHERE id = ? AND company_id = ? AND default_role = 0`,
      [role_id, company_id],
    );
    if (results.affectedRows == 0) throw "Você não pode excluir o cargo padrão da empresa";
    this.returnCompanyRoles(company_id, true).catch(() => {});
  },
  editRole: function (company_id, role_id, name, permission) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    UPDATE 
                        config_company_roles
                    SET
                        name = ?, permission = ?
                    WHERE
                        id = ? AND company_id = ?
                `,
          [name, permission, role_id, company_id],
        )
        .then((results) => {
          if (results.affectedRows == 0) {
            reject("Ocorreu um erro ao editar o cargo");
          }

          this.returnCompanyRoles(company_id, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnCompanyRoles: function (company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        *
                    FROM
                        config_company_roles
                    WHERE
                        company_id = ?
                `,
          [company_id],
          !clearCache,
          60,
        )
        .then((results) => {
          resolve(results);
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  createCompany: async function (user_id, data) {
    const cleanDocument = String(data.document || "").replace(/\D/g, "");
    let apiKey = null, walletId = null, asaasStatus = 'UNCONFIGURED';
    try {
      const walletInfo = await functions.executeSql(
        `SELECT asaas_api_key, asaas_wallet_id, asaas_status, owner_user_id FROM asaas_wallets WHERE document = ?`,
        [cleanDocument],
      );

      if (walletInfo.length > 0 || process.env.ASAAS_API_KEY) {
        // Uma subconta Asaas (carteira + apiKey) nunca é compartilhada entre empresas ativas,
        // e só o usuário que a criou pode reaproveitá-la.
        const linked = await functions.executeSql(`SELECT id FROM companies WHERE document = ? LIMIT 1`, [cleanDocument]);
        if (linked.length > 0) {
          throw new HttpError(409, "Este CPF/CNPJ já está vinculado a outra empresa ativa. Use outro documento ou fale com o suporte.");
        }
      }

      if (walletInfo.length > 0) {
        if (Number(walletInfo[0].owner_user_id) !== Number(user_id)) {
          throw new HttpError(409, "Este CPF/CNPJ já possui uma conta de recebimentos vinculada a outro usuário. Fale com o suporte.");
        }
        apiKey = decrypt(walletInfo[0].asaas_api_key);
        walletId = walletInfo[0].asaas_wallet_id;
        asaasStatus = walletInfo[0].asaas_status || "PENDING";
      } else if (process.env.ASAAS_API_KEY) {
        const asaasAccount = await _asaasService.createSubaccount({
          name: data.name,
          email: data.email,
          cnpj_cpf: data.document,
          phone: data.phone,
          cep: data.zip_code,
          address_number: data.address_number,
          complement: data.complement,
          birthDate: data.birthDate,
          companyType: data.companyType,
          incomeValue: data.incomeValue,
        });

        apiKey = asaasAccount.apiKey;
        walletId = asaasAccount.walletId;
        asaasStatus = "PENDING";

        await functions.executeSql(
          `INSERT INTO asaas_wallets (document, asaas_api_key, asaas_wallet_id, asaas_status, owner_user_id) VALUES (?, ?, ?, ?, ?)`,
          [cleanDocument, encrypt(apiKey), walletId, asaasStatus, user_id],
        );
        await _asaasService.createWebhook(apiKey).catch(() => console.warn("[Asaas] Falha ao registrar webhook na subconta"));
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Mensagem de negócio do Asaas (sanitizada) ou genérica; nunca o objeto do Axios.
      const description = error?.response?.data?.errors?.[0]?.description;
      console.error("[Asaas] Falha ao criar subconta:", error?.response?.status || error?.code || "erro");
      throw new HttpError(400, typeof description === "string" ? description.slice(0, 300) : "Falha ao processar a conta de recebimentos.");
    }

    const results = await functions.executeSql(
      `
                        INSERT INTO
                            companies
                            (name, address, zip_code, city, state, business_type, document, phone, email, address_number, complement, asaas_wallet_id, asaas_api_key, asaas_status)
                        VALUES
                            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `,
      [
        data.name,
        data.address,
        data.zip_code,
        data.city,
        data.state,
        data.business_type,
        cleanDocument,
        data.phone,
        data.email,
        data.address_number,
        data.complement,
        walletId,
        apiKey ? encrypt(apiKey) : null,
        asaasStatus,
      ],
    );

    await Promise.all([
      _usersService.enterCompany(user_id, results.insertId),
      this.createRole(results.insertId, "Gerente", 1, true).then((roleId) => _usersService.insertRole(user_id, roleId)),
      this.insertCompanyDefaultPreferences(results.insertId),
    ]);
    // F3: endereço da página pública (página nasce desabilitada; a empresa publica quando quiser).
    await this.assignSlug(results.insertId, data.name).catch(() => console.error('[companies] slug não atribuído'));
    _usersService.returnUserCompanies(user_id, true).catch(() => {});
    return results.insertId;
  },
  assignSlug: async function (companyId, name) {
    const { slugify, withSuffix } = require("../utils/slug");
    const base = slugify(name);
    for (const candidate of [base, withSuffix(base), withSuffix(base), withSuffix(base)]) {
      try {
        const result = await functions.executeSql("UPDATE companies SET slug = ? WHERE id = ? AND slug IS NULL", [candidate, companyId]);
        return result.affectedRows ? candidate : null;
      } catch (error) {
        if (error?.code !== "ER_DUP_ENTRY") throw error;
      }
    }
    return null;
  },
  insertCompanyDefaultPreferences: function (company_id) {
    return Promise.all([
      ['notificate_scheduling', 1], ['notificate_in_app_payment', 1],
      ['notificate_scheduling_cancelation', 1], ['accept_custom_location', 0],
      ['require_payment_on_booking', 0], ['auto_finish_appointments', 0],
    ].map(([code, active]) => functions.insertCompanyPreference(company_id, code, active)));
  },
  returnCompanyConfigurations: function (company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        p.id,
                        p.code,
                        p.name,
                        ccp.active
                    FROM
                        preferences p
                    LEFT JOIN
                        config_companies_preferences ccp ON ccp.preference_id = p.id
                    WHERE
                        ccp.company_id = ?
                `,
          [company_id],
          !clearCache,
          60,
        )
        .then((results) => {
          let preferences = results.map((preference) => {
            return {
              id: preference.id,
              code: preference.code,
              name: preference.name,
              active: preference.active == 1 ? true : false,
            };
          });

          functions
            .executeSql(
              `
                        SELECT
                            *
                        FROM
                            config_companies_schedule
                        WHERE
                            company_id = ?
                        ORDER BY day
                    `,
              [company_id],
              !clearCache,
              60,
            )
            .then((results2) => {
              let schedule = [];

              for (let i = 1; i <= 7; i++) {
                //For para os dias da semana
                let scheduleDay = results2.filter((item) => {
                  return item.day == i;
                });

                schedule.push({
                  day: i,
                  hours: scheduleDay.map((item) => {
                    return {
                      initial_date: item.initial_date,
                      final_date: item.final_date,
                    };
                  }),
                });
              }

              let configurations = {
                notifications: preferences,
                opening_hours: schedule,
              };

              resolve(configurations);
            });
        });
    });
  },
  editCompanyConfigurations: async function (company_id, configurations) {
    // Horários já validados por Joi (HH:mm); ainda assim tudo vai por placeholder.
    const rows = [];
    for (const currentDay of configurations?.opening_hours || []) {
      for (const currentHour of currentDay.hours || []) {
        rows.push([company_id, currentDay.day, currentHour.initial_date, currentHour.final_date]);
      }
    }
    await functions.executeTransaction(async (query) => {
      await query(`DELETE FROM config_companies_schedule WHERE company_id = ?`, [company_id]);
      if (rows.length > 0) {
        await query(`INSERT INTO config_companies_schedule (company_id, day, initial_date, final_date) VALUES ?`, [rows]);
      }
    });
    this.returnCompanyConfigurations(company_id, true).catch(() => {});
  },
  // Admin = membro da empresa com cargo (desta empresa) de permission = 1.
  checkCompanyPermission: async function (user_id, company_id) {
    const userId = Number(user_id);
    const companyId = Number(company_id);
    if (!Number.isSafeInteger(userId) || !/^\d{1,10}$/.test(String(company_id ?? "").trim()) || companyId <= 0) {
      throw "Você não tem permissão de administrador";
    }
    const results = await functions.executeSql(
      `SELECT 1 FROM company_members cm
         INNER JOIN config_users_roles cur ON cur.user_id = cm.user_id
         INNER JOIN config_company_roles ccr ON ccr.id = cur.role_id AND ccr.company_id = cm.company_id
        WHERE cm.user_id = ? AND cm.company_id = ? AND ccr.permission = 1
        LIMIT 1`,
      [userId, companyId],
      true,
      60,
    );
    if (results.length == 0) throw "Você não tem permissão de administrador";
  },
  editCompany: function (
    user_id,
    company_id,
    name,
    address,
    city,
    state,
    business_type,
    zip_code,
    configurations,
  ) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    UPDATE 
                        companies
                    SET 
                        name = ?, address = ?, city = ?, state = ?, business_type = ?, zip_code = ?
                    WHERE
                        id = ?
                `,
          [name, address, city, state, business_type, zip_code, company_id],
        )
        .then((results) => {
          if (results.affectedRows === 0) {
            return reject(
              "Ocorreu um erro ao alterar as informações da empresa",
            );
          }

          this.editCompanyConfigurations(company_id, configurations)
            .then(() => {
              this.returnCompany(company_id, user_id, true).catch(() => {});

              if (
                typeof _usersService !== "undefined" &&
                _usersService.returnUserCompanies
              ) {
                _usersService
                  .returnUserCompanies(user_id, true)
                  .catch(() => {});
              }

              resolve();
            })
            .catch((error) => {
              reject(error);
            });
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  checkCompaniesFromUser: function (user_id, company_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        *
                    FROM
                        company_members
                    WHERE
                        user_id = ? AND company_id = ?
                `,
          [user_id, company_id],
        )
        .then((results) => {
          resolve(results);
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  // Garante que o cargo pertence à empresa (impede atribuir cargo de outro tenant).
  assertRoleInCompany: async function (role_id, company_id, query = functions.executeSql) {
    const rows = await query(
      `SELECT id, permission FROM config_company_roles WHERE id = ? AND company_id = ?`,
      [role_id, company_id],
    );
    if (!rows.length) throw "Cargo inválido para esta empresa";
    return rows[0];
  },
  inviteUser: async function (
    company_id,
    requested_user_name,
    requested_user_id,
    requested_user_email,
    request_user,
    role_id,
  ) {
    const email = String(requested_user_email || "").trim().toLowerCase();
    await this.assertRoleInCompany(role_id, company_id);

    const member = await functions.executeSql(
      `SELECT 1 FROM company_members cm INNER JOIN users u ON u.id = cm.user_id
        WHERE cm.company_id = ? AND (u.email = ? OR u.id = ?)`,
      [company_id, email, Number(requested_user_id) || 0],
    );
    if (member.length > 0) throw "Este usuário já faz parte desta empresa";

    const existing = await this.checkIfExistInvite(company_id, email);
    if (existing.length > 0) throw "Este usuário já foi convidado para esta empresa";

    // Convites vencidos e não usados deixam de bloquear um novo convite.
    await functions.executeSql(
      `UPDATE company_invitations SET status = 'declined'
        WHERE company_id = ? AND invited_user = ? AND status = 'pending'`,
      [company_id, email],
    );

    // Token de 32 bytes; só o hash é persistido. Expira em 7 dias e é de uso único.
    const token = randomToken(32);
    await functions.executeSql(
      `INSERT INTO company_invitations (invited_user, company_id, invited_by, token, token_hash, expires_at, role_id)
       VALUES (?, ?, ?, NULL, ?, NOW() + INTERVAL 7 DAY, ?)`,
      [email, company_id, request_user, sha256(token), role_id],
    );

    const company = await functions.executeSql(`SELECT name FROM companies WHERE id = ?`, [company_id]);
    const link_convite = `${process.env.URL_SITE}/empresa_entrar?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
    const emailHtml = emailTemplates.inviteUser(requested_user_name, company[0]?.name || "", link_convite);
    await sendEmails.sendEmail(emailHtml, "Convite para entrar em uma empresa", process.env.USER_EMAIL, email);
    this.returnCompanyUsers(company_id, true).catch(() => {});
    return token;
  },
  checkIfExistInvite: function (company_id, email) {
    return functions.executeSql(
      `SELECT id FROM company_invitations
        WHERE company_id = ? AND invited_user = ? AND status = 'pending' AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [company_id, email],
    );
  },
  returnCompanyUsers: function (company_id, clearCache = false) {
    return functions.executeSql(
      `
                    SELECT
                        u.id,
                        u.name,
                        u.email,
                        ccr.id AS role,
                        ccr.name AS roleName,
                        ccr.permission AS rolePermission,
                        "Membro" AS status
                    FROM
                        company_members cm
                    INNER JOIN
                        users u ON u.id = cm.user_id
                    INNER JOIN
                        config_users_roles cur ON cur.user_id = u.id
                    INNER JOIN
                        config_company_roles ccr ON ccr.id = cur.role_id AND ccr.company_id = ?
                    WHERE
                        cm.company_id = ?

                    UNION

                    SELECT
                        NULL AS id,
                        invited_user AS name,
                        "" AS email,
                        "" AS role,
                        "" AS roleName,
                        0 AS rolePermission,
                        "Convite pendente" AS status
                    FROM
                        company_invitations ci
                    WHERE
                        ci.company_id = ? AND ci.status = "pending" AND ci.used_at IS NULL
                        AND (ci.expires_at IS NULL OR ci.expires_at > NOW())

                    ORDER BY id IS NULL, name
                `,
      [company_id, company_id, company_id],
      !clearCache,
      60,
    );
  },
  changeUserRole: async function (role_id, user_id, company_id) {
    // Cargo e usuário precisam pertencer à empresa; só o vínculo desta empresa é alterado.
    await this.assertRoleInCompany(role_id, company_id);
    const member = await functions.executeSql(
      `SELECT 1 FROM company_members WHERE company_id = ? AND user_id = ?`,
      [company_id, user_id],
    );
    if (!member.length) throw "Usuário não pertence a esta empresa";
    const result = await functions.executeSql(
      `UPDATE config_users_roles SET role_id = ?
        WHERE user_id = ? AND role_id IN (SELECT id FROM config_company_roles WHERE company_id = ?)`,
      [role_id, user_id, company_id],
    );
    if (!result.affectedRows) {
      await functions.executeSql(`INSERT INTO config_users_roles (role_id, user_id) VALUES (?, ?)`, [role_id, user_id]);
    }
    this.returnCompanyUsers(company_id, true).catch(() => {});
  },
  // Busca convite válido (pendente, não usado, não expirado) pelo hash do token.
  findValidInvite: async function (token, query = functions.executeSql, forUpdate = false) {
    if (typeof token !== "string" || token.length < 16 || token.length > 200) return null;
    const rows = await query(
      `SELECT id, company_id, invited_user, role_id FROM company_invitations
        WHERE token_hash = ? AND status = 'pending' AND used_at IS NULL
          AND expires_at IS NOT NULL AND expires_at > NOW()${forUpdate ? " FOR UPDATE" : ""}`,
      [sha256(token)],
    );
    return rows[0] || null;
  },
  checkTokenValidity: async function (token, user_email) {
    const invite = await this.findValidInvite(token);
    if (!invite) throw "Token inválido ou expirado.";
    if (String(invite.invited_user).toLowerCase() !== String(user_email || "").trim().toLowerCase()) {
      throw "E-mail inválido para o convite";
    }
    return invite.invited_user;
  },
  // Aceite do convite: transação única, uso único, cargo revalidado contra a empresa.
  enterCompany: async function (token, user_email) {
    const result = await functions.executeTransaction(async (query) => {
      const invite = await this.findValidInvite(token, query, true);
      if (!invite) throw "Token inválido ou expirado.";
      if (String(invite.invited_user).toLowerCase() !== String(user_email || "").trim().toLowerCase()) {
        throw "E-mail inválido para o convite";
      }
      const users = await query(`SELECT id FROM users WHERE email = ?`, [invite.invited_user]);
      if (!users.length) throw "Email inválido para o convite";
      const userId = users[0].id;
      await this.assertRoleInCompany(invite.role_id, invite.company_id, query);

      const member = await query(`SELECT 1 FROM company_members WHERE user_id = ? AND company_id = ?`, [userId, invite.company_id]);
      if (!member.length) await query(`INSERT INTO company_members (user_id, company_id) VALUES (?, ?)`, [userId, invite.company_id]);
      await query(
        `DELETE FROM config_users_roles WHERE user_id = ? AND role_id IN (SELECT id FROM config_company_roles WHERE company_id = ?)`,
        [userId, invite.company_id],
      );
      await query(`INSERT INTO config_users_roles (role_id, user_id) VALUES (?, ?)`, [invite.role_id, userId]);
      const used = await query(
        `UPDATE company_invitations SET status = 'accepted', used_at = NOW() WHERE id = ? AND used_at IS NULL`,
        [invite.id],
      );
      if (used.affectedRows !== 1) throw "Token inválido ou expirado.";
      return { userId, companyId: invite.company_id };
    });
    this.returnCompanyUsers(result.companyId, true).catch(() => {});
    _usersService.returnUserCompanies(result.userId, true).catch(() => {});
  },
  removeUserFromCompany: async function (company_id, exclude_user_id, connected_user_id) {
    if (Number(exclude_user_id) === Number(connected_user_id)) {
      throw "Você não pode se auto remover da empresa";
    }
    const members = await functions.executeSql(`SELECT user_id FROM company_members WHERE company_id = ?`, [company_id]);
    if (members.length == 0) throw "Ocorreu um erro ao verificar os membros da empresa";
    if (members.length == 1) throw "Você não pode sair de uma empresa cujo o único membro é você";
    if (!members.some((m) => Number(m.user_id) === Number(exclude_user_id))) throw "Ocorreu um erro ao remover o usuário";

    await functions.executeTransaction(async (query) => {
      await query(`DELETE FROM company_members WHERE company_id = ? AND user_id = ?`, [company_id, exclude_user_id]);
      // Profissional continua existindo; só perde o vínculo com quem saiu.
      await query(`UPDATE professionals SET user_id = NULL WHERE company_id = ? AND user_id = ?`, [company_id, exclude_user_id]);
      await query(
        `DELETE FROM company_invitations WHERE company_id = ? AND invited_user = (SELECT email FROM users WHERE id = ?)`,
        [company_id, exclude_user_id],
      );
      await query(
        `DELETE FROM config_users_roles WHERE user_id = ? AND role_id IN (SELECT id FROM config_company_roles WHERE company_id = ?)`,
        [exclude_user_id, company_id],
      );
    });
    this.returnCompanyUsers(company_id, true).catch(() => {});
    _usersService.returnUserCompanies(exclude_user_id, true).catch(() => {});
  },
  findUserByToken: async function (token, user_email) {
    const email = await this.checkTokenValidity(token, user_email);
    const results = await _usersService.checkIfUserExists(email);
    return !!results.exist;
  },
  createService: function (
    company_id,
    name,
    value,
    cost,
    observations,
    duration,
    requires_location,
    accepts_quantity,
    measurement_unit_id,
  ) {
    return new Promise((resolve, reject) => {
      const safeUnit = MEASUREMENT_UNITS[measurement_unit_id] || "unidade";

      functions
        .executeSql(
          `INSERT INTO services (company_id, name, value, cost, observations, duration, requires_location, accepts_quantity, measurement_unit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            company_id,
            name,
            value,
            cost,
            observations,
            duration,
            requires_location ? 1 : 0,
            accepts_quantity ? 1 : 0,
            safeUnit,
          ],
        )
        .then((results) => {
          if (results.affectedRows === 0) reject("Erro ao criar o serviço");
          this.returnCompanyServices(company_id, true);
          resolve();
        })
        .catch((error) => reject(error));
    });
  },
  createProduct: function (
    company_id,
    name,
    value,
    cost,
    description,
    unit_of_measure,
  ) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    INSERT INTO products (company_id, name, value, cost, description, unit_of_measure)
                    VALUES (?, ?, ?, ?, ?, ?)
                `,
          [company_id, name, value, cost, description, unit_of_measure],
        )
        .then((results) => {
          if (results.affectedRows === 0) {
            reject("Erro ao criar o produto");
          }
          this.returnCompanyProducts(company_id, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnCompanyServices: function (company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `SELECT id, name, value, cost, observations, duration, requires_location, accepts_quantity, measurement_unit
           FROM services WHERE company_id = ?`,
          [company_id],
          !clearCache,
        )
        .then((results) => resolve(results))
        .catch((error) => reject(error));
    });
  },
  returnCompanyProducts: function (company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT 
                        p.id, p.name, p.value, p.cost, p.description, p.unit_of_measure, um.name AS unit_of_measure_name, um.abbreviation AS unit_of_measure_abbreviation, p.current_stock AS available_quantity
                    FROM 
                        products p
                    INNER JOIN
                        units_of_measurement um ON um.id = p.unit_of_measure
                    WHERE 
                        p.company_id = ?
                `,
          [company_id],
          !clearCache,
        )
        .then((results) => {
          resolve(results);
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  editService: function (
    company_id,
    service_id,
    name,
    value,
    cost,
    observations,
    duration,
    requires_location,
    accepts_quantity,
    measurement_unit_id,
  ) {
    return new Promise((resolve, reject) => {
      const safeUnit = MEASUREMENT_UNITS[measurement_unit_id] || "unidade";

      functions
        .executeSql(
          `UPDATE services
           SET name = ?, value = ?, cost = ?, observations = ?, duration = ?, requires_location = ?, accepts_quantity = ?, measurement_unit = ?
           WHERE id = ? AND company_id = ?`,
          [
            name,
            value,
            cost,
            observations,
            duration,
            requires_location ? 1 : 0,
            accepts_quantity ? 1 : 0,
            safeUnit,
            service_id,
            company_id,
          ],
        )
        .then((results) => {
          if (results.affectedRows === 0) reject("Erro ao atualizar o serviço");
          this.returnCompanyServices(company_id, true);
          resolve();
        })
        .catch((error) => reject(error));
    });
  },
  editProduct: function (
    company_id,
    product_id,
    name,
    value,
    cost,
    description,
    unit_of_measure,
  ) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    UPDATE products
                    SET name = ?, value = ?, cost = ?, description = ?, unit_of_measure = ?
                    WHERE id = ? AND company_id = ?
                `,
          [
            name,
            value,
            cost,
            description,
            unit_of_measure,
            product_id,
            company_id,
          ],
        )
        .then((results) => {
          if (results.affectedRows === 0) {
            reject("Erro ao atualizar o produto");
          }
          this.returnCompanyProducts(company_id, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  excludeService: function (company_id, service_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    DELETE FROM services
                    WHERE id = ? AND company_id = ?
                `,
          [service_id, company_id],
        )
        .then((results) => {
          if (results.affectedRows === 0) {
            reject("Erro ao excluir o serviço");
          }
          this.returnCompanyServices(company_id, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  excludeProduct: function (company_id, product_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    DELETE FROM products
                    WHERE id = ? AND company_id = ?
                `,
          [product_id, company_id],
        )
        .then((results) => {
          if (results.affectedRows === 0) {
            reject("Erro ao excluir o produto");
          }
          this.returnCompanyProducts(company_id, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  getPreferences: function (company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        *,
                        (SELECT active FROM config_companies_preferences ccp WHERE ccp.preference_id = p.id AND ccp.company_id = ?) AS active
                    FROM
                        preferences p
                `,
          [company_id],
          !clearCache,
        )
        .then((results) => {
          resolve(results);
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  setPreferences: function (company_id, preferences) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!Array.isArray(preferences) || preferences.some((p) => !p || typeof p.code !== "string")) {
          return reject("Preferências inválidas");
        }
        for (let i = 0; i < preferences.length; i++) {
          let currentPreference = preferences[i];
          
          await functions.insertCompanyPreference(
            company_id,
            currentPreference.code,
            !currentPreference.active ? 0 : 1,
          );
        }

        
        this.getPreferences(company_id, true);
        this.returnCompanyConfigurations(company_id, true);
        
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  },
  deleteCompany: async function (user_id, company_id) {
    // Permissão pelo id do cargo (permission = 1), não pelo nome; tudo em uma transação.
    const checkAdmin = await functions.executeSql(
      `SELECT r.id FROM config_users_roles ur
         INNER JOIN config_company_roles r ON ur.role_id = r.id
         INNER JOIN company_members cm ON cm.user_id = ur.user_id AND cm.company_id = r.company_id
       WHERE ur.user_id = ? AND r.company_id = ? AND r.permission = 1`,
      [user_id, company_id],
    );
    if (checkAdmin.length === 0) {
      throw "Acesso negado. Apenas o Administrador pode excluir a empresa.";
    }
    try {
      await functions.executeTransaction(async (query) => {
        const steps = [
          `DELETE FROM appointment_services WHERE appointment_id IN (SELECT id FROM appointments WHERE company_id = ?)`,
          `DELETE FROM sales_products WHERE sale_id IN (SELECT id FROM sales WHERE company_id = ?)`,
          `DELETE FROM payments WHERE company_id = ?`,
          `DELETE FROM accounts_receivable WHERE customer_id IN (SELECT id FROM customers WHERE company_id = ?)`,
          `DELETE FROM stock_movements WHERE product_id IN (SELECT id FROM products WHERE company_id = ?)`,
          `DELETE FROM sales WHERE company_id = ?`,
          `DELETE FROM appointments WHERE company_id = ?`,
          `DELETE FROM products WHERE company_id = ?`,
          `DELETE FROM services WHERE company_id = ?`,
          `DELETE FROM consents WHERE company_id = ?`,
          `DELETE FROM customers WHERE company_id = ?`,
          `DELETE FROM company_invitations WHERE company_id = ?`,
          `DELETE FROM company_members WHERE company_id = ?`,
          `DELETE FROM config_companies_preferences WHERE company_id = ?`,
          `DELETE FROM config_companies_schedule WHERE company_id = ?`,
          `DELETE FROM config_users_roles WHERE role_id IN (SELECT id FROM config_company_roles WHERE company_id = ?)`,
          `DELETE FROM config_company_roles WHERE company_id = ?`,
          `DELETE FROM config_notifications WHERE company = ?`,
          `DELETE FROM config_opening_hours WHERE company = ?`,
          `DELETE FROM companies WHERE id = ?`,
        ];
        for (const sql of steps) await query(sql, [company_id]);
      });
    } catch (error) {
      console.error("[Erro ao excluir empresa]", error?.code || "erro");
      throw "Não foi possível excluir a empresa devido a um bloqueio no banco de dados.";
    }
  },
  checkAsaasStatus: async function (company_id) {
    const companyData = await functions.executeSql(
      `SELECT asaas_api_key, asaas_status, asaas_wallet_id, document FROM companies WHERE id = ?`,
      [company_id],
    );
    if (!companyData[0]) throw new Error('Empresa não encontrada.');
    if (!companyData[0].asaas_api_key) return { status: 'UNCONFIGURED', onboardingUrl: null };

    const asaasData = await _asaasService.getAccountStatus(decryptKey(companyData[0].asaas_api_key));
    const newStatus = asaasData.status || "PENDING";

    if (newStatus !== companyData[0].asaas_status) {
      await functions.executeSql(`UPDATE companies SET asaas_status = ? WHERE id = ?`, [newStatus, company_id]);
      // A chave cifrada muda a cada gravação (IV aleatório): casa pela carteira/documento.
      await functions.executeSql(
        `UPDATE asaas_wallets SET asaas_status = ? WHERE asaas_wallet_id = ? OR document = ?`,
        [newStatus, companyData[0].asaas_wallet_id, companyData[0].document],
      );
    }

    // Só campos de status vão para o cliente.
    return { status: newStatus, onboardingUrl: asaasData.onboardingUrl || null };
  },
};

module.exports = companiesService;
