const jwt = require("jsonwebtoken");
const { getJwtSecret } = require("../config/jwt");

module.exports = (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).send({ mensagem: "Token não fornecido" });
    }
    const decode = jwt.verify(header.slice(7).trim(), getJwtSecret(), { algorithms: ["HS256"] });
    if (!Number.isInteger(Number(decode?.id))) throw new Error("token sem id");
    req.usuario = decode;
    next();
  } catch (error) {
    return res.status(401).send({ mensagem: "Falha na verificação da autenticação" });
  }
};
