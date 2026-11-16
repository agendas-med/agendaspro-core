# Operação do agendaspro-core

Guia de produção da API: deploy no Heroku Eco, variáveis de ambiente, go-live das integrações, checklist, runbook de incidentes, backup, custos e LGPD.

Os preços e limites de terceiros abaixo foram conferidos em **2026-11-16**. Os marcados *(a verificar)* não puderam ser confirmados na fonte nessa data. Confira todos antes de contratar.

Regras deste documento:
- nenhum segredo real é escrito aqui (o repositório é público);
- os valores `<...>` são exemplos para substituir.

## 1. Arquitetura de produção

| Peça | Escolha | Observação |
|---|---|---|
| API | Heroku, 1 dyno **web Eco** (`app.json`) | Sem worker. O dyno dorme após 30 min sem tráfego e tem filesystem efêmero. |
| Banco | MariaDB (JawsDB Maria ou externo) | A URL do add-on é lida direto (`JAWSDB_MARIA_URL`/`DATABASE_URL`, ver `config/database.js`). |
| Migrations | Release phase: `npm run db:migrate` | Usa `GET_LOCK`, é idempotente e o deploy é abortado se falhar. |
| Jobs | Tabela `jobs`, drenada por `POST /internal/jobs/tick` | O gatilho é externo, de hora em hora (seção 4). Webhooks também drenam de forma oportunista. |
| Arquivos | S3 (`AWS_*`) | Nada persistente em disco local. |
| Site | Estático (Cloudflare Pages/Netlify/Vercel) | Ver o README do `agendaspro-site`. |

Endpoints de operação:

| Rota | Auth | Uso |
|---|---|---|
| `GET /health` | nenhuma | Liveness, sem banco. Responde `{"status":"ok"}`. Serve para monitor e para aquecer o dyno. |
| `GET /health/ready` | nenhuma | Readiness: o banco responde e a última migration do código está aplicada. Responde `200 {"status":"ready"}` ou `503 {"status":"unavailable"}`, sem detalhes. Tem cache de 5 s e responde 503 durante o desligamento. |
| `GET /health/deep` | `Bearer ADMIN_TOKEN` | Diagnóstico detalhado. |
| `POST /internal/jobs/tick` | `Bearer JOBS_TICK_TOKEN` | Drena a fila dentro de `JOBS_TICK_BUDGET_MS` e devolve estatísticas. |

Ciclo de vida do processo (`server.js`):

1. **Boot:**
   - `config/validateEnv.js` valida o ambiente.
   - Em `NODE_ENV=production`, qualquer erro aborta o boot com exit 1.
   - O log lista **só os nomes** das variáveis com problema.
2. **SIGTERM** (deploy, restart diário ou sleep do Eco):
   - para de aceitar conexões;
   - fecha as ociosas;
   - após 10 s, encerra à força as restantes;
   - fecha o pool e sai antes do SIGKILL do Heroku (30 s).
3. **Erros não tratados:** `unhandledRejection` e `uncaughtException` registram só a mensagem e passam pelo mesmo desligamento. O Heroku reinicia o dyno.

## 2. Matriz de variáveis de ambiente

Legenda da coluna "Obrig.":
- **P**: obrigatória em produção; sem ela o boot falha.
- **F**: obrigatória quando a feature indicada está ligada; sem ela o boot falha em produção.
- **R**: recomendada; sem ela o boot gera um aviso e a feature fica desligada ou degradada.
- **O**: opcional.

O `.env.example` traz a lista completa com comentários. Abaixo estão as que importam para operar.

### Núcleo

| Variável | Obrig. | Padrão | Onde obter / observação |
|---|---|---|---|
| `NODE_ENV` | P | — | `production` no Heroku (`app.json`). |
| `PORT` | — | 3001 | Definida pelo Heroku. |
| `JWT_SECRET` (ou `JWT_KEY`) | P | — | 32+ caracteres aleatórios (`app.json` gera). |
| `JWT_EXPIRES_IN` / `REFRESH_TOKEN_TTL_DAYS` | O | 8h / 30 | Sessão do painel. |
| `APP_ENCRYPTION_KEY` | P | — | base64 de **exatamente 32 bytes**: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Guarde uma cópia em cofre fora do Heroku: sem ela, as chaves Asaas e os tokens OAuth cifrados no banco são irrecuperáveis. |
| `JOBS_TICK_TOKEN` | P | — | 32+ caracteres. É o mesmo valor do gatilho externo. |
| `ADMIN_TOKEN` | R | — | 32+ caracteres, **diferente** do `JOBS_TICK_TOKEN`. Sem ele, `/health/deep` e as rotas administrativas respondem 503. |
| `CORS_ORIGINS` | P | `URL_SITE` | Origens do painel separadas por vírgula, só `https://`. |
| `PUBLIC_CORS_ORIGINS` | O | — | Origens do site que chamam `/public`. |
| `PUBLIC_API_URL` | P (operacional) | — | URL pública desta API. |
| `URL_SITE` / `PUBLIC_SITE_URL` | R | — | Painel (links de e-mail) e site (links de gestão de agendamento). |
| `TRUST_PROXY` | O | 1 | Número de proxies à frente. Use 1 no Heroku, ou 2 se houver um CDN/proxy próprio antes. |
| `GLOBAL_RATE_LIMIT_PER_MIN` | O | 300 | Limite por IP em memória, por minuto. `0` desliga. Webhooks, `/health` e o tick ficam isentos. |
| `BODY_LIMIT` / `UPLOAD_BODY_LIMIT` / `PROFESSIONAL_PHOTO_MAX_BYTES` | O | 1mb / 6mb / 2 MB | Limites de corpo. |
| `APP_TIMEZONE` | O | America/Sao_Paulo | As consultas usam `-03:00` por sessão, independentemente do TZ do servidor e do banco. |
| `ENABLE_INPROCESS_CRON` | O | false | Mantenha `false` no Eco; o boot avisa se estiver ligado. |

