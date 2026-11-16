process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const mysql = require('mysql');
const { promisify } = require('node:util');

// F6: Instagram no MariaDB isolado. A API do Instagram é um stub HTTP local (nunca a real);
// segredos e tokens são falsos e gerados por execução.
const secret = () => crypto.randomBytes(32).toString('base64url');

test('F6: Instagram (OAuth, cache, Free x Premium, insights, jobs, UTM/atribuição, callbacks Meta, isolamento)', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 240000 }, async t => {
  const database = `agendaspro_f6ig_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
  const adminQuery = promisify(admin.query).bind(admin);
  let server, pool, stub;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    const ig = { mode: 'ok', calls: [], valid: new Set(), seq: 0 };
    const MEDIA = Array.from({ length: 10 }, (_, i) => ({
      id: `1790000000000${String(i).padStart(2, '0')}`, caption: `Post ${i}`, media_type: i === 3 ? 'VIDEO' : 'IMAGE', media_product_type: i === 3 ? 'REELS' : 'FEED',
      permalink: `https://www.instagram.com/p/teste${i}/`, media_url: `https://cdn.example.test/${i}.jpg`, timestamp: new Date(Date.now() - i * 86400000).toISOString(),
      like_count: 10 + i, comments_count: i,
    }));
    const json = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://stub');
        const token = url.searchParams.get('access_token');
        ig.calls.push({ method: req.method, path: url.pathname, metric: url.searchParams.get('metric') });
        if (url.pathname === '/oauth/access_token') {
          const form = new URLSearchParams(body);
          if (form.get('code') !== 'codigo-bom' || form.get('grant_type') !== 'authorization_code' || !form.get('redirect_uri')) return json(res, 400, { error_type: 'OAuthException', code: 400, error_message: 'bad code' });
          return json(res, 200, { data: [{ access_token: `curto-${++ig.seq}`, user_id: '9001', permissions: 'instagram_business_basic,instagram_business_manage_insights' }] });
        }
        if (url.pathname === '/access_token') {
          const long = `longo-${++ig.seq}-${secret()}`;
          ig.valid.add(long);
          return json(res, 200, { access_token: long, token_type: 'bearer', expires_in: 5184000 });
        }
        if (url.pathname === '/refresh_access_token') {
          if (!ig.valid.has(token)) return json(res, 400, { error: { code: 190, type: 'OAuthException', message: 'invalid' } });
          const long = `renovado-${++ig.seq}-${secret()}`;
          ig.valid.add(long);
          ig.lastRefreshed = long;
          return json(res, 200, { access_token: long, token_type: 'bearer', expires_in: 5184000 });
        }
        if (!url.pathname.startsWith('/v27.0/')) return json(res, 404, { error: { code: 803 } });
        if (ig.mode === 'expired' || !ig.valid.has(token)) return json(res, 400, { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } });
        if (ig.mode === 'rate') return json(res, 400, { error: { code: 4, message: 'Application request limit reached' } });
        if (url.pathname === '/v27.0/me') {
          return json(res, 200, { user_id: '17841400000000001', username: 'studio.teste', name: 'Studio Teste', account_type: 'BUSINESS', profile_picture_url: 'https://cdn.example.test/p.jpg', followers_count: 1000, follows_count: 50, media_count: MEDIA.length });
        }
        if (url.pathname === '/v27.0/me/media') {
          const limit = Number(url.searchParams.get('limit')) || 25;
          const start = Number(url.searchParams.get('after') || 0);
          const items = MEDIA.slice(start, start + limit);
          const next = start + limit < MEDIA.length;
          return json(res, 200, { data: items, paging: { cursors: { after: String(start + limit) }, ...(next ? { next: 'https://stub/next' } : {}) } });
        }
        if (url.pathname === '/v27.0/me/insights') {
          const metrics = url.searchParams.get('metric').split(',');
          return json(res, 200, { data: metrics.map((name, i) => ({ name, period: 'day', total_value: { value: 100 * (i + 1) } })) });
        }
        if (/^\/v27\.0\/\d+\/insights$/.test(url.pathname)) {
          const metrics = url.searchParams.get('metric').split(',');
          // Força o caminho "uma a uma": REELS recusa a chamada conjunta.
          if (url.pathname.includes('179000000000003') && metrics.length > 1) return json(res, 400, { error: { code: 100, message: 'metric not supported' } });
          const values = { reach: 200, views: 300, saved: 5, shares: 3, likes: 20, comments: 2, total_interactions: 30 };
          return json(res, 200, { data: metrics.map(name => ({ name, period: 'lifetime', values: [{ value: values[name] }] })) });
        }
        return json(res, 404, { error: { code: 803 } });
      });
    });
    await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;
    const APP_SECRET = secret();
    Object.assign(process.env, {
      MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_INPROCESS_CRON: 'false', ASAAS_API_KEY: '', JWT_SECRET: secret(),
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), OAUTH_STATE_SECRET: secret(),
      ADMIN_TOKEN: secret(), JOBS_TICK_TOKEN: secret(), ASAAS_WEBHOOK_TOKEN: secret(),
      ASAAS_MAIN_WALLET_ID: 'wallet-plataforma-teste', ASAAS_SUBSCRIPTIONS_ENABLED: 'false',
      PUBLIC_BOOKING_TOKEN_SECRET: secret(), TURNSTILE_ENABLED: 'false', TURNSTILE_DEV_BYPASS: 'true', PUBLIC_SITE_URL: 'https://site.example.test',
      PUBLIC_API_URL: 'https://api.example.test',
      INSTAGRAM_APP_ID: '1234567890', INSTAGRAM_APP_SECRET: APP_SECRET,
      INSTAGRAM_REDIRECT_URIS: 'https://app.example.test/integracoes/instagram,http://localhost:8080/integracoes/instagram',
      INSTAGRAM_OAUTH_URL: `${stubUrl}/oauth/authorize`, INSTAGRAM_API_URL: stubUrl, INSTAGRAM_GRAPH_URL: stubUrl, INSTAGRAM_GRAPH_VERSION: 'v27.0',
    });
    for (const key of ['JWT_KEY', 'APP_TIMEZONE', 'INSTAGRAM_CACHE_TTL_MIN', 'INSTAGRAM_MAX_POSTS', 'INSTAGRAM_REFRESH_MAX_PER_HOUR']) delete process.env[key];

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
    const jobs = require('../services/jobsService');
    const { decrypt } = require('../utils/crypto');
    const app = require('../app');
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    async function call(method, path, { body, raw, auth, company, headers = {} } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(company !== undefined ? { 'Selected-company': String(company) } : {}), ...headers },
        body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
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
      await sql("INSERT INTO subscription_invoices (company_id, subscription_id, plan_id, provider_payment_id, amount_cents, status, due_date, period_start, period_end) VALUES (?, ?, ?, ?, ?, 'paid', CURDATE(), NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 29 DAY)", [companyId, sub, p.id, `pay_f6_${companyId}`, p.price_cents]);
    };
    const A = await tenant('a', '52998224725'); // Free
    const B = await tenant('b', '11144477735'); // Premium
    await premium(B.companyId);

    // Membro (não admin) da empresa A.
    const memberEmail = `membro-${process.pid}@agendaspro.test`;
    const memberPassword = `senha-m-${secret()}`;
    const reg = await expect(200, 'POST', '/users/register', { body: { name: 'Membro A', email: memberEmail, password: memberPassword } });
    const memberToken = (await expect(200, 'POST', '/users/login', { body: { email: memberEmail, password: memberPassword } })).returnObj.jwtToken;
    await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [A.companyId, reg.returnObj.id]);
    const M = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: memberToken, company: A.companyId });

    async function connect(ctx) {
      const start = (await ctx.as('POST', '/integrations/instagram/connect/start', {})).data;
      const done = (await ctx.as('POST', '/integrations/instagram/callback', { code: 'codigo-bom#_', state: start.state })).data;
      return { start, done };
    }

    await t.test('status, connect/start (admin), allowlist de redirect_uri', async () => {
      const st = (await A.as('GET', '/integrations/instagram/status')).data;
      assert.deepEqual([st.configured, st.connected, st.account], [true, false, null]);
      const denied = await M('POST', '/integrations/instagram/connect/start', {}, 403);
      assert.equal(denied.error.code, 'admin_required');
      const bad = await A.as('POST', '/integrations/instagram/connect/start', { redirect_uri: 'https://evil.example.test/cb' }, 400);
      assert.equal(bad.error.code, 'redirect_uri_not_allowed');
      const ok = (await A.as('POST', '/integrations/instagram/connect/start', { redirect_uri: 'http://localhost:8080/integracoes/instagram' })).data;
      const url = new URL(ok.authorize_url);
      assert.equal(url.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_insights');
      assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:8080/integracoes/instagram');
      assert.equal(url.searchParams.get('state'), ok.state);
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(ok.expires_in, 600);
    });

    await t.test('callback: state de outra empresa recusado; conecta com token cifrado; state de uso único', async () => {
      const startA = (await A.as('POST', '/integrations/instagram/connect/start', {})).data;
      const cross = await B.as('POST', '/integrations/instagram/callback', { code: 'codigo-bom', state: startA.state }, 400);
      assert.equal(cross.error.code, 'oauth_state_invalid');
      const badCode = await A.as('POST', '/integrations/instagram/callback', { code: 'codigo-ruim', state: startA.state }, 502);
      assert.equal(badCode.error.code, 'instagram_oauth_failed');
      // state já consumido (mesmo com falha na troca): precisa iniciar de novo.
      const reused = await A.as('POST', '/integrations/instagram/callback', { code: 'codigo-bom', state: startA.state }, 400);
      assert.equal(reused.error.code, 'oauth_state_invalid');
      const { done } = await connect(A);
      assert.equal(done.connected, true);
      assert.equal(done.account.username, 'studio.teste');
      assert.equal(done.account.status, 'active');
      const [row] = await sql('SELECT access_token_enc FROM instagram_accounts WHERE company_id = ?', [A.companyId]);
      assert.ok(row.access_token_enc.startsWith('enc:v1:'));
      assert.ok(ig.valid.has(decrypt(row.access_token_enc)));
      for (const raw of responses) assert.ok(!/longo-|curto-/.test(raw), 'token nunca sai em resposta');
    });

    await t.test('Free: perfil + até 6 posts em cache; insights/conversão/UTM por post exigem Premium', async () => {
      const before = ig.calls.length;
      const overview = (await M('GET', '/integrations/instagram/overview')).data;
      assert.equal(overview.account.followers_count, 1000);
      assert.equal(overview.premium, false);
      assert.equal(overview.stale, false);
      const posts = (await M('GET', '/integrations/instagram/posts?limit=50')).data;
      assert.equal(posts.items.length, 6);
      assert.equal(posts.limit_total, 6);
      assert.equal(posts.items[0].engagement_basis, 'followers');
      assert.equal(posts.items[0].engagement_rate, 0.01); // (10 likes + 0 comentários) / 1000 seguidores
      const callsAfterFirst = ig.calls.length;
      assert.ok(callsAfterFirst > before);
      await M('GET', '/integrations/instagram/posts');
      assert.equal(ig.calls.length, callsAfterFirst, 'segunda leitura vem do cache');
      for (const path of ['/integrations/instagram/insights', '/integrations/instagram/conversion']) {
        const blocked = await M('GET', path, undefined, 402);
        assert.equal(blocked.error.code, 'plan_upgrade_required');
        assert.equal(blocked.error.feature, 'instagram');
      }
      const postLink = await M('POST', '/integrations/instagram/utm-link', { placement: 'post', campaign: 'promo', content: 'post1' }, 402);
      assert.equal(postLink.error.code, 'plan_upgrade_required');
    });

    const slugA = `empresa-a-${process.pid}`;
    const slugB = `empresa-b-${process.pid}`;
    await A.as('PUT', '/public-page', { slug: slugA, public_page_enabled: true });
    await B.as('PUT', '/public-page', { slug: slugB, public_page_enabled: true });

    await t.test('UTM bio liberado no Free; link aponta para a página pública', async () => {
      const link = (await M('POST', '/integrations/instagram/utm-link', { placement: 'bio', label: 'Bio' }, 201)).data;
      assert.equal(link.url, `https://site.example.test/b/${slugA}?utm_source=instagram&utm_medium=bio&utm_campaign=perfil`);
      const again = (await M('POST', '/integrations/instagram/utm-link', { placement: 'bio' }, 201)).data;
      assert.equal(again.id, link.id, 'idempotente');
      const list = (await M('GET', '/integrations/instagram/utm-links')).data;
      assert.equal(list.length, 1);
    });

    await t.test('Premium: paginação, insights por post (fallback por métrica), conta, comparativo', async () => {
      await connect(B);
      const page1 = (await B.as('GET', '/integrations/instagram/posts?limit=4')).data;
      assert.equal(page1.items.length, 4);
      assert.equal(page1.limit_total, 50);
      const page2 = (await B.as('GET', `/integrations/instagram/posts?limit=4&before=${page1.next_before}`)).data;
      assert.equal(page2.items[0].media_id, '179000000000004');
      const page3 = (await B.as('GET', `/integrations/instagram/posts?limit=4&before=${page2.next_before}`)).data;
      assert.equal(page3.items.length, 2);
      assert.equal(page3.next_before, null);
      const insights = (await B.as('GET', '/integrations/instagram/insights')).data;
      assert.equal(insights.posts.length, 10);
      assert.equal(insights.posts[0].insights.reach, 200);
      assert.equal(insights.posts[0].engagement_basis, 'reach');
      assert.equal(insights.posts[0].engagement_rate, 0.15); // 30 interações / 200 de alcance
      const reels = insights.posts.find(post => post.media_id === '179000000000003');
      assert.equal(reels.insights.total_interactions, 30, 'REELS veio pelo caminho métrica a métrica');
      assert.ok(ig.calls.some(call => call.path.endsWith('179000000000003/insights') && call.metric === 'reach'));
      assert.equal(insights.account_insights.reach, 100);
      assert.equal(insights.account_insights.profile_links_taps, 500);
      assert.equal(insights.engagement.engagement_basis, 'reach');
      assert.ok(Array.isArray(insights.comparison.by_type) && insights.comparison.top.length === 3);
      assert.ok(!ig.calls.some(call => call.metric && call.metric.includes('impressions')), 'impressions descontinuada não é pedida');
    });

    await t.test('limite de uso da Meta: serve cache com stale=true e pausa chamadas', async () => {
      ig.mode = 'rate';
      const out = (await B.as('GET', '/integrations/instagram/posts?refresh=true')).data;
      assert.equal(out.stale, true);
      assert.equal(out.items.length, 10);
      const [row] = await sql('SELECT rate_limited_until > NOW() AS paused FROM instagram_accounts WHERE company_id = ?', [B.companyId]);
      assert.equal(Number(row.paused), 1);
      const calls = ig.calls.length;
      const again = (await B.as('GET', '/integrations/instagram/overview?refresh=true')).data;
      assert.equal(again.stale, true);
      assert.equal(ig.calls.length, calls, 'pausado: nenhuma chamada à Meta');
      ig.mode = 'ok';
      await sql('UPDATE instagram_accounts SET rate_limited_until = NULL WHERE company_id = ?', [B.companyId]);
    });

    await t.test('jobs: renovação do token antes de expirar e snapshot diário Premium', async () => {
      await sql('UPDATE instagram_accounts SET token_expires_at = NOW() + INTERVAL 3 DAY, token_refreshed_at = NOW() - INTERVAL 2 DAY');
      await jobs.tick({ budgetMs: 8000 });
      const rows = await sql('SELECT company_id, access_token_enc, token_expires_at > NOW() + INTERVAL 50 DAY AS renewed FROM instagram_accounts ORDER BY company_id');
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(Number(row.renewed), 1);
        assert.ok(decrypt(row.access_token_enc).startsWith('renovado-'));
      }
      const snaps = await sql('SELECT company_id, followers_count, profile_links_taps FROM instagram_snapshots');
      assert.deepEqual(snaps.map(s => s.company_id), [B.companyId], 'snapshot só para Premium');
      assert.equal(snaps[0].followers_count, 1000);
      const payloads = await sql("SELECT payload FROM jobs WHERE type LIKE 'instagram_%'");
      for (const job of payloads) assert.ok(!/renovado-|longo-/.test(String(job.payload)), 'payload de job sem token');
      const history = (await B.as('GET', '/integrations/instagram/insights')).data.history;
      assert.equal(history.length, 1);
    });

    await t.test('visitas UTM + atribuição do agendamento + funil de conversão', async () => {
      const corte = (await sql('INSERT INTO services (name, duration, value, cost, company_id, requires_location, accepts_quantity, online_booking) VALUES (?, 30, 40, 0, ?, 0, 0, 1)', ['Corte', B.companyId])).insertId;
      const pro = (await B.as('POST', '/professionals', { name: 'Ana', service_ids: [corte] }, 201)).data;
      for (let weekday = 0; weekday < 7; weekday++) {
        await sql("INSERT INTO availability_rules (company_id, professional_id, weekday, start_time, end_time) VALUES (?, ?, ?, '08:00', '18:00')", [B.companyId, pro.id, weekday]);
      }
      const [{ D }] = await sql("SELECT DATE_FORMAT(NOW() + INTERVAL 2 DAY, '%Y-%m-%d') AS D");
      const utm = { utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'perfil' };
      for (let i = 0; i < 3; i++) await expect(202, 'POST', `/public/b/${slugB}/visits`, { body: utm });
      await expect(202, 'POST', `/public/b/${slugB}/visits`, { body: { utm_source: 'google' } });
      await expect(400, 'POST', `/public/b/${slugB}/visits`, { body: { utm_source: 'instagram', ip: '1.2.3.4' } });
      await expect(404, 'POST', `/public/b/nao-existe-${process.pid}/visits`, { body: utm });
      const booking = {
        service_ids: [corte], professional_id: pro.id, start: `${D}T10:00`, customer: { name: 'Cliente Teste', phone: '11988887777' },
        consent: true, source: 'link', idempotency_key: `idem-${secret().slice(0, 20)}`, attribution: utm,
      };
      await expect(400, 'POST', `/public/b/${slugB}/bookings`, { body: { ...booking, attribution: { ...utm, email: 'x@y.z' } } });
      const created = await expect(201, 'POST', `/public/b/${slugB}/bookings`, { body: booking });
      // Reenvio sem atribuição = mesmo pedido (request_hash não inclui UTM).
      const { attribution, ...withoutUtm } = booking;
      const replay = await expect(200, 'POST', `/public/b/${slugB}/bookings`, { body: withoutUtm });
      assert.equal(replay.public_id || replay.data?.public_id, created.public_id || created.data?.public_id);
      const [attr] = await sql('SELECT utm_source, utm_campaign FROM booking_attributions WHERE company_id = ?', [B.companyId]);
      assert.deepEqual({ ...attr }, { utm_source: 'instagram', utm_campaign: 'perfil' });
      const conv = (await B.as('GET', '/integrations/instagram/conversion')).data;
      assert.equal(conv.totals.visits, 3);
      assert.equal(conv.totals.bookings, 1);
      assert.equal(conv.totals.revenue_estimated_cents, 4000);
      assert.equal(conv.totals.visit_to_booking_rate, 0.3333);
      assert.equal(conv.by_campaign[0].utm_campaign, 'perfil');
      // Isolamento: A não vê a conversão de B (e é Free).
      await A.as('GET', '/integrations/instagram/conversion', undefined, 402);
    });

    await t.test('token expirado/revogado: reauth_required e 409 até reconectar', async () => {
      ig.mode = 'expired';
      const out = await B.as('GET', '/integrations/instagram/overview?refresh=true', undefined, 409);
      assert.equal(out.error.code, 'instagram_reauth_required');
      const st = (await B.as('GET', '/integrations/instagram/status')).data;
      assert.equal(st.account.status, 'reauth_required');
      ig.mode = 'ok';
      await connect(B);
      assert.equal((await B.as('GET', '/integrations/instagram/status')).data.account.status, 'active');
    });

    await t.test('callbacks Meta: assinatura inválida 400; exclusão de dados remove conta e é idempotente', async () => {
      const sign = payload => {
        const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return `${crypto.createHmac('sha256', APP_SECRET).update(body).digest('base64url')}.${body}`;
      };
      const form = value => ({ raw: new URLSearchParams({ signed_request: value }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const forged = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '9001' })).toString('base64url');
      await expect(400, 'POST', '/webhook/instagram/data-deletion', form(`${crypto.randomBytes(32).toString('base64url')}.${forged}`));
      await expect(400, 'POST', '/webhook/instagram/deauthorize', form('lixo'));
      const signed = sign({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user_id: '9001' });
      const out = await expect(200, 'POST', '/webhook/instagram/data-deletion', form(signed));
      assert.match(out.confirmation_code, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(out.url, `https://api.example.test/webhook/instagram/deletion-status/${out.confirmation_code}`);
      assert.equal((await sql('SELECT COUNT(*) AS n FROM instagram_accounts'))[0].n, 0, 'as duas empresas usavam o mesmo usuário do app no stub');
      assert.equal((await sql('SELECT COUNT(*) AS n FROM instagram_media'))[0].n, 0);
      const again = await expect(200, 'POST', '/webhook/instagram/data-deletion', form(signed));
      assert.equal(again.confirmation_code, out.confirmation_code);
      const st = (await expect(200, 'GET', `/webhook/instagram/deletion-status/${out.confirmation_code}`)).data;
      assert.equal(st.status, 'completed');
      const [req] = await sql('SELECT user_hash FROM instagram_deletion_requests WHERE confirmation_code = ?', [out.confirmation_code]);
      assert.ok(!req.user_hash.includes('9001'));
    });

    await t.test('desconectar (admin): apaga token, posts e série; mantém links UTM; isolamento entre empresas', async () => {
      await connect(A);
      await connect(B);
      await A.as('GET', '/integrations/instagram/posts');
      await B.as('GET', '/integrations/instagram/posts');
      await M('POST', '/integrations/instagram/disconnect', undefined, 403);
      const out = (await A.as('POST', '/integrations/instagram/disconnect')).data;
      assert.equal(out.disconnected, true);
      assert.equal((await sql('SELECT COUNT(*) AS n FROM instagram_accounts WHERE company_id = ?', [A.companyId]))[0].n, 0);
      assert.equal((await sql('SELECT COUNT(*) AS n FROM instagram_media WHERE company_id = ?', [A.companyId]))[0].n, 0);
      assert.ok((await sql('SELECT COUNT(*) AS n FROM instagram_media WHERE company_id = ?', [B.companyId]))[0].n > 0, 'B intacta');
      assert.equal((await sql('SELECT COUNT(*) AS n FROM marketing_links WHERE company_id = ?', [A.companyId]))[0].n, 1);
      const gone = await A.as('GET', '/integrations/instagram/posts', undefined, 404);
      assert.equal(gone.error.code, 'integration_not_connected');
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (stub) await new Promise(resolve => stub.close(resolve));
    if (pool) await new Promise(resolve => pool.end(() => resolve()));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
