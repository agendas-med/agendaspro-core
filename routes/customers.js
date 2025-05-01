const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _customersService = require("../services/customersService");
const _companiesService = require("../services/companiesService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");

router.post("/", login, validate.validateRequest(validate.schemas.customers.createCustomer), (req, res, next) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _customersService.create(req.headers['selected-company'], req.body.name, req.body.cpf, req.body.birthday, req.body.tel, req.body.image).then(() => {
            let response = functions.createResponse("Cliente cadastrado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.delete("/:customer_id", login, (req, res) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _customersService.delete(req.headers['selected-company'], req.params.customer_id).then(() => {
            let response = functions.createResponse("Cliente removido com sucesso", null, "DELETE", 200);
            return res.status(200).send(response);
        }).catch((error) => res.status(500).send(error));
    }).catch((error) => res.status(401).send(error));
});

router.patch("/:customer_id", login, validate.validateRequest(validate.schemas.customers.createCustomer), (req, res) => {
    _companiesService.checkCompanyPermission(req.usuario.id, req.headers['selected-company']).then(() => {
        _customersService.update(req.headers['selected-company'], req.params.customer_id, req.body.name, req.body.cpf, req.body.birthday, req.body.tel, req.body.image).then(() => {
            let response = functions.createResponse("Cliente atualizado com sucesso", null, "PATCH", 200);
            return res.status(200).send(response);
        }).catch((error) => res.status(500).send(error));
    }).catch((error) => res.status(401).send(error));
});

router.get("/:customer_id", login, validate.validateCompanyAccess, (req, res) => {
    _customersService.get(req.params.customer_id).then((customer) => {
        let response = functions.createResponse("Retorno do cliente", customer, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => res.status(500).send(error));
});

router.get("/", login, validate.validateCompanyAccess, (req, res) => {
    _customersService.getAllByCompany(req.headers['selected-company']).then((customers) => {
        let response = functions.createResponse("Retorno dos clientes da empresa", customers, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {console.log(error); res.status(500).send(error)});
});

router.post("/find", login, validate.validateCompanyAccess, (req, res) => {
    _customersService.find(req.headers['selected-company'], req.body.search_string).then((customers) => {
        let response = functions.createResponse("Retorno dos clientes da empresa", customers, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => res.status(500).send(error));
});

module.exports = router;