require('dotenv').config();
const cron = require('node-cron');
const notificationService = require('./services/notificationService');

if (process.env.ENABLE_REMINDERS !== 'false') cron.schedule('* * * * *', async () => {
    console.log("[Cron] Verificando lembretes de agendamento...");
    try { await notificationService.sendHourlyReminders(); }
    catch (error) { console.error('[Lembretes]', error.message); }
});

if (process.env.MP_AUTO_PAYOUTS === 'true') {
    let running = false;
    cron.schedule('* * * * *', async () => {
        if (running) return;
        running = true;
        try { await require('./scripts/reconcile-payments')(); }
        catch (error) { console.error('[Mercado Pago]', error.message); }
        finally { running = false; }
    });
}


const express = require('express');
const app = express();
const morgan = require('morgan');
const bodyParser = require("body-parser");
const cors = require('cors');

const usersRoute = require('./routes/users');
const companiesRoute = require('./routes/companies');
const customersRoute = require('./routes/customers');
const appointmentsRoute = require('./routes/appointments');
const financialRoute = require('./routes/financial');
const reportsRoute = require("./routes/reports");
const salesRoute = require("./routes/sales");
const utilsRoute = require("./routes/utils");
const stockRoute = require("./routes/stock");
const webhookRoute = require("./routes/webhook");

app.use(morgan('dev'));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(cors());
require('dotenv').config();

app.use((req, res, next) => {
    if (process.env.URL_SITE) res.header('Access-Control-Allow-Origin', process.env.URL_SITE);
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization, Selected-company, Idempotency-Key'
    );

    if (req.method == 'OPTIONS') {
        res.header('Access-Control-Allow-Methods', 'PUT, POST, PATCH, DELETE, GET');
        return res.status(200).send({});
    }

    next();
});

app.get('/health', async (req, res) => {
    try {
        await require('./utils/functions').executeSql('SELECT 1');
        res.json({ status: 'ok', database: 'ok' });
    } catch (error) { res.status(503).json({ status: 'unavailable', database: 'unavailable' }); }
});
app.use('/users', usersRoute);
app.use('/companies', companiesRoute);
app.use('/customers', customersRoute);
app.use("/appointments", appointmentsRoute);
app.use("/financial", financialRoute);
app.use("/reports", reportsRoute);
app.use("/sales", salesRoute);
app.use("/utils", utilsRoute);
app.use("/stock", stockRoute);
app.use("/webhook", webhookRoute);
app.use('/payments/mercadopago', require('./routes/mercadopago'));

app.use('/public', express.static('public'));

app.use((req, res, next) => {
    const erro = new Error("Não encontrado");
    erro.status = 404;
    next(erro);
});

app.use((error, req, res, next) => {
    res.status(error.status || 500);
    return res.send({
       mensagem: error.message
    });
});

module.exports = app;
