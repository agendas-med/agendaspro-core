const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _reportsService = require("../services/reportsService");
const functions = require("../utils/functions");

router.post("/", login, (req, res, next) => {
    _reportsService.retornaAgendamentos(req.headers['selected-company'], req.body.type, req.body.date).then((results) => {
        let response = functions.createResponse("Retorno do relatório de agendamentos", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

module.exports = router;