### Banco

| Variável | Obrig. | Padrão | Observação |
|---|---|---|---|
| `JAWSDB_MARIA_URL` / `JAWSDB_URL` / `CLEARDB_DATABASE_URL` / `DATABASE_URL` | P (uma delas, ou as `MYSQL_*`) | — | Formato `mysql://` ou `mariadb://`. Os add-ons definem a variável sozinhos. |
| `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE` | alternativa | porta 3306 | Se `MYSQL_HOST` existir, as `MYSQL_*` têm precedência sobre a URL. |
| `MYSQL_CONNECTION_LIMIT` | R | 10 | Use **limite do plano − 2**. No Kitefin/Leopard, use **5**: a release phase e o `heroku run` também abrem conexões. |
| `MYSQL_ROOT_PASSWORD` | só testes | — | Nunca em produção. |

### Jobs

| Variável | Padrão | Observação |
|---|---|---|
| `JOBS_TICK_BUDGET_MS` | 20000 (máx. 25000) | Tempo de drenagem por tick. Com o cron-job.org (timeout de cerca de 30 s), use **15000**. |
| `JOBS_DRAIN_THROTTLE_SEC` / `JOBS_DRAIN_ON_WEBHOOK` | 300 / ligado | Drenagem oportunista nos webhooks. |
| `TICK_WARM_ATTEMPTS` / `TICK_WARM_DELAY_MS` / `TICK_TIMEOUT_MS` | 6 / 5000 / 60000 | Só para `scripts/jobs-tick.js`. |

### API pública e anti-bot

| Variável | Obrig. | Observação |
|---|---|---|
| `PUBLIC_BOOKING_TOKEN_SECRET` | R | Sem ela, as reservas públicas respondem 503. |
| `PUBLIC_BOOKING_TOKEN_TTL_DAYS` | O | Padrão 90. |
| `TURNSTILE_SECRET_KEY` | R (F com chat público) | Cloudflare Dashboard → Turnstile → widget → Secret key. Em produção sem ela, leads, reservas e chat respondem 503 (fail-closed). `TURNSTILE_DEV_BYPASS` e `TURNSTILE_ENABLED=false` são ignoradas em produção. |
| `PUBLIC_*_IP_MAX` / `PUBLIC_*_PHONE_MAX` / `PUBLIC_SLUG_MISS_MAX` / `PUBLIC_VISITS_IP_MAX` | O | Limites por rota (`rateLimit.js`, no banco). |
| `SALES_NOTIFY_EMAIL` / `SALES_NOTIFY_WHATSAPP` | O | Notificação de novos leads. |

### Asaas (pagamentos e assinatura)

| Variável | Obrig. | Observação |
|---|---|---|
| `ASAAS_ENV` | O | `sandbox` (padrão) ou `production`. O boot avisa se não for `production`. |
| `ASAAS_API_KEY` | F (cobrança) | Painel Asaas → Integrações → Chave de API. Sandbox e produção têm chaves diferentes. |
| `ASAAS_WEBHOOK_TOKEN` | F (com `ASAAS_API_KEY` ou assinaturas) | De 32 a 255 caracteres sem espaço, igual ao "token de autenticação" do webhook no Asaas. |
| `ASAAS_MAIN_WALLET_ID`, `WEBHOOK_URL` | F (`ASAAS_SUBSCRIPTIONS_ENABLED=true`) | `walletId` da conta principal (split) e URL pública do webhook. |
| `PLAN_PREMIUM_PRICE_CENTS` / `BILLING_GRACE_DAYS` | O | 4990 / 3. |

### WhatsApp Cloud API (Meta)

