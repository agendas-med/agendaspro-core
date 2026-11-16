const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { isShuttingDown } = require('../utils/shutdown');

// /health       : liveness leve, sem banco (roteador do Heroku, monitores, aquecimento do tick).
// /health/ready : readiness — banco responde e a última migration do código está aplicada.
//                 Corpo sem detalhes; 503 durante o desligamento. Resultado em cache curto
//                 (otimização descartável) para não martelar o banco.
const router = express.Router();
const READY_CACHE_MS = 5000;
let cache = { at: 0, ok: false };

function latestMigration() {
  try {
    const dir = path.join(__dirname, '../sql/migrations');
    const files = fs.readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
    return files.length ? files[files.length - 1].replace(/\.sql$/, '') : null;
  } catch {
    return null;
  }
}
const LATEST = latestMigration();

async function checkReady() {
  const functions = require('../utils/functions');
  await functions.executeSql('SELECT 1');
  if (!LATEST) return true;
  const rows = await functions.executeSql('SELECT 1 FROM schema_migrations WHERE version = ?', [LATEST]);
  return rows.length > 0;
}

router.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ status: 'ok' });
});

router.get('/ready', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (isShuttingDown()) return res.status(503).json({ status: 'unavailable' });
  const now = Date.now();
  if (now - cache.at > READY_CACHE_MS) {
    let ok = false;
    try { ok = await checkReady(); } catch { ok = false; }
    cache = { at: now, ok };
  }
  return cache.ok ? res.json({ status: 'ready' }) : res.status(503).json({ status: 'unavailable' });
});

function resetCacheForTests() {
  cache = { at: 0, ok: false };
}

module.exports = router;
module.exports.resetCacheForTests = resetCacheForTests;
module.exports.LATEST_MIGRATION = LATEST;
