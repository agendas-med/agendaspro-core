# Contratos F6-core: Instagram, atribuição UTM e Google Agenda

Integrações externas por empresa: Instagram (perfil, posts, insights e funil de conversão da página pública) e Google Agenda (exportar agendamentos e importar horários ocupados como bloqueios).

> **Chamadas reais nunca exercitadas.** Todo o fluxo foi testado só contra stubs HTTP locais (`test/f6.instagram.integration.test.js`, `test/f6.gcal.integration.test.js`). Nenhuma chamada à Meta ou ao Google foi feita. Antes de liberar, faça um teste manual com contas reais em ambiente de homologação (ver "Pendências de validação real").

## Regras comuns

- Todas as rotas `/integrations/*` usam JWT e o header `Selected-company` (middleware `member`).
- **Leitura** (status, vínculos, dados): qualquer membro. **Gerenciar** (conectar, callback, desconectar, vincular, sincronizar, listar calendários da conta Google): somente o admin da empresa. Os demais recebem `403 {error:{code:'admin_required'}}`.
- Recursos de outra empresa respondem `404`, indistinguível de um recurso inexistente.
- **OAuth:** o front chama `POST .../connect/start`, redireciona o usuário para `authorize_url`, recebe `code` e `state` na `redirect_uri` e repassa os dois para `POST .../callback`.
  - O `state` é assinado (HMAC com `OAUTH_STATE_SECRET`), de uso único, válido por `expires_in` segundos e preso à empresa e ao usuário que iniciaram.
  - `redirect_uri` precisa estar na allowlist do servidor. Fora dela: `400 redirect_uri_not_allowed`. Se o front omitir, vale a primeira da lista.
  - State adulterado, expirado, reusado ou de outra empresa/usuário: `400 oauth_state_invalid`.
- **Tokens de acesso e refresh** ficam só cifrados no banco (AES-256-GCM, `APP_ENCRYPTION_KEY`). Nunca aparecem em respostas nem em logs.
- **Integração sem configuração no servidor** (sem client id/secret ou sem allowlist): `503 integration_not_configured`; `status` responde `configured:false`.
- **Erros:** `{error:{code, message, ...detalhes}}`. Validação Joi: `400 {errors:[{message, field}]}`. Plano insuficiente: `402 {error:{code:'plan_upgrade_required', feature, plan}}`.
- Respostas de sucesso vêm em `{data}`.

## Instagram (`/integrations/instagram`)

API do Instagram com login do Instagram (contas profissionais: Empresa ou Criador). Escopos: `instagram_business_basic` e `instagram_business_manage_insights`.

| Método e rota | Quem | Corpo / query | Resposta (`data`) |
|---|---|---|---|
| `GET /status` | membro | – | `{configured, connected, account}` |
| `POST /connect/start` | admin | `{redirect_uri?}` | `{authorize_url, state, redirect_uri, expires_in, scopes[]}` |
| `POST /callback` | admin | `{code, state}` | igual a `status` (um `#_` no fim do `code` é removido) |
| `POST /disconnect` | admin | – | `{disconnected}` |
| `GET /overview` | membro | `?refresh=true` | `{account, engagement, stale, premium}` |
| `GET /posts` | membro | `?limit=1..50 (12)&before=<media_id>&refresh` | `{items[], next_before, limit_total, stale}` |
| `POST /refresh` | membro | – | igual a `overview`; no Premium, também atualiza insights |
| `GET /insights` | membro, Premium | `?days=1..365 (30)&refresh` | `{account_insights, posts[], engagement, comparison, history[], stale}` |
| `GET /conversion` | membro, Premium | `?from&to (ISO)&utm_campaign` | `{period:{from,to}, totals, by_campaign[]}` |
| `POST /utm-link` | membro | `{placement: bio\|post\|story\|campaign, campaign?, content?, label?}` | `201 {id, label, utm_*, url, created_at, public_page_ready}` |
| `GET /utm-links` | membro | – | lista dos links (até 200) |

**`account`** (nunca contém token):