| Variável | Obrig. | Observação |
|---|---|---|
| `WHATSAPP_CLOUD_ENABLED` | O | `true` liga o envio e o recebimento. |
| `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID` | F | App Meta → Configurações básicas (secret). WhatsApp → Configuração da API (Phone number ID). Use o token permanente de **usuário do sistema** (Business Settings). O verify token é um valor seu, repetido no cadastro do webhook. |
| `META_WABA_ID`, `WHATSAPP_DISPLAY_PHONE` | R | Sincronização de templates e exibição. |
| `META_GRAPH_VERSION`, `WHATSAPP_TEMPLATE_LANG` | O | `v21.0`, `pt_BR`. |
| `WHATSAPP_LEGACY_RELAY` e `WHATSAPP_*_TOKEN`, `WHATSAPP_API_URL`, `WEBHOOK_SECRET_TOKEN` | O | Relay legado. Mantenha desligado em produção (o boot avisa). |

### IA (OpenAI, modelo `gpt-6-luna`)

| Variável | Padrão | Observação |
|---|---|---|
| `OPENAI_API_KEY` | — | platform.openai.com → API keys. Use uma chave de projeto com limite mensal no painel da OpenAI. Sem ela, chat e assistente respondem só de forma determinística. |
| `OPENAI_MODEL_DEFAULT` / `OPENAI_BASE_URL` | gpt-6-luna / — | |
| `AI_GLOBAL_DAILY_TOKENS` / `AI_GLOBAL_DAILY_BUDGET_USD` | 2000000 / 1.00 | Teto global diário. Ao atingir, a IA desliga até o dia seguinte. |
| `AI_PRICE_INPUT_USD_PER_MTOK` / `AI_PRICE_OUTPUT_USD_PER_MTOK` | 0.10 / 0.50 | Preços usados no cálculo do teto em US$. Atualize se a tabela da OpenAI mudar. |
| `AI_TIMEOUT_MS` / `AI_MAX_RETRIES` | 10000 (1000–12000) | |
| `AI_BREAKER_FAILURES` / `AI_BREAKER_COOLDOWN_MS` | 5 / 300000 | Circuit breaker no banco (tabela `ai_circuit`). |
| `PUBLIC_CHAT_ENABLED` | false | Exige `TURNSTILE_SECRET_KEY` e `PUBLIC_CHAT_TOKEN_SECRET` (ou `PUBLIC_BOOKING_TOKEN_SECRET`). |
| `PUBLIC_CHAT_*` | ver `.env.example` | Sessão: 6000 tokens. Empresa: 20000 por dia. IP: 6000 por dia. Saída: 220. |
| `ASSISTANT_ENABLED` / `ASSISTANT_TOKEN_SECRET` | false / — | Sem o secret, as ações de escrita do assistente ficam desligadas. |
| `ASSISTANT_*` | ver `.env.example` | Empresa: 200k por dia e 3M por mês. Usuário: 80k por dia. Saída: 400. |
| `ASSISTANT_RAG_ENABLED` / `OPENAI_EMBEDDING_MODEL` | false / — | O RAG exige o modelo de embedding. |

### Integrações

| Variável | Obrig. | Observação |
|---|---|---|
| `OAUTH_STATE_SECRET` | R | HMAC do `state` OAuth. Se ausente, é derivado de `APP_ENCRYPTION_KEY` (com aviso). |
| `INSTAGRAM_APP_ID` → `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URIS` | F | App Meta com o produto "Instagram API with Instagram Login". `INSTAGRAM_DELETION_STATUS_URL` é opcional. |
| `GOOGLE_CALENDAR_CLIENT_ID` → `_CLIENT_SECRET`, `_REDIRECT_URIS` | F | Google Cloud Console → Credenciais → OAuth client (Web). |
| `GOOGLE_CALENDAR_EVENT_SALT` | R | Defina antes do primeiro push e **nunca troque**. |
| `GOOGLE_CALENDAR_WEBHOOK_URL` | O | HTTPS público para `events.watch`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | O | Login com Google no painel. |

### Outros

| Variável | Observação |
|---|---|
| `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_PUBLIC_READ` | Uploads. Use um usuário IAM restrito ao bucket. |
| `USER_EMAIL`, `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN` | E-mail transacional (Gmail OAuth2, nodemailer). |
| `DEMO_PASSWORD` | Só para `db:seed-demo`. Nunca em produção. |

## 3. Go-live passo a passo

### 3.1 Heroku

1. Crie o app em `heroku create <app> --stack heroku-24`, ou use o botão "Deploy" a partir do `app.json`.
2. Configure o dyno: `heroku ps:type web=eco`. O plano Eco custa US$ 5/mês por 1000 horas compartilhadas entre todos os apps Eco da conta.
3. Configure as variáveis:
   ```sh
   heroku config:set NODE_ENV=production APP_ENCRYPTION_KEY=<base64-32-bytes> \
     CORS_ORIGINS=https://<painel> PUBLIC_API_URL=https://<app>.herokuapp.com MYSQL_CONNECTION_LIMIT=5
   ```
   Os segredos HMAC (`JWT_SECRET`, `JOBS_TICK_TOKEN`, `ADMIN_TOKEN` e os `*_TOKEN_SECRET`) são gerados pelo `app.json`. Sem ele, crie cada um com `openssl rand -hex 32`.
