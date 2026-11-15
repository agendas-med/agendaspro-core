const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../config/jwt");
const functions = require("../utils/functions");

// Access token válido + emitido depois da última troca de senha (consulta em cache de 60 s;
// qualquer escrita no banco limpa o cache, então a troca de senha vale na hora).
module.exports = async (req, res, next) => {
  let decode;
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).send({ mensagem: "Token não fornecido" });
    }
    decode = jwt.verify(header.slice(7).trim(), getJwtSecret(), { algorithms: ["HS256"] });
    if (!Number.isInteger(Number(decode?.id))) throw new Error("token sem id");
  } catch (error) {
    return res.status(401).send({ mensagem: "Falha na verificação da autenticação" });
  }
  try {
    const rows = await functions.executeSql(
      "SELECT UNIX_TIMESTAMP(password_changed_at) AS changed FROM users WHERE id = ?",
      [Number(decode.id)], true, 60,
    );
    const issuedAt = Number(decode.orig_iat || decode.iat);
    if (!rows.length || (rows[0].changed && issuedAt < Number(rows[0].changed))) {
      return res.status(401).send({ mensagem: "Sessão expirada. Entre novamente." });
    }
  } catch (error) {
    return res.status(503).send({ mensagem: "Serviço indisponível. Tente novamente." });
  }
  req.usuario = decode;
  next();
};
