const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const validate = require("../middleware/validate");
const requireToken = require("../middleware/requireToken");
const rateLimit = require("../middleware/rateLimit");
const { sendError } = require("../middleware/errorHandler");
const _companiesService = require("../services/companiesService");
const functions = require("../utils/functions");
const _asaasService = require("../services/asaasService");
const { decryptKey } = require("../services/asaasKeys");
const Joi = require("joi");
const { respondError } = require("../middleware/tenant");
const { isValidTimezone, resolveTimezone } = require("../utils/time");

// Erros de negócio (strings) seguem como antes (texto puro); erros internos viram 500 genérico.
const fail = (req, res, status = 500) => (error) => sendError(req, res, error, status, { text: typeof error === 'string' });
const ok = (res, message, data, method) => res.status(200).send(functions.createResponse(message, data ?? null, method, 200));

// Empresa do header validada (inteiro + vínculo) e usuário com cargo administrador nela.
const requireAdmin = (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.companyId).then(() => next()).catch(fail(req, res, 401));
};
const member = [login, validate.validateCompanyAccess];
const admin = [login, validate.validateCompanyAccess, requireAdmin];

const inviteTokenSchema = Joi.object({
    token: Joi.string().min(16).max(200).required(),
    email: Joi.string().email({ tlds: { allow: false } }).max(255).required(),
});
const inviteLimiter = rateLimit({ key: 'invite-token', windowSec: 900, max: 20 });

router.get("/", ...member, (req, res) => {
    _companiesService.returnCompany(req.companyId, req.usuario.id)
        .then((results) => ok(res, "Retorno da empresa solicitada", results, "GET"))
        .catch(fail(req, res));
});

router.post("/create_company", login, rateLimit({ key: 'create-company', windowSec: 3600, max: 10 }), validate.validateRequest(validate.schemas.companies.createCompany), (req, res) => {
    _companiesService.createCompany(req.usuario.id, req.body)
        .then((id) => ok(res, "Empresa criada com sucesso", { id }, "POST"))
        .catch((error) => sendError(req, res, error, 500));
});

router.patch("/:company_id", login, validate.validateRequest(validate.schemas.companies.editCompany), (req, res) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.params.company_id).then(() => {
        const companyId = Number(req.params.company_id);
        _companiesService.editCompany(req.usuario.id, companyId, req.body.name, req.body.address, req.body.city, req.body.state, req.body.business_type, req.body.zip_code, req.body.configurations)
            .then(() => ok(res, "Empresa alterada com sucesso", null, "PATCH"))
            .catch(fail(req, res));
    }).catch(fail(req, res, 401));
});

router.get("/business_types", (req, res) => {
    _companiesService.returnBusinessTypes()
        .then((results) => ok(res, "Retorno dos tipos de negócio", results, "GET"))
        .catch(fail(req, res));
});

router.post("/roles", ...admin, validate.validateRequest(validate.schemas.companies.createRole), (req, res) => {
    _companiesService.createRole(req.companyId, req.body.name, req.body.permission)
        .then(() => ok(res, "Cargo criado com sucesso", null, "POST"))
        .catch(fail(req, res));
});

router.get("/roles", ...member, (req, res) => {
    _companiesService.returnCompanyRoles(req.companyId)
        .then((roles) => ok(res, "Retorno dos cargos da empresa", roles, "GET"))
        .catch(fail(req, res));
});

router.post("/roles/:id", ...admin, validate.validateRequest(validate.schemas.companies.editRole), (req, res) => {
    // O id da rota prevalece; o do corpo é aceito por compatibilidade.
    const roleId = Number(req.params.id) || req.body.id;
    _companiesService.editRole(req.companyId, roleId, req.body.name, req.body.permission)
        .then(() => ok(res, "Cargo salvo com sucesso", null, "POST"))
        .catch(fail(req, res));
});

router.delete("/roles/:id", ...admin, (req, res) => {
    _companiesService.excludeRole(req.companyId, Number(req.params.id) || 0)
        .then(() => ok(res, "Cargo excluído com sucesso", null, "DELETE"))
        .catch(fail(req, res));
});

