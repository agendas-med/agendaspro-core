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
    },
    retornaFaturamento: function (company_id, competence, range, tipo) {
        return new Promise((resolve, reject) => {
            let dateFilter, dateFormat, formatLabel, titleLabel;
            let allPeriods = [];
    
            if (competence === "anual") {
                if (!/^\d{4}$/.test(range)) {
                    return reject(new Error("Ano inválido. Use o formato 'YYYY'."));
                }
    
                dateFilter = `YEAR(a.date) = ${range}`;
                dateFormat = "%Y-%m"; // Agrupa por mês
                formatLabel = (date) => {
                    const meses = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", 
                                   "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
                    return meses[date.getMonth()];
                };
    
                // Gerar todos os meses do ano
                allPeriods = Array.from({ length: 12 }, (_, index) => formatLabel(new Date(range, index)));
            } else if (competence === "semanal") {
                let match = range.match(/^(\d{4})-W(\d{2})$/);
                if (!match) {
                    return reject(new Error("Semana inválida. Use o formato 'YYYY-Www'."));
                }
    
                let [_, year, week] = match;
    
                // Encontrar a primeira segunda-feira do ano ISO-8601
                let jan4 = new Date(year, 0, 4); // O dia 4 de janeiro sempre está na semana 1 do ano ISO
                let firstMonday = new Date(jan4);
                firstMonday.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1); // Ajusta para a segunda-feira da primeira semana

                dateFilter = `a.date BETWEEN '${new Date(year, 0, 1).toISOString().split("T")[0]}' AND '${new Date(year, 11, 31).toISOString().split("T")[0]}'`;
                dateFormat = "%Y-%m-%d"; // Agrupa por dia
                formatLabel = (date) => {
                    const diasSemana = ["Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira", 
                                        "Quinta-feira", "Sexta-feira", "Sábado"];
                    return `${diasSemana[date.getDay()]} (${date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })})`;
                };
    
                let startOfWeek = new Date(firstMonday);
                startOfWeek.setDate(startOfWeek.getDate() + (parseInt(week) - 1) * 7);

                for (let i = 0; i < 7; i++) {
                    let currentDate = new Date(startOfWeek);
                    currentDate.setDate(startOfWeek.getDate() + i);
                    allPeriods.push(formatLabel(currentDate));
                }
            } else {
                return reject(new Error("Tipo inválido. Use 'anual' ou 'semanal'."));
            }
    
            const query = `
                SELECT 
                    DATE_FORMAT(a.date, '${dateFormat}') AS periodo, 
                    SUM(s.value) * COUNT(a.id) AS total_receita,
                    SUM(s.cost) * COUNT(a.id) AS total_despesa
                FROM appointment_status_view a
                JOIN appointment_services asv ON a.id = asv.appointment_id
                JOIN services s ON asv.service_id = s.id
                WHERE a.company_id = ? 
                    AND a.canceled = 0
                    AND a.status = "realizado"
                    AND ${dateFilter}
                GROUP BY periodo
                ORDER BY periodo
            `;
    
            functions.executeSql(query, [company_id])
                .then(results => {
                    let data = {};
                    let labels = new Set();
    
                    results.forEach(row => {
                        let date;
                        
                        if (competence === 'anual') {
                            let [year, month] = row.periodo.split('-').map(Number);
                            date = new Date(year, month - 1);
                        } else if (competence === 'semanal') {
                            let [year, month, day] = row.periodo.split('-').map(Number);
                            date = new Date(year, month - 1, day);
                        }

                        let periodoFormatado = formatLabel(date);
    
                        labels.add(periodoFormatado);
    
                        if (!data[periodoFormatado]) {
                            data[periodoFormatado] = { faturamento: 0, despesa: 0 };
                        }
    
                        data[periodoFormatado].faturamento += row.total_receita;
                        data[periodoFormatado].despesa += row.total_despesa;
                    });
    
                    const sortedLabels = allPeriods;
                    const chartData = {
                        labels: sortedLabels,
                        datasets: [
                            {
                                label: `Faturamento`,
                                backgroundColor: 'rgba(75, 192, 192, 0.5)', // Cor para Faturamento
                                borderColor: 'rgba(75, 192, 192, 1)', // Cor da borda
                                borderWidth: 1,
                                data: sortedLabels.map(periodo => {
                                    return data[periodo]?.faturamento || 0;
                                })
                            },
                            {
                                label: `Despesa`,
                                backgroundColor: 'rgba(255, 99, 132, 0.5)', // Cor para Despesas
                                borderColor: 'rgba(255, 99, 132, 1)', // Cor da borda
                                borderWidth: 1,
                                data: sortedLabels.map(periodo => {
                                    return data[periodo]?.despesa || 0;
                                })
                            }
                        ]
                    };
    
                    resolve(chartData);
                })
                .catch(error => reject(error));
        });
    }    
}

module.exports = reportsService;