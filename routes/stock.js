const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _stockService = require("../services/stockService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");

router.get("/", login, validate.validateCompanyAccess, (req, res, next) => {
    _stockService.returnStock(req.headers['selected-company']).then((results) => {
        let response = functions.createResponse("Retorno do estoque", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

router.post("/add", login, validate.validateCompanyAccess, (req, res, next) => {
    _stockService.add(
        req.body.product_id,
        req.body.quantity
    ).then(() => {
        let response = functions.createResponse("Estoque alterado", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

router.post("/remove", login, validate.validateCompanyAccess, (req, res, next) => {
    _stockService.remove(
        req.body.product_id,
        req.body.quantity
    ).then(() => {
        let response = functions.createResponse("Estoque alterado", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

module.exports = router;