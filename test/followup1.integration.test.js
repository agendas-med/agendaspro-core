process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mysql = require('mysql');
const { promisify } = require('node:util');

// Follow-up 1 (bloco D): foto do profissional, vínculo profissional<->usuário, quota de equipe atômica,
// profissional no agendamento e DECIMAL. Nada externo é chamado; segredos gerados por execução.
const secret = () => crypto.randomBytes(32).toString('base64url');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(40)]);
const dataUrl = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`;

test('Follow-up 1: bloco D no MariaDB isolado', { skip: !process.env.MYSQL_ROOT_PASSWORD, timeout: 180000 }, async t => {
  const database = `agendaspro_fu1_${process.pid}`;
  const admin = mysql.createConnection({ host: process.env.MYSQL_HOST, port: process.env.MYSQL_PORT, user: 'root', password: process.env.MYSQL_ROOT_PASSWORD });
  const adminQuery = promisify(admin.query).bind(admin);
  let server, pool;
  try {
    await adminQuery('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database]);
    Object.assign(process.env, {
      MYSQL_DATABASE: database, MYSQL_USER: 'root', MYSQL_PASSWORD: process.env.MYSQL_ROOT_PASSWORD,
      ENABLE_INPROCESS_CRON: 'false', ASAAS_API_KEY: '', JWT_SECRET: secret(),
      APP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_TOKEN: secret(), JOBS_TICK_TOKEN: secret(), ASAAS_WEBHOOK_TOKEN: secret(),
      WHATSAPP_INBOUND_TOKEN: secret(), WHATSAPP_OUTBOUND_TOKEN: secret(),
      ASAAS_SUBSCRIPTIONS_ENABLED: 'false', WHATSAPP_CLOUD_ENABLED: 'false', PUBLIC_API_URL: '',
    });
    delete process.env.JWT_KEY;
    delete process.env.APP_TIMEZONE;

    await require('../scripts/migrate')({ log: () => {} });
    const functions = require('../utils/functions');
    pool = require('../mysql').pool;
    const sql = functions.executeSql.bind(functions);
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
      const buffer = Buffer.from(await response.arrayBuffer());
      const raw = buffer.toString('utf8');
      let data;
      try { data = JSON.parse(raw); } catch { data = raw; }
      return { status: response.status, data, raw, buffer, headers: response.headers };
    }
    const expect = async (expected, ...args) => {
      const result = await call(...args);
      assert.equal(result.status, expected, `${args[0]} ${args[1]}: ${result.raw.slice(0, 300)}`);
      return result.data;
    };
    const [business] = await sql('SELECT id FROM business_types LIMIT 1');

    async function user(label) {
      const email = `${label}-${process.pid}@agendaspro.test`;
      const password = `senha-${label}-${secret()}`;
      await expect(200, 'POST', '/users/register', { body: { name: `Pessoa ${label}`, email, password } });
      const login = (await expect(200, 'POST', '/users/login', { body: { email, password } })).returnObj;
      return { email, userId: login.id, token: login.jwtToken };
    }
    async function tenant(label, document) {
      const owner = await user(label);
      const companyId = (await expect(200, 'POST', '/companies/create_company', {
        auth: owner.token,
        body: { name: `Empresa ${label}`, address: 'Rua de Testes', zip_code: '01310-100', city: 'São Paulo', state: 'SP', business_type: business.id, email: `empresa-${label}@example.test`, phone: '11999999999', document, address_number: '10', complement: '', birthDate: '1990-01-01', incomeValue: 5000 },
      })).returnObj.id;
      const ctx = { ...owner, companyId };
      ctx.as = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: ctx.token, company: ctx.companyId });
      // Membro comum (não admin) da empresa.
      ctx.member = async memberLabel => {
        const m = await user(memberLabel);
        await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [companyId, m.userId]);
        m.as = (method, path, body, expected = 200) => expect(expected, method, path, { body, auth: m.token, company: companyId });
        return m;
      };
      return ctx;
    }
    const A = await tenant('a', '52998224725');
    const B = await tenant('b', '11144477735');
    const premium = async companyId => {
      const [p] = await sql("SELECT id, price_cents FROM plans WHERE code = 'premium'");
      const sub = (await sql("INSERT INTO company_subscriptions (company_id, plan_id, price_cents, status) VALUES (?, ?, ?, 'active')", [companyId, p.id, p.price_cents])).insertId;
      await sql("INSERT INTO subscription_invoices (company_id, subscription_id, plan_id, provider_payment_id, amount_cents, status, due_date, period_start, period_end) VALUES (?, ?, ?, ?, ?, 'paid', CURDATE(), NOW() - INTERVAL 1 DAY, NOW() + INTERVAL 29 DAY)", [companyId, sub, p.id, `pay_fu1_${companyId}`, p.price_cents]);
    };
    await premium(A.companyId); // A em Premium (vários profissionais); B fica no Free
    const memberA = await A.member('a-membro');

    await t.test('D1: foto do profissional no banco, validada pelos bytes e servida com nosniff', async () => {
      const pro = (await A.as('POST', '/professionals', { name: 'Ana Foto' }, 201)).data;
      const saved = (await A.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/png', PNG) })).data;
      assert.match(saved.photo_url, new RegExp(`^/files/professional-photo/${pro.id}/[a-f0-9]{16}$`));

      const served = await call('GET', saved.photo_url);
      assert.equal(served.status, 200);
      assert.equal(served.headers.get('content-type'), 'image/png');
      assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
      assert.match(served.headers.get('content-security-policy'), /sandbox/);
      assert.ok(served.buffer.equals(PNG), 'bytes devolvidos iguais aos enviados');
      await expect(404, 'GET', saved.photo_url.replace(/[a-f0-9]{16}$/, '0000000000000000'));
      await expect(404, 'GET', `/files/professional-photo/${pro.id}/nao-hex`);

      // SVG, tipo declarado divergente dos bytes, base64 fora do formato.
      await A.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/svg+xml', Buffer.from('<svg onload="alert(1)"/>')) }, 400);
      await A.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/jpeg', PNG) }, 400);
      await A.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/png', Buffer.from('GIF89a-nao-e-png')) }, 400);
      await A.as('POST', `/professionals/${pro.id}/photo`, { image: 'https://example.test/x.png' }, 400);
      process.env.PROFESSIONAL_PHOTO_MAX_BYTES = '32';
      try {
        await A.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/png', PNG) }, 413);
      } finally {
        delete process.env.PROFESSIONAL_PHOTO_MAX_BYTES;
      }

      // Isolamento e papel: outra empresa não acha; membro comum não envia.
      await B.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/png', PNG) }, 404);
      await B.as('DELETE', `/professionals/${pro.id}/photo`, undefined, 404);
      await memberA.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/png', PNG) }, 401);

      // Troca: o hash muda e a URL antiga deixa de servir.
      const other = Buffer.concat([PNG.subarray(0, 8), crypto.randomBytes(40)]);
      const replaced = (await A.as('POST', `/professionals/${pro.id}/photo`, { image: dataUrl('image/png', other) })).data;
      assert.notEqual(replaced.photo_url, saved.photo_url);
      await expect(404, 'GET', saved.photo_url);
      await expect(200, 'GET', replaced.photo_url);

      const removed = (await A.as('DELETE', `/professionals/${pro.id}/photo`)).data;
      assert.equal(removed.photo_url, null);
      await expect(404, 'GET', replaced.photo_url);

      // Remover não apaga uma photo_url externa definida manualmente.
      await A.as('PATCH', `/professionals/${pro.id}`, { photo_url: 'https://cdn.example.test/ana.png' });
      assert.equal((await A.as('DELETE', `/professionals/${pro.id}/photo`)).data.photo_url, 'https://cdn.example.test/ana.png');
    });

    await t.test('D2: vínculo profissional <-> usuário (members, me, 409, saída da empresa)', async () => {
      const outsider = await B.member('b-membro');
      assert.equal((await memberA.as('GET', '/professionals/me')).data, null);
      await memberA.as('GET', '/professionals/members', undefined, 401);

      const linked = (await A.as('POST', '/professionals', { name: 'Bruno Vinculado', user_id: memberA.userId }, 201)).data;
      assert.equal(linked.user_id, memberA.userId);
      const me = (await memberA.as('GET', '/professionals/me')).data;
      assert.equal(me.id, linked.id);

      const members = (await A.as('GET', '/professionals/members')).data;
      const row = members.find(m => m.user_id === memberA.userId);
      assert.equal(row.professional_id, linked.id);
      assert.equal(members.find(m => m.user_id === A.userId).professional_id, null);
      assert.ok(!members.some(m => m.user_id === outsider.userId), 'membro de outra empresa não aparece');

      // Mesmo usuário em outro profissional ativo: 409 com code; usuário de outra empresa: 400.
      const taken = await call('POST', '/professionals', { body: { name: 'Duplicado', user_id: memberA.userId }, auth: A.token, company: A.companyId });
      assert.equal(taken.status, 409);
      assert.equal(taken.data.error.code, 'professional_user_taken');
      assert.equal(taken.data.error.professional_id, linked.id);
      await A.as('POST', '/professionals', { name: 'Fora', user_id: outsider.userId }, 400);
      const free = (await A.as('POST', '/professionals', { name: 'Carla Livre' }, 201)).data;
      await A.as('PATCH', `/professionals/${free.id}`, { user_id: memberA.userId }, 409);

      // Desativado libera o usuário; reativar o antigo com o vínculo ocupado dá 409.
      await A.as('DELETE', `/professionals/${linked.id}`);
      assert.equal((await A.as('PATCH', `/professionals/${free.id}`, { user_id: memberA.userId })).data.user_id, memberA.userId);
      await A.as('PATCH', `/professionals/${linked.id}`, { active: true }, 409);
      assert.equal((await memberA.as('GET', '/professionals/me')).data.id, free.id);

      // Saída da empresa desfaz o vínculo (o profissional continua).
      await A.as('DELETE', `/companies/remove_user/${memberA.userId}`);
      const [after] = await sql('SELECT user_id, active FROM professionals WHERE id = ?', [free.id]);
      assert.equal(after.user_id, null);
      assert.equal(after.active, 1);
      await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [A.companyId, memberA.userId]);
    });

    await t.test('D3: quota max_team_users atômica no convite e revalidada no aceite', async () => {
      const mail = require('../config/sendEmail');
      const original = mail.sendEmail;
      const links = [];
      mail.sendEmail = async html => { links.push(String(html)); };
      try {
        const C = await tenant('c', '86288366757'); // Free: max_team_users = 2 (membros + convites pendentes)
        const [role] = await sql('SELECT id FROM config_company_roles WHERE company_id = ? ORDER BY id LIMIT 1', [C.companyId]);
        const invite = email => call('POST', '/companies/invite_user', { body: { name: 'Convidado', email, role: role.id }, auth: C.token, company: C.companyId });

        // 4 convites simultâneos com 1 vaga: exatamente 1 passa, os outros 402.
        const results = await Promise.all([1, 2, 3, 4].map(n => invite(`par${n}-${process.pid}@agendaspro.test`)));
        const statuses = results.map(r => r.status).sort();
        assert.deepEqual(statuses, [200, 402, 402, 402], JSON.stringify(results.map(r => r.raw.slice(0, 120))));
        const denied = results.find(r => r.status === 402).data.error;
        assert.equal(denied.code, 'plan_upgrade_required');
        assert.equal(denied.quota, 'max_team_users');
        const [{ used }] = await sql("SELECT COUNT(*) AS used FROM company_invitations WHERE company_id = ? AND status = 'pending'", [C.companyId]);
        assert.equal(Number(used), 1);

        // Aceite: o convite já conta; se a equipe passou do limite (ex.: downgrade), 402 e o convite segue pendente.
        const okIndex = results.findIndex(r => r.status === 200);
        const invitedEmail = `par${okIndex + 1}-${process.pid}@agendaspro.test`;
        const token = decodeURIComponent(/token=([^&"'\s]+)/.exec(links.find(h => h.includes(encodeURIComponent(invitedEmail))))[1]);
        const extra = await user('c-extra');
        await sql('INSERT INTO company_members (company_id, user_id) VALUES (?, ?)', [C.companyId, extra.userId]);
        const invitedPassword = `senha-${secret()}`;
        await expect(200, 'POST', '/users/register', { body: { name: 'Convidado', email: invitedEmail, password: invitedPassword } });
        const over = await call('POST', '/companies/enter_company', { body: { token, email: invitedEmail } });
        assert.equal(over.status, 402, over.raw);
        assert.equal(over.data.error.code, 'plan_upgrade_required');

        await sql('DELETE FROM company_members WHERE company_id = ? AND user_id = ?', [C.companyId, extra.userId]);
        await expect(200, 'POST', '/companies/enter_company', { body: { token, email: invitedEmail } });
        const [{ members }] = await sql('SELECT COUNT(*) AS members FROM company_members WHERE company_id = ?', [C.companyId]);
        assert.equal(Number(members), 2);
        assert.equal((await invite(`depois-${process.pid}@agendaspro.test`)).status, 402);
      } finally {
        mail.sendEmail = original;
      }
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await new Promise(resolve => pool.end(resolve));
    await adminQuery('DROP DATABASE IF EXISTS ??', [database]).catch(() => {});
    admin.end();
  }
});