```
{ig_user_id, username, name, account_type, profile_picture_url, followers_count, follows_count, media_count,
 status: 'active'|'reauth_required', scopes[], connected_at, token_expires_at,
 profile_synced_at, media_synced_at, rate_limited_until|null}
```

**Plano:**
- Free: status, conexão, perfil e os últimos 6 posts (`limit_total`), além do link UTM da bio.
- Premium (feature `instagram`): insights, histórico, comparativo, conversão e links por post, story ou campanha. Fora do Premium esses links respondem `402`.

**Cache:**
- Perfil e posts ficam em cache por `INSTAGRAM_CACHE_TTL_MIN` (30 min); insights por post, por `INSTAGRAM_INSIGHTS_TTL_MIN` (360 min).
- `refresh=true` força a atualização, limitado a `INSTAGRAM_REFRESH_MAX_PER_HOUR` (6/h) por empresa. Acima do limite, serve o cache.
- Se a API estiver em limite de uso ou indisponível, a resposta traz os dados do cache com `stale:true`.

**Erros específicos:**
- `502 instagram_oauth_failed {provider_code}`
- `409 instagram_reauth_required` (token expirou ou foi revogado; reconectar)
- `429 instagram_rate_limited {retry_at?}`: há uma pausa mínima de 15 min após um 429/limite da Meta
- `502 instagram_unavailable`
- `404 integration_not_connected`

**Jobs:**
- O token longo (60 dias) é renovado quando faltam 7 dias ou menos para expirar; se já expirou, a conta vai para `reauth_required`.
- No Premium, um snapshot diário do perfil e dos insights da conta é gravado na data local da empresa e alimenta `history`.

**Desconectar** apaga o token, o perfil, os posts, a série histórica e os states pendentes. Links UTM e visitas ficam: são dados da própria empresa. A API não tem endpoint de revogação, então o usuário remove o app no Instagram em Configurações > Apps e sites.

### Callbacks da Meta (`/webhook/instagram`, servidor a servidor)

Corpo form-encoded `signed_request`. A assinatura é verificada com HMAC-SHA256 usando `INSTAGRAM_APP_SECRET`; se for inválida, a resposta é `400 invalid_signed_request`. As chamadas são idempotentes: o código de confirmação é derivado do próprio `signed_request`.

- `POST /deauthorize`: remove as conexões do usuário e responde `200 {ok:true}`.
- `POST /data-deletion`: remove as conexões e responde `200 {url, confirmation_code}`. A `url` vem de `INSTAGRAM_DELETION_STATUS_URL` ou, na falta dela, de `PUBLIC_API_URL + /webhook/instagram/deletion-status`.
- `GET /deletion-status/:code`: público, sem dados pessoais. Responde `{data:{confirmation_code, kind, status, processed_at, message}}` ou `404`.

## Atribuição UTM da página pública (`/public`)

UTM é normalizada para minúsculas, `[a-z0-9_.-]`. Limites: `utm_source` e `utm_medium` até 40 caracteres; `utm_campaign` e `utm_content` até 80. Nada de IP ou dado pessoal é gravado.

- `POST /public/b/:slug/visits` com `{utm_source?, utm_medium?, utm_campaign?, utm_content?}` responde `202 {recorded:true}`.
  - Grava um contador agregado por empresa, dia local e UTM.
  - Limite de `PUBLIC_VISITS_IP_MAX` (60/h) por IP. Slug inexistente responde `404` e conta para o bloqueio anti-enumeração.
  - O front chama uma vez por carregamento da página `/b/:slug` que tenha UTM na URL.
- `POST /public/b/:slug/bookings` aceita o campo opcional `attribution: {utm_*}`, gravado em `booking_attributions`. Ele não entra no hash de idempotência.
- O funil (`GET /integrations/instagram/conversion`) segue:
  - Visitas: `utm_source=instagram`.
  - Agendamentos não cancelados: `source=instagram` ou UTM do Instagram.
  - Receita estimada (valor dos serviços) e realizada (pagamentos não estornados), em centavos.
  - `totals.profile_links_taps` vem dos snapshots; é `null` quando não há snapshot.

## Google Agenda (`/integrations/google-calendar`, Premium `google_calendar`)

