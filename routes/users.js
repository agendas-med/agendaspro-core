const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _usersService = require("../services/usersService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");

router.post("/register", (req, res, next) => {
    _usersService.register(req.body.name, req.body.email, req.body.password).then((results) => {
        let response = functions.createResponse("Usuário criado com sucesso", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/login", (req, res, next) => {
    _usersService.login(req.body.email, req.body.password).then((results) => {
        let response = functions.createResponse("Usuario autenticado com sucesso", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.get("/", login, (req, res, next) => {
    _usersService.returnUser(req.usuario.id, req.headers['selected-company']).then((results) => {
        let response = functions.createResponse("Retorno do usuário", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.get("/return_companies", login, (req, res, next) => {
    _usersService.returnCompanies(req.usuario.id).then((results) => {
        let response = functions.createResponse("Retorno das empresas do usuário", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/check_jwt", (req, res, next) => {
    _usersService.checkJwt(req.body.token).then((results) => {
        let returnObj = {
            newToken: results
        }

        let response = functions.createResponse("Token válido e foi renovado", returnObj, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/find", login, validate.validateRequest(validate.schemas.users.find), (req, res, next) => {
    _usersService.findUser(req.body.search_string).then((results) => {
        let response = functions.createResponse("Usuário encontrado", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
})

router.post("/change-profile", login, validate.validateRequest(validate.schemas.users.change_profile), (req, res, next) => {
    _usersService.changeProfile(req.usuario.id, req.headers['selected-company'], req.body.address, req.body.city, req.body.state, req.body.tel, req.body.zip_code).then((results) => {
        let response = functions.createResponse("Perfil atualizado com sucesso", results, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
})

router.get("/request-reset-password", login, (req, res, next) => {
    _usersService.requestResetPassword(req.usuario.id).then(() => {
        let response = functions.createResponse("Email para redefinição de senha enviado", null, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

router.post("/check-token-validity", (req, res, next) => {
    _usersService.checkTokenValidity(req.body.token).then(() => {
        let response = functions.createResponse("Token válido", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(401).send(error);
    })
});

router.post("/reset-password", (req, res, next) => {
    _usersService.resetPassword(req.body.token, req.body.password).then(() => {
        let response = functions.createResponse("Senha alterada com sucesso", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

module.exports = router;