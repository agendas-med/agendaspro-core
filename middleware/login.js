const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  try {
    if (!req.headers.authorization) {
      return res.status(401).send({ mensagem: "Token não fornecido" });
    }

    const token = req.headers.authorization.split(" ")[1];
    const decode = jwt.verify(token, process.env.JWT_KEY);
    req.usuario = decode;

    next();
  } catch (error) {
    return res
      .status(401)
      .send({ mensagem: "Falha na verificação da autenticação" });
  }
};
