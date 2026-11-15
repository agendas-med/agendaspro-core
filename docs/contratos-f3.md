# Contratos F3 (core) — API pública de agendamento

Prefixo `/public`, sem autenticação. A empresa vem **sempre do slug** (nunca do corpo/query).
Corpos e queries validados com Joi; **campos desconhecidos = 400**. Dinheiro em **centavos**.
Datas/horas são **hora de parede no fuso da empresa** (`timezone` IANA na resposta).

## Formato comum

- Sucesso: JSON direto (sem `{data}`), 200/201.
- Erro: `{ "error": { "code", "message" } }`; 429 traz `Retry-After` (segundos); 500 traz
  `error.correlation_id` e nunca detalhes internos.
- Headers: CORS só para `PUBLIC_CORS_ORIGINS` (vírgula; fallback `URL_SITE`; em não-produção sem
  lista, aberto), métodos GET/POST, sem credenciais. `Content-Security-Policy: default-src 'none';
  frame-ancestors 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `nosniff`.
  Corpo máx. 32 KB (413 `payload_too_large`). Rota inexistente: 404 `not_found`.
- O `manage_token` some do log de acesso (`/public/bookings/[token]`).

| code | status | quando |
|---|---|---|
| `validation_error` | 400 | Joi, JSON inválido, data inexistente, serviço/profissional de outra empresa, período > 14 dias |
| `consent_required` | 400 | `consent` diferente de `true` |
| `turnstile_failed` | 400 | token Turnstile ausente/recusado |
| `not_found` | 404 | slug inexistente/página desligada, token inválido ou adulterado |
| `token_expired` | 410 | token válido porém expirado |
| `slot_taken` | 409 | horário ocupado, fora do expediente/antecedência mínima/horizonte |
| `idempotency_conflict` | 409 | mesma `idempotency_key` com dados diferentes |
| `already_cancelled` · `not_allowed` · `cancel_window_closed` | 409 | gestão por token |
| `rate_limited` | 429 | limites abaixo |
| `payment_unavailable` | 503 | sinal exigido e Asaas indisponível/falhou (reserva desfeita) |
| `service_unavailable` | 503 | Turnstile sem segredo em modo verify, segredo de token ausente |
| `payload_too_large` | 413 | corpo > 32 KB |
| `internal_error` | 500 | demais |

## Rotas

### `POST /public/leads`
Corpo `{ name, whatsapp, email?, segment, source? (padrão "site", máx. 80), message?, consent?, turnstile_token }`
→ **201** `{ ok: true }`. Grava em `leads` com `consent_at`; job `lead_notify` avisa o comercial
(`SALES_NOTIFY_EMAIL` e/ou `SALES_NOTIFY_WHATSAPP`). WhatsApp inválido → 400.

### `GET /public/b/:slug`
```
{ company: { name, slug, logo_url, description, address, phone, timezone, hours, instagram_url,
             theme: { primary_color|null }, powered_by: boolean },
  services: [{ id, name, description, duration_min, price_cents, deposit_cents, requires_payment }],
  professionals: [{ id, name, photo_url, service_ids: [...] }] }
```
- Só com `public_page_enabled = 1` e feature `public_page` do plano; senão 404.
- `powered_by` = feature `public_page_branding` (Free true, Premium false); `theme.primary_color` só com `theme_custom` (Premium).
- Serviços: `online_booking = 1`; serviços com sinal ficam ocultos se a empresa não tem Asaas aprovado (+ feature `deposit_pix`).
- Profissionais: ativos, com expediente e vinculados a algum serviço listado.

### `GET /public/b/:slug/availability?service_id=1[,2..5]&professional_id?&from=YYYY-MM-DD&to=YYYY-MM-DD`
→ `{ timezone, days: [{ date, slots: [{ start: "HH:mm", professional_id }] }] }`
- Máx. 14 dias. `service_id` aceita lista (duração somada). Sem `professional_id` = qualquer
  profissional apto a **todos** os serviços (um slot por profissional livre).
- Considera expediente (`availability_rules`), bloqueios, agendamentos que ocupam a agenda
  (inclusive reservas com sinal pendente dentro do prazo), antecedência mínima e horizonte.

### `POST /public/b/:slug/bookings`
```
{ service_ids: [1..5 únicos], professional_id: id|null, start: "YYYY-MM-DDTHH:mm",
  customer: { name, phone, email?, cpf? }, consent: true,
  source: "instagram"|"qr"|"link"|"whatsapp"|"site", idempotency_key: /^[A-Za-z0-9_-]{8,64}$/,
  turnstile_token }
```
→ **201** `{ booking, payment?, manage_token }` (formato de `booking` abaixo).
- Reenvio com a mesma `idempotency_key` (por empresa) e mesmos dados → **200** com a mesma
  reserva/token/Pix, sem consumir Turnstile nem limites; dados diferentes → 409.
- Ordem: consentimento → idempotência → Turnstile → limites → transação (trava a empresa,
  `ensureSlot` por profissional candidato). Dupla reserva concorrente: uma 201, demais 409.
- Cliente reaproveitado pelo telefone (dígitos nacionais) dentro da empresa; cadastro existente
  não é sobrescrito. Consentimento LGPD gravado em `consents` (`public_booking`, `public:<source>`).
- Cria agendamento (`source`), serviços, venda `em_aberto` e `public_bookings`.
- **Sinal**: soma de `deposit_cents` dos serviços (limitada ao total). Gera Pix Asaas com split/comissão
  da F2 (`SALE_<id>`), status `pending_payment` com prazo `booking_hold_minutes` (padrão 15). Falha no
  Asaas → reserva cancelada e 503 `payment_unavailable`. Sem sinal → `confirmed` + job de confirmação.

### `GET /public/bookings/:manage_token`
```
{ booking: { id, status: "confirmed"|"pending_payment"|"cancelled"|"completed", cancellation_reason?,
             start: "YYYY-MM-DDTHH:mm", end, service_ids, service_names, professional_id,
             professional_name, deposit_cents },
  company: { name, slug, address, phone, timezone },
  policy: { can_cancel, can_reschedule, min_notice_hours },
  payment?: { provider: "asaas", amount_cents, pix_qr_base64, pix_copy_paste, expires_at } }
