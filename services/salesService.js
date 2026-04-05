const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const _stockService = require("./stockService");

let salesService = {
  create: function (company_id, customer_id, appointment_id, products, status) {
    return new Promise(async (resolve, reject) => {
      try {
        const companyInfo = await functions.executeSql(
          `SELECT asaas_status FROM companies WHERE id = ?`,
          [company_id],
        );
        if (companyInfo[0].asaas_status !== "APPROVED") {
          return reject(
            "Ação bloqueada. A conta de recebimentos desta empresa ainda não foi aprovada ou validada.",
          );
        }

        let unavailableProducts = [];

        for (let i = 0; i < products.length; i++) {
          let currentProduct = products[i];
          let currentProductAvailableQuantity = await functions.returnColumn(
            "products",
            currentProduct.id,
            "current_stock",
            "id",
          );

          if (currentProduct.quantity > currentProductAvailableQuantity) {
            unavailableProducts.push({
              availableQuantity: currentProductAvailableQuantity,
              product: currentProduct,
            });
          }
        }

        if (unavailableProducts.length > 0) {
          let returnString = `Um ou mais produtos estão indisponíveis para esta quantidade: \n`;

          for (let i = 0; i < unavailableProducts.length; i++) {
            returnString +=
              "\n" +
              unavailableProducts[i].product.name +
              " (Disponível: " +
              unavailableProducts[i].availableQuantity +
              ")";
          }

          reject(returnString);
        } else {
          const validStatus = status || "em_aberto";

          functions
            .executeSql(
              `
                            INSERT INTO
                                sales
                                (company_id, customer_id, appointment_id, status)
                            VALUES
                                (?, ?, ?, ?)
                        `,
              [company_id, customer_id, appointment_id, validStatus],
            )
            .then(async (results) => {
              let sale_id = results.insertId;
              let productsToInsert = [];

              for (let i = 0; i < products.length; i++) {
                let currentProduct = products[i];
                productsToInsert.push(
                  `(${sale_id}, ${currentProduct.id}, ${currentProduct.quantity}, ${currentProduct.value})`,
                );

                await _stockService.remove(
                  currentProduct.id,
                  currentProduct.quantity,
                );
              }

              if (productsToInsert.length > 0) {
                functions
                  .executeSql(
                    `
                                    INSERT INTO 
                                        sales_products
                                        (sale_id, product_id, quantity, unit_price)
                                    VALUES
                                        ${productsToInsert.join(",")}
                                `,
                    [],
                  )
                  .then(() => {
                    this.returnSales(company_id, true);
                    resolve(sale_id);
                  })
                  .catch((error) => {
                    reject(error);
                  });
              } else {
                this.returnSales(company_id, true);
                resolve(sale_id);
              }
            })
            .catch((error) => {
              reject(error);
            });
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
                    `,
          [saleId],
        );

        resolve(result.length > 0);
      } catch (error) {
        reject(error);
      }
    });
  },
  update: function (
    sale_id,
    company_id,
    customer_id,
    appointment_id,
    products,
    status,
  ) {
    return new Promise(async (resolve, reject) => {
      try {
        let isFinishedSale = await this.isFinishedSale(sale_id);

        if (isFinishedSale) {
          reject("Impossível alterar a venda pois já está concluída");
        } else {
          let unavailableProducts = [];

          for (let i = 0; i < products.length; i++) {
            let currentProduct = products[i];
            let currentProductAvailableQuantity = await functions.returnColumn(
              "products",
              currentProduct.id,
              "current_stock",
              "id",
            );

            if (currentProduct.quantity > currentProductAvailableQuantity) {
              unavailableProducts.push({
                availableQuantity: currentProductAvailableQuantity,
                product: currentProduct,
              });
            }
          }

          if (unavailableProducts.length > 0) {
            let returnString = `Um ou mais produtos estão indisponíveis para esta quantidade: \n`;

            for (let i = 0; i < unavailableProducts.length; i++) {
              returnString +=
                "\n" +
                unavailableProducts[i].product.name +
                " (Disponível: " +
                unavailableProducts[i].availableQuantity +
                ")";
            }

            reject(returnString);
          } else {
            if (status == "realizada") {
              let payments = await this.returnPayments(sale_id);

              if (!payments.length) {
                reject(
                  "A venda não pode ser concluída pois existem valores em aberto",
                );
                return;
              }

              let paymentsSum = payments.reduce((acumulador, pagamento) => {
                return acumulador + parseFloat(pagamento.amount);
              }, 0);

              let sale = await this.returnSale(sale_id);

              if (paymentsSum < sale.total) {
                reject(
                  "A venda não pode ser concluída pois existem valores em aberto",
                );
                return;
              }
            }

            functions
              .executeSql(
                `
                                UPDATE
                                    sales
                                SET
                                    customer_id = ?, appointment_id = ?, status = ?
                                WHERE
                                    company_id = ? AND id = ?
                            `,
                [customer_id, appointment_id, status, company_id, sale_id],
              )
              .then((results) => {
                this.removeProductsFromSale(sale_id)
                  .then(async () => {
                    let promises = [];

                    for (let i = 0; i < products.length; i++) {
                      let currentProduct = products[i];

                      promises.push(
                        this.insertProductInSale(
                          sale_id,
                          currentProduct.id,
                          currentProduct.quantity,
                        ),
                      );

                      if (status == "realizada") {
                        promises.push(
                          _stockService.remove(
                            currentProduct.id,
                            currentProduct.quantity,
                          ),
                        );
                      }
                    }

                    Promise.all(promises)
                      .then(() => {
                        this.returnSales(company_id, true);
                        resolve();
                      })
                      .catch((error) => {
                        reject(error);
                      });
                  })
                  .catch((error) => {
                    reject(error);
                  });
              })
              .catch((error) => {
                reject(error);
              });
          }
        }
      } catch (error) {
        reject(error);
      }
    });
  },
  delete: function (sale_id, company_id) {
    return new Promise(async (resolve, reject) => {
      const saleInfo = await functions.executeSql(
        `SELECT s.appointment_id, asv.status AS appointment_status FROM sales s INNER JOIN appointment_status_view asv ON asv.id = s.appointment_id WHERE s.id = ? AND s.company_id = ?`,
        [sale_id, company_id],
      );

      if (saleInfo.length > 0 && (saleInfo[0].appointment_id !== null && saleInfo[0].appointment_status != "cancelado")) {
        return reject(
          "Não é possível excluir uma venda que possui serviços ou um agendamento vinculado.",
        );
      }

      functions
        .executeSql(
          `
                    DELETE FROM
                        sales
                    WHERE
                        id = ? AND company_id = ?
                `,
          [sale_id, company_id],
        )
        .then(() => {
          this.returnSales(company_id, true);
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  removeProductsFromSale: function (sale_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    DELETE FROM
                        sales_products
                    WHERE
                        sale_id = ?
                `,
          [sale_id],
        )
        .then(() => {
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  insertProductInSale: function (sale_id, product_id, quantity) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    INSERT INTO
                        sales_products
                        (sale_id, product_id, quantity)
                    VALUES
                        (?, ?, ?)
                `,
          [sale_id, product_id, quantity],
        )
        .then(() => {
          resolve();
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnSaleProducts: function (sale_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
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
                `,
          [sale_id],
          !clearCache,
        )
        .then((results) => {
          resolve(results);
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnSaleServices: function (sale_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `SELECT s.id, s.name, s.duration, s.observations, s.cost, s.value, aps.quantity
           FROM services s
           INNER JOIN appointment_services aps ON aps.service_id = s.id
           INNER JOIN sales sa ON sa.appointment_id = aps.appointment_id
           WHERE sa.id = ?`,
          [sale_id],
          !clearCache,
        )
        .then((results) => resolve(results))
        .catch((error) => reject(error));
    });
  },
  returnSale: function (sale_id) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        s.*,
                        c.id AS customer_id,
                        c.name AS customer_name,
                        SUM(COALESCE(p.amount, 0)) AS total_paid,
                        IF(
                            COUNT(p.id) > 0,
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
                        s.id = ?
                    GROUP BY
                        s.id, c.id, c.name;
                `,
          [sale_id],
        )
        .then(async (results) => {
          if (results.length) {
            results[0] = await this.insertSalePaymentsAndValueAndProducts(
              results[0],
              true,
            );
            resolve(results[0]);
          } else {
            reject("Nenhuma venda encontrada");
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnSales: function (company_id, clearCache = false) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
          `
                    SELECT
                        s.*,
                        c.id AS customer_id,
                        c.name AS customer_name,
                        SUM(COALESCE(p.amount, 0)) AS total_paid,
                        IF(
                            COUNT(p.id) > 0,
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
                `,
          [company_id],
          !clearCache,
        )
        .then(async (results) => {
          for (let i = 0; i < results.length; i++) {
            results[i] = await this.insertSalePaymentsAndValueAndProducts(
              results[i],
              clearCache,
            );
          }
          resolve(results);
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  insertSalePaymentsAndValueAndProducts: async function (
    currentSale,
    clearCache = false,
  ) {
    currentSale["debts_list"] = [];
    currentSale["payments_summary"] = {};

    let products = await this.returnSaleProducts(currentSale.id, clearCache);
    let services = await this.returnSaleServices(currentSale.id, clearCache);
    let productsValuesSum = 0;
    let servicesValuesSum = 0;

    if (
      currentSale.payments &&
      currentSale.payments[0] &&
      currentSale.payments[0].id !== null
    ) {
      JSON.parse(currentSale.payments).forEach((p) => {
        if (!currentSale.payments_summary[p.payment_type])
          currentSale.payments_summary[p.payment_type] = 0;
        currentSale.payments_summary[p.payment_type] += p.amount;
      });
    }

    for (let j = 0; j < products.length; j++) {
      let currentProduct = products[j];
      currentSale.debts_list.push({
        value: currentProduct.value * currentProduct.quantity,
        name: currentProduct.name,
      });
      productsValuesSum += currentProduct.value * currentProduct.quantity;
    }

    for (let j = 0; j < services.length; j++) {
      let currentService = services[j];
      let qty = currentService.quantity || 1;

      currentSale.debts_list.push({
        value: currentService.value * qty,
        name:
          qty > 1 ? `${currentService.name} (x${qty})` : currentService.name,
      });

      servicesValuesSum += currentService.value * qty;
    }

    currentSale["total"] = productsValuesSum + servicesValuesSum;
    currentSale.payments = currentSale.payments
      ? JSON.parse(currentSale.payments)
      : [];
    return { ...currentSale, products, services };
  },
  insertPayment: function (
    company_id,
    sale_id,
    amount,
    payment_type,
    customer_id,
  ) {
    return new Promise((resolve, reject) => {
      functions
        .executeSql(
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
                `,
          [company_id, sale_id, amount, customer_id, payment_type],
        )
        .then((results) => {
          if (results.insertId) {
            this.returnSales(company_id, true);
            resolve();
          } else {
            reject("Ocorreu um erro ao inserir o pagamento");
          }
        })
        .catch((error) => {
          reject(error);
        });
    });
  },
  returnPayments: function (sale_id) {
    return new Promise(async (resolve, reject) => {
      try {
        let payments = await functions.executeSql(
          `
                    SELECT
                        *
                    FROM
                        payments
                    WHERE
                        sale_id = ?
                `,
          [sale_id],
        );

        resolve(payments);
      } catch (error) {
        reject(error);
      }
    });
  },
};

module.exports = salesService;
