const functions = require("../utils/functions");
const sendEmails = require("../config/sendEmail");
const emailTemplates = require("../templates/emailTemplates");
const moment = require("moment");

moment.locale('pt-br');

let reportsService = {
    retornaAgendamentos: function (company_id, tipoFiltro, dataReferencia) {
        return new Promise((resolve, reject) => {
            let dataBase;
    
            // Interpretar a data de referência conforme o tipo de filtro
            try {
                if (tipoFiltro === 'anual') {
                    dataBase = moment(`${dataReferencia}-01-01`, 'YYYY-MM-DD');
                } else if (tipoFiltro === 'semanal') {
                    dataBase = moment(dataReferencia, 'GGGG-[W]WW');
                } else {
                    return reject(new Error('Tipo de filtro inválido. Use "anual" ou "semanal".'));
                }
            } catch (err) {
                return reject(new Error('Data de referência inválida.'));
            }
            
            try {
                let labels = [];
                let data = [];
                let query = '';
                let queryParams = [];
        
                if (tipoFiltro === 'anual') {
                    labels = moment.months();
                    data = Array(12).fill(0);
                    query = `
                        SELECT MONTH(date) AS chave, COUNT(*) AS total
                        FROM appointment_status_view
                        WHERE YEAR(date) = ? AND canceled = 0 AND company_id = ?
                        GROUP BY MONTH(date)
                    `;
                    queryParams = [dataBase.year(), company_id];
                } else if (tipoFiltro === 'semanal') {
                    labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
                    data = Array(7).fill(0);
                    query = `
                        SELECT WEEKDAY(date) AS chave, COUNT(*) AS total
                        FROM appointment_status_view
                        WHERE date BETWEEN ? AND ? AND canceled = 0 AND company_id = ?
                        GROUP BY WEEKDAY(date)
                    `;
                    queryParams = [
                        dataBase.startOf('isoWeek').format('YYYY-MM-DD'),
                        dataBase.endOf('isoWeek').format('YYYY-MM-DD'),
                        company_id
                    ];
                }
        
                // Executa a query e formata os dados para o Chart.js
                functions.executeSql(query, queryParams)
                    .then(resultados => {
                        resultados.forEach(row => {
                            const index = Number(row.chave) - (tipoFiltro === 'anual' ? 1 : 0);
                            if (data[index] !== undefined) {
                                data[index] = row.total;
                            }
                        });
        
                        resolve({
                            labels,
                            datasets: [
                                {
                                    label: 'Agendamentos',
                                    data,
                                    borderColor: 'rgba(75, 192, 192, 1)',
                                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                                    fill: true,
                                    tension: 0.3,
                                    pointRadius: 5,
                                    pointBackgroundColor: 'rgba(75, 192, 192, 1)',
                                },
                            ]
                        });
                    })
                    .catch(reject);
            } catch (error) {
                reject(error);
            }
        });
    }
}

module.exports = reportsService;