4. Faça o deploy com `git push heroku launch/mvp:main`. **Esse passo é manual e fica fora do escopo dos agentes.**
   - A release phase roda as migrations. O primeiro deploy num banco vazio leva cerca de 3 s; os seguintes, menos de 1 s.
   - Se a release falhar, a versão nova não sobe e a anterior continua no ar.
5. Verifique:
   - `curl https://<app>.herokuapp.com/health` deve responder 200.
   - `curl https://<app>.herokuapp.com/health/ready` também deve responder 200.
   - `heroku logs --tail` não deve mostrar `[env] erro`. Leia os `[env] aviso`.
6. Domínio próprio:
   - `heroku domains:add api.<dominio>`, depois `heroku certs:auto:enable` para o certificado automático (ACM);
   - aponte o CNAME do DNS para o alvo informado.

   *(a verificar: disponibilidade do ACM no Eco; sem ele, use o domínio `herokuapp.com` atrás de um proxy/CDN com `TRUST_PROXY=2`)*

### 3.2 Banco: JawsDB Maria ou externo

- **JawsDB:** `heroku addons:create jawsdb-maria:<plano>`. O add-on define `JAWSDB_MARIA_URL`, que é lida automaticamente.

  | Plano | Armazenamento | Conexões | Preço | Uso |
  |---|---|---|---|---|
  | Kitefin | 5 MB | 10 | gratuito | Só para teste: 5 MB não comportam a operação real. |
  | Leopard | 1 GB | 15 | cerca de US$ 10/mês | Mínimo recomendado para o lançamento. |
  | Blacktip | — | 30 | US$ 24/mês | |

- **Externo** (MariaDB 10.6 ou superior; a CI usa 11.4):
  - defina `DATABASE_URL=mysql://<usuario>:<senha>@<host>:3306/<base>`, ou as `MYSQL_*`;
  - crie um usuário **não root** com `ALL` só na base da aplicação;
  - as migrations rodam com esse usuário (validado na CI e localmente).
- Use charset utf8mb4.
- O timezone do servidor de banco é indiferente, porque a aplicação faz `SET time_zone='-03:00'` por consulta.

### 3.3 Gatilho horário dos jobs

Sem o gatilho, lembretes, confirmações, sincronizações e expirações de hold só andam quando chega algum webhook.

**Principal: cron-job.org (gratuito).**
1. Crie o job com a URL `https://<app>.herokuapp.com/internal/jobs/tick`.
2. Configure:
   - método **POST**;
   - header `Authorization: Bearer <JOBS_TICK_TOKEN>`;
   - agenda de hora em hora, no minuto 7.
3. Defina `JOBS_TICK_BUDGET_MS=15000`. O timeout do serviço é de cerca de 30 s e o dyno pode estar dormindo.
4. Ative a notificação de falha por e-mail.

**Reserva: GitHub Actions (`.github/workflows/jobs-tick.yml`).**
1. Em Settings → Secrets → Actions, crie `API_BASE_URL` e `JOBS_TICK_TOKEN`.
2. O workflow roda no minuto 7 de cada hora e aquece o dyno via `/health`, com retentativas, antes do POST.

Limitações do agendamento do GitHub:
- execuções podem atrasar ou ser puladas;
- o agendamento é **desativado após 60 dias sem commits** em repositório público.

Dois ticks no mesmo horário são seguros: a fila usa lock por job e chaves de dedupe.

**UptimeRobot (plano gratuito):** só faz GET. Serve para **monitorar** `GET /health` ou `/health/ready`, não para disparar o tick. Ping a cada 5 min mantém o Eco acordado o mês inteiro, consumindo cerca de 744 h das 1000 h do pool. Use só se não houver outros apps Eco na conta.

**Manual ou local:**
```sh
API_BASE_URL=https://<app>.herokuapp.com JOBS_TICK_TOKEN=<token> npm run jobs:tick
```

### 3.4 Asaas: do sandbox à produção

1. **Sandbox** (`ASAAS_ENV=sandbox`, chave do sandbox):
   - cadastre o webhook em `https://<app>.herokuapp.com/webhook/...` (rota conforme `docs/contratos-f2.md`), com o token = `ASAAS_WEBHOOK_TOKEN`;
   - faça um pagamento PIX de teste e confira o status no painel.
2. **Produção:**
   - crie a chave de produção e troque `ASAAS_ENV=production`, `ASAAS_API_KEY` e `ASAAS_MAIN_WALLET_ID`;
   - **recadastre o webhook** na conta de produção com um token novo;
   - só depois disso ligue `ASAAS_SUBSCRIPTIONS_ENABLED=true`.
