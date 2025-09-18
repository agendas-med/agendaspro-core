const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const _stockService = require("./stockService");

let salesService = {
    create: function (company_id, customer_id, appointment_id, products, status) {
        return new Promise(async (resolve, reject) => {
            try {
                let unavailableProducts = [];

                for (let i = 0; i < products.length; i++) {
                    let currentProduct = products[i];
                    let currentProductAvailableQuantity = await functions.returnColumn("products", currentProduct.id, "current_stock", "id");

                    if (currentProduct.quantity > currentProductAvailableQuantity) {
                        unavailableProducts.push({availableQuantity: currentProductAvailableQuantity, product: currentProduct});
                    }
                }

                if (unavailableProducts.length > 0) {
                    let returnString = `Um ou mais produtos estão indisponíveis para esta quantidade: \n`;

                    for (let i = 0; i < unavailableProducts.length; i++) {
                        returnString += "\n" + unavailableProducts[i].product.name + " (Disponível: " + unavailableProducts[i].availableQuantity + ")";
                    }

                    reject(returnString);
                } else {
                    functions.executeSql(
                        `
                            INSERT INTO
                                sales
                                (company_id, customer_id, appointment_id, status)
                            VALUES
                                (?, ?, ?, ?)
                        `, [company_id, customer_id, appointment_id, status]
                    ).then((results) => {
                        let promises = [];

                        for (let i = 0; i < products.length; i++) {
                            let currentProduct = products[i];
                            
                            promises.push(
                                this.insertProductInSale(results.insertId, currentProduct.id, currentProduct.quantity)
                            )
                        }

                        Promise.all(promises).then(() => {
                            this.returnSales(company_id, true);
                            resolve();
                        }).catch((error) => {
                            reject(error);
                        })
                    }).catch((error) => {
                        reject(error);
                    })
                }
            } catch (error) {
                reject(error);
            }
        });
    },   
    isFinishedSale: function (saleId) {
        return new Promise(async (resolve, reject) => {
            try {
                let result = await functions.executeSql(
                    `
                        SELECT
                            id
                        FROM
                            sales
                        WHERE
                            status = "realizada"
                        AND
                            id = ?
                    `, [saleId]
                )

                resolve(result.length > 0);
            } catch (error) {
                reject(error);
            }
        })
    },
    update: function (sale_id, company_id, customer_id, appointment_id, products, status) {
        return new Promise(async (resolve, reject) => {
            try {
                let isFinishedSale = await this.isFinishedSale(sale_id);

                if (isFinishedSale) {
                    reject("Impossível alterar a venda pois já está concluída");
                } else {
                    let unavailableProducts = [];

                    for (let i = 0; i < products.length; i++) {
                        let currentProduct = products[i];
                        let currentProductAvailableQuantity = await functions.returnColumn("products", currentProduct.id, "current_stock", "id");

                        if (currentProduct.quantity > currentProductAvailableQuantity) {
                            unavailableProducts.push({availableQuantity: currentProductAvailableQuantity, product: currentProduct});
                        }
                    }
                    
                    if (unavailableProducts.length > 0) {
                        let returnString = `Um ou mais produtos estão indisponíveis para esta quantidade: \n`;

                        for (let i = 0; i < unavailableProducts.length; i++) {
                            returnString += "\n" + unavailableProducts[i].product.name + " (Disponível: " + unavailableProducts[i].availableQuantity + ")";
                        }

                        reject(returnString);
                    } else {
                        functions.executeSql(
                            `
                                UPDATE
                                    sales
                                SET
                                    customer_id = ?, appointment_id = ?, status = ?
                                WHERE
                                    company_id = ? AND id = ?
                            `, [customer_id, appointment_id, status, company_id, sale_id]
                        ).then((results) => {
                            this.removeProductsFromSale(sale_id).then(async () => {
                                let promises = [];

                                for (let i = 0; i < products.length; i++) {
                                    let currentProduct = products[i];

                                    promises.push(
                                        this.insertProductInSale(results.insertId, currentProduct.id, currentProduct.quantity)
                                    )

                                    if (status == "realizada") {
                                        promises.push(_stockService.remove(currentProduct.id, currentProduct.quantity));
                                    }
                                }

                                Promise.all(promises).then(() => {
                                    this.returnSales(company_id, true);
                                    resolve();
                                }).catch((error) => {
                                    reject(error);
                                })
                            }).catch((error) => {
                                reject(error);
                            })
                        }).catch((error) => {
                            reject(error);
                        })
                    }
                }
            } catch (error) {
                reject(error);
            }
        });
    },   
    delete: function (sale_id, company_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    DELETE FROM
                        sales
                    WHERE
                        id = ? AND company_id = ?
                `, [sale_id, company_id]
            ).then(() => {
                this.returnSales(company_id, true);
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    removeProductsFromSale: function (sale_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    DELETE FROM
                        sales_products
                    WHERE
                        sale_id = ?
                `, [sale_id]
            ).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    insertProductInSale: function (sale_id, product_id, quantity) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO
                        sales_products
                        (sale_id, product_id, quantity)
                    VALUES
                        (?, ?, ?)
                `, [sale_id, product_id, quantity]
            ).then(() => {
                resolve();
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnSaleProducts: function (sale_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        p.id,
                        p.name,
                        p.value,
                        p.description,
                        p.cost,
                        sp.quantity,
                        p.current_stock AS available_quantity
                    FROM
                        products p
                    INNER JOIN
                        sales_products sp ON sp.product_id = p.id
                    WHERE
                        sp.sale_id = ? 
                `, [sale_id], !clearCache
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnSaleServices: function (sale_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        s.id,
                        s.name,
                        s.duration,
                        s.observations,
                        s.cost,
                        s.value
                    FROM
                        services s
                    INNER JOIN
                        appointment_services aps ON aps.service_id = s.id
                    INNER JOIN
                        sales sa ON sa.appointment_id = aps.appointment_id
                    WHERE
                        sa.id = ?
                `, [sale_id], !clearCache
            ).then((results) => {
                resolve(results);
            }).catch((error) => {
                reject(error);
            })
        })
    },
    returnSales: function (company_id, clearCache = false) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    SELECT
                        s.*,
                        c.id AS customer_id,
                        c.name AS customer_name,
                        SUM(COALESCE(p.amount, 0)) AS total_paid,
                        COALESCE(
                            JSON_ARRAYAGG(
                                JSON_OBJECT(
                                    'id', p.id,
                                    'amount', p.amount,
                                    'payment_type', p.payment_type
                                )
                            ),
                            '[]'
                        ) AS payments
                    FROM
                        sales AS s
                    INNER JOIN
                        customers AS c ON c.id = s.customer_id
                    LEFT JOIN
                        payments p ON p.sale_id = s.id
                    WHERE
                        s.company_id = ?
                    GROUP BY
                        s.id, c.id, c.name;
                `, [company_id], !clearCache
            ).then(async (results) => {
                for (let i = 0; i < results.length; i++) {
                    let currentSale = results[i];

                    currentSale["debts_list"] = [];
                    currentSale["payments_summary"] = {}; // Novo objeto para a soma dos pagamentos

                    let products = await this.returnSaleProducts(currentSale.id, clearCache);
                    let services = await this.returnSaleServices(currentSale.id, clearCache);
                    let productsValuesSum = 0;
                    let servicesValuesSum = 0;

                    if (currentSale.payments && currentSale.payments[0] && currentSale.payments[0].id !== null) {
                        JSON.parse(currentSale.payments).forEach(p => {
                            if (!currentSale.payments_summary[p.payment_type]) {
                                currentSale.payments_summary[p.payment_type] = 0;
                            }

                            currentSale.payments_summary[p.payment_type] += p.amount;
                        });
                    }
                    
                    currentSale["products"] = products;
                    currentSale["services"] = services;
                    
                    for (let j = 0; j < products.length; j++) {
                        let currentProduct = products[j];
                        currentSale.debts_list.push({
                            value: currentProduct.value * currentProduct.quantity,
                            name: currentProduct.name
                        });
                        productsValuesSum += (currentProduct.value * currentProduct.quantity);
                    }

                    for (let j = 0; j < services.length; j++) {
                        let currentService = services[j];
                        currentSale.debts_list.push({
                            value: currentService.value,
                            name: currentService.name
                        });
                        servicesValuesSum += currentService.value;
                    }

                    let finalValue = productsValuesSum + servicesValuesSum;

                    currentSale["total"] = finalValue;
                    currentSale.payments = JSON.parse(currentSale.payments);
                    currentSale = {...currentSale, products: products};
                }
                resolve(results);
            }).catch((error) => {
                reject(error);
            });
        });
    },
    insertPayment: function (company_id, sale_id, amount, payment_type, customer_id) {
        return new Promise((resolve, reject) => {
            functions.executeSql(
                `
                    INSERT INTO
                        payments
                        (
                            company_id,
                            sale_id,
                            amount,
                            customer_id,
                            payment_type
                        )
                    VALUES
                        (?, ?, ?, ?, ?)
                `, [company_id, sale_id, amount, customer_id, payment_type]
            ).then((results) => {
                if (results.insertId) {
                    this.returnSales(company_id, true);
                    resolve();
                } else {
                    reject("Ocorreu um erro ao inserir o pagamento");
                }
            }).catch((error) => {
                reject(error);
            })
        })
    }
}

module.exports = salesService;