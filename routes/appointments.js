const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _appointmentsService = require("../services/appointmentsService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");

// Criar um agendamento
router.post("/", login, validate.validateRequest(validate.schemas.appointments.create), (req, res, next) => {
    _appointmentsService.create(
        req.headers['selected-company'],
        req.body.customer_id,
        req.body.customer_name,
        req.body.date,
        req.body.duration,
        req.body.observations,
        req.body.service
    ).then(() => {
        let response = functions.createResponse("Agendamento criado com sucesso", null, "POST", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

// Atualizar um agendamento
router.patch("/:id", login, validate.validateRequest(validate.schemas.appointments.update), (req, res, next) => {
    _appointmentsService.update(
        req.params.id,
        req.headers['selected-company'],
        req.body.customer_id,
        req.body.customer_name,
        req.body.date,
        req.body.duration,
        req.body.observations,
        req.body.service
    ).then(() => {
        let response = functions.createResponse("Agendamento atualizado com sucesso", null, "PATCH", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

// Excluir um agendamento
router.delete("/:id", login, (req, res, next) => {
    _appointmentsService.delete(
        req.params.id,
        req.headers['selected-company']
    ).then(() => {
        let response = functions.createResponse("Agendamento excluído com sucesso", null, "DELETE", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

// Obter um agendamento específico
router.get("/:id", login, (req, res, next) => {
    _appointmentsService.getById(
        req.params.id,
        req.headers['selected-company']
    ).then((appointment) => {
        let response = functions.createResponse("Agendamento encontrado", appointment, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(404).send(error);
    });
});

// Obter todos os agendamentos da empresa
router.get("/", login, (req, res, next) => {
    _appointmentsService.getAllByCompany(
        req.headers['selected-company']
    ).then((appointments) => {
        let response = functions.createResponse("Lista de agendamentos", appointments, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    });
});

module.exports = router;