3. Se houver chaves de subcontas antigas em texto puro no banco, rode o `db:encrypt-secrets` (seção 6.3).

### 3.5 WhatsApp Cloud API (Meta)

1. Crie o app Meta (tipo Business), adicione o produto WhatsApp e registre o número de produção (verificação do Business Manager).
2. Crie um usuário do sistema com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`, e gere o token permanente (`META_ACCESS_TOKEN`).
3. Configure o webhook:
   - URL `https://<app>.herokuapp.com/webhook/meta`;
   - verify token = `META_VERIFY_TOKEN`;
   - assine o campo `messages`.
4. Defina `META_APP_SECRET` e `META_PHONE_NUMBER_ID`, e `META_WABA_ID` se for usar templates. Depois ligue `WHATSAPP_CLOUD_ENABLED=true`.
5. Aprove os templates no WhatsApp Manager e sincronize pela rota interna de templates (`ADMIN_TOKEN`; ver `docs/contratos-f4.md`).

### 3.6 Instagram

1. No app Meta, adicione "Instagram API with Instagram Login".
2. Configure:
   - redirect URI = valor de `INSTAGRAM_REDIRECT_URIS`;
   - callbacks de desautorização e exclusão em `https://<app>.herokuapp.com/webhook/instagram/...` (ver `docs/contratos-f6.md`).
3. Defina `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`. O app precisa de App Review para contas fora da lista de testadores.

### 3.7 Google OAuth e Google Agenda

1. No Google Cloud Console, configure a tela de consentimento (externa) e o escopo do Calendar (ver `docs/contratos-f6.md`). Crie um OAuth client do tipo Web.
2. Use redirect URIs exatamente iguais a `GOOGLE_CALENDAR_REDIRECT_URIS`.
3. Defina `GOOGLE_CALENDAR_EVENT_SALT` antes do primeiro vínculo.
4. Para mais de 100 usuários, os escopos sensíveis exigem **verificação do app** pelo Google, que leva semanas. Planeje com antecedência.

### 3.8 Cloudflare Turnstile

1. Em Cloudflare → Turnstile, crie um widget com os domínios do site (e `localhost` só no widget de desenvolvimento).
2. A site key vai no site (`VITE_TURNSTILE_SITE_KEY`) e a secret key no core (`TURNSTILE_SECRET_KEY`).

### 3.9 OpenAI

1. Crie um projeto dedicado e uma chave de projeto (`OPENAI_API_KEY`). Defina no painel um **limite de gasto mensal** (ex.: US$ 20) e um alerta.
2. Mantenha `AI_GLOBAL_DAILY_BUDGET_USD` coerente com o limite mensal. Por exemplo, US$ 1/dia dá no máximo cerca de US$ 30/mês.
3. Ligue as features uma a uma, observando `ai_usage`: primeiro `ASSISTANT_ENABLED`, depois `PUBLIC_CHAT_ENABLED`.

## 4. Checklist de pré-lançamento

- [ ] CI verde no último commit: suíte serial sem skips e migrate 2x com usuário não root.
- [ ] `npm audit --omit=dev` revisado. Pendência conhecida: nodemailer 6 (seção 9).
- [ ] `NODE_ENV=production`. O boot não mostra nenhum `[env] erro`, e os `[env] aviso` foram lidos e aceitos.
- [ ] `APP_ENCRYPTION_KEY` tem cópia em cofre fora do Heroku.
- [ ] `ADMIN_TOKEN` ≠ `JOBS_TICK_TOKEN`, ambos com 32+ caracteres.
- [ ] `CORS_ORIGINS` e `PUBLIC_CORS_ORIGINS` só com `https://` dos domínios reais.
- [ ] `MYSQL_CONNECTION_LIMIT` ≤ limite do plano − 2.
- [ ] `GET /health` e `GET /health/ready` respondem 200 em produção.
- [ ] O gatilho do tick está configurado, uma execução manual responde 200 com estatísticas, e o alerta de falha está ativo.
- [ ] Monitor externo em `/health/ready` com alerta por e-mail.
- [ ] Asaas em produção: webhook recadastrado com token novo e um pagamento real de valor mínimo conciliado.
- [ ] WhatsApp: número verificado, templates aprovados, webhook validado (GET do verify) e uma mensagem real de ida e volta.
- [ ] Turnstile com os domínios corretos. Um lead e uma reserva de teste em produção.
- [ ] OpenAI com limite mensal no painel e `AI_GLOBAL_DAILY_BUDGET_USD` definido.
- [ ] Backup inicial feito e restaurado num banco descartável (seção 6).
- [ ] Política de privacidade publicada com o contato do encarregado (seção 8).
- [ ] Site: build de produção com a CSP `connect-src` incluindo a URL real da API (README do site).

## 5. Runbook de incidentes

