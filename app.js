require('./config/env');

const express = require('express');
const app = express();
const morgan = require('morgan');
const helmet = require('helmet');
const cors = require('cors');
const { errorHandler } = require('./middleware/errorHandler');

// Lembretes rodam pela fila de jobs (POST /internal/jobs/tick, gatilho externo horário).
// O cron em processo é só para desenvolvimento/instância sempre ligada.
if (process.env.ENABLE_INPROCESS_CRON === 'true') {
    const cron = require('node-cron');
    const jobsService = require('./services/jobsService');
    cron.schedule('*/15 * * * *', () => {
        jobsService.tick().catch((error) => console.error('[cron] tick falhou:', String(error?.message || error).slice(0, 200)));
    });
}

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
const internalRoute = require("./routes/internal");
const filesRoute = require("./routes/files");
const privacyRoute = require("./routes/privacy");

// Atrás do roteador do Heroku: um proxy confiável (req.ip correto para o rate limit).
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Log de acesso sem query string (tokens), corpo ou headers.
// manage_token da API pública é credencial: some do log.
morgan.token('path', (req) => (req.originalUrl || req.url || '').split('?')[0].replace(/^(\/public\/bookings\/)[^/]+/, '$1[token]'));
if (process.env.NODE_ENV !== 'test') app.use(morgan(':method :path :status :response-time ms'));

// API pública (F3): CORS, corpo, headers e erros próprios; montada antes do CORS/body globais.
// Compatibilidade: uploads locais antigos (/public/uploads/x) redirecionam para /static/uploads/x.
app.get('/public/uploads/:file', (req, res, next) => {
    if (!/^[\w.-]{1,200}$/.test(req.params.file) || req.params.file.startsWith('.')) return next();
    return res.redirect(301, `/static/uploads/${encodeURIComponent(req.params.file)}`);
});
app.use('/public', require('./routes/public'));

// F4: webhook da WhatsApp Cloud API (Meta). Corpo bruto para validar X-Hub-Signature-256.
app.use('/webhook/meta', require('./routes/whatsappWebhook'));

// CORS por allowlist (CORS_ORIGINS, separado por vírgula; URL_SITE como fallback).
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.URL_SITE || '')
    .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (!allowedOrigins.length && process.env.NODE_ENV !== 'production') return callback(null, true);
        return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'Selected-company'],
    // O front (outra origem) lê Retry-After dos 429 (login, convite, assistente).
    exposedHeaders: ['Retry-After'],
    maxAge: 600,
}));

// Limite de corpo: 1 MB em geral; cadastro de clientes aceita imagem base64 (até 6 MB).
const bodyLimit = process.env.BODY_LIMIT || '1mb';
app.use('/customers', express.json({ limit: process.env.UPLOAD_BODY_LIMIT || '6mb' }));
app.use(/^\/professionals\/\d+\/photo$/, express.json({ limit: '2mb' })); // foto do profissional (≤ 1 MB decodificada)
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ limit: bodyLimit, extended: true }));

// Health leve (sem banco) para o roteador; o profundo exige ADMIN_TOKEN.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
app.use("/internal", internalRoute);
app.use("/files", filesRoute);
app.use("/privacy", privacyRoute);
app.use("/billing", require('./routes/billing'));
app.use("/professionals", require('./routes/professionals'));
app.use("/availability-rules", require('./routes/availabilityRules'));
app.use("/time-blocks", require('./routes/timeBlocks'));
app.use("/public-page", require('./routes/publicPage'));
app.use("/whatsapp", require('./routes/whatsapp'));
app.use("/assistant", require('./routes/assistant'));
app.get('/health/deep', require('./middleware/requireToken')('ADMIN_TOKEN'), internalRoute.deepHealth);

// Arquivos estáticos em /static. O prefixo /public é da API pública (F3).
app.use('/static', express.static('static', { dotfiles: 'deny', index: false }));

app.use((req, res, next) => {
    const erro = new Error("Não encontrado");
    erro.status = 404;
    next(erro);
});

app.use(errorHandler);

module.exports = app;
