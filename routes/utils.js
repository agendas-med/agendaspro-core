const express = require('express');
const router = express.Router();
const login = require("../middleware/login");
const _utilsService = require("../services/utilsService");
const functions = require("../utils/functions");

router.get("/units_of_measurement", login, (req, res, next) => {
    _utilsService.returnUnitsOfMeasurement().then((results) => {
        let response = functions.createResponse("Retorno das unidades de medida", results, "GET", 200);
        return res.status(200).send(response);
    }).catch((error) => {
        return res.status(500).send(error);
    })
});

module.exports = router;