# Contratos F5-A (core) — chat público de texto e infraestrutura de IA

Prefixo `/public/chat`, montado dentro de `/public` (mesmo CORS, cabeçalhos de segurança, corpo máx.
32 KB e formato de erro de `docs/contratos-f3.md`). Só **texto**. Desligado por padrão:
`PUBLIC_CHAT_ENABLED=true` liga; senão toda rota responde **503 `chat_disabled`**.

CORS: `allowedHeaders` = `Content-Type, Accept, Authorization`; `exposedHeaders` = `Retry-After`
(o front lê o tempo de espera em 429).

## Autenticação

`POST /public/chat/session` devolve `session_token` (`cs1.<id>.<exp_ms>.<hmac>`). As demais rotas
exigem `Authorization: Bearer <session_token>`; inválido/adulterado → 401 `invalid_session`,
expirado → 401 `session_expired` (o front abre outra sessão). Sem cookie, sem credenciais CORS.
A empresa vem **só** do `company_slug` informado na criação (gravado na sessão), nunca de mensagens.

## Erros específicos

| code | status | quando |
|---|---|---|
| `chat_disabled` | 503 | flag desligada |
| `service_unavailable` | 503 | Turnstile sem segredo; sem `PUBLIC_CHAT_TOKEN_SECRET` e sem `PUBLIC_BOOKING_TOKEN_SECRET` |
| `validation_error` | 400 | Joi (campos desconhecidos, `audience` ausente/inválido) |
| `turnstile_failed` | 400 | token Turnstile ausente/recusado |
| `not_found` | 404 | `company_slug` inexistente ou página desligada (conta no anti-enumeração do chat, `public:chat-slugmiss`, separado do de `/public/b/:slug`; não gasta a cota de sessões do IP) |
| `invalid_session` · `session_expired` | 401 | token |
| `session_blocked` | 403 | sessão bloqueada por tentativas de injeção |
| `message_too_long` | 413 | mensagem acima de `PUBLIC_CHAT_MESSAGE_MAX_CHARS` (padrão 500) |
| `in_progress` | 409 | mesmo `client_msg_id` ainda sem resposta (`Retry-After: 2`) |
| `session_closed` | 409 | sessão encerrada |
| `lead_exists` · `already_rated` | 409 | lead/avaliação já enviados nesta sessão |
| `rate_limited` | 429 | sessões por IP/dia, mensagens/min por IP ou sessão, limites de lead |
| `too_fast` | 429 | intervalo mínimo entre mensagens (`PUBLIC_CHAT_DEBOUNCE_MS`) |
| `message_limit` | 429 | teto de mensagens da sessão |
| `cooldown` | 429 | pausa após 3 tentativas de injeção (`Retry-After`) |

## Rotas

### `POST /public/chat/session`
Corpo `{ audience: "business"|"customer" (obrigatório), turnstile_token, company_slug? }`.
`company_slug` só vale com `audience=customer` (chat da página `/b/{slug}`); com `audience=business`
é ignorado (follow-up 1; antes era 400) e a sessão sai com `company:null`.
→ **201** `{ session_token, expires_at, limits:{max_messages,max_tokens,max_chars}, audience, company:{name,slug}|null }`.
Limite `PUBLIC_CHAT_SESSIONS_PER_IP_DAY` (padrão 10), contado só em sessões criadas (Turnstile recusado
e 404 de slug não consomem).

### `POST /public/chat/message`
Corpo `{ message (1..max_chars), client_msg_id? (^[A-Za-z0-9_-]{8,64}$) }`.
→ **200** `{ reply, suggestions[], actions[], proactive_hint|null, source, degraded?, replayed?, cooldown_seconds?, remaining:{messages,tokens} }`.
- `source`: `faq` (determinística), `ai`, `fallback`, `refusal` (tópico proibido), `guard` (injeção ou saída bloqueada).
- Reenvio com o mesmo `client_msg_id` devolve a mesma resposta com `replayed:true` (não conta mensagem).
- `degraded:true`: IA indisponível (orçamento, breaker, erro, timeout); a resposta é determinística e
  traz ação de contato.
- **SSE**: com `Accept: text/event-stream` (ou `?stream=1`) a resposta é `text/event-stream` com
  eventos `delta` `{text}` e um `done` com o JSON completo acima. Erros continuam HTTP + JSON.

`actions[]` (a IA não escolhe ações livres; vêm da FAQ ou da intenção na allowlist):

| type | campos |
|---|---|
| `link` | `label`, `url` (só domínios permitidos) |
| `plans` | `plans:[{code,name,price_cents,commission_bps}]` |
| `lead_form` | `endpoint:"/public/chat/lead"`, `requires_consent:true` |
| `handoff` | `label`, `url` (wa.me do estabelecimento ou da plataforma) |
| `slots` | `service_id`, `slots:[{date:"YYYY-MM-DD",time:"HH:mm"}]` (até 6), `booking_url` |

`proactive_hint` (regra fixa): `{type, text, action}` — `signup` após pergunta de planos;
`lead_form` a partir da 3ª mensagem (empresa, sem lead); `booking_link` no chat de uma página `/b/{slug}`.

**Garantias**: a IA nunca agenda, cancela, cobra nem grava dados; a reserva acontece só pela página
`/b/{slug}` (contratos F3). Preços/comissões vêm da tabela `plans`, nunca escritos à mão.

### `GET /public/chat/session`
→ `{ audience, status, expires_at, company, limits, remaining, messages:[{id,role,content,created_at,suggestions?,actions?}] }` (últimas 40).

### `POST /public/chat/session/close`
→ `{ ok: true }`. Mensagens seguintes → 409 `session_closed`.

### `POST /public/chat/rating`
Corpo `{ rating: 1..5, comment? (máx. 500) }` → `{ ok: true }`; uma vez por sessão.

### `POST /public/chat/lead`
Só `audience=business`. Corpo `{ name, whatsapp, email?, segment? (padrão "não informado"), message?, consent: true }`
→ **201** `{ ok, reply }`. Grava em `leads` com `source="chat"` e `consent_at`; job `lead_notify`.
Um por sessão; aplica os limites de `/public/leads` (por IP e por WhatsApp).

## Ordem de defesa por mensagem

1. flag e token; 2. limites por IP e por sessão (banco); 3. idempotência; 4. portão atômico
(sessão ativa, não expirada, fora de cooldown, abaixo do teto, fora do debounce); 5. guarda anti-injeção
(heurística normalizada: leet, espaçado, base64, rot13) → recusa sem IA, strikes (cooldown na 3ª,
bloqueio na 5ª); 6. tópicos proibidos → recusa fixa; 7. FAQ/dados públicos; 8. IA só em ambiguidade,
com reserva de orçamento por sessão/IP/empresa/global e circuit breaker; 9. filtro de saída (canário,
trechos do prompt, links fora da allowlist, telefones/e-mails/CPF não permitidos, marcação).

Prompt da IA: instruções fixas + dados entre tags (`<conhecimento>`, `<dados_estabelecimento>`,
`<resumo>`, `<mensagem_visitante>`) tratados como DADO, escapados; histórico curto (4 mensagens não
sinalizadas); resposta em JSON estrito `{intent (allowlist), reply, suggestions}`.

## Tabelas (migração 009)

`chat_sessions`, `chat_messages` (único por `session_id + client_msg_id`), `ai_usage` (tokens e custo
por chamada), `ai_budget_counters` (contadores diários por escopo), `ai_circuit` (breaker). IP só como
HMAC. Nenhum estado em memória (dyno Eco).

## Variáveis

Ver `.env.example`, blocos "F5: infraestrutura de IA" e "F5: chat público".
