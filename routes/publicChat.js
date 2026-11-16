const express = require('express');
const chat = require('../services/publicChatService');

// /public/chat/* (montado dentro de routes/public.js: herda CORS, cabeçalhos, limite de 32 KB
// e o tratamento de erros { error: { code, message } } + Retry-After).
// Autenticação por "Authorization: Bearer <session_token>" (sem cookie, sem credenciais CORS).
const router = express.Router();

const run = fn => async (req, res, next) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.status(out?.__status || 200).json(out?.__body ?? out);
  } catch (error) {
    next(error);
  }
};

const withSession = (fn, opts = {}) => run(async (req, res) => fn(await chat.authenticate(req.get('authorization'), opts), req, res));

const wantsStream = req => /\btext\/event-stream\b/i.test(req.get('accept') || '') || req.query.stream === '1';

// SSE: o pipeline inteiro roda antes (erros continuam sendo HTTP + JSON). Depois o texto é
// enviado em blocos "delta" e um "done" com o JSON completo. Sem estado em memória.
function stream(res, payload) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  const words = String(payload.reply || '').match(/\S+\s*/g) || [];
  for (let i = 0; i < words.length; i += 6) {
    res.write(`event: delta\ndata: ${JSON.stringify({ text: words.slice(i, i + 6).join('') })}\n\n`);
  }
  res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
  res.end();
}

router.post('/session', run(async req => ({ __status: 201, __body: await chat.createSession(req.body, { ip: req.ip }) })));

router.get('/session', withSession(session => chat.getSession(session)));

router.post('/session/close', withSession(session => chat.closeSession(session)));

router.post('/message', withSession(async (session, req, res) => {
  const payload = await chat.sendMessage(session, req.body, { ip: req.ip });
  if (wantsStream(req)) return stream(res, payload);
  return payload;
}));

router.post('/rating', withSession((session, req) => chat.rateSession(session, req.body)));

// Lead aceita sessão recém-expirada (PUBLIC_CHAT_LEAD_GRACE_MIN): o visitante que demorou a
// preencher o formulário não perde o contato. Só aqui; mensagens seguem exigindo sessão válida.
router.post('/lead', withSession(async (session, req) => ({ __status: 201, __body: await chat.captureLead(session, req.body, { ip: req.ip }) }), { lead: true }));

module.exports = router;