router.get("/return_users", ...admin, (req, res) => {
    _companiesService.returnCompanyUsers(req.companyId)
        .then((results) => ok(res, "Retorno dos membros da empresa", results, "GET"))
        .catch(fail(req, res));
});

router.post("/invite_user", ...admin, rateLimit({ key: 'invite-user', windowSec: 3600, max: 30 }), validate.validateRequest(validate.schemas.companies.inviteUser), (req, res) => {
    // Quota de usuários da equipe (membros + convites pendentes): checada dentro da transação do convite.
    _companiesService.inviteUser(req.companyId, req.body.name, req.body.id, req.body.email, req.usuario.id, req.body.role)
        .then(() => ok(res, "Convite enviado com sucesso", null, "POST"))
        .catch((error) => error?.code === 'plan_upgrade_required' ? respondError(req, res, error) : fail(req, res)(error));
});

// Fuso da empresa (IANA). Datas de agenda são hora de parede nesse fuso; padrão APP_TIMEZONE.
const timezoneSchema = Joi.object({ timezone: Joi.string().max(64).allow(null).required() });
router.get("/timezone", ...member, (req, res) => {
    functions.executeSql('SELECT timezone FROM companies WHERE id = ?', [req.companyId])
        .then(([row]) => ok(res, "Fuso da empresa", { timezone: row?.timezone || null, effective: resolveTimezone(row?.timezone) }, "GET"))
        .catch(fail(req, res));
});
router.put("/timezone", ...admin, validate.validateRequest(timezoneSchema), (req, res) => {
    const { timezone } = req.body;
    if (timezone !== null && !isValidTimezone(timezone)) return res.status(400).send({ message: 'Fuso horário inválido (use um nome IANA, ex.: America/Sao_Paulo).' });
    functions.executeSql('UPDATE companies SET timezone = ? WHERE id = ?', [timezone, req.companyId])
        .then(() => ok(res, "Fuso atualizado", { timezone, effective: resolveTimezone(timezone) }, "PUT"))
        .catch(fail(req, res));
});

router.post("/change_user_role", ...admin, validate.validateRequest(validate.schemas.companies.editUser), (req, res) => {
    _companiesService.changeUserRole(req.body.role, req.body.id, req.companyId)
        .then(() => ok(res, "Cargo do usuário alterado com sucesso", null, "POST"))
        .catch(fail(req, res));
});

router.post("/find_user_by_token", inviteLimiter, validate.validateRequest(inviteTokenSchema), (req, res) => {
    _companiesService.findUserByToken(req.body.token, req.body.email)
        .then((results) => ok(res, "Verificação de existência do usuário", results, "POST"))
        .catch(fail(req, res, 400));
});

router.post("/enter_company", inviteLimiter, validate.validateRequest(inviteTokenSchema), (req, res) => {
    _companiesService.enterCompany(req.body.token, req.body.email)
        .then(() => ok(res, "Acesso à empresa liberado", null, "POST"))
        .catch((error) => error?.code === 'plan_upgrade_required' ? respondError(req, res, error) : fail(req, res, 400)(error));
});

router.delete("/remove_user/:user_id", ...admin, (req, res) => {
    _companiesService.removeUserFromCompany(req.companyId, Number(req.params.user_id) || 0, req.usuario.id)
        .then(() => ok(res, "Usuário removido com sucesso", null, "DELETE"))
        .catch(fail(req, res));
});

router.post("/services", ...admin, validate.validateRequest(validate.schemas.services.create), (req, res) => {
    _companiesService.createService(req.companyId, req.body.name, req.body.value, req.body.cost, req.body.observations, req.body.duration, req.body.requires_location, req.body.accepts_quantity, req.body.measurement_unit_id).then(() => {
        _companiesService.returnCompany(req.companyId, req.usuario.id, true).catch(() => {});
        ok(res, "Serviço criado com sucesso", null, "POST");
    }).catch(fail(req, res));
});

router.get("/services", ...member, (req, res) => {
    _companiesService.returnCompanyServices(req.companyId)
        .then((services) => ok(res, "Serviços retornados com sucesso", services, "GET"))
        .catch(fail(req, res));
});

