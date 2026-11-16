# Contratos: Core follow-up 1

Ajustes do core após F1–F5. Todos são **compatíveis** com os contratos anteriores, salvo quando a seção diz "mudança de comportamento". As mudanças pontuais de F4, F5-A e F5-B também estão anotadas nos respectivos `contratos-*.md`; este arquivo reúne os itens novos.

## D1. Foto do profissional (upload no core)

O dyno do Heroku tem disco efêmero, e o fallback local de `config/s3.js` (`static/uploads`) perde arquivos a cada deploy. Por isso a foto do profissional fica no banco (`professional_photos`, migração 015), sem depender de S3.

| Método | Rota | Papel | Corpo / resposta |
| --- | --- | --- | --- |
| `POST` | `/professionals/:id/photo` | admin | `{ "image": "data:image/png;base64,..." }` → `200 {data: <profissional>}` com `photo_url` preenchida |
| `DELETE` | `/professionals/:id/photo` | admin | `200 {data: <profissional>}`; `photo_url` vira `null` se apontava para a foto do core |
| `GET` | `/files/professional-photo/:id/:hash` | pública | bytes da imagem |

Regras:

- **Formatos aceitos:** só PNG, JPEG e WebP, enviados como data URL base64.
- **Validação pelos bytes:** o tipo é conferido pelos primeiros bytes (magic number) e tem de bater com o tipo declarado. SVG, GIF, HTML disfarçado ou URL dão `400`.
- **Limite de tamanho:** `PROFESSIONAL_PHOTO_MAX_BYTES` (padrão 1 MiB decodificado). Acima disso a resposta é `413`. O corpo JSON dessa rota aceita até 2 MB, então valores acima de ~1,4 MiB não têm efeito.
- **URL:** `photo_url` = `<PUBLIC_API_URL>/files/professional-photo/<id>/<16 hex do sha256>`.
  - A URL muda a cada troca de imagem; a antiga passa a responder `404`.
  - Cache: `public, max-age=31536000, immutable`.
  - Cabeçalhos de segurança: `X-Content-Type-Options: nosniff` e `Content-Security-Policy: default-src 'none'; sandbox`.
- **Pública por design:** a foto já aparece na página pública. Sem o hash da versão atual, a rota dá `404`.
- **Isolamento:**
  - profissional de outra empresa: `404`;
  - membro não admin: `401` (mesmo comportamento das demais rotas admin de `/professionals`).
- **`photo_url` externa:** o `PATCH /professionals/:id` com `photo_url` continua aceito. `DELETE .../photo` não apaga uma URL externa.
- **Exclusão:** a foto some junto com o profissional ou a empresa (`ON DELETE CASCADE`).

## D2. Vínculo profissional ↔ usuário (`professionals.user_id`)

O campo `user_id` já era aceito em `POST`/`PATCH /professionals`. O que mudou:

| Método | Rota | Papel | Resposta |
| --- | --- | --- | --- |
| `GET` | `/professionals/members` | admin | `{data: [{user_id, name, email, professional_id}]}`: membros da empresa e o profissional **ativo** vinculado (ou `null`), para o seletor do painel |
| `GET` | `/professionals/me` | membro | `{data: <profissional> \| null}`: o profissional ativo do usuário logado nesta empresa |

Regras do vínculo:

- **Um vínculo por usuário:** cada usuário fica ligado a no máximo **um profissional ativo** por empresa. Se ele já estiver ligado a outro, a resposta é `409 {error: {code: "professional_user_taken", message, professional_id}}`, onde `professional_id` é o profissional que já tem o vínculo.
  - Isso vale para criar, para `PATCH` com `user_id` e para reativar (`active: true`).
  - A checagem roda com a empresa travada (`FOR UPDATE`), então duas requisições simultâneas não criam vínculo duplicado.
- **Desativar libera o usuário:** um profissional desativado não segura o vínculo.
- **Usuário de outra empresa:** `400`, como antes.
- **Saída da empresa:** quando o usuário é removido (`DELETE /companies/remove_user/:id`), o `user_id` dos profissionais dele vira `null`. O profissional continua existindo.

## D3. Quota `max_team_users` atômica

O uso da quota é a soma de **membros** e **convites pendentes não vencidos**. Free tem limite 2; Premium é ilimitado.

- **Convite (`POST /companies/invite_user`):**
  - A empresa é travada (`SELECT … FOR UPDATE`) e a contagem e o `INSERT` do convite rodam na mesma transação. Convites simultâneos não passam do limite.
  - Acima do limite, a resposta é `402 {error: {code: "plan_upgrade_required", quota: "max_team_users", limit, used, plan}}`, igual a antes.
  - O e-mail sai depois do commit.
- **Aceite (`POST /companies/enter_company`):** o convite pendente já está contado, então aceitar não aumenta o uso. O aceite só é recusado com o mesmo `402` se a equipe já estiver **acima** do limite, por exemplo depois de um downgrade. Nesse caso o convite continua pendente.
  - Mudança de comportamento: antes, o aceite entrava sem checar a quota.
  - Os demais erros do aceite continuam `400`.

## D4. Agendamento do bot sempre com profissional

- Booking público (`/public/.../appointments`) e o bot F4 já escolhiam um profissional apto e livre. Isso não mudou.
- O **bot legado do WhatsApp** (`/webhook`, `openaiService`) criava agendamentos com `professional_id = NULL`. Agora usa `autoAssign`:
  - Candidatos: profissionais **ativos** que atendem **todos** os serviços do agendamento, em ordem de id.
  - Fica com o primeiro sem conflito no horário.
  - Se todos estão ocupados, a criação falha com o erro de horário ocupado (`slot_taken`, "Nenhum profissional disponível neste horário.").
  - Se nenhum profissional atende os serviços, o agendamento continua sem profissional, como antes. Assim, empresas sem cadastro de profissionais não quebram.
- O painel (`POST /appointments`) e as ferramentas do assistente (F5-B) **não mudaram**: sem `professional_id`, continuam sem profissional.
## D5. Dinheiro em `DECIMAL(12,2)` (migração 016)

- Migração `016_money_decimal.sql` (idempotente) muda de `FLOAT` para `DECIMAL(12,2) NOT NULL` as colunas:
  - `accounts_receivable.amount`
  - `payments.amount`
  - `products.value` e `products.cost`
  - `services.value` e `services.cost`

  Estoque e quantidades (`products.current_stock`, `stock_movements.quantity`) continuam `FLOAT`.
- Valores gravados com mais de 2 casas são arredondados para 2 casas.
- O pool (`mysql.js`) converte `DECIMAL` em `Number`, então os campos da API continuam numéricos.
- `SUM` e `AVG` sobre essas colunas também voltam como número, não string.
- **Mudança visível:** `sales_products.unit_price` já era `DECIMAL` e chegava como **string** (`"10.50"`). Agora chega como **número** (`10.5`) em todas as respostas que o expõem, por exemplo o `value` dos itens de venda.