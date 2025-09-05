const functions = require("../utils/functions");

let stockService = {
    returnStock: function (company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        p.id,
                        p.name AS produto,
                        CASE WHEN p.current_stock = 0 THEN "Vazio" ELSE "Normal" END AS status,
                        CONCAT(p.current_stock, " ", um.abbreviation) AS quantidade
                    FROM
                        products p
                    LEFT JOIN
                        units_of_measurement um ON um.id = p.unit_of_measure
                    WHERE
                        p.company_id = ?
                `, [company_id]
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    add: function (product_id, quantity) {
        return new Promise((resolve, reject) => {
            const queries = [
                {
                    query: "UPDATE products SET current_stock = current_stock + ? WHERE id = ?",
                    queryParams: [quantity, product_id]
                },
                {
                    query: "INSERT INTO stock_movements (product_id, quantity, type) VALUES (?, ?, ?)",
                    queryParams: [product_id, quantity, "add"]
                }
            ];

            functions.executeTransaction(queries).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    remove: function (product_id, quantity) {
        return new Promise((resolve, reject) => {
            const queries = [
                {
                    query: "UPDATE products SET current_stock = current_stock - ? WHERE id = ?",
                    queryParams: [quantity, product_id]
                },
                {
                    query: "INSERT INTO stock_movements (product_id, quantity, type) VALUES (?, ?, ?)",
                    queryParams: [product_id, quantity, "remove"]
                }
            ];

            functions.executeTransaction(queries).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = stockService;