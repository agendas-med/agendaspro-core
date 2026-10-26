require("dotenv").config();
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const mysql = require("mysql");
const { promisify } = require("node:util");

test(
  "Split 1:1: OAuth, cobrança, mensalidade e webhook com MariaDB isolado",
  { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 120000 },
  async (t) => {
    const database = `agendaspro_split_test_${process.pid}`;
    const admin = mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT,
      user: "root",
      password: process.env.MYSQL_ROOT_PASSWORD,
      multipleStatements: true,
    });
    const adminSql = promisify(admin.query).bind(admin);
    let server, provider, pool;
    const listen = async (app) => {
      const value = app.listen(0, "127.0.0.1");
      await new Promise((resolve) => value.once("listening", resolve));
      return value;
    };
    try {
      await adminSql(
        "CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        [database],
      );
      Object.assign(process.env, {
        MYSQL_DATABASE: database,
        MYSQL_USER: "root",
        MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
        ENABLE_REMINDERS: "false",
        MP_RECONCILE_ENABLED: "false",
        PAYMENT_PROVIDER: "mercadopago",
        ASAAS_API_KEY: "",
        MP_ACCESS_TOKEN: "central-fixture",
        MP_COLLECTOR_ID: "123",
        MP_ENV: "test",
        MP_WEBHOOK_SECRET: "fixture-webhook",
        MP_WEBHOOK_URL: "https://example.test/webhook/mercadopago",
        MP_CLIENT_ID: "999",
        MP_CLIENT_SECRET: "client-fixture",
        MP_OAUTH_REDIRECT_URI:
          "https://example.test/payments/mercadopago/oauth/callback",
        MP_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
        URL_SITE: "http://localhost:8080",
      });
      process.env.JWT_KEY ||= "fixture-jwt-key";
      await require("../scripts/migrate")();
      await require("../scripts/migrate")();
      const db = require("../utils/functions");
      pool = require("../mysql").pool;
      const sql = db.executeSql.bind(db);
      const preferences = new Map(),
        payments = new Map(),
        subscriptions = new Map(),
        invoices = new Map();
      let preferencePosts = 0,
        subscriptionPosts = 0,
        refreshes = 0,
        loseResponse = false,
        rejectNextPreference = false,
        ownerIsTest = true,
        providerFailure,
        orderPreferenceOverride;
      provider = await listen(
        http.createServer(async (req, res) => {
          try {
            let raw = "";
            for await (const chunk of req) raw += chunk;
            const body = raw ? JSON.parse(raw) : {};
            const url = new URL(req.url, "http://provider.test");
            const path = url.pathname;
            res.setHeader("Content-Type", "application/json");
            const send = (value) => res.end(JSON.stringify(value));
            const seller =
              req.headers.authorization?.includes("seller-fixture");
            if (path === "/oauth/token") {
              assert.equal(body.test_token, "false");
              if (body.grant_type === "authorization_code") {
                assert.equal(typeof body.code_verifier, "string");
                assert.equal(body.client_id, "999");
              } else {
                assert.equal(body.grant_type, "refresh_token");
                refreshes++;
              }
              return send({
                access_token: "seller-fixture",
                refresh_token: "refresh-fixture",
                expires_in: 3600,
                user_id: 456,
              });
            }
            if (path === "/users/me")
              return send({
                id: seller ? 456 : 123,
                site_id: "MLB",
                nickname: "VENDEDOR TESTE",
                tags: ownerIsTest ? ["test_user"] : [],
              });
            if (path === "/checkout/preferences/search")
              return send({
                elements: [...preferences.values()].filter(
                  (p) =>
                    p.external_reference ===
                    url.searchParams.get("external_reference"),
                ),
              });
            if (path === "/checkout/preferences" && req.method === "POST") {
              assert.ok(
                seller,
                "Cobrança deve usar o token do vendedor, nunca o token central.",
              );
              preferencePosts++;
              const [durable] = await sql(
                "SELECT request_body FROM mp_charges WHERE idempotency_key=?",
                [req.headers["x-idempotency-key"]],
              );
              assert.equal(durable.request_body, raw);
              if (rejectNextPreference) {
                rejectNextPreference = false;
                res.statusCode = 400;
                return send({ error: "invalid_request" });
              }
              const value = {
                ...body,
                id: "PREF" + preferencePosts,
                collector_id: 456,
                client_id: "999",
                init_point:
                  "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=" +
                  preferencePosts,
                sandbox_init_point:
                  "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=" +
                  preferencePosts,
              };
              preferences.set(value.id, value);
              if (loseResponse) {
                loseResponse = false;
                return req.socket.destroy();
              }
              return send(value);
            }
            if (path.startsWith("/checkout/preferences/")) {
              const value = preferences.get(path.split("/").pop());
              assert.ok(value);
              if (req.method === "PUT") Object.assign(value, body);
              return send(value);
            }
            if (path === "/v1/payments/search")
              return send({
                results: [...payments.values()].filter(
                  (p) =>
                    p.external_reference ===
                    url.searchParams.get("external_reference"),
                ),
              });
            if (path.startsWith("/v1/payments/")) {
              const value = payments.get(path.split("/").pop());
              assert.ok(value);
              assert.equal(seller, value.collector_id === 456);
              return send(value);
            }
            if (path.startsWith("/merchant_orders/")) {
              const payment = [...payments.values()].find(
                (p) => String(p.order?.id) === path.split("/").pop(),
              );
              assert.ok(payment);
              const preference = [...preferences.values()].find(
                (p) => p.external_reference === payment.external_reference,
              );
              assert.ok(preference);
              return send({
                id: payment.order.id,
                preference_id: orderPreferenceOverride || preference.id,
                collector: { id: payment.collector_id },
                payments: [{ id: payment.id }],
              });
            }
            if (path === "/preapproval/search")
              return send({
                results: [...subscriptions.values()].filter(
                  (p) =>
                    p.external_reference ===
                    url.searchParams.get("external_reference"),
                ),
              });
            if (path === "/preapproval" && req.method === "POST") {
              assert.equal(seller, false);
              subscriptionPosts++;
              assert.equal(body.auto_recurring.transaction_amount, 49.9);
              const value = {
                ...body,
                id: "SUB" + subscriptionPosts,
                collector_id: 123,
                init_point:
                  "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=" +
                  subscriptionPosts,
              };
              subscriptions.set(value.id, value);
              return send(value);
            }
            if (path.startsWith("/preapproval/")) {
              const value = subscriptions.get(path.split("/").pop());
              assert.ok(value);
              if (req.method === "PUT") Object.assign(value, body);
              return send(value);
            }
            if (path === "/authorized_payments/search")
              return send({
                results: [...invoices.values()].filter(
                  (i) =>
                    i.preapproval_id === url.searchParams.get("preapproval_id"),
                ),
              });
            if (path.startsWith("/authorized_payments/"))
              return send(invoices.get(path.split("/").pop()));
            throw new Error("Endpoint inesperado: " + req.method + " " + path);
          } catch (error) {
            providerFailure = error;
            res.statusCode = 500;
            res.end(JSON.stringify({ error: "fixture failure" }));
          }
        }),
      );
      require("../services/mercadoPagoService").client.defaults.baseURL = `http://127.0.0.1:${provider.address().port}`;
      server = await listen(require("../app"));
      const base = `http://127.0.0.1:${server.address().port}`;
      let token, companyId;
      async function request(method, path, body, expected = 200, headers = {}) {
        const response = await fetch(base + path, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: "Bearer " + token } : {}),
            ...(companyId ? { "Selected-company": String(companyId) } : {}),
            ...headers,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
        });
        const raw = await response.text();
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        assert.equal(response.status, expected, `${method} ${path}: ${raw}`);
        return expected === 302 ? response.headers.get("location") : data;
      }
      const registration = await request("POST", "/users/register", {
        name: "Admin Split",
        email: "split@agendaspro.test",
        password: "integration-password",
      });
      token = (
        await request("POST", "/users/login", {
          email: "split@agendaspro.test",
          password: "integration-password",
        })
      ).returnObj.jwtToken;
      const [business] = await sql("SELECT id FROM business_types LIMIT 1");
      companyId = (
        await request("POST", "/companies/create_company", {
          name: "Empresa Split",
          address: "Rua Teste",
          zip_code: "01310-100",
          city: "São Paulo",
          state: "SP",
          business_type: business.id,
          email: "seller@example.com",
          phone: "11999999999",
          document: "52998224725",
          address_number: "10",
          complement: "",
          birthDate: "1990-01-01",
          incomeValue: 5000,
        })
      ).returnObj.id;
      await request("POST", "/customers", {
        name: "Cliente Split",
        cpf: "12345678901",
        birthday: "1990-01-01",
        tel: "11999999999",
        image: "",
        email: "payer@example.com",
      });
      const customer = (await request("GET", "/customers")).returnObj[0];
      const [unit] = await sql("SELECT id FROM units_of_measurement LIMIT 1");
      const productId = (
        await sql(
          "INSERT INTO products (name,value,cost,current_stock,company_id,unit_of_measure) VALUES ('Produto',100,20,100,?,?)",
          [companyId, unit.id],
        )
      ).insertId;
      const newSale = async () =>
        (
          await request("POST", "/sales", {
            company_id: companyId,
            customer_id: customer.id,
            appointment_id: null,
            status: "em_aberto",
            products: [{ id: productId, quantity: 1 }],
          })
        ).returnObj.id;
      const input = (sale) => ({
        sale_id: sale,
        customer_id: customer.id,
        amount: 100,
        payment_type: "mercadopago",
      });
      async function signed(id, type = "payment", hint, expected = 200) {
        const requestId = crypto.randomUUID(),
          ts = "1781009491";
        const digest = crypto
          .createHmac("sha256", process.env.MP_WEBHOOK_SECRET)
          .update(
            `id:${String(id).toLowerCase()};request-id:${requestId};ts:${ts};`,
          )
          .digest("hex");
        return request(
          "POST",
          `/webhook/mercadopago?data.id=${id}${hint ? "&charge_id=" + hint : ""}`,
          {
            type,
            data: { id },
            user_id: type === "payment" && String(id) !== "99001" ? 456 : 123,
          },
          expected,
          { "x-request-id": requestId, "x-signature": `ts=${ts},v1=${digest}` },
        );
      }
      async function connect() {
        const result = await request(
          "POST",
          "/payments/mercadopago/connect",
          {},
        );
        const url = new URL(result.url);
        assert.equal(url.hostname, "auth.mercadopago.com.br");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const state = url.searchParams.get("state");
        const target = await request(
          "GET",
          `/payments/mercadopago/oauth/callback?state=${state}&code=fixture-code`,
          undefined,
          302,
        );
        assert.ok(target.includes("connection=success"));
        return state;
      }
      function paymentFor(charge, status = "approved") {
        const payment = {
          id: String(80000 + payments.size),
          collector_id: 456,
          marketplace_owner: 123,
          live_mode: true,
          order: { id: String(900000 + payments.size), type: "mercadopago" },
          currency_id: "BRL",
          transaction_amount: 100,
          transaction_amount_refunded: 0,
          external_reference: preferences.get("PREF" + preferencePosts)
            .external_reference,
          status,
          payment_method_id: "pix",
          fee_details: [{ type: "application_fee", amount: charge.commission }],
        };
        payments.set(payment.id, payment);
        return payment;
      }
      let freeCharge, premiumCharge, subId;
      await t.test(
        "sem conexão não cobra; callbacks inválidos ou repetidos falham sem conectar outra empresa",
        async () => {
          const sale = await newSale();
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            400,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          const state = await connect();
          const replay = await request(
            "GET",
            `/payments/mercadopago/oauth/callback?state=${state}&code=fixture-code`,
            undefined,
            302,
          );
          assert.ok(replay.includes("connection=failed"));
          const status = await request("GET", "/payments/mercadopago/status");
          assert.equal(status.connection.collector_id, "456");
          assert.equal(status.plan.current.code, "free");
          assert.equal(status.commission_bps, 500);
          assert.equal(
            JSON.stringify(status).includes("seller-fixture"),
            false,
          );
          const [stored] = await sql("SELECT * FROM mp_connections");
          assert.notEqual(stored.access_token, "seller-fixture");
          assert.notEqual(stored.refresh_token, "refresh-fixture");
          await request("POST", "/payments/mercadopago/connect", {}, 403, {
            "Selected-company": "99999",
          });
          const [assigned] = await sql(
            "SELECT role_id FROM config_users_roles WHERE user_id=?",
            [registration.returnObj.id],
          );
          const role = (
            await sql(
              "INSERT INTO config_company_roles(company_id,name,permission,default_role) VALUES (?,'Leitura',0,0)",
              [companyId],
            )
          ).insertId;
          await sql("UPDATE config_users_roles SET role_id=? WHERE user_id=?", [
            role,
            registration.returnObj.id,
          ]);
          await request("POST", "/payments/mercadopago/connect", {}, 403);
          await request("POST", "/payments/mercadopago/plans/premium", {}, 403);
          await sql("UPDATE config_users_roles SET role_id=? WHERE user_id=?", [
            assigned.role_id,
            registration.returnObj.id,
          ]);
        },
      );
      await t.test(
        "Gratuito retém 5%, usa token do vendedor e congela a comissão na cobrança",
        async () => {
          const sale = await newSale(),
            key = crypto.randomUUID();
          freeCharge = await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": key },
          );
          assert.equal(freeCharge.commission, 5);
          assert.equal(freeCharge.plan, "free");
          assert.equal(freeCharge.api, "checkout");
          assert.equal(
            new URL(freeCharge.checkout_url).origin,
            "https://www.mercadopago.com.br",
          );
          const again = await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": key },
          );
          assert.equal(again.id, freeCharge.id);
          assert.equal(preferencePosts, 1);
          await request(
            "POST",
            "/payments/mercadopago/charges",
            { ...input(sale), amount: 99 },
            400,
            { "Idempotency-Key": key },
          );
          await request(
            "POST",
            "/sales/insert_payment",
            { ...input(sale), payment_type: "dinheiro" },
            400,
          );
          await request(
            "GET",
            `/payments/mercadopago/charges/${freeCharge.id}`,
            undefined,
            403,
            { "Selected-company": "99999" },
          );
        },
      );
      await t.test(
        "webhook valida conta, valor, assinatura e comissão; reentrega registra uma única entrada",
        async () => {
          const remote = paymentFor(freeCharge);
          remote.transaction_amount = 99;
          await signed(remote.id, "payment", freeCharge.id, 503);
          remote.transaction_amount = 100;
          remote.fee_details[0].amount = 1;
          await signed(remote.id, "payment", freeCharge.id, 503);
          remote.fee_details[0].amount = 5;
          remote.marketplace_owner = 321;
          await signed(remote.id, "payment", freeCharge.id, 503);
          remote.marketplace_owner = 123;
          preferences.get("PREF1").client_id = "998";
          await signed(remote.id, "payment", freeCharge.id, 503);
          preferences.get("PREF1").client_id = "999";
          orderPreferenceOverride = "OTHER";
          await signed(remote.id, "payment", freeCharge.id, 503);
          orderPreferenceOverride = undefined;
          ownerIsTest = false;
          await signed(remote.id, "payment", freeCharge.id, 503);
          ownerIsTest = true;
          await request(
            "POST",
            `/webhook/mercadopago?data.id=${remote.id}&charge_id=${freeCharge.id}`,
            { type: "payment", data: { id: remote.id } },
            401,
          );
          await Promise.all([
            signed(remote.id, "payment", freeCharge.id),
            signed(remote.id, "payment", freeCharge.id),
          ]);
          const [count] = await sql(
            "SELECT COUNT(*) total FROM payments WHERE sale_id=?",
            [freeCharge.sale_id],
          );
          assert.equal(count.total, 1);
          const sale = (await request("GET", `/sales/${freeCharge.sale_id}`))
            .returnObj;
          assert.equal(sale.status, "realizada");
          assert.equal(sale.mp_charge_id, null);
          assert.equal(
            (await sql("SELECT COUNT(*) total FROM mp_payouts"))[0].total,
            0,
          );
        },
      );
      await t.test(
        "resposta perdida recupera a preferência por referência sem um segundo POST",
        async () => {
          const sale = await newSale(),
            key = crypto.randomUUID();
          loseResponse = true;
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            400,
            { "Idempotency-Key": key },
          );
          const before = preferencePosts;
          const recovered = await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": key },
          );
          assert.ok(recovered.checkout_url);
          assert.equal(preferencePosts, before);
          await request("POST", "/sales/cancel_pix", { sale_id: sale });
          assert.equal(
            (await request("GET", `/sales/${sale}`)).returnObj.mp_charge_id,
            null,
          );
        },
      );
      await t.test(
        "recusa definitiva não prende a venda; repetição da chave não reenvia e uma nova tentativa funciona",
        async () => {
          const sale = await newSale(),
            key = crypto.randomUUID();
          rejectNextPreference = true;
          const failed = await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": key },
          );
          assert.equal(failed.status, "creation_failed");
          assert.equal(
            (await request("GET", `/sales/${sale}`)).returnObj.mp_charge_id,
            null,
          );
          const before = preferencePosts;
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": key },
          );
          assert.equal(preferencePosts, before);
          const recovered = await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assert.equal(recovered.status, "pending");
        },
      );
      await t.test(
        "webhook global sem charge_id confirma serviço, produto, agendamento e financeiro uma única vez",
        async () => {
          const [before] = await sql(
            "SELECT current_stock FROM products WHERE id = ?",
            [productId],
          );
          const serviceId = (
            await sql(
              "INSERT INTO services (name,value,cost,duration,company_id) VALUES ('Atendimento split',30,10,30,?)",
              [companyId],
            )
          ).insertId;
          const appointmentId =
            await require("../services/appointmentsService").create(
              companyId,
              customer.id,
              "Cliente Split",
              "2027-08-01 10:00:00",
              30,
              "",
              [{ id: serviceId, quantity: 1 }],
              "pendente_pagamento",
            );
          const [sale] = await sql(
            "SELECT id FROM sales WHERE appointment_id = ?",
            [appointmentId],
          );
          await request("PATCH", `/sales/${sale.id}`, {
            company_id: companyId,
            customer_id: customer.id,
            appointment_id: appointmentId,
            status: "em_aberto",
            products: [{ id: productId, quantity: 1 }],
          });
          const charge = await request(
            "POST",
            "/payments/mercadopago/charges",
            { ...input(sale.id), amount: 130 },
            200,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assert.equal(charge.commission, 6.5);
          const remote = paymentFor(charge);
          remote.transaction_amount = 130;
          await signed(remote.id);
          await signed(remote.id);
          assert.equal(
            (
              await sql("SELECT payment_status FROM appointments WHERE id=?", [
                appointmentId,
              ])
            )[0].payment_status,
            "pago",
          );
          assert.equal(
            (
              await sql("SELECT current_stock FROM products WHERE id=?", [
                productId,
              ])
            )[0].current_stock,
            before.current_stock - 1,
          );
          assert.equal(
            (
              await sql("SELECT COUNT(*) total FROM payments WHERE sale_id=?", [
                sale.id,
              ])
            )[0].total,
            1,
          );
          const finance = (await request("GET", "/financial")).returnObj.find(
            (row) => row.sale_id === sale.id,
          );
          assert.equal(finance.total_paid, 130);
          assert.equal(finance.remaining, 0);
        },
      );
      await t.test(
        "token expirado ou TEST legado renova a conexão; conta real não gera cobrança de teste",
        async () => {
          await sql(
            "UPDATE mp_connections SET expires_at=DATE_SUB(NOW(),INTERVAL 1 HOUR)",
          );
          const sale = await newSale();
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assert.equal(refreshes, 1);
          await sql(
            "UPDATE mp_connections SET access_token=?, expires_at=DATE_ADD(NOW(),INTERVAL 1 HOUR)",
            [require("../utils/mercadoPagoTokens").encrypt("TEST-legacy-fixture")],
          );
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(await newSale()),
            200,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assert.equal(refreshes, 2);
          ownerIsTest = false;
          const other = await newSale(),
            before = preferencePosts;
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(other),
            400,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assert.equal(preferencePosts, before);
          ownerIsTest = true;
        },
      );
      await t.test(
        "autorizar assinatura sem pagar não libera desconto; fatura paga ativa 1%",
        async () => {
          const result = await request(
            "POST",
            "/payments/mercadopago/plans/premium",
            {},
          );
          subId = result.subscription.id;
          assert.equal(result.current.code, "free");
          assert.equal(subscriptionPosts, 1);
          await request("POST", "/payments/mercadopago/plans/premium", {});
          assert.equal(subscriptionPosts, 1);
          const remote = subscriptions.get("SUB1");
          remote.status = "authorized";
          await signed("SUB1", "subscription_preapproval");
          assert.equal(
            (await request("GET", "/payments/mercadopago/plans")).current.code,
            "free",
          );
          const now = new Date().toISOString();
          const p = {
            id: "99001",
            collector_id: 123,
            live_mode: true,
            currency_id: "BRL",
            transaction_amount: 49.9,
            transaction_amount_refunded: 0,
            status: "approved",
            date_approved: now,
          };
          payments.set(p.id, p);
          invoices.set("77001", {
            id: 77001,
            preapproval_id: "SUB1",
            transaction_amount: 49.9,
            debit_date: now,
            payment: { id: 99001 },
          });
          p.transaction_amount = 40;
          await signed(
            "77001",
            "subscription_authorized_payment",
            undefined,
            503,
          );
          assert.equal(
            (await request("GET", "/payments/mercadopago/plans")).current.code,
            "free",
          );
          p.transaction_amount = 49.9;
          ownerIsTest = false;
          await signed(
            "77001", "subscription_authorized_payment", undefined, 503,
          );
          ownerIsTest = true;
          await signed("77001", "subscription_authorized_payment");
          await signed("77001", "subscription_authorized_payment");
          const plan = (await request("GET", "/payments/mercadopago/plans"))
            .current;
          assert.equal(plan.code, "premium");
          assert.equal(plan.commission_bps, 100);
          assert.equal(
            (
              await sql("SELECT COUNT(*) total FROM mp_subscription_invoices")
            )[0].total,
            1,
          );
          const sale = await newSale();
          premiumCharge = await request(
            "POST",
            "/payments/mercadopago/charges",
            input(sale),
            200,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          assert.equal(premiumCharge.commission, 1);
          assert.equal(premiumCharge.plan, "premium");
          assert.equal(
            (
              await request(
                "GET",
                `/payments/mercadopago/charges/${freeCharge.id}`,
              )
            ).commission,
            5,
          );
        },
      );
      await t.test(
        "cancelar renovação preserva período pago; vencimento e devolução removem o benefício",
        async () => {
          await request(
            "POST",
            `/payments/mercadopago/plans/${subId}/cancel`,
            {},
          );
          assert.equal(subscriptions.get("SUB1").status, "cancelled");
          assert.equal(
            (await request("GET", "/payments/mercadopago/plans")).current.code,
            "premium",
          );
          const [invoice] = await sql(
            "SELECT period_end FROM mp_subscription_invoices",
          );
          await sql(
            "UPDATE mp_subscription_invoices SET period_end=DATE_SUB(NOW(),INTERVAL 1 DAY)",
          );
          assert.equal(
            (await request("GET", "/payments/mercadopago/plans")).current.code,
            "free",
          );
          await sql("UPDATE mp_subscription_invoices SET period_end=?", [
            invoice.period_end,
          ]);
          payments.get("99001").transaction_amount_refunded = 49.9;
          await signed("99001", "payment");
          assert.equal(
            (await request("GET", "/payments/mercadopago/plans")).current.code,
            "free",
          );
          assert.equal(
            (
              await request(
                "GET",
                `/payments/mercadopago/charges/${premiumCharge.id}`,
              )
            ).commission,
            1,
          );
        },
      );
      await t.test(
        "desconectar impede novas cobranças; endpoints de payout estão aposentados",
        async () => {
          await request("POST", "/payments/mercadopago/disconnect", {});
          assert.equal(
            (await request("GET", "/payments/mercadopago/status")).connection,
            null,
          );
          await request(
            "POST",
            "/payments/mercadopago/charges",
            input(await newSale()),
            400,
            { "Idempotency-Key": crypto.randomUUID() },
          );
          await request(
            "POST",
            "/payments/mercadopago/payouts/1/submit",
            {},
            410,
          );
          await request("PUT", "/payments/mercadopago/destination", {}, 410);
          assert.equal(
            (await sql("SELECT COUNT(*) total FROM mp_payouts"))[0].total,
            0,
          );
        },
      );
      await t.test(
        "migração repetida depois dos recebimentos mantém o tipo Mercado Pago e os valores",
        async () => {
          const [before] = await sql(
            "SELECT COUNT(*) total, SUM(amount) amount FROM payments WHERE payment_type='mercadopago'",
          );
          await require("../scripts/migrate")();
          const [after] = await sql(
            "SELECT COUNT(*) total, SUM(amount) amount FROM payments WHERE payment_type='mercadopago'",
          );
          assert.deepEqual(after, before);
        },
      );
      if (providerFailure) throw providerFailure;
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (provider) await new Promise((resolve) => provider.close(resolve));
      if (pool) await promisify(pool.end).bind(pool)();
      await adminSql("DROP DATABASE IF EXISTS ??", [database]);
      admin.end();
    }
  },
);
