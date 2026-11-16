process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql');
const { promisify } = require('node:util');

// F6: Google Agenda no MariaDB isolado. OAuth e Calendar API são um stub HTTP local (nunca o Google);
// segredos e tokens são falsos e gerados por execução.
const secret = () => crypto.randomBytes(32).toString('base64url');

test('F6: Google Agenda (OAuth+PKCE, push idempotente, bloqueios por syncToken, 410, webhook, eco, RBAC, plano, desconexão)', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 240000 }, async t => {
  const database = `agendaspro_f6gc_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
  const adminQuery = promisify(admin.query).bind(admin);
  let server, pool, stub;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);

    // ---------- stub Google ----------
    const g = {
      calls: [], challenges: new Set(), access: new Set(), refresh: new Set(), revoked: [], stopped: [], watches: [], deletedCalendars: [],
      calendars: new Map([['primary@example.test', { summary: 'Pessoal', accessRole: 'owner', primary: true }], ['feriados@example.test', { summary: 'Feriados', accessRole: 'reader' }]]),
      events: new Map(), seq: 0, expireSyncOnce: false, noRefreshToken: false, n: 0,
    };
    const eventsOf = cal => { if (!g.events.has(cal)) g.events.set(cal, new Map()); return g.events.get(cal); };
    const putEvent = (cal, ev) => eventsOf(cal).set(ev.id, { status: 'confirmed', ...ev, _seq: ++g.seq });
    const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    const apiError = (res, status, reason) => json(res, status, { error: { code: status, errors: [{ reason }], message: reason } });
    const idToken = email => `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
    stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://stub');
        const path = decodeURIComponent(url.pathname);
        g.calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams) });
        if (path === '/token') {
          const form = new URLSearchParams(raw);
          if (form.get('grant_type') === 'authorization_code') {
            const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
            if (form.get('code') !== 'codigo-bom' || !g.challenges.has(challenge) || !form.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant' });
            const access = `at-${++g.n}-${secret()}`; const refresh = `rt-${g.n}-${secret()}`;
            g.access.add(access); g.refresh.add(refresh);
            return json(res, 200, { access_token: access, expires_in: 3599, scope: 'openid email https://www.googleapis.com/auth/calendar.app.created', token_type: 'Bearer', id_token: idToken('agenda@example.test'), ...(g.noRefreshToken ? {} : { refresh_token: refresh }) });
          }
          if (form.get('grant_type') === 'refresh_token') {
            if (!g.refresh.has(form.get('refresh_token'))) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
            const access = `at-${++g.n}-${secret()}`;
            g.access.add(access);
            return json(res, 200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
          }
          return json(res, 400, { error: 'unsupported_grant_type' });
        }
        if (path === '/revoke') { const token = new URLSearchParams(raw).get('token'); g.revoked.push(token); g.refresh.delete(token); return json(res, 200, {}); }
        const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
        if (!g.access.has(auth)) return apiError(res, 401, 'authError');
        const body = raw ? JSON.parse(raw) : {};
        if (path === '/users/me/calendarList') {
          return json(res, 200, { items: [...g.calendars].map(([id, c]) => ({ id, summary: c.summary, accessRole: c.accessRole, primary: !!c.primary })) });
        }
        if (path === '/calendars' && req.method === 'POST') {
          const id = `app${++g.n}@group.example.test`;
          g.calendars.set(id, { summary: body.summary, accessRole: 'owner', timeZone: body.timeZone });
          return json(res, 200, { id, summary: body.summary });
        }
        if (path === '/channels/stop') { g.stopped.push(body); return res.writeHead(204).end(); }
        let m = path.match(/^\/calendars\/([^/]+)$/);
        if (m && req.method === 'DELETE') { g.deletedCalendars.push(m[1]); g.calendars.delete(m[1]); return res.writeHead(204).end(); }
        m = path.match(/^\/calendars\/([^/]+)\/events\/watch$/);
        if (m) {
          g.watches.push({ calendar: m[1], ...body });
          return json(res, 200, { kind: 'api#channel', id: body.id, resourceId: `res-${m[1]}`, expiration: String(Date.now() + 7 * 86400000) });
        }
        m = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
        if (m) {
          const [, cal, eventId] = m;
          if (!g.calendars.has(cal)) return apiError(res, 404, 'notFound');
          const store = eventsOf(cal);
          if (req.method === 'POST') {
            if (!/^[a-v0-9]{5,1024}$/.test(body.id)) return apiError(res, 400, 'invalid');
            if (store.has(body.id)) return apiError(res, 409, 'duplicate');
            putEvent(cal, body);
            return json(res, 200, body);
          }
          if (req.method === 'PUT') {
            if (!store.has(eventId)) return apiError(res, 404, 'notFound');
            putEvent(cal, { ...body, id: eventId });
            return json(res, 200, body);
          }
          if (req.method === 'DELETE') {
            const ev = store.get(eventId);
            if (!ev) return apiError(res, 404, 'notFound');
            if (ev.status === 'cancelled') return apiError(res, 410, 'deleted');
            putEvent(cal, { ...ev, status: 'cancelled' });
            return res.writeHead(204).end();
          }
          // GET list: syncToken é incompatível com timeMin (como na API real).
          const q = url.searchParams;
          if (q.get('syncToken') && q.get('timeMin')) return apiError(res, 400, 'invalid');
          if (q.get('syncToken') && g.expireSyncOnce) { g.expireSyncOnce = false; return apiError(res, 410, 'fullSyncRequired'); }
          const since = q.get('syncToken') ? Number(q.get('syncToken').split(':')[1]) : -1;
          const all = [...store.values()].filter(e => (since >= 0 ? e._seq > since : e.status !== 'cancelled')).sort((a, b) => a._seq - b._seq);
          const offset = Number(q.get('pageToken') || 0);
          const page = all.slice(offset, offset + 2).map(({ _seq, ...e }) => e); // páginas pequenas: exercita paginação
          const more = offset + 2 < all.length;
          return json(res, 200, { items: page, ...(more ? { nextPageToken: String(offset + 2) } : { nextSyncToken: `st:${g.seq}` }) });
        }
        return apiError(res, 404, 'notFound');
      });
    });
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;
    Object.assign(process.env, {
      MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_INPROCESS_CRON: 'false', ASAAS_API_KEY: '', JWT_SECRET: secret(),
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), OAUTH_STATE_SECRET: secret(),
      ADMIN_TOKEN: secret(), JOBS_TICK_TOKEN: secret(), ASAAS_WEBHOOK_TOKEN: secret(),
      ASAAS_MAIN_WALLET_ID: 'wallet-plataforma-teste', ASAAS_SUBSCRIPTIONS_ENABLED: 'false',
      PUBLIC_BOOKING_TOKEN_SECRET: secret(), TURNSTILE_ENABLED: 'false', TURNSTILE_DEV_BYPASS: 'true',
      GOOGLE_CALENDAR_CLIENT_ID: 'cliente-teste.apps.googleusercontent.com', GOOGLE_CALENDAR_CLIENT_SECRET: secret(),
      GOOGLE_CALENDAR_REDIRECT_URIS: 'https://app.example.test/integracoes/google,http://localhost:8080/integracoes/google',
      GOOGLE_OAUTH_URL: `${stubUrl}/auth`, GOOGLE_TOKEN_URL: `${stubUrl}/token`, GOOGLE_REVOKE_URL: `${stubUrl}/revoke`, GOOGLE_CALENDAR_API_URL: stubUrl,
      GOOGLE_CALENDAR_WEBHOOK_URL: 'https://api.example.test/webhook/google-calendar',
    });
    for (const key of ['JWT_KEY', 'APP_TIMEZONE', 'GOOGLE_CALENDAR_SCOPES', 'GOOGLE_CALENDAR_PUSH_MAX_OPS', 'URL_SITE']) delete process.env[key];

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const jobs = require('../services/jobsService');
    const sync = require('../services/googleCalendar/sync');
    const { decrypt } = require('../utils/crypto');
    const { wallClock } = require('../utils/time');
    const app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, path, { body, auth, company, headers = {} } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(company !== undefined ? { 'Selected-company': String(company) } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, raw: text };
    }
    const responses = [];
    const expect = async (expected, ...args) => {
      const result = await call(...args);
      responses.push(result.raw);
      assert.equal(result.status, expected, `${args[0]} ${args[1]}: ${result.raw.slice(0, 400)}`);
      return result.data;
    };
    const [business] = await sql('SELECT id FROM business_types LIMIT 1');
    async function tenant(label, document) {
      const email = `${label}-${process.pid}@agendaspro.test`;
      const password = `senha-${label}-${secret()}`;
      await expect(200, 'POST', '/users/register', { body: { name: `Dono ${label}`, email, password } });
      const login = (await expect(200, 'POST', '/users/login', { body: { email, password } })).returnObj;
      const companyId = (await expect(200, 'POST', '/companies/create_company', {
        auth: login.jwtToken,
        body: { name: `Empresa ${label}`, address: 'Rua de Testes', zip_code: '01310-100', city: 'São Paulo', state: 'SP', business_type: business.id, email: `empresa-${label}@example.test`, phone: '11999999999', document, address_number: '10', complement: '', birthDate: '1990-01-01', incomeValue: 5000 },
      })).returnObj.id;
      const ctx = { companyId, token: login.jwtToken };
      ctx.as = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: ctx.token, company: ctx.companyId });
      return ctx;
    }
    const premium = async companyId => {
      const [p] = await sql("SELECT id, price_cents FROM plans WHERE code = 'premium'");
      const sub = (await sql("INSERT INTO company_subscriptions (company_id, plan_id, price_cents, status) VALUES (?, ?, ?, 'active')", [companyId, p.id, p.price_cents])).insertId;
      await sql("INSERT INTO subscription_invoices (company_id, subscription_id, plan_id, provider_payment_id, amount_cents, status, due_date, period_start, period_end) VALUES (?, ?, ?, ?, ?, 'paid', CURDATE(), NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 29 DAY)", [companyId, sub, p.id, `pay_f6gc_${companyId}`, p.price_cents]);
    };
    const A = await tenant('a', '52998224725'); // Free
    const B = await tenant('b', '11144477735'); // Premium
    await premium(B.companyId);
    const memberEmail = `membro-${process.pid}@agendaspro.test`;
    const memberPassword = `senha-m-${secret()}`;
    const reg = await expect(200, 'POST', '/users/register', { body: { name: 'Membro B', email: memberEmail, password: memberPassword } });
    const memberToken = (await expect(200, 'POST', '/users/login', { body: { email: memberEmail, password: memberPassword } })).returnObj.jwtToken;
    await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [B.companyId, reg.returnObj.id]);
    const M = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: memberToken, company: B.companyId });
    const GC = '/integrations/google-calendar';

    async function connect(ctx) {
      const start = (await ctx.as('POST', `${GC}/connect/start`, {})).data;
      g.challenges.add(new URL(start.authorize_url).searchParams.get('code_challenge'));
      return (await ctx.as('POST', `${GC}/callback`, { code: 'codigo-bom', state: start.state })).data;
    }
    const account = async companyId => (await sql('SELECT * FROM google_calendar_accounts WHERE company_id = ?', [companyId]))[0];

    await t.test('Free x Premium, RBAC e allowlist de redirect_uri; URL com PKCE S256', async () => {
      assert.deepEqual((await A.as('GET', `${GC}/status`)).data, { configured: true, connected: false, account: null, links: [] });
      const upgrade = await A.as('POST', `${GC}/connect/start`, {}, 402);
      assert.deepEqual([upgrade.error.code, upgrade.error.feature], ['plan_upgrade_required', 'google_calendar']);
      assert.equal((await M('POST', `${GC}/connect/start`, {}, 403)).error.code, 'admin_required');
      assert.equal((await B.as('POST', `${GC}/connect/start`, { redirect_uri: 'https://evil.example.test/cb' }, 400)).error.code, 'redirect_uri_not_allowed');
      const ok = (await B.as('POST', `${GC}/connect/start`, { redirect_uri: 'http://localhost:8080/integracoes/google' })).data;
      const url = new URL(ok.authorize_url);
      assert.equal(url.origin + url.pathname, `${stubUrl}/auth`);
      assert.deepEqual(['code_challenge_method', 'access_type', 'prompt', 'response_type', 'state'].map(k => url.searchParams.get(k)), ['S256', 'offline', 'consent', 'code', ok.state]);
      assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
      assert.ok(!ok.authorize_url.includes('code_verifier'));
      const [row] = await sql('SELECT code_verifier_enc FROM oauth_states WHERE provider = ? AND company_id = ? ORDER BY created_at DESC LIMIT 1', ['google_calendar', B.companyId]);
      const verifier = decrypt(row.code_verifier_enc);
      assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), url.searchParams.get('code_challenge'));
    });

    await t.test('callback: state adulterado/reusado recusado, code ruim = 502; conecta com refresh token cifrado e calendário do app', async () => {
      const start = (await B.as('POST', `${GC}/connect/start`, {})).data;
      g.challenges.add(new URL(start.authorize_url).searchParams.get('code_challenge'));
      assert.equal((await B.as('POST', `${GC}/callback`, { code: 'codigo-bom', state: `${start.state}x` }, 400)).error.code, 'oauth_state_invalid');
      assert.equal((await B.as('POST', `${GC}/callback`, { code: 'codigo-ruim', state: start.state }, 502)).error.code, 'google_calendar_oauth_failed');
      assert.equal((await B.as('POST', `${GC}/callback`, { code: 'codigo-bom', state: start.state }, 400)).error.code, 'oauth_state_invalid', 'uso único');
      const st = await connect(B);
      assert.equal(st.connected, true);
      assert.equal(st.account.email, 'agenda@example.test');
      assert.equal(st.account.status, 'active');
      assert.equal(st.links.length, 1);
      assert.deepEqual([st.links[0].role, st.links[0].professional_id, st.links[0].created_by_app, st.links[0].calendar_summary], ['push', null, true, 'AgendasPRO']);
      const row = await account(B.companyId);
      assert.ok(g.refresh.has(decrypt(row.refresh_token_enc)));
      assert.ok(!row.refresh_token_enc.includes('rt-'));
      assert.equal((await M('GET', `${GC}/status`)).data.connected, true, 'membro lê o status');
      assert.equal((await M('GET', `${GC}/calendars`, undefined, 403)).error.code, 'admin_required');
    });

    // Agendamentos de B (amanhã 10:00 e depois de amanhã 15:00).
    const customer = (await sql("INSERT INTO customers (name, tel, company_id) VALUES ('Maria Souza', '11988887777', ?)", [B.companyId])).insertId;
    const corte = (await sql('INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity) VALUES (?, 30, 40, 0, ?, 0, 0)', ['Corte', B.companyId])).insertId;
    const appt = async (dayOffset, hhmm, duration = 30) => {
      const id = (await sql(`INSERT INTO appointments (company_id, customer_id, customer_name, date, duration) VALUES (?, ?, 'Maria Souza', DATE_FORMAT(NOW() + INTERVAL ? DAY, '%Y-%m-%d ${hhmm}:00'), ?)`, [B.companyId, customer, dayOffset, duration])).insertId;
      await sql('INSERT INTO appointment_services (service_id, appointment_id, quantity) VALUES (?, ?, 1)', [corte, id]);
      return id;
    };
    const ap1 = await appt(1, '10:00');
    const ap2 = await appt(2, '15:00', 60);
    const appCal = async () => (await sql("SELECT calendar_id FROM google_calendar_links WHERE company_id = ? AND role = 'push'", [B.companyId]))[0].calendar_id;
    const writes = () => g.calls.filter(c => ['POST', 'PUT', 'DELETE'].includes(c.method) && c.path.includes('/events')).length;

    await t.test('push: tick exporta eventos com id determinístico e dados mínimos; reconciliação é idempotente', async () => {
      await jobs.tick({ budgetMs: 8000 });
      const cal = await appCal();
      const store = eventsOf(cal);
      const { eventId } = require('../services/googleCalendar/mapping');
      const ev = store.get(eventId(B.companyId, ap1));
      assert.ok(ev, 'evento criado com o id determinístico');
      assert.equal(ev.summary, 'Maria · Corte');
      assert.ok(!JSON.stringify([...store.values()]).includes('11988887777') && !JSON.stringify([...store.values()]).includes('Souza'), 'sem telefone/sobrenome');
      assert.equal(ev.extendedProperties.private.agendaspro, '1');
      assert.match(ev.start.dateTime, /T10:00:00$/);
      assert.equal(store.size, 2);
      const before = writes();
      assert.equal((await sync.pushJob({ company_id: B.companyId })).unchanged, 2);
      assert.equal(writes(), before, 'nada mudou = nenhuma escrita');
      // Edição -> PUT; queda após criar no Google (mapeamento perdido) -> 409 -> PUT, sem duplicar.
      await sql('UPDATE appointments SET duration = 45 WHERE id = ?', [ap1]);
      await sql('DELETE FROM google_calendar_events WHERE appointment_id = ?', [ap2]);
      const stats = await sync.pushJob({ company_id: B.companyId });
      assert.deepEqual([stats.updated, stats.inserted, stats.errors], [1, 1, 0]);
      assert.equal(store.size, 2);
      assert.match(store.get(eventId(B.companyId, ap1)).end.dateTime, /T10:45:00$/);
      // Cancelamento -> evento removido no Google e mapeamento apagado.
      await sql('UPDATE appointments SET canceled = 1 WHERE id = ?', [ap2]);
      assert.equal((await sync.pushJob({ company_id: B.companyId })).deleted, 1);
      assert.equal(store.get(eventId(B.companyId, ap2)).status, 'cancelled');
      assert.equal((await sql('SELECT COUNT(*) AS n FROM google_calendar_events WHERE company_id = ?', [B.companyId]))[0].n, 1);
    });

    const day = offset => new Date(Date.now() + offset * 86400000);
    const at = (offset, hourUtc) => { const d = day(offset); d.setUTCHours(hourUtc, 0, 0, 0); return d; };
    const tz = 'America/Sao_Paulo';
    let busyLink;

    await t.test('vínculo busy: validações, anti-eco e isolamento', async () => {
      const cals = (await B.as('GET', `${GC}/calendars`)).data;
      assert.ok(cals.some(c => c.id === 'primary@example.test' && c.primary));
      await B.as('POST', `${GC}/links`, { role: 'busy', calendar_id: 'primary@example.test' }, 400); // sem profissional nem all_company
      assert.equal((await B.as('POST', `${GC}/links`, { role: 'busy', calendar_id: 'nao-existe@example.test', all_company: true }, 404)).error.code, 'calendar_not_found');
      assert.equal((await B.as('POST', `${GC}/links`, { role: 'busy', calendar_id: await appCal(), all_company: true }, 409)).error.code, 'calendar_link_conflict', 'destino não pode ser origem');
      assert.equal((await B.as('POST', `${GC}/links`, { role: 'push', calendar_id: 'feriados@example.test' }, 409)).error.code, 'calendar_link_conflict', 'já há destino padrão');
      assert.equal((await B.as('POST', `${GC}/links`, { role: 'busy', calendar_id: 'primary@example.test', professional_id: 999999 }, 404)).error.code, 'professional_not_found');
      busyLink = (await B.as('POST', `${GC}/links`, { role: 'busy', calendar_id: 'primary@example.test', all_company: true }, 201)).data;
      assert.deepEqual([busyLink.role, busyLink.professional_id], ['busy', null]);
      assert.equal((await A.as('DELETE', `${GC}/links/${busyLink.id}`, undefined, 404)).error.code, 'calendar_link_not_found', 'outra empresa não enxerga');
      assert.deepEqual((await A.as('GET', `${GC}/links`)).data, []);
    });

    await t.test('pull: completo (paginado) importa só ocupados; incremental por syncToken; 410 refaz; canal criado', async () => {
      const cal = 'primary@example.test';
      putEvent(cal, { id: 'ocupado1', start: { dateTime: at(2, 13).toISOString() }, end: { dateTime: at(2, 14).toISOString() }, summary: 'Consulta particular' });
      putEvent(cal, { id: 'livre1', transparency: 'transparent', start: { dateTime: at(2, 15).toISOString() }, end: { dateTime: at(2, 16).toISOString() } });
      putEvent(cal, { id: 'recusado1', attendees: [{ self: true, responseStatus: 'declined' }], start: { dateTime: at(2, 17).toISOString() }, end: { dateTime: at(2, 18).toISOString() } });
      putEvent(cal, { id: 'eco1', extendedProperties: { private: { agendaspro: '1' } }, start: { dateTime: at(2, 19).toISOString() }, end: { dateTime: at(2, 20).toISOString() } });
      const dayDate = wallClock(day(3), tz).slice(0, 10);
      const nextDate = wallClock(day(4), tz).slice(0, 10);
      putEvent(cal, { id: 'diainteiro1', start: { date: dayDate }, end: { date: nextDate } });
      putEvent(cal, { id: 'zero1', start: { dateTime: at(2, 21).toISOString() }, end: { dateTime: at(2, 21).toISOString() } });

      const full = await sync.pullJob({ link_id: busyLink.id });
      assert.deepEqual([full.full, full.upserted], [true, 2]);
      const blocks = () => sql("SELECT external_ref, professional_id, DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i') AS s, DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i') AS e, reason FROM time_blocks WHERE company_id = ? AND source = 'google' ORDER BY starts_at", [B.companyId]);
      let rows = await blocks();
      assert.deepEqual(rows.map(r => r.external_ref), [`${busyLink.id}:ocupado1`, `${busyLink.id}:diainteiro1`]);
      assert.equal(rows[0].s, wallClock(at(2, 13), tz).slice(0, 16), 'convertido para a hora de parede da empresa');
      assert.deepEqual([rows[1].s, rows[1].e], [`${dayDate} 00:00`, `${nextDate} 00:00`]);
      assert.ok(rows.every(r => r.reason === 'Ocupado (Google Agenda)' && r.professional_id === null), 'título do evento não é importado');
      const listCalls = g.calls.filter(c => c.method === 'GET' && c.path === `/calendars/${cal}/events`);
      assert.ok(listCalls.length >= 3, 'paginou');
      assert.ok(listCalls.every(c => c.query.timeMin && !c.query.syncToken));
      assert.equal(g.watches.length, 1);
      assert.equal(g.watches[0].address, 'https://api.example.test/webhook/google-calendar');

      // Incremental: move o ocupado, cancela o dia inteiro, transforma o livre em ocupado.
      putEvent(cal, { ...eventsOf(cal).get('ocupado1'), start: { dateTime: at(2, 12).toISOString() }, end: { dateTime: at(2, 13).toISOString() } });
      putEvent(cal, { ...eventsOf(cal).get('diainteiro1'), status: 'cancelled' });
      putEvent(cal, { ...eventsOf(cal).get('livre1'), transparency: 'opaque' });
      const inc = await sync.pullJob({ link_id: busyLink.id });
      assert.deepEqual([inc.full, inc.upserted, inc.removed], [false, 2, 1]);
      const incCalls = g.calls.filter(c => c.method === 'GET' && c.path === `/calendars/${cal}/events` && c.query.syncToken);
      assert.ok(incCalls.length >= 1 && incCalls.every(c => !c.query.timeMin), 'syncToken sem timeMin');
      rows = await blocks();
      assert.deepEqual(rows.map(r => r.external_ref).sort(), [`${busyLink.id}:livre1`, `${busyLink.id}:ocupado1`]);
      assert.equal(rows.find(r => r.external_ref.endsWith('ocupado1')).s, wallClock(at(2, 12), tz).slice(0, 16));

      // 410: token expirado -> limpa e refaz completo.
      eventsOf(cal).delete('livre1'); // sumiu sem tombstone: só o completo percebe
      g.expireSyncOnce = true;
      const reset = await sync.pullJob({ link_id: busyLink.id });
      assert.deepEqual([reset.reset, reset.full], [true, true]);
      rows = await blocks();
      assert.deepEqual(rows.map(r => r.external_ref), [`${busyLink.id}:ocupado1`]);
      assert.ok((await sql('SELECT sync_token FROM google_calendar_links WHERE id = ?', [busyLink.id]))[0].sync_token);

      // Bloqueio sincronizado não é apagado à mão; aparece com source na listagem.
      const listed = (await B.as('GET', '/time-blocks')).data;
      const gblock = listed.find(b => b.source === 'google');
      assert.ok(gblock);
      await B.as('DELETE', `/time-blocks/${gblock.id}`, undefined, 409);
      // Anti-eco: eventos do calendário do app nunca viram bloqueio.
      assert.equal((await sql("SELECT COUNT(*) AS n FROM time_blocks WHERE company_id = ? AND source = 'google' AND link_id <> ?", [B.companyId, busyLink.id]))[0].n, 0);
    });

    await t.test('webhook: valida canal/token/resourceId, ignora "sync", dedupe por mensagem e enfileira pull', async () => {
      const ch = g.watches[0];
      const hook = (headers, expected) => expect(expected, 'POST', '/webhook/google-calendar', { headers });
      const h = (extra = {}) => ({ 'X-Goog-Channel-ID': ch.id, 'X-Goog-Channel-Token': ch.token, 'X-Goog-Resource-ID': `res-${ch.calendar}`, 'X-Goog-Resource-State': 'exists', 'X-Goog-Message-Number': '5', ...extra });
      await hook(h({ 'X-Goog-Channel-Token': 'errado' }), 403);
      await hook(h({ 'X-Goog-Resource-ID': 'outro' }), 403);
      await hook(h({ 'X-Goog-Channel-ID': 'desconhecido' }), 404);
      await hook({}, 400);
      const pulls = async () => (await sql("SELECT COUNT(*) AS n FROM jobs WHERE type = 'gcal_pull' AND status = 'pending'"))[0].n;
      await sql("DELETE FROM jobs WHERE type = 'gcal_pull'");
      await hook(h({ 'X-Goog-Resource-State': 'sync', 'X-Goog-Message-Number': '1' }), 204);
      assert.equal(await pulls(), 0, 'sync só confirma o canal');
      await hook(h(), 204);
      assert.equal(await pulls(), 1);
      await sql("DELETE FROM jobs WHERE type = 'gcal_pull'");
      await hook(h(), 204);
      assert.equal(await pulls(), 0, 'reentrega da mesma mensagem não enfileira');
      assert.equal((await sql("SELECT COUNT(*) AS n FROM inbound_events WHERE provider = 'google_calendar'"))[0].n, 1);
      const [link] = await sql('SELECT channel_token_hash FROM google_calendar_links WHERE id = ?', [busyLink.id]);
      assert.notEqual(link.channel_token_hash, ch.token, 'token do canal guardado só como hash');
    });

    await t.test('renovação: access token vencido é renovado; refresh revogado -> reauth_required (sem retry)', async () => {
      await sql('UPDATE google_calendar_accounts SET access_expires_at = NOW() - INTERVAL 1 MINUTE WHERE company_id = ?', [B.companyId]);
      const refreshes = () => g.calls.filter(c => c.path === '/token').length;
      const before = refreshes();
      assert.ok((await B.as('GET', `${GC}/calendars`)).data.length >= 2);
      assert.equal(refreshes(), before + 1);
      assert.equal((await B.as('GET', `${GC}/calendars`)).data.length >= 2, true);
      assert.equal(refreshes(), before + 1, 'access token reaproveitado enquanto válido');
      g.refresh.clear();
      await sql('UPDATE google_calendar_accounts SET access_expires_at = NOW() - INTERVAL 1 MINUTE WHERE company_id = ?', [B.companyId]);
      assert.equal((await sync.pushJob({ company_id: B.companyId })).skipped, 'reauth');
      assert.equal((await account(B.companyId)).status, 'reauth_required');
      assert.equal((await B.as('GET', `${GC}/calendars`, undefined, 409)).error.code, 'google_calendar_reauth_required');
      assert.equal((await B.as('GET', `${GC}/status`)).data.account.status, 'reauth_required');
      // Reconecta (mesma conta): volta a ativo, vínculos preservados.
      const st = await connect(B);
      assert.equal(st.account.status, 'active');
      assert.equal(st.links.length, 2);
    });

    await t.test('desconectar (LGPD): para canal, apaga calendário do app (opcional), revoga e apaga tudo local', async () => {
      await sql("INSERT INTO time_blocks (company_id, starts_at, ends_at, reason) VALUES (?, NOW() + INTERVAL 5 DAY, NOW() + INTERVAL 5 DAY + INTERVAL 1 HOUR, 'manual')", [B.companyId]);
      const cal = await appCal();
      const rt = decrypt((await account(B.companyId)).refresh_token_enc);
      assert.equal((await M('POST', `${GC}/disconnect`, {}, 403)).error.code, 'admin_required');
      const out = (await B.as('POST', `${GC}/disconnect`, { remove_app_calendars: true })).data;
      assert.deepEqual(out, { disconnected: true, revoked: true, removed_calendars: 1 });
      assert.ok(g.revoked.includes(rt));
      assert.deepEqual(g.deletedCalendars, [cal]);
      assert.ok(g.stopped.some(s => s.id === g.watches[0].id));
      for (const table of ['google_calendar_accounts', 'google_calendar_links', 'google_calendar_events']) {
        assert.equal((await sql(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = ?`, [B.companyId]))[0].n, 0, table);
      }
      assert.equal((await sql("SELECT COUNT(*) AS n FROM time_blocks WHERE company_id = ? AND source = 'google'", [B.companyId]))[0].n, 0);
      assert.equal((await sql("SELECT COUNT(*) AS n FROM time_blocks WHERE company_id = ? AND source = 'manual'", [B.companyId]))[0].n, 1, 'bloqueio manual fica');
      assert.equal((await sql("SELECT COUNT(*) AS n FROM oauth_states WHERE company_id = ? AND provider = 'google_calendar'", [B.companyId]))[0].n, 0);
      assert.deepEqual((await B.as('POST', `${GC}/disconnect`, {})).data, { disconnected: false, revoked: false, removed_calendars: 0 });
      // Free também consegue desconectar (sem integração = no-op).
      assert.equal((await A.as('POST', `${GC}/disconnect`, {})).data.disconnected, false);
    });

    await t.test('nenhum token/segredo nas respostas', async () => {
      const all = responses.join('\n');
      for (const token of [...g.access, ...g.revoked]) assert.ok(!all.includes(token), 'token vazou numa resposta');
      assert.ok(!all.includes(process.env.GOOGLE_CALENDAR_CLIENT_SECRET));
      assert.ok(!/refresh_token|access_token|code_verifier/.test(all));
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (stub) await new Promise(resolve => stub.close(resolve));
    if (pool) await new Promise(resolve => pool.end(() => resolve()));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
