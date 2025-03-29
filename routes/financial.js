const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _financialService = require("../services/financialService");
const functions = require("../utils/functions");

router.get("/", login, (req, res, next) => {
    _financialService.returnFinancial(req.headers['selected-company']).then((results) => {
        let response = functions.createResponse("Retorno do financeiro", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

module.exports = router;