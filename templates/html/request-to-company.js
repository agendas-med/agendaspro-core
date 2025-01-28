let template = `
    <table style="font-family: Arial, Helvetica, sans-serif; background: #F6F6F6; width: 100%; height: 100%;">
        <tbody>
            <tr>
                <td>
                    <table style="width: 638px; background: #fff; margin: 0 auto;" cellspacing="0">
                        <tbody>
                            <tr>
                                <td>
                                    <table cellspacing="0">
                                        <tbody>
                                            <tr>
                                                <td style="padding: 20px; padding-bottom: 0px;">
                                                    <h1 style="font-size: 34px; color: #3E6990;">Olá!</h1>
                                                    <h3 style="font-size: 24px; color: #5E5E5E; font-weight: 400;">Você foi convidado para entrar na empresa {company}.</h3>
                                                </td>
                                                <td style="padding: 20px; padding-bottom: 0px;">
                                                    <img src="https://gourmetech-test-storage.s3.sa-east-1.amazonaws.com/undraw_online_transactions.png">
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td>
                                    <table style="width: 100%;">
                                        <tbody>
                                            <tr>
                                                <td style="padding: 20px;">
                                                    <hr style="background: #9B9B9B; margin: 0;">
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td>
                                    <table style="width: 100%;">
                                        <tbody>
                                            <tr>
                                                <td style="padding: 20px;">
                                                    <p style="font-size: 16px; color: #5E5E5E; margin: 0;">Faça login no botão abaixo e venha fazer parte da equipe {company}!</p>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="text-align: center; padding: 20px;">
                                                    <a href="${process.env.URL_SITE}/login?email={email}&tp={temporary_password}" target="_blank" style="font-size: 16px; color: #FCFCFC; text-decoration: none; background: #23967F; border-radius: 8px; border: none; padding: 10px 25px; margin: auto; cursor: pointer;">Entrar</a>
                                                </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                        <tr>
                            <td style="padding-top: 25px;">
                                <table style="background: #3E6990; width: 100%;">
                                    <tbody>
                                        <tr>
                                            <td style="padding: 20px;">
                                                <img src="https://gourmetech-test-storage.s3.sa-east-1.amazonaws.com/gourmetech-erp-para-restaurantes-branco.png">
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 20px 20px 5px 20px;">
                                                <p style="margin: 0; font-size: 16px; color: #FCFCFC;">Fale conosco</p>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 3px 20px; display: flex; align-items:center;">
                                                <img src="https://gourmetech-test-storage.s3.sa-east-1.amazonaws.com/web-icon.png" style="margin-right: 5px; width: 16px; height: 16px;">
                                                <a href="https://dev.gourmetech.com.br" target="_blank" style="text-decoration: none; color: #FCFCFC; font-size: 12px;">gourmetech.com.br</a>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 3px 20px; display: flex; align-items:center;">
                                                <img src="https://gourmetech-test-storage.s3.sa-east-1.amazonaws.com/email-icon.png" style="margin-right: 5px; width: 16px; height: 16px;">
                                                <a href="mailto:contato@gourmetech.com.br" style="text-decoration: none; color: #FCFCFC; font-size: 12px;">contato@gourmetech.com.br</a>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 20px;">
                                                <hr style="background: #FCFCFC;">
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding: 0 20px 20px 20px; text-align: center;">
                                                <p style="margin: 0; color: #fcfcfc; font-size: 12px;">Este é um email automático, por favor não responda.</p>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </td>
        </tr>
    </tbody>
</table>
`;

module.exports = template;