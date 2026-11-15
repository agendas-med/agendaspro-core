const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _stockService = require("../services/stockService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");
const { sendError } = require("../middleware/errorHandler");

const fail = (req, res) => (error) => sendError(req, res, error, typeof error === 'string' ? 400 : 500, { text: typeof error === 'string' });

router.get("/", login, validate.validateCompanyAccess, (req, res) => {
    _stockService.returnStock(req.companyId).then((results) => {
        return res.status(200).send(functions.createResponse("Retorno do estoque", results, "GET", 200));
    }).catch(fail(req, res));
});

router.post("/add", login, validate.validateCompanyAccess, (req, res) => {
    _stockService.add(req.companyId, req.body.product_id, req.body.quantity).then(() => {
        return res.status(200).send(functions.createResponse("Estoque alterado", null, "POST", 200));
    }).catch(fail(req, res));
});

router.post("/remove", login, validate.validateCompanyAccess, (req, res) => {
    _stockService.remove(req.companyId, req.body.product_id, req.body.quantity).then(() => {
        return res.status(200).send(functions.createResponse("Estoque alterado", null, "POST", 200));
    }).catch(fail(req, res));
});

module.exports = router;