Antes de tudo, olhe `heroku logs --tail` e os status de terceiros (Heroku, Meta, OpenAI, Asaas). Os logs não contêm corpo, query string nem tokens. Procure pelo `correlation_id` que o cliente recebeu no erro 500.

### 5.1 API fora do ar ou lenta

| Sintoma | Ação |
|---|---|
| `/health` falha | `heroku ps`. Depois `heroku restart`. Veja `[boot]`/`[env] erro` nos logs. Se o crash veio do último deploy, faça `heroku rollback`. |
| `/health` 200 e `/health/ready` 503 | Banco fora ou migration pendente. Teste o banco com `heroku run node -e "require('./utils/functions').executeSql('SELECT 1').then(()=>{console.log('ok');process.exit(0)})"`. Se a migration estiver pendente, rode `heroku run npm run db:migrate`. |
| Erro `ER_CON_COUNT_ERROR` / too many connections | Reduza `MYSQL_CONNECTION_LIMIT`. Encerre `heroku run` esquecidos. |
| 429 em massa | `GLOBAL_RATE_LIMIT_PER_MIN` baixo demais ou ataque. Ajuste a variável (reinicia o dyno). Se a origem for um IP só, bloqueie no CDN/proxy. |
| Dyno dormindo, primeira resposta lenta | Esperado no Eco. Se incomodar, use Basic (US$ 7/mês). |

### 5.2 IA degradada

Os sinais aparecem em `ai_usage`, com `status` `error`, `timeout` ou `blocked` e `latency_ms` alta:
```sql
SELECT feature, status, COUNT(*) n, ROUND(AVG(latency_ms)) ms
FROM ai_usage WHERE created_at >= NOW() - INTERVAL 1 HOUR
GROUP BY feature, status;
```

**Circuit breaker.** Depois de `AI_BREAKER_FAILURES` (5) falhas seguidas, o circuito abre por `AI_BREAKER_COOLDOWN_MS` (5 min). Nesse período, chat, assistente e bot respondem de forma determinística.
- Ver o estado: `SELECT name, failures, opened_until_ms, reason FROM ai_circuit;`
- Forçar o fechamento, depois que o provedor voltar: `UPDATE ai_circuit SET opened_until_ms = 0, failures = 0 WHERE name = 'provider';`
- Forçar a abertura, para parar a IA por 1 hora sem deploy: `UPDATE ai_circuit SET opened_until_ms = (UNIX_TIMESTAMP() + 3600) * 1000 WHERE name = 'provider';`

**Teto global atingido.** A IA para até a virada do dia. Para consultar o consumo do dia:
```sql
SELECT scope, scope_key, tokens, cost_micro_usd/1e6 AS usd, calls
FROM ai_budget_counters WHERE day = CURDATE() ORDER BY cost_micro_usd DESC LIMIT 20;
```
Só aumente `AI_GLOBAL_DAILY_BUDGET_USD` depois de entender o motivo, por exemplo abuso num `scope_key` de IP ou empresa.

**Kill switches.** Cada `heroku config:set` reinicia o dyno, e a mudança vale em segundos.

| Para desligar | Comando | Efeito |
|---|---|---|
| Chat público | `heroku config:set PUBLIC_CHAT_ENABLED=false` | Os endpoints de chat respondem desligado. O site segue com reserva e lead. |
| Assistente do painel | `heroku config:set ASSISTANT_ENABLED=false` | O painel esconde ou desativa o assistente. |
| Toda a IA, sem mexer nas features | `heroku config:unset OPENAI_API_KEY` ou forçar a abertura do breaker | Respostas determinísticas. |
| WhatsApp Cloud | `heroku config:set WHATSAPP_CLOUD_ENABLED=false` | Para envio e recebimento. O webhook da Meta passa a falhar e a Meta reenvia por algum tempo. Os lembretes ficam pendentes ou falham na fila. |

### 5.3 Fila de jobs parada

- Ver a fila: `SELECT status, COUNT(*) FROM jobs GROUP BY status;` e `SELECT type, last_error FROM jobs WHERE status='failed' ORDER BY id DESC LIMIT 20;`
- Confira o histórico do cron-job.org e do GitHub Actions. Um tick manual responde as estatísticas (`npm run jobs:tick`).
- 401 no tick: o token difere entre o Heroku e o gatilho. 503: `JOBS_TICK_TOKEN` não está definida.
- Jobs `running` com `locked_until` vencido são liberados no próximo tick (`released`).

### 5.4 Webhooks (Asaas, Meta, Google) rejeitados

- 401/403 em massa indica que um token ou segredo mudou de um lado só (`ASAAS_WEBHOOK_TOKEN`, `META_APP_SECRET`). Corrija e reprocesse pelo painel do provedor. O Asaas tem fila de webhooks pausada.
- Se a fila de webhooks do Asaas foi pausada por erros seguidos, reative-a no painel depois da correção.

### 5.5 Vazamento de segredo

