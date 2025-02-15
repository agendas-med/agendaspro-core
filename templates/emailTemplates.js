require('dotenv').config();
const inviteUserHtml = require("./html/request-to-company");

let templates = {
    inviteUser: function (requested_user_name, company_name, link_convite) {
        let html = inviteUserHtml.replace("{{nome_destinatario}}", requested_user_name).replace("{{nome_empresa}}", company_name).replace("{{link_convite}}", link_convite);
        return html;
    }
}

module.exports = templates;