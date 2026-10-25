const crypto = require("node:crypto");
const db = require("../utils/functions");
const gateway = require("./mercadoPagoService");
const config = require("../config/mercadopago");
const tokens = require("../utils/mercadoPagoTokens");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function oauthConfig() {
  const value = config.settings();
  if (
    !value.clientId ||
    !value.clientSecret ||
    !/^https:\/\//.test(value.redirectUri || "")
  ) {
    throw new Error(
      "A conexão Mercado Pago aguarda Client ID, Client Secret e Redirect URL no backend.",
    );
  }
  return value;
}
function validateOwner(owner, expected) {
  if (
    !/^\d+$/.test(String(owner.id)) ||
    owner.site_id !== "MLB" ||
    !Array.isArray(owner.tags) ||
    owner.tags.includes("test_user") !==
      (config.settings().environment === "test") ||
    (expected && String(owner.id) !== String(expected))
  )
    throw new Error(
      "Conta Mercado Pago diferente da conta ou do ambiente esperado.",
    );
  if (String(owner.id) === config.settings().collectorId)
    throw new Error(
      "Conecte a conta do vendedor; ela deve ser diferente da conta do AgendasPro.",
    );
}
const service = {
  async start(companyId, userId) {
    const settings = oauthConfig();
    const state = crypto.randomBytes(32).toString("hex");
    const verifier = crypto.randomBytes(48).toString("base64url");
    await db.executeSql(
      `INSERT INTO mp_oauth_states (state_hash, company_id, user_id, environment, verifier, expires_at)
      VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
      [
        hash(state),
        companyId,
        userId,
        settings.environment,
        tokens.encrypt(verifier),
      ],
    );
    const url = new URL("https://auth.mercadopago.com.br/authorization");
    Object.entries({
      client_id: settings.clientId,
      response_type: "code",
      platform_id: "mp",
      redirect_uri: settings.redirectUri,
      state,
      code_challenge: crypto
        .createHash("sha256")
        .update(verifier)
        .digest("base64url"),
      code_challenge_method: "S256",
    }).forEach(([name, value]) => url.searchParams.set(name, value));
    return { url: url.href };
  },
  async callback(state, code) {
    const settings = oauthConfig();
    if (
      !/^[a-f0-9]{64}$/.test(state || "") ||
      typeof code !== "string" ||
      code.length > 2048 ||
      !code
    )
      throw new Error("Autorização inválida ou expirada.");
    const intent = await db.executeTransaction(async (query) => {
      const [row] = await query(
        "SELECT *, expires_at > NOW() AS valid FROM mp_oauth_states WHERE state_hash = ? FOR UPDATE",
        [hash(state)],
      );
      if (
        !row ||
        row.consumed_at ||
        !row.valid ||
        row.environment !== settings.environment
      )
        throw new Error("Autorização inválida ou expirada.");
      const [permission] = await query(
        `SELECT 1 FROM company_members m JOIN config_users_roles ur ON ur.user_id = m.user_id
        JOIN config_company_roles r ON r.id = ur.role_id AND r.company_id = m.company_id
        WHERE m.user_id = ? AND m.company_id = ? AND r.permission = 1 LIMIT 1`,
        [row.user_id, row.company_id],
      );
      if (!permission)
        throw new Error("A permissão de administrador foi removida.");
      await query(
        "UPDATE mp_oauth_states SET consumed_at = NOW() WHERE state_hash = ?",
        [hash(state)],
      );
      return row;
    });
    const response = await gateway.request("POST", "/oauth/token", {
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: settings.redirectUri,
      code_verifier: tokens.decrypt(intent.verifier),
      test_token: String(settings.environment === "test"),
    });
    if (
      !response.access_token ||
      !response.refresh_token ||
      !Number.isFinite(response.expires_in) ||
      response.expires_in <= 0
    )
      throw new Error("Autorização incompleta. Conecte novamente.");
    const owner = await gateway.request(
      "GET",
      "/users/me",
      undefined,
      {},
      response.access_token,
    );
    validateOwner(owner, response.user_id);
    await db.executeTransaction(async (query) => {
      await query("SELECT id FROM companies WHERE id = ? FOR UPDATE", [
        intent.company_id,
      ]);
      await query(
        "UPDATE mp_connections SET active = 0 WHERE company_id = ? AND environment = ?",
        [intent.company_id, settings.environment],
      );
      await query(
        `INSERT INTO mp_connections (company_id, environment, collector_id, nickname, access_token, refresh_token, expires_at, connected_by)
        VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?)
        ON DUPLICATE KEY UPDATE nickname = VALUES(nickname), access_token = VALUES(access_token), refresh_token = VALUES(refresh_token),
        expires_at = VALUES(expires_at), active = 1, connected_by = VALUES(connected_by)`,
        [
          intent.company_id,
          settings.environment,
          String(owner.id),
          owner.nickname || "",
          tokens.encrypt(response.access_token),
          tokens.encrypt(response.refresh_token),
          response.expires_in,
          intent.user_id,
        ],
      );
    });
    return intent.company_id;
  },
  async current(companyId) {
    const [row] = await db.executeSql(
      `SELECT id, collector_id, nickname, created_at FROM mp_connections
      WHERE company_id = ? AND environment = ? AND active = 1 LIMIT 1`,
      [companyId, config.settings().environment],
    );
    return row || null;
  },
  async disconnect(companyId) {
    await db.executeSql(
      "UPDATE mp_connections SET active = 0 WHERE company_id = ? AND environment = ?",
      [companyId, config.settings().environment],
    );
    return { connected: false };
  },
  async credentials(connectionId, companyId, requireActive = false) {
    return db.executeTransaction(async (query) => {
      const [row] = await query(
        "SELECT *, expires_at > DATE_ADD(NOW(), INTERVAL 60 SECOND) AS valid FROM mp_connections WHERE id = ? AND company_id = ? FOR UPDATE",
        [connectionId, companyId],
      );
      if (
        !row ||
        row.environment !== config.settings().environment ||
        (requireActive && !row.active)
      )
        throw new Error("Conecte a conta Mercado Pago da empresa.");
      let accessToken = tokens.decrypt(row.access_token);
      if (!row.valid) {
        const settings = oauthConfig();
        const response = await gateway.request("POST", "/oauth/token", {
          grant_type: "refresh_token",
          test_token: String(settings.environment === "test"),
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          refresh_token: tokens.decrypt(row.refresh_token),
        });
        if (
          !response.access_token ||
          !response.refresh_token ||
          !Number.isFinite(response.expires_in) ||
          response.expires_in <= 0 ||
          String(response.user_id) !== row.collector_id
        )
          throw new Error("Renove a conexão Mercado Pago.");
        accessToken = response.access_token;
        const owner = await gateway.request(
          "GET",
          "/users/me",
          undefined,
          {},
          accessToken,
        );
        validateOwner(owner, row.collector_id);
        await query(
          "UPDATE mp_connections SET access_token = ?, refresh_token = ?, expires_at = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
          [
            tokens.encrypt(accessToken),
            tokens.encrypt(response.refresh_token),
            response.expires_in,
            row.id,
          ],
        );
      }
      return { accessToken, collectorId: row.collector_id };
    });
  },
};
module.exports = service;
