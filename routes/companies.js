const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const validate = require("../middleware/validate");
const _companiesService = require("../services/companiesService");
const functions = require("../utils/functions");

router.get("/", login, (req, res, next) => {
    _companiesService.returnCompany(req.headers['selected-company'], req.usuario.id).then((results) => {
        let response = functions.createResponse("Retorno da empresa solicitada", results, "GET", 200);
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
        return res.status(500).send(error);
    })
});

router.patch("/:company_id", login, validate.validateRequest(validate.schemas.companies.editCompany), (req, res, next) => {
    _companiesService.checkCompanyAdmin(req.usuario.id, req.params.company_id).then(() => {
        _companiesService.editCompany(req.params.company_id, req.body.name, req.body.address, req.body.city, req.body.state, req.body.business_type, req.body.zip_code, req.body.configurations).then(() => {
            let response = functions.createResponse("Empresa alterada com sucesso", null, "PATCH", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
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

router.post("/roles", login, validate.validateRequest(validate.schemas.companies.createRole), (req, res, next) => {
    _companiesService.checkCompanyAdmin(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.createRole(req.headers['selected-company'], req.body.name, req.body.permission).then(() => {
            let response = functions.createResponse("Cargo criado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.get("/roles", login, (req, res, next) => {
    _companiesService.returnCompanyRoles(req.headers['selected-company']).then(() => {
        let response = functions.createResponse("Cargo criado com sucesso", null, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/roles/:id", login, (req, res, next) => {
    _companiesService.checkCompanyAdmin(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.editRole(req.headers['selected-company'], req.body.id, req.body.name, req.body.permission).then(() => {
            let response = functions.createResponse("Cargo salvo com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.delete("/roles/:id", login, (req, res, next) => {
    _companiesService.checkCompanyAdmin(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.excludeRole(req.headers['selected-company'], req.params.id).then(() => {
            let response = functions.createResponse("Cargo excluído com sucesso", null, "DELETE", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.post("/invite_user", login, (req, res, next) => {
    _companiesService.checkCompanyAdmin(req.usuario.id, req.headers['selected-company']).then(() => {
        _companiesService.inviteUser(req.headers['selected-company'], req.body.name, req.body.id, req.body.email, req.usuario.id).then(() => {
            let response = functions.createResponse("Convite enviado com sucesso", null, "POST", 200);
            return res.status(200).send(response);
        }).catch((error) => {
            return res.status(500).send(error);
        })
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

module.exports = router;