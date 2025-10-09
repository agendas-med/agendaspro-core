const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _salesService = require("../services/salesService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");

// Criar uma venda
router.post("/", login, validate.validateRequest(validate.schemas.sales.create), validate.validateCompanyAccess, (req, res, next) => {
    _salesService.create(
        req.headers['selected-company'],
        req.body.customer_id,
        req.body.appointment_id,
        req.body.products,
        req.body.status
    ).then(() => {
        let response = functions.createResponse("Venda criada com sucesso", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

// Atualizar uma venda
router.patch("/:id", login, validate.validateRequest(validate.schemas.sales.create), validate.validateCompanyAccess, (req, res, next) => {
    if (req.query.finish == "true") {
        req.body.status = "realizada";
    }

    _salesService.update(
        req.params.id,
        req.headers['selected-company'],
        req.body.customer_id,
        req.body.appointment_id,
        req.body.products,
        req.body.status
    ).then(() => {
        let response = functions.createResponse("Venda atualizada com sucesso", null, "PATCH", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

// Excluir uma venda
router.delete("/:id", login, validate.validateCompanyAccess, (req, res, next) => {
    _salesService.delete(
        req.params.id,
        req.headers['selected-company']
    ).then(() => {
        let response = functions.createResponse("Venda excluída com sucesso", null, "DELETE", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

// Retorna as vendas
router.get("/", login, validate.validateCompanyAccess, (req, res, next) => {
    _salesService.returnSales(req.headers['selected-company']).then((sales) => {
        let response = functions.createResponse("Retorno das vendas", sales, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        console.log(error)
        return res.status(500).send(error);
    });
});

// Insere pagamento
router.post("/insert_payment", login, validate.validateCompanyAccess, validate.validateRequest(validate.schemas.payments.create), (req, res, next) => {
    _salesService.insertPayment(
        req.headers['selected-company'], 
        req.body.sale_id, 
        req.body.amount, 
        req.body.payment_type, 
        req.body.customer_id
    ).then(() => {
        let response = functions.createResponse("Pagamento inserido com sucesso", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(404).send(error);
    });
})

module.exports = router;