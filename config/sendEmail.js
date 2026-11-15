require('./env');
const email = require('../config/email');

let sendEmail = {
    sendEmail: function (emailHtml, emailTitle, from, to) {
        return new Promise((resolve, reject) => {
            email.sendMail({
                html: emailHtml,
                subject: emailTitle,
                from: from,
                to: [to]
            }).then(message => {
                console.log('[email] enviado');
                resolve(true);
            }).catch(err => {
                reject(err);
            })
        })
    }
}

module.exports = sendEmail;