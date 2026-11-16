# Contratos F2 (core)

Base: rotas autenticadas exigem `Authorization: Bearer <jwt>` e `Selected-company: <id>`; `company_id`
vem sempre do header validado, nunca do corpo. Corpos e query strings são validados com Joi e
**campos desconhecidos são rejeitados (400)**. Dinheiro em **centavos (inteiros)**, taxas em
**bps** (1 bps = 0,01%). Datas/horas de agenda são **hora de parede no fuso da empresa**
(`YYYY-MM-DD HH:mm[:ss]`).

Formato das rotas novas (F2):

- Sucesso: `{ "data": ... }` (criação responde 201).
- Validação: `400 { "errors": [{ "message", "field" }] }`.
- Negócio: `4xx { "message" }`.
- Limite de plano: `402 { "error": { "code": "plan_upgrade_required", "message", "plan", "quota"?, "limit"?, "used"?, "feature"? } }`.
- Assinatura desligada: `503 { "error": { "code": "billing_disabled", "message" } }`.

RBAC: **membro** = qualquer usuário vinculado à empresa; **admin** = dono/cargo com permissão
de administração (`checkCompanyPermission`), senão 401.

## Planos e assinatura — `/billing`

| Método | Rota | Papel | Corpo / query | Resposta `data` |
|---|---|---|---|---|
| GET | `/billing/plans` | membro | — | `[{ code, name, price_cents, commission_bps, billing_cycle, features, sort_order }]` |
| GET | `/billing/subscription` | membro | — | `Overview` |
| POST | `/billing/subscription` | admin | `{ plan_code: "free"\|"premium", billing_type?: "UNDEFINED"\|"PIX"\|"BOLETO"\|"CREDIT_CARD" }` | `Overview` |
| GET | `/billing/invoices` | admin | — | `[{ id, amount_cents, status, due_date, period_start, period_end, paid_at, invoice_url, plan_code }]` |
| GET | `/billing/commissions` | admin | `?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{ items: [{ id, sale_id, plan_code, commission_bps, gross_cents, commission_cents, split_applied, status, created_at, settled_at }], totals_settled: { gross_cents, commission_cents, net_cents } }` |

`Overview`:

```json
{
  "entitlement": { "plan_code": "free|premium", "plan_name": "...", "commission_bps": 500, "features": {}, "source": "free|paid|grace", "paid_through": "ISO|null", "grace_until": "ISO|null" },
  "subscription": { "status": "pending|active|canceled", "plan_code": "premium", "billing_type": "PIX", "price_cents": 4990, "next_due_date": "YYYY-MM-DD", "canceled_at": null } | null,
  "pending_invoice_url": "https://...|null",
  "subscriptions_enabled": true
}
```

- **Entitlement** é calculado na leitura (sem cron). A empresa é Premium se existe fatura `paid`
  com `period_start <= agora < period_end + BILLING_GRACE_DAYS` (padrão 3). Uma fatura
  `refunded` deixa de valer. Em `source: "grace"` o front deve avisar que o pagamento está
  vencido.
- **Assinar Premium**:
  - O corpo de `POST` é `{ plan_code: "premium" }`. A assinatura nasce `pending` e o plano só
    muda quando o webhook confirma o pagamento; até lá o front mostra `pending_invoice_url`.
  - Repetir o pedido não cria outra assinatura.
  - Com período Premium já pago em curso, a nova cobrança começa ao fim dele.
- **Voltar ao Free** é `{ plan_code: "free" }`: cancela a assinatura no provedor, e o período
  já pago continua valendo até o fim.
- **Features do plano**:
  - `max_professionals` (Free 1).
  - `max_team_users` (Free 2: membros mais convites pendentes).
  - `whatsapp_monthly_messages` (Free 50).
  - `whatsapp_reminder_2h` (só Premium).
  - `null` significa ilimitado.
- **Preço Premium**: `PLAN_PREMIUM_PRICE_CENTS` (padrão 4990).
- **Flag**: com `ASAAS_SUBSCRIPTIONS_ENABLED=true`, as assinaturas são criadas no Asaas com a
  chave principal. Com `false`, `POST premium` responde 503 `billing_disabled`.

## Comissão por venda (split Pix)

- **Onde se aplica**: toda cobrança Pix Asaas, seja `POST /sales/insert_payment` com
  `payment_type: "pix_asaas"` ou o link de pagamento do bot.
- **Como é calculada**: a comissão segue o plano efetivo no momento da cobrança (Free 500 bps,
  Premium 50 bps), com aritmética inteira e arredondamento de meio centavo para cima.
- **Split**: é enviado ao Asaas como `fixedValue` na carteira `ASAAS_MAIN_WALLET_ID`. Sem essa
  carteira, nenhum split é enviado, mas a comissão é registrada assim mesmo (`split_applied:
  false`).
- **Status** em `sale_commissions`:
  - `pending` ao criar a cobrança.
  - `settled` com PAYMENT_RECEIVED/CONFIRMED.
  - `canceled` com OVERDUE/DELETED.
  - `refunded` com REFUNDED.

## Profissionais — `/professionals`

