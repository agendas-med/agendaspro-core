let year = new Date().getFullYear();

let template = `
    <table style="font-family: Arial, Helvetica, sans-serif; background: #F6F6F6; width: 100%; height: 100%;">
        <tbody>
            <tr>
                <td align="center">
                    <table role="presentation" width="600px" border="0" cellspacing="0" cellpadding="0" style="background: #ffffff; border-radius: 8px; padding: 20px; box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.1);">
                    <tr>
                        <td align="center" style="padding: 20px;">
                        <h2 style="color: #333333; margin-bottom: 10px;">🚀 Você foi convidado!</h2>
                        <p style="color: #555555; font-size: 16px;">Olá, <strong>{{nome_destinatario}}</strong>,</p>
                        <p style="color: #555555; font-size: 16px;"><strong>Você recebeu um convite para se tornar membro da empresa <strong>{{nome_empresa}}</strong>.</p>
                        <p style="color: #555555; font-size: 16px;">Clique no botão abaixo para aceitar o convite e começar:</p>
                        <a href="{{link_convite}}" style="display: inline-block; background-color: #64b451; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: bold; padding: 12px 20px; border-radius: 5px; margin-top: 10px;">Aceitar convite</a>
                        </td>
                    </tr>
                    <tr>
                        <td align="center" style="padding: 20px; font-size: 14px; color: #777777;">
                        <p>Se você não reconhece este convite, pode ignorá-lo com segurança.</p>
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