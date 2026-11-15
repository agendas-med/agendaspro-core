const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _reportsService = require("../services/reportsService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");
const { sendError } = require("../middleware/errorHandler");

// Erros de validação do serviço (Error de negócio) voltam como 400; demais, 500 genérico.
const fail = (req, res) => (error) => sendError(req, res, error, error instanceof Error && !require("../middleware/errorHandler").isInternal(error) ? 400 : 500);

router.post("/appointments", login, validate.validateCompanyAccess, (req, res) => {
    _reportsService.retornaAgendamentos(req.companyId, req.body.type, req.body.date).then((results) => {
        return res.status(200).send(functions.createResponse("Retorno do relatório de agendamentos", results, "POST", 200));
    }).catch(fail(req, res));
});

// Assinatura do serviço: (company_id, competence, range). O front envia { type, date };
// { competence, range } também é aceito.
router.post("/invoicing", login, validate.validateCompanyAccess, (req, res) => {
    const competence = req.body.competence ?? req.body.type;
    const range = req.body.range ?? req.body.date;
    _reportsService.retornaFaturamento(req.companyId, competence, range == null ? range : String(range)).then((results) => {
        return res.status(200).send(functions.createResponse("Retorno do relatório de faturamento", results, "POST", 200));
    }).catch(fail(req, res));
});

module.exports = router;
