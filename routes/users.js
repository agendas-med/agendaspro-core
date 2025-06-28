const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _usersService = require("../services/usersService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");
const axios = require("axios");

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

router.post("/google-login", async (req, res) => {
    const { token } = req.body;

    try {
        // 🔹 Pegando o Token de Acesso do Google
        const { data } = await axios.post("https://oauth2.googleapis.com/token", null, {
            params: {
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: process.env.URL_SITE,
                grant_type: "authorization_code",
                code: token
            }
        });

        const accessToken = data.access_token;

        const { data: userInfo } = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        const results = await functions.executeSql(
            `
                SELECT
                    *
                FROM
                    users
                WHERE
                    code = ?
            `, [userInfo.id]
        )

        let userId = results[0]?.id;

        if (results.length == 0) {
            let insertedUser = await functions.executeSql(
                `
                    INSERT INTO
                        users
                        (code, name, email, url_photo)
                    VALUES
                        (?, ?, ?, ?)
                `, [userInfo.id, userInfo.given_name, userInfo.email, userInfo.picture]
            )

            userId = insertedUser.insertId;
        }

        _usersService.googleLogin(userId).then((jwtToken) => {
            let returnObj = {
                user: userId,
                token: jwtToken
            }
            
            let response = functions.createResponse("Usuário autenticado com sucesso", returnObj, "POST", 200);
            return res.status(200).send(response);
        })        
    } catch (error) {
        if (error.code == "ER_DUP_ENTRY") {
            error = "Email do google inválido";
        }

        return res.status(500).send(error);
    }
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

router.post("/request-reset-password", (req, res, next) => {
    _usersService.requestResetPassword(req.body.email).then(() => {
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