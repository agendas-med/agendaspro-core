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