```
- `payment` só enquanto `pending_payment`. Sem dados do cliente.
- `cancellation_reason`: `customer`, `company`, `payment_expired`, `payment_failed`, `paid_after_expiry`.
- **Expiração na leitura (sem cron)**: sinal não pago após o prazo aparece como
  `cancelled/payment_expired` e deixa de ocupar a agenda (view `appointment_status_view` = `cancelado`).

### `POST /public/bookings/:manage_token/cancel` `{}` · `POST .../reschedule` `{ start }`
→ 200 com a mesma visão. Cancelar respeita `booking_cancel_notice_minutes` (padrão 120);
remarcar só reservas `confirmed`, mesmo profissional, mesma checagem de vaga/antecedência/horizonte.
Cancelar marca a venda `cancelada` e tenta cancelar Pix pendente.

## manage_token
`v1.<public_id>.<exp_unix>.<hmac>`; HMAC-SHA256 com `PUBLIC_BOOKING_TOKEN_SECRET` (≥ 32 caracteres,
senão 503), comparação em tempo constante, validade `PUBLIC_BOOKING_TOKEN_TTL_DAYS` (padrão 90, 1–365)
contada da criação e gravada em `public_bookings.token_expires_at`. Determinístico (reenvio
idempotente e links da fila devolvem o mesmo token).
Link enviado ao cliente: `${PUBLIC_SITE_URL}/agendamento/<token>`.

## Segurança e limites (tabela `rate_limits`, por janela)
| chave | padrão | env |
|---|---|---|
| leitura por IP (`/b/*`) | 300 / 10 min | — |
| gestão por IP (`/bookings/*`) | 60 / 10 min | — |
| leads por IP | 5 / h | `PUBLIC_LEADS_IP_MAX` |
| leads por WhatsApp | 3 / dia | `PUBLIC_LEADS_PHONE_MAX` |
| reservas por IP | 10 / h | `PUBLIC_BOOKING_IP_MAX` |
| reservas por telefone por empresa | 5 / dia | `PUBLIC_BOOKING_PHONE_MAX` |
| slugs inexistentes por IP (anti-enumeração) | 20 / h → bloqueia `/b/*` | `PUBLIC_SLUG_MISS_MAX` |

Turnstile: `TURNSTILE_SECRET_KEY` (+ `TURNSTILE_VERIFY_URL` opcional). **Produção sempre verifica**
(fail closed: sem segredo ou erro de rede → 503). Fora de produção, bypass só com
`TURNSTILE_ENABLED=false` **e** `TURNSTILE_DEV_BYPASS=true`.

## Painel — `/public-page` (Bearer + `Selected-company`, resposta `{data}`)
- `GET /public-page` (membro) → `{ slug, public_page_enabled, public_description, logo_url, instagram_url,
  public_hours, theme_primary_color, booking_min_notice_minutes, booking_cancel_notice_minutes,
  booking_hold_minutes, booking_slot_step_minutes, booking_horizon_days }`.
- `PUT /public-page` (admin) com qualquer subconjunto. Slug 3–60 `[a-z0-9-]`, sem hífen duplo/borda,
  palavras reservadas → 400; em uso → 409; publicar sem slug → 400. URLs só https.
- `PUT /public-page/services/:id` (admin) `{ online_booking?, public_description?, deposit_cents? (0 ou ≥ 500) }`.
- Empresa nova recebe slug gerado do nome (sufixo aleatório se ocupado); existentes definem no painel.
  Página nasce desligada.

## Notificações (fila `jobs`, sem processo sempre ligado)
- `lead_notify`: e-mail (`config/email`, exige `USER_EMAIL`) e/ou WhatsApp ao comercial.
- `booking_confirmation`: ao cliente na criação sem sinal, no webhook de sinal pago e na remarcação;
  WhatsApp se o plano permite e há quota (`whatsapp_monthly_messages`), senão e-mail. Lembretes da F2
  ignoram reservas com sinal pendente.

## Migração
`sql/migrations/007_f3_public.sql` (idempotente): colunas de página/política em `companies`
(`slug` único), `services.online_booking/public_description/deposit_cents`,
`appointments.hold_expires_at/source`, tabelas `public_bookings` e `leads`.

## Riscos / pendências
- Sinal pago após expirar com vaga já tomada: reserva fica cancelada (`paid_after_expiry`,
  `conflict_at`) e o **estorno é manual** (log `[public]`).
- Venda de sinal expirado permanece `em_aberto` (não aparece na agenda; limpeza futura).
- Ordem de travas difere entre webhook (venda → agendamento) e cancelamento (empresa → agendamento →
  venda): deadlock possível e raro; o Asaas reenvia o webhook.
- Reenvio idempotente durante a criação do Pix pode voltar sem `payment` (ler pelo token depois).
- Asaas pode exigir CPF do pagador: `customer.cpf` opcional.
- Split/Pix exercitados só com stub; não validados contra a API real do Asaas.
