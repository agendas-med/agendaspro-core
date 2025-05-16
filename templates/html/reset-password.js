let year = new Date().getFullYear();

let template = `
    <table style="font-family: Arial, Helvetica, sans-serif; background: #F6F6F6; width: 100%; height: 100%;">
        <tbody>
            <tr>
            <td align="center">
                <table role="presentation" width="600px" border="0" cellspacing="0" cellpadding="0" style="background: #ffffff; border-radius: 8px; padding: 20px; box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.1);">
                <tr>
                    <td align="center" style="padding: 20px;">
                    <h2 style="color: #333333; margin-bottom: 10px;">🔐 Solicitação de Redefinição de Senha</h2>
                    <p style="color: #555555; font-size: 16px;">Olá, <strong>{{nome_usuario}}</strong>,</p>
                    <p style="color: #555555; font-size: 16px;">Recebemos uma solicitação para redefinir a senha da sua conta (<strong>{{email_usuario}}</strong>).</p>
                    <p style="color: #555555; font-size: 16px;">Data da solicitação: <strong>{{data_solicitacao}}</strong></p>
                    <p style="color: #d9534f; font-size: 15px;"><strong>Atenção:</strong> este link é válido por apenas 15 minutos.</p>
                    <a href="{{link_redefinicao}}" style="display: inline-block; background-color: #64b451; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: bold; padding: 12px 20px; border-radius: 5px; margin-top: 10px;">Redefinir Senha</a>
                    </td>
                </tr>
                <tr>
                    <td align="center" style="padding: 20px; font-size: 14px; color: #777777;">
                    <p>Se você não solicitou essa redefinição, pode ignorar este e-mail com segurança.</p>
                    <p style="margin-top: 10px;">&copy; ${year} AgendasPro. Todos os direitos reservados.</p>
                    </td>
                </tr>
                </table>
            </td>
            </tr>
        </tbody>
    </table>
`;

module.exports = template;