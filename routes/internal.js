const express = require('express');
const router = express.Router();
const requireToken = require('../middleware/requireToken');
const functions = require('../utils/functions');
const { sendError } = require('../middleware/errorHandler');
const jobsService = require('../services/jobsService');

// Gatilho externo HORÁRIO (cron-job.org / GitHub Actions). Processa em lote com orçamento
// de ~20 s; o que sobrar continua no próximo tick.
router.post('/jobs/tick', requireToken('JOBS_TICK_TOKEN'), async (req, res) => {
    try {
        const budgetMs = Math.min(Number(process.env.JOBS_TICK_BUDGET_MS) || 20000, 25000);
        const stats = await jobsService.tick({ budgetMs });
        return res.status(200).send({ ok: true, ...stats });
    } catch (error) {
        return sendError(req, res, error);
    }
});

async function deepHealth(req, res) {
    const result = { status: 'ok', database: 'ok', jobs: null };
    try {
        await functions.executeSql('SELECT 1');
        const [jobs] = await functions.executeSql(
            `SELECT SUM(status = 'pending' AND due_at <= NOW()) AS due, SUM(status = 'failed') AS failed, SUM(status = 'running') AS running FROM jobs`
        );
        result.jobs = { due: Number(jobs.due) || 0, failed: Number(jobs.failed) || 0, running: Number(jobs.running) || 0 };
        return res.json(result);
    } catch (error) {
        return res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
}

router.get('/health/deep', requireToken('ADMIN_TOKEN'), deepHealth);

// F4: atualiza o status de aprovação dos modelos WhatsApp a partir da Meta.
router.post('/whatsapp/templates/sync', requireToken('ADMIN_TOKEN'), async (req, res) => {
    try {
        return res.status(200).send({ ok: true, ...(await require('../services/whatsapp/inbox').syncTemplates()) });
    } catch (error) {
        if (error?.providerCode) return res.status(502).send({ ok: false, code: error.providerCode });
        return sendError(req, res, error);
    }
});

module.exports = router;
module.exports.deepHealth = deepHealth;