Independente do login com Google (`routes/users.js`, `GOOGLE_CLIENT_ID`). Usa outro client, `GOOGLE_CALENDAR_CLIENT_ID`.

**Escopos padrão** (mínimos; sobrescreva com `GOOGLE_CALENDAR_SCOPES`):
- `calendar.app.created`: cria e gerencia só o calendário "AgendasPRO".
- `calendar.events.freebusy`: lê os horários ocupados dos calendários escolhidos.
- `calendar.calendarlist.readonly`: lista os calendários para o usuário escolher.
- `openid email`: mostra qual conta foi conectada.

O OAuth usa PKCE S256: o `code_verifier` fica cifrado junto do state, e o servidor nunca o expõe. A autorização pede `access_type=offline` e `prompt=consent`.

| Método e rota | Quem | Corpo | Resposta (`data`) |
|---|---|---|---|
| `GET /status` | membro | – | `{configured, connected, account, links[]}` |
| `POST /connect/start` | admin, Premium | `{redirect_uri?}` | `{authorize_url, state, redirect_uri, expires_in, scopes[]}` |
| `POST /callback` | admin, Premium | `{code, state}` | igual a `status` |
| `POST /disconnect` | admin, **qualquer plano** | `{remove_app_calendars?: boolean=false}` | `{disconnected, revoked, removed_calendars}` |
| `GET /calendars` | admin, Premium | – | `[{id, summary, primary, access_role, time_zone}]` |
| `GET /links` | membro | – | `links[]` |
| `POST /links` | admin, Premium | ver abaixo | `201 link` |
| `DELETE /links/:id` | admin | – | `{deleted:true}`. Para `busy`, para o canal e apaga os bloqueios importados. Para `push`, os eventos já exportados ficam no Google; se era o último destino, os mapeamentos locais são apagados. |
| `POST /sync` | admin, Premium | – | `202 {queued}` (limite `GOOGLE_CALENDAR_SYNC_MAX_PER_HOUR`, 6/h, senão `429 rate_limited`; sem conexão, `404 integration_not_connected`) |

```
account = {email, status: 'active'|'reauth_required', scopes[], connected_at, last_push_at, last_error_code}
link    = {id, role: 'push'|'busy', professional_id|null, calendar_id, calendar_summary, created_by_app,
           last_sync_at, last_full_sync_at, push_channel_active}
```

**Conectar:**
- Cria o calendário "AgendasPRO" no fuso da empresa e um vínculo `push` padrão (`professional_id:null`).
- Se a criação falhar, a conexão continua e o erro fica em `account.last_error_code`. O admin pode criar depois com `POST /links {role:'push', create_app_calendar:true}`.
- Reconectar a mesma conta preserva os vínculos. Conectar outra conta apaga os vínculos, mapeamentos e bloqueios da conta anterior.
- Se o Google não devolver refresh token para uma conta nova, a resposta é `502 google_calendar_oauth_failed {provider_code:'no_refresh_token'}`. O caso típico é um consentimento anterior sem `prompt=consent`; a solução é o usuário remover o acesso em myaccount.google.com > Segurança e tentar de novo.

**`POST /links`:**
- `role:'push'` (destino dos agendamentos):
  - `{calendar_id}` ou `{create_app_calendar:true}`, mais `professional_id?`.
  - Um destino por profissional, mais um padrão com `professional_id:null` para os demais.
  - O calendário precisa ter acesso `owner` ou `writer`.
  - Na prática, com os escopos padrão, só calendários criados pelo app aceitam escrita.
- `role:'busy'` (origem de horários ocupados):
  - `{calendar_id, professional_id}` bloqueia um profissional.
  - `{calendar_id, all_company:true}` bloqueia a empresa inteira (opt-in explícito).
  - Sem nenhum dos dois, a resposta é `400`.
- Erros:
  - `404 calendar_not_found`: o calendário não aparece na conta.
  - `404 professional_not_found`.
  - `409 calendar_link_conflict`: destino duplicado para o profissional, calendário já usado no outro sentido (isso evita eco), vínculo repetido, ou calendário sem permissão de escrita.

