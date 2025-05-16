require('dotenv').config();
const inviteUserHtml = require("./html/request-to-company");
const resetPassword = require("./html/reset-password");

let templates = {
    inviteUser: function (requested_user_name, company_name, link_convite) {
        let html = inviteUserHtml.replace("{{nome_destinatario}}", requested_user_name).replace("{{nome_empresa}}", company_name).replace("{{link_convite}}", link_convite);
        return html;
    },
    resetPassword: function (user_name, user_email, request_date, link) {
        let html = resetPassword.replace("{{nome_usuario}}", user_name).replace("{{email_usuario}}", user_email).replace("{{data_solicitacao}}", request_date).replace("{{link_redefinicao}}", link);
        return html;
    }
}

module.exports = templates;