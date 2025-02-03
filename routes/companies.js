const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _companiesService = require("../services/companiesService");
const functions = require("../utils/functions");

router.post("/", login, (req, res, next) => {
    _companiesService.returnCompany(req.body.company_id, req.usuario.id).then((results) => {
        let response = functions.createResponse("Retorno da empresa solicitada", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.get("/business_types", login, (req, res, next) => {
    _companiesService.returnBusinessTypes().then((results) => {
        let response = functions.createResponse("Retorno dos tipos de negócio", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

module.exports = router;