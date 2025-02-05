const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const validate = require("../middleware/validate");
const _companiesService = require("../services/companiesService");
const functions = require("../utils/functions");

router.post("/", login, validate.validateRequest(validate.schemas.companies.returnCompany), (req, res, next) => {
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

router.post("/create_company", login, validate.validateRequest(validate.schemas.companies.createCompany), (req, res, next) => {
    _companiesService.createCompany(req.usuario.id, req.body.name, req.body.address, req.body.zip_code, req.body.city, req.body.state, req.body.business_type).then(() => {
        let response = functions.createResponse("Empresa criada com sucesso", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        console.log(error)
        return res.status(500).send(error);
    })
});

module.exports = router;