1. Troque o segredo no provedor e no Heroku (`config:set`).
2. Para `JWT_SECRET`, todas as sessões caem, o que é esperado.
3. `APP_ENCRYPTION_KEY` **não pode** ser simplesmente trocada: os dados cifrados ficariam ilegíveis. A rotação exige decifrar com a chave antiga e cifrar com a nova, e ainda **não há script para isso**. Trate como incidente grave e planeje com o código.
4. Se a base pública do repositório recebeu um segredo, a troca é obrigatória; reescrever o histórico não basta.

## 6. Backup, restauração e cifragem de segredos

### 6.1 Backup

Os planos de add-on variam na política de backup *(a verificar no plano contratado)*. Faça backup lógico próprio, no mínimo diário, guardado fora do Heroku (por exemplo, S3 com versionamento e criptografia):
```sh
mysqldump --single-transaction --routines --triggers --no-tablespaces \
  -h <host> -P <porta> -u <usuario> -p <base> | gzip > agendaspro-$(date +%F).sql.gz
```

Cuidados:
- O dump contém PII e segredos cifrados. Proteja-o como produção.
- O dump **sem** a `APP_ENCRYPTION_KEY` não restaura as integrações (Asaas, Instagram, Google). Guarde a chave separada do dump.

### 6.2 Restauração

1. Restaure numa base nova:
   ```sh
   gunzip -c agendaspro-AAAA-MM-DD.sql.gz | mysql -h <host> -u <usuario> -p <base_nova>
   ```
2. Aponte uma cópia do app ou um ambiente local para a base nova e rode `npm run db:migrate`. É idempotente: completa migrations mais novas que o dump.
3. Valide com `/health/ready` e um login de teste. Depois aponte produção para a base (`config:set DATABASE_URL=...`).
4. Teste a restauração **antes** do lançamento e depois uma vez por trimestre.

### 6.3 `db:encrypt-secrets`

Cifra com AES-256-GCM (`APP_ENCRYPTION_KEY`) as chaves Asaas ainda gravadas em texto puro, vindas de bancos anteriores à F1. É idempotente: ignora o que já está cifrado.
```sh
heroku run npm run db:encrypt-secrets -- --dry-run   # só conta o que seria cifrado
heroku run npm run db:encrypt-secrets
```
Rode **depois** de um backup e com a `APP_ENCRYPTION_KEY` definitiva.

## 7. Custo inicial por serviço

Valores em 2026-11-16. Os itens *(a verificar)* não foram confirmados na fonte.

| Serviço | Plano inicial | Custo/mês | Observações |
|---|---|---|---|
| Heroku dyno | Eco | US$ 5 (pool de 1000 h por conta) | 1 dyno 24×7 usa cerca de 744 h. Com o gatilho horário e tráfego diurno, fica bem menos. Dorme após 30 min. O próximo passo é Basic (US$ 7, não dorme). |
| Banco | JawsDB Leopard | cerca de US$ 10 | Kitefin (grátis, 5 MB) só serve para teste. Alternativa: MariaDB externo gerenciado *(a verificar)*. |
| Gatilho dos jobs | cron-job.org | grátis | Reserva no GitHub Actions: grátis em repositório público. |
| Monitor | UptimeRobot Free | grátis | Só GET, intervalo de 5 min. |
| Site | Cloudflare Pages | grátis | Netlify e Vercel também têm plano grátis. O plano Hobby da Vercel proíbe uso comercial: use Pro ou outro provedor. GitHub Pages proíbe SaaS comercial. |
| Turnstile | Cloudflare | grátis | |
| Asaas | por transação | sem mensalidade | Tarifas por PIX, boleto e cartão conforme a conta *(a verificar)*. Os planos do AgendasPro cobram 5%/0,5%. |
| WhatsApp Cloud | por mensagem (Meta) | variável | Referências: utilidade cerca de R$ 0,035, marketing cerca de R$ 0,32. Conversas de serviço (o cliente escreve primeiro) são grátis dentro da janela, e há cotas grátis *(a verificar na tabela vigente da Meta)*. Lembretes são templates de utilidade. |
| OpenAI | por token | teto por `AI_GLOBAL_DAILY_BUDGET_USD` | Ver abaixo. |
| S3 | por uso | centavos no início | |
| E-mail | Gmail OAuth2 | grátis | O Gmail tem limite diário de envio. Para volume, migre para um provedor transacional. |

**Piso estimado no lançamento:** US$ 15/mês (Eco + Leopard), mais o uso de WhatsApp e IA.

### Custo de IA por interação (`gpt-6-luna`)

O cálculo usa os preços padrão do código (`services/ai/budget.js`): US$ 0,10 por 1M tokens de entrada e US$ 0,50 por 1M de saída. Confirme na tabela da OpenAI.

