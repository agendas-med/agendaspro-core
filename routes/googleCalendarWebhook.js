const express = require('express');
const { hit } = require('../middleware/rateLimit');
const sync = require('../services/googleCalendar/sync');

// F6: notificações push do Google Agenda (events.watch). Sem corpo útil: tudo vem nos headers X-Goog-*.
// Autenticidade = channel id + token do canal (guardado como hash) + resourceId. Resposta sem detalhes.
const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { hits } = await hit(`gcal_webhook_ip:${req.ip}`, 60);
    if (hits > (Number(process.env.GOOGLE_CALENDAR_WEBHOOK_IP_MAX_PER_MIN) || 120)) return res.status(429).end();
    const status = await sync.handleNotification(req.headers);
    return res.status(status).end();
  } catch (error) {
    console.error('[gcal] webhook falhou:', String(error?.message || error).slice(0, 200));
    return res.status(500).end(); // o Google reentrega com backoff
  }
});

module.exports = router;