**Exportação (push):**
- Job `gcal_push` por empresa. Roda a cada tick horário, logo após conectar ou vincular, e no `POST /sync`.
- Reconcilia os agendamentos não cancelados, sem hold pendente, de agora−1 dia até `GOOGLE_CALENDAR_PUSH_DAYS` (90 dias), com os eventos do calendário de destino:
  - O id do evento é determinístico (hash de empresa + agendamento). Um insert repetido após uma queda responde 409 e vira atualização, sem duplicar.
  - Um hash do conteúdo evita escrita quando nada mudou.
  - Agendamento cancelado ou apagado remove o evento.
  - Se o profissional trocou de destino, o evento é movido.
- Dados enviados: primeiro nome do cliente, serviços, profissional, horário de parede com o fuso da empresa e a marca `extendedProperties.private.agendaspro=1`, que serve de anti-eco. Não vão telefone, e-mail, sobrenome nem observações. O evento é privado e sem lembretes, e não notifica ninguém (`sendUpdates=none`).
- No máximo `GOOGLE_CALENDAR_PUSH_MAX_OPS` (100) escritas por execução; o restante é reenfileirado.
- **Latência:** não há gancho na criação ou edição de agendamento, então a atualização chega no próximo tick (até ~1 h) ou com `POST /sync`.

**Importação (busy → bloqueios):**
- Job `gcal_pull` por vínculo `busy`.
- A primeira leitura é completa (agora−1 dia até `GOOGLE_CALENDAR_BUSY_DAYS`, 180 dias). As seguintes são incrementais por `syncToken`.
  - Se o Google responder `410` (token expirado), o token é descartado e a leitura completa é refeita, removendo os bloqueios que sumiram.
- Viram bloqueio (`time_blocks.source='google'`, `reason='Ocupado (Google Agenda)'`) só eventos ocupados.
  - Ignorados: cancelados, "livre" (transparent), recusados pelo próprio usuário e eventos do próprio AgendasPRO (anti-eco).
  - O título e os participantes do evento **não** são importados.
  - Eventos de dia inteiro bloqueiam de 00:00 a 00:00 do dia seguinte, no fuso da empresa.
- Os bloqueios importados aparecem em `GET /time-blocks` com `source:'google'` e passam a contar na disponibilidade (painel e página pública).
  - `DELETE /time-blocks/:id` de um bloqueio importado responde `409`: remova o evento no Google ou desvincule o calendário.
  - Bloqueios manuais têm `source:'manual'`.
- **Notificações push:**
  - Com `GOOGLE_CALENDAR_WEBHOOK_URL` (HTTPS) configurada, cada vínculo `busy` abre um canal `events.watch` com TTL `GOOGLE_CALENDAR_WATCH_TTL_SEC` (7 dias), renovado quando faltam menos de 24 h.
  - O webhook `POST /webhook/google-calendar` valida `X-Goog-Channel-ID`, `X-Goog-Channel-Token` (guardado só como hash, comparação em tempo constante) e `X-Goog-Resource-ID`.
  - Respostas: `400` para headers ausentes, `404` para canal desconhecido, `403` para token ou recurso divergente.
  - `X-Goog-Resource-State: sync` só confirma o canal. As demais notificações têm dedupe por canal e número da mensagem (`inbound_events`), enfileiram um pull e respondem `204`.
  - Limite por IP: `GOOGLE_CALENDAR_WEBHOOK_IP_MAX_PER_MIN` (120/min).
  - O tick horário é o fallback: sem webhook, a importação continua por hora.

**Erros:**
- `409 google_calendar_reauth_required`: refresh revogado ou expirado; a conta vai para `status:'reauth_required'`, e os jobs param sem retry até reconectar.
- `429 google_calendar_rate_limited`
- `502 google_calendar_unavailable {provider_code}`: no job, falhas de limite ou indisponibilidade são retentadas com backoff.
- `404 calendar_link_not_found`

**Downgrade para o Free:** os jobs param de exportar. No próximo pull de cada vínculo `busy`, os bloqueios importados são apagados, para não bloquear agenda com dado que deixou de sincronizar. A conexão fica até o admin desconectar, e desconectar é permitido no Free.