| Método | Rota | Papel | Corpo / query | Resposta `data` |
|---|---|---|---|---|
| GET | `/professionals` | membro | `?include_inactive=true` | `[Professional]` |
| GET | `/professionals/:id` | membro | — | `Professional` |
| POST | `/professionals` | admin | `{ name, email?, phone?, photo_url?, color?: "#RRGGBB", user_id?, service_ids?: [id] }` | `Professional` (201) ou 402 `max_professionals` |
| PATCH | `/professionals/:id` | admin | mesmos campos (todos opcionais), mais `active?: boolean` | `Professional` (reativar conta na quota) |
| DELETE | `/professionals/:id` | admin | — | `{ deactivated: true }` (desativa; histórico mantido) |

`Professional`: `{ id, name, email, phone, photo_url, color, user_id, active, service_ids }`. O
`user_id` precisa ser membro da empresa e os `service_ids`, serviços da empresa (senão 400). Ids
de outra empresa respondem 404.

## Expediente — `/availability-rules`

| Método | Rota | Papel | Corpo / query | Resposta `data` |
|---|---|---|---|---|
| GET | `/availability-rules` | membro | `?professional_id=` | `[{ id, professional_id, weekday, start_time, end_time }]` |
| POST | `/availability-rules` | admin | `{ professional_id, weekday: 0-6 (0=domingo), start_time: "HH:mm", end_time: "HH:mm"\|"24:00" }` | regra (201) |
| PUT | `/availability-rules/professional/:id` | admin | `{ rules: [{ weekday, start_time, end_time }] }` | regras do profissional (substitui todas) |
| DELETE | `/availability-rules/:id` | admin | — | `{ deleted: true }` |

Intervalos sobrepostos no mesmo dia, ou com fim antes do início, respondem 400. Um profissional
**sem regras** atende a qualquer hora (comportamento legado).

## Bloqueios — `/time-blocks`

| Método | Rota | Papel | Corpo / query | Resposta `data` |
|---|---|---|---|---|
| GET | `/time-blocks` | membro | `?from=&to=&professional_id=` (YYYY-MM-DD HH:mm) | `[{ id, professional_id, starts_at, ends_at, reason }]` |
| POST | `/time-blocks` | admin | `{ professional_id?: id\|null, starts_at, ends_at, reason? }` | bloqueio (201) |
| DELETE | `/time-blocks/:id` | admin | — | `{ deleted: true }` |

Com `professional_id` nulo, o bloqueio vale para a empresa inteira (feriado).

## Agendamentos (alteração)

- `POST /appointments` e `PATCH /appointments/:id` aceitam `professional_id?: id|null`. No
  PATCH, omitir o campo mantém o atual.
- **Validações**: o profissional precisa estar ativo e ser da empresa. O horário não pode
  conflitar com o mesmo profissional nem com agendamentos sem profissional. Não pode cair em
  bloqueio (da empresa ou do profissional) e precisa caber no expediente do profissional,
  quando houver. Qualquer violação responde 400 com `message`.
- **Sem profissional**: vale a regra legada de conflito na empresa inteira, mais os bloqueios
  da empresa.
- `GET` passa a devolver `professional_id`.

## Fuso da empresa — `/companies/timezone`

| Método | Rota | Papel | Corpo | Resposta (`returnObj`, formato legado) |
|---|---|---|---|---|
| GET | `/companies/timezone` | membro | — | `{ timezone: "IANA"\|null, effective }` |
| PUT | `/companies/timezone` | admin | `{ timezone: "America/Manaus"\|null }` | `{ timezone, effective }` |

O valor `null` volta para `APP_TIMEZONE` (padrão `America/Sao_Paulo`).

## Lembretes

- **Gatilho**: horário (`POST /internal/jobs/tick`), com janelas tolerantes a atraso.
- **24h**: o agendamento começa entre agora + 1h e agora + 24h30. Todos os planos.
- **2h**: o agendamento começa entre agora + 1h e agora + 2h30. Só Premium (feature
  `whatsapp_reminder_2h`). Com o 2h ativo, o de 24h é suprimido quando faltam 3h ou menos, para
  não mandar duas mensagens seguidas.
- **Idempotência**: dedupe por agendamento e horário. Os flags `notified_1h` e `notified_2h` são
  zerados quando o horário muda.
- **Quota**: o envio respeita `whatsapp_monthly_messages`.

## Estáticos

- Os arquivos estáticos do core saíram de `/public` e agora ficam em `/static`, por exemplo
  `/static/default-user-image.png`. O prefixo `/public` fica livre para a API pública da F3.
- **Compatibilidade**: `/public/uploads/:arquivo` responde 301 para `/static/uploads/:arquivo`.
  Qualquer outra rota `/public/*` responde 404 JSON.

## Banco

- **Migrations**:
  - `005_f2_billing`: `plans` (seed free/premium), `company_subscriptions`,
    `subscription_invoices`, `sale_commissions`, `usage_counters`.
  - `006_f2_professionals`: `companies.timezone`, `professionals`, `professional_services`,
    `availability_rules`, `time_blocks`, `appointments.professional_id` e
    `appointments.notified_2h`.
- **Compatibilidade**: as duas são aditivas, retrocompatíveis e idempotentes no runner.
- **Fonte da verdade**: as migrations. `sql/structure.sql` era um snapshot legado; no
  follow-up 1 (D7) foi regenerado a partir das migrations (ver `contratos-followup1.md`).

## Variáveis novas (`.env.example`)

- `PLAN_PREMIUM_PRICE_CENTS`
- `BILLING_GRACE_DAYS`
- `ASAAS_SUBSCRIPTIONS_ENABLED`
- `ASAAS_MAIN_WALLET_ID` já existia; agora é usada no split.