| Interação | Tokens típicos (estimativa) | Custo |
|---|---|---|
| Mensagem no chat público | cerca de 2000 de entrada (prompt, contexto da empresa, histórico) + até 220 de saída | cerca de US$ 0,0003 |
| Mensagem no assistente do painel | cerca de 4000 de entrada + até 400 de saída | cerca de US$ 0,0006 |
| Resposta do bot de WhatsApp | cerca de 1500 de entrada + 200 de saída | cerca de US$ 0,00025 |

Limites que contêm o gasto:
- **Global:** 2M tokens e US$ 1,00 por dia. É o teto absoluto, cerca de 3 mil mensagens de chat por dia, e no máximo US$ 30/mês.
- **Chat público:** 6000 tokens por sessão, 20000 por empresa por dia e 6000 por IP por dia.
- **Assistente:** 200k por empresa por dia, 80k por usuário por dia e 3M por empresa por mês.
- **Bot de WhatsApp:** 4000 tokens por dia no plano free e 40000 no premium, configurável por empresa.

Complemento obrigatório: o limite mensal de gasto no painel da OpenAI.

## 8. LGPD

Esta seção descreve o que o código faz hoje. Não é parecer jurídico.

**Controlador e operador.** Cada empresa cliente controla os dados dos próprios clientes finais. O AgendasPro atua como operador desses dados e como controlador dos dados das contas do painel.

**Encarregado (DPO).**
- Nome: `<NOME DO ENCARREGADO>`.
- Contato: `<e-mail do encarregado>`.

O contato deve estar publicado na política de privacidade do site.

**Direitos do titular.** O administrador da empresa exerce estes direitos no painel, pelas rotas `/privacy` (ver `routes/privacy.js`):

| Direito | Rota | O que faz |
|---|---|---|
| Acesso e portabilidade | `GET /privacy/customers/:id/export` | Exporta os dados do cliente. |
| Anonimização | `POST /privacy/customers/:id/anonymize` | Troca o nome por "Cliente anonimizado". Apaga telefone, CPF, e-mail, foto e aniversário. Limpa observações e endereço dos agendamentos. Mantém o histórico financeiro e da agenda sem PII. |
| Exclusão | `DELETE /privacy/customers/:id` | Só quando não há histórico financeiro. Caso contrário, responde 409 e a anonimização deve ser usada. |
| Consentimento | `POST /privacy/customers/:id/consents` | Registra consentimento por finalidade: `whatsapp_reminders`, `whatsapp_bot`, `marketing`, `data_processing`. |

Efeitos da anonimização:
- Clientes anonimizados deixam de receber notificações.
- Somem do bot, do assistente e da busca por telefone da reserva pública.
- As fontes de RAG ligadas a eles são removidas.

**Retenção.** Hoje **não há expurgo automático por prazo** de:
- conversas do chat público e do assistente;
- mensagens de WhatsApp;
- leads;
- `ai_usage`;
- jobs concluídos.

Os únicos expurgos automáticos são de dados técnicos: `rate_limits` vencidos e `oauth_states` expirados. Os tokens de gestão de reserva expiram em `PUBLIC_BOOKING_TOKEN_TTL_DAYS` (90 dias).

Antes de crescer, defina uma política, por exemplo:
- conversas de IA: 180 dias;
- leads não convertidos: 12 meses;
- dados financeiros: prazo fiscal.

Depois, implemente os jobs de expurgo. Hoje isso é uma pendência.

**Operadores e subprocessadores**, a listar na política de privacidade:

| Fornecedor | Função |
|---|---|
| Heroku/Salesforce | Hospedagem nos EUA |
| Provedor do banco | Banco de dados |
| AWS S3 | Arquivos |
| Meta | WhatsApp e Instagram |
| OpenAI | IA; os prompts levam contexto mínimo e os dados de cliente são mascarados no assistente |
| Asaas | Pagamentos |
| Google | Agenda e login |
| Cloudflare | Turnstile e site |

Esses fornecedores implicam transferência internacional (art. 33).

**Segurança aplicada:**
- segredos de integração cifrados (AES-256-GCM);
- senhas com bcrypt;
- logs sem corpo, query string, tokens ou PII;
- respostas 500 genéricas com `correlation_id`;
- Turnstile fail-closed;
- rate limits.

## 9. Pendências conhecidas de segurança e operação

- **nodemailer 6.x:** `npm audit --omit=dev` aponta 1 alerta *high*. A correção exige um major (10.x) sem teste automatizado do envio Gmail OAuth2. Atualize com teste manual de envio. A CI roda o audit de forma informativa.
- **Rotação de `APP_ENCRYPTION_KEY`:** não há script (seção 5.5).
- **Expurgo por prazo:** não implementado (seção 8).
- **Desligamento gracioso:** o caminho de SIGTERM real foi testado só em teste unitário, com servidor e pool simulados. No Heroku, confira o log `[shutdown] concluído` no primeiro restart.
- **Limite global:** fica em memória e é por dyno. Com mais de um dyno, cada um conta separadamente.