**Desconectar (LGPD):**
1. Para os canais de push.
2. Com `remove_app_calendars:true`, apaga no Google os calendários criados pelo app. Sem a flag, os eventos exportados ficam na agenda do usuário.
3. Revoga o refresh token (melhor esforço; `revoked` informa o resultado).
4. Apaga a conta, os vínculos, os mapeamentos, os bloqueios importados e os states pendentes. Bloqueios manuais ficam.

**Fora de escopo nesta fase:** o link iCal para o plano Free (gap registrado).

## Configuração nos consoles (manual, fora do código)

### Meta (Instagram)

1. Em developers.facebook.com, crie um app do tipo **Business** e adicione o produto **Instagram** > "API setup with Instagram business login".
2. Copie o *Instagram App ID* e o *Instagram App Secret* para `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`. Atenção: são os valores da seção Instagram, não os do app do Facebook.
3. Em *Business login settings*, configure:
   - **OAuth redirect URIs**: as mesmas URLs de `INSTAGRAM_REDIRECT_URIS` (a página do front que recebe `code` e `state`). Precisam bater exatamente.
   - **Deauthorize callback URL**: `https://<api>/webhook/instagram/deauthorize`.
   - **Data deletion request URL**: `https://<api>/webhook/instagram/data-deletion`.
4. Para contas que não são testers, peça **App Review** de `instagram_business_basic` e `instagram_business_manage_insights` (Advanced Access). Isso exige Business Verification, política de privacidade pública e vídeo do fluxo.
5. Durante o desenvolvimento, adicione as contas de teste em *Roles > Instagram testers* e aceite o convite no app do Instagram.
6. A conta do Instagram precisa ser profissional (Empresa ou Criador).

### Google Cloud (Google Agenda)

1. Em console.cloud.google.com, use um projeto (pode ser o mesmo do login com Google) e ative a **Google Calendar API**.
2. Crie uma credencial **OAuth client ID** do tipo *Web application*, separada da do login.
   - **Authorized redirect URIs**: as mesmas de `GOOGLE_CALENDAR_REDIRECT_URIS`.
   - Copie os valores para `GOOGLE_CALENDAR_CLIENT_ID` e `GOOGLE_CALENDAR_CLIENT_SECRET`.
3. Na **OAuth consent screen**, cadastre os escopos acima, a política de privacidade, os termos e os domínios autorizados.
   - Os escopos de Calendar são **sensíveis**, então publicar para produção exige **verificação do app** pelo Google (vídeo de demonstração e justificativa por escopo).
   - Em modo *Testing*, só os usuários de teste cadastrados conseguem conectar, e o **refresh token expira em 7 dias**.
4. O webhook (`GOOGLE_CALENDAR_WEBHOOK_URL=https://<api>/webhook/google-calendar`) exige HTTPS com certificado válido. Se ficar vazio, vale só o fallback horário.
5. Defina `GOOGLE_CALENDAR_EVENT_SALT` uma única vez e não troque mais: os ids dos eventos já exportados dependem dele.

## Pendências de validação real

- **Instagram:**
  - O formato real do `signed_request` de desautorização e exclusão (campo `user_id`: id do app ou do Instagram) não foi conferido.
  - Os nomes e a disponibilidade das métricas de insights na versão `INSTAGRAM_GRAPH_VERSION` (padrão `v27.0`) não foram verificados.
  - O snapshot cobre as últimas 24 h, não o dia calendário anterior.
- **Google:**
  - Não foi confirmado que `calendar.events.freebusy` permite `events.list` e `events.watch` (o design depende disso). Se não permitir, ajuste `GOOGLE_CALENDAR_SCOPES`, por exemplo para `calendar.events.readonly`, e documente a justificativa na verificação.
  - Também não foram verificados com o Google real:
    - a presença de `accessRole` em calendários criados pelo app;
    - o comportamento do `syncToken` com `timeMin`;
    - os headers reais das notificações.
- O fluxo ponta a ponta (connect, criar agendamento, ver o evento no Google, criar evento no Google, ver o bloqueio no painel) precisa ser feito à mão com contas de teste.
