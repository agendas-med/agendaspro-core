const crypto = require("node:crypto");

function key() {
  const value = process.env.MP_TOKEN_ENCRYPTION_KEY || "";
  const buffer = Buffer.from(value, "base64");
  if (buffer.length !== 32)
    throw new Error(
      "Configure MP_TOKEN_ENCRYPTION_KEY com uma chave base64 de 32 bytes.",
    );
  return buffer;
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((part) => part.toString("base64"))
    .join(".");
}
function decrypt(value) {
  const [iv, tag, data] = value
    .split(".")
    .map((part) => Buffer.from(part, "base64"));
  const cipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8");
}
module.exports = { encrypt, decrypt };