router.post("/services/:id", ...admin, validate.validateRequest(validate.schemas.services.create), (req, res) => {
    _companiesService.editService(req.companyId, req.params.id, req.body.name, req.body.value, req.body.cost, req.body.observations, req.body.duration, req.body.requires_location, req.body.accepts_quantity, req.body.measurement_unit_id)
        .then(() => ok(res, "Serviço atualizado com sucesso", null, "POST"))
        .catch(fail(req, res));
});

router.delete("/services/:id", ...admin, (req, res) => {
    _companiesService.excludeService(req.companyId, req.params.id)
        .then(() => ok(res, "Serviço excluído com sucesso", null, "DELETE"))
        .catch(fail(req, res));
});

router.get("/preferences", ...admin, (req, res) => {
    _companiesService.getPreferences(req.companyId)
        .then((results) => ok(res, "Retorno das preferências", results, "GET"))
        .catch(fail(req, res));
});

router.post("/preferences", ...admin, (req, res) => {
    _companiesService.setPreferences(req.companyId, req.body.preferences).then(() => {
        _companiesService.returnCompany(req.companyId, req.usuario.id, true).catch(() => {});
        ok(res, "Preferências atualizadas com sucesso", null, "POST");
    }).catch(fail(req, res));
});

router.post("/products", ...admin, validate.validateRequest(validate.schemas.products.create), (req, res) => {
    _companiesService.createProduct(req.companyId, req.body.name, req.body.value, req.body.cost, req.body.description, req.body.unit_of_measure)
        .then(() => ok(res, "Produto criado com sucesso", null, "POST"))
        .catch(fail(req, res));
});

router.get("/products", ...member, (req, res) => {
    _companiesService.returnCompanyProducts(req.companyId)
        .then((products) => ok(res, "Produtos retornados com sucesso", products, "GET"))
        .catch(fail(req, res));
});

router.post("/products/:id", ...admin, validate.validateRequest(validate.schemas.products.create), (req, res) => {
    _companiesService.editProduct(req.companyId, req.params.id, req.body.name, req.body.value, req.body.cost, req.body.description, req.body.unit_of_measure)
        .then(() => ok(res, "Produto atualizado com sucesso", null, "POST"))
        .catch(fail(req, res));
});

router.delete("/products/:id", ...admin, (req, res) => {
    _companiesService.excludeProduct(req.companyId, req.params.id)
        .then(() => ok(res, "Produto excluído com sucesso", null, "DELETE"))
        .catch(fail(req, res));
});

router.get("/asaas_status", ...member, (req, res) => {
    _companiesService.checkAsaasStatus(req.companyId)
        .then((asaasData) => ok(res, "Status retornado com sucesso", asaasData, "GET"))
        .catch(() => res.status(500).send({ message: "Erro ao consultar status da conta." }));
});

// Rota operacional: exige ADMIN_TOKEN (header), nunca devolve resposta bruta do Asaas.
router.post("/admin/sync_webhooks", requireToken('ADMIN_TOKEN'), async (req, res) => {
    try {
        const wallets = await functions.executeSql(`SELECT asaas_api_key FROM asaas_wallets WHERE asaas_api_key IS NOT NULL`);
        let sucessos = 0;
        let erros = 0;
        for (const wallet of wallets) {
            try {
                await _asaasService.createWebhook(decryptKey(wallet.asaas_api_key));
                sucessos++;
            } catch (e) {
                erros++;
            }
        }
        return res.status(200).send({ mensagem: `Sincronização concluída. Sucessos: ${sucessos}, Erros: ${erros}` });
    } catch (error) {
        return sendError(req, res, error);
    }
});

router.delete("/:id", login, (req, res) => {
    if (!validate.parseCompanyId(String(req.params.id))) return res.status(400).send({ message: "Empresa inválida." });
    _companiesService.deleteCompany(req.usuario.id, Number(req.params.id))
        .then(() => ok(res, "Empresa excluída permanentemente.", null, "DELETE"))
        .catch((error) => typeof error === 'string' ? res.status(400).send({ message: error }) : sendError(req, res, error));
});

module.exports = router;
