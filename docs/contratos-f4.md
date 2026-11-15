# Contratos F4 (core) — correções de agenda e WhatsApp Cloud API

## Parte A — hora de parede e filtros

### Datas de agenda = hora de parede, sem offset
Todas as datas **de agenda** saem como `"YYYY-MM-DD HH:mm:ss"` (hora de parede no fuso da
empresa, sem `Z` nem offset), formatadas no SQL com `DATE_FORMAT` — não dependem mais do
`timezone: '-03:00'` do pool.

| rota | campos |
|---|---|
| `GET /appointments`, `GET /appointments/:id` | `date`, `start`, `end` (= `date + duration`), `checkin`, `checkout` |
| `GET /customers` | `last_appointment`, `next_appointment` |
| `GET /financial/*` (contas a receber de agendamentos) | `due_date` |
| `GET /time-blocks` | `starts_at`, `ends_at` (já eram parede; agora via SQL) |
| exportação LGPD (`/privacy`) | `appointments[].date` |

Antes: `date`/`start` eram `Date` serializado (`...T12:00:00.000Z` = parede + 3h) e `end` ISO
com `Z`. O front (`utils/payloads.js#coreWall`) já aceita valores sem offset e os mantém;
`moment("YYYY-MM-DD HH:mm:ss")` lê como hora local. Nenhuma mudança obrigatória no front.

Continuam **instantes** do relógio do servidor (sessão `-03:00`), não hora de parede da empresa:
`created_at`, `updated_at`, `hold_expires_at`, `token_expires_at` e afins.
Entrada (POST/PATCH) não mudou: hora de parede `YYYY-MM-DD HH:mm[:ss]`.

### `GET /appointments?professional_id=N[&include_unassigned=true]`
- `professional_id` (inteiro > 0; inválido → 400): só os agendamentos desse profissional.
- `include_unassigned=true|1`: soma os agendamentos sem profissional (`professional_id NULL`).
- Combina com `start`/`end`/`today`. Sempre dentro da empresa da sessão (profissional de outra
  empresa → lista vazia).

### `GET /time-blocks?professional_id=N[&include_company_blocks=false]`
- Com `professional_id`: bloqueios do profissional **mais** os da empresa inteira
  (`professional_id NULL`, ex.: feriado) — padrão `include_company_blocks=true`.
- `include_company_blocks=false|0`: só os do profissional.
- Sem `professional_id`: todos os bloqueios da empresa.

## Parte B — WhatsApp Cloud API oficial (módulo do core)

Um número da plataforma (`whatsapp_accounts`, via `META_PHONE_NUMBER_ID`). Sem whatsapp-web.js.
Liga com `WHATSAPP_CLOUD_ENABLED=true` (sem isso, avisos são pulados com `not_configured`).

