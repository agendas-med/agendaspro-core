const express = require("express");
const router = express.Router();
const login = require("../middleware/login");
const _salesService = require("../services/salesService");
const functions = require("../utils/functions");
const validate = require("../middleware/validate");
const _asaasService = require("../services/asaasService");

// Criar uma venda
router.post(
  "/",
  login,
  validate.validateRequest(validate.schemas.sales.create),
  validate.validateCompanyAccess,
  (req, res, next) => {
    _salesService
      .create(
        req.headers["selected-company"],
        req.body.customer_id,
        req.body.appointment_id,
        req.body.products,
        req.body.status,
      )
      .then(() => {
        let response = functions.createResponse(
          "Venda criada com sucesso",
          null,
          "POST",
          200,
        );
        return res.status(200).send(response);
      })
      .catch((error) => {
        console.log(error);
        return res.status(500).send(error);
      });
  },
);

// Atualizar uma venda
router.patch(
  "/:id",
  login,
  validate.validateRequest(validate.schemas.sales.create),
  validate.validateCompanyAccess,
  (req, res, next) => {
    if (req.query.finish == "true") {
      req.body.status = "realizada";
    }

    _salesService
      .update(
        req.params.id,
        req.headers["selected-company"],
        req.body.customer_id,
        req.body.appointment_id,
        req.body.products,
        req.body.status,
      )
      .then(() => {
        let response = functions.createResponse(
          "Venda atualizada com sucesso",
          null,
          "PATCH",
          200,
        );
        return res.status(200).send(response);
      })
      .catch((error) => {
        return res.status(500).send(error);
      });
  },
);

// Excluir uma venda
router.delete(
  "/:id",
  login,
  validate.validateCompanyAccess,
  (req, res, next) => {
    _salesService
      .delete(req.params.id, req.headers["selected-company"])
      .then(() => {
        let response = functions.createResponse(
          "Venda excluída com sucesso",
          null,
          "DELETE",
          200,
        );
        return res.status(200).send(response);
      })
      .catch((error) => {
        return res.status(500).send(error);
      });
  },
);

// Retorna as vendas
router.get("/", login, validate.validateCompanyAccess, (req, res, next) => {
  _salesService
    .returnSales(req.headers["selected-company"])
    .then((sales) => {
      let response = functions.createResponse(
        "Retorno das vendas",
        sales,
        "GET",
        200,
      );
      return res.status(200).send(response);
    })
    .catch((error) => {
      console.log(error);
      return res.status(500).send(error);
    });
});

router.post(
  "/insert_payment",
  login,
  validate.validateCompanyAccess,
  async (req, res, next) => {
    try {
      const data = req.body;
      const company_id = req.headers["selected-company"];

      if (data.payment_type === "pix_asaas") {
        const companyData = await functions.executeSql(
          `SELECT asaas_api_key FROM companies WHERE id = ?`,
          [company_id],
        );

        if (
          !companyData ||
          companyData.length === 0 ||
          !companyData[0].asaas_api_key
        ) {
          return res
            .status(400)
            .send("A empresa ainda não configurou os recebimentos online.");
        }

        const subaccountApiKey = companyData[0].asaas_api_key;

        const customerData = await functions.executeSql(
          `SELECT name, cpf, tel, email FROM customers WHERE id = ?`,
          [data.customer_id],
        );
        const c = customerData[0];

        const asaasCustomerId = await _asaasService.getOrCreateCustomer(
          { name: c.name, cpf: c.cpf, email: c.email, tel: c.tel },
          subaccountApiKey,
        );

        const pixData = await _asaasService.createPixCharge(
          {
            customerAsaasId: asaasCustomerId,
            value: data.amount,
            externalReference: `SALE_${data.sale_id}`,
            description: `Venda #${data.sale_id} no AgendasPRO`,
          },
          subaccountApiKey,
        );

        await functions.executeSql(
          `UPDATE sales SET pix_asaas_id = ?, pix_payload = ?, pix_expiration_date = ? WHERE id = ?`,
          [
            pixData.paymentId,
            pixData.payload,
            pixData.expirationDate,
            data.sale_id,
          ],
        );

        return res.status(200).send({ pix: pixData });
      }

      await functions.executeSql(
        `INSERT INTO accounts_receivable (sale_id, amount, payment_type, status, receive_date) VALUES (?, ?, ?, 'recebido', NOW())`,
        [data.sale_id, data.amount, data.payment_type],
      );

      await _salesService.insertPayment(
        company_id,
        data.sale_id,
        data.amount,
        data.payment_type,
        data.customer_id,
      );

      res.status(200).send("Pagamento registrado com sucesso.");
    } catch (error) {
      console.error(error);
      res.status(500).send(error.message || "Erro ao inserir pagamento.");
    }
  },
);

router.post("/cancel_pix", login, async (req, res) => {
  try {
    await functions.executeSql(
      `UPDATE sales SET pix_asaas_id = NULL, pix_payload = NULL, pix_expiration_date = NULL WHERE id = ?`,
      [req.body.sale_id],
    );
    res.status(200).send("PIX desvinculado com sucesso.");
  } catch (error) {
    res.status(500).send("Erro ao cancelar PIX.");
  }
});

module.exports = router;
