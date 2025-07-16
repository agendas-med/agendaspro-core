const functions = require("../utils/functions");

let utilsService = {
    returnUnitsOfMeasurement: function () {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        *
                    FROM
                        units_of_measurement
                `, []
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = utilsService;