### Webhook da Meta — `GET|POST /webhook/meta`
- `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → 200 com o challenge (texto) ou 403.
- `POST`: corpo cru; `X-Hub-Signature-256: sha256=<hmac>` com `META_APP_SECRET`, comparação em
  tempo constante. Assinatura inválida/ausente → 401; JSON inválido → 400; falha ao registrar → 500
  (a Meta reentrega); senão 200 `{received:true}` imediato.
- Dedupe em `inbound_events` (`provider='meta'`, `msg:<wamid>` / `st:<wamid>:<status>`), depois job
  `whatsapp_inbound` (dedupe `wa_in:<id>`). Se enfileirar falhar o registro é desfeito.
- `phone_number_id` desconhecido é ignorado. Rate limit por telefone: `WHATSAPP_INBOUND_MAX`/min (20).

### Bot (máquina de estados determinística)
- Empresa: pela conversa atual ou pelo slug da página pública ("Agendar <slug>", link `wa_link`).
  Exige `public_page_enabled`.
- Agendar: serviço → profissional (pulado se único) → dia → horário (disponibilidade F2/F3) → nome
  → confirmar (aviso LGPD). Grava com `source='whatsapp'`; sinal Pix vem em mensagem separada
  (copia-e-cola). Meus agendamentos / cancelar / remarcar seguem as regras F3, só os do telefone.
- "menu", "trocar", "atendente" (handoff para humano) a qualquer momento.

### IA (`OPENAI_MODEL_DEFAULT`, padrão `gpt-6-luna`)
- Só para texto livre que o parser não entendeu. Saída `json_schema` estrito, sem tools; allowlist
  de intents e de ids (só serviços/profissionais da empresa; resto vira `null`).
- Texto do cliente vai delimitado e escapado (`<mensagem_cliente>`), nunca como instrução.
- Teto diário de tokens por empresa em `ai_usage_daily` (reserva atômica + conciliação com o uso
  real). Plano: `whatsapp_ai_daily_tokens` (free 4000, premium 40000); a empresa pode baixar via
  `ai_daily_token_limit`. Sem saldo: o bot só repergunta.

### Consentimento (LGPD)
- Opt-in registrado na primeira mensagem do cliente (`opt_in_at`, `opt_in_source`).
- `PARAR`/`SAIR`/`STOP`: opt-out em toda a plataforma; um aviso e depois silêncio; avisos pulados
  (`opted_out`) e atendente recebe 409 `opted_out`. `VOLTAR` reativa.

### Janela de 24h e modelos
- Dentro de 24h da última mensagem do cliente: texto livre. Fora: só modelo `approved`.
- Modelos semeados como `pending` (aprovar na Meta e marcar `approved`):
  `agendamento_lembrete`(4), `agendamento_confirmado`(4), `agendamento_remarcado`(4),
  `atendimento_retomar`(1), `lead_novo`(4) — idioma `pt_BR`, categoria UTILITY.
- Lembretes 24h e 2h usam `agendamento_lembrete` fora da janela.

### Limite mensal e entrega
- `whatsapp_monthly_messages` em `usage_counters` (Free = 50). Contam avisos (lembrete/confirmação)
  e mensagens de atendente; respostas do bot não contam. No limite: aviso pulado (`quota`),
  atendente 402 `plan_upgrade_required`.
- Erro 5xx/rede da Meta: retentado pelo job com backoff; 4xx definitivo: `failed` sem retentar.
- Status (`sent→delivered→read`, `failed`) monotônico em `whatsapp_messages`.

### Painel — `/whatsapp/*` (JWT + `Selected-company`; `company_id` sempre da sessão)
| Método e rota | Papel | Notas |
|---|---|---|
| `GET /whatsapp/status` | membro | `enabled`, `wa_link`, `settings` (sem segredos) |
| `PUT /whatsapp/config` | admin | `bot_enabled`, `ai_enabled`, `welcome_text`, `ai_daily_token_limit` |
| `GET /whatsapp/conversations` | membro | `mode`, `assigned_to_me`, `limit≤100`, `offset`; inclui `window_open` |
| `GET /whatsapp/conversations/:id` | membro | 404 `conversation_not_found` fora da empresa |
| `GET /whatsapp/conversations/:id/messages` | membro | `before_id`, `limit≤200` |
| `POST /whatsapp/conversations/:id/assume` | membro | modo `human` (bot calado) |
| `POST /whatsapp/conversations/:id/release` | membro | volta ao bot (auto após `WHATSAPP_HUMAN_TIMEOUT_H`, 12h) |
| `POST /whatsapp/conversations/:id/messages` | membro | `{text}` xor `{template, params[]}` → 201; 409 `window_closed`/`opted_out`/`template_unavailable`; 400 `template_params`; 402 `plan_upgrade_required` |
| `GET /whatsapp/templates` | membro | nome, finalidade, `param_count`, status |
| `GET /whatsapp/usage?period=YYYY-MM` | membro | plano, mensagens usado/limite, `breakdown` por status, IA |

### Legado descontinuado
`POST /webhook/whatsapp` (relay whatsapp-web.js) responde 410. `WHATSAPP_LEGACY_RELAY=true`
reativa temporariamente. O repositório whatsapp-bot fica sem uso: desligar o processo e remover
`WHATSAPP_API_URL`/tokens do relay após a virada.

### Configuração na Meta (manual)
1. App Meta (Business) com o produto WhatsApp; WABA e número verificados → `META_WABA_ID`,
   `META_PHONE_NUMBER_ID`, `WHATSAPP_DISPLAY_PHONE`.
2. System User com token permanente (`whatsapp_business_messaging`, `whatsapp_business_management`)
   → `META_ACCESS_TOKEN`. App Secret → `META_APP_SECRET`.
3. Webhook: `https://<api>/webhook/meta`, verify token = `META_VERIFY_TOKEN`, assinar o campo `messages`.
4. Criar e aprovar os 5 modelos acima (texto em `sql/migrations/008_f4_whatsapp.sql`) e marcar
   `approved` em `whatsapp_templates`.

### Riscos conhecidos
- Resposta do bot que falhou não é reenviada em retry (o dedupe por wamid barra o reprocessamento).
- Conversa pertence a uma empresa por vez (trocar de empresa via slug).
- Agendamento pelo bot: só números BR; listas com até 10 itens.
- Payload do job guarda o texto da mensagem (dado pessoal; limpar jobs antigos).
