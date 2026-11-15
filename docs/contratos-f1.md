# Contratos da API — F1 (core)

Mudanças visíveis para o front (`agendaspro-system`) e para integrações. Tudo continua compatível com o formato `createResponse` (`{ message, returnObj, request: { method, status } }`) salvo onde indicado.

## Autenticação

| Rota | Corpo | Resposta (`returnObj`) |
| --- | --- | --- |
| `POST /users/login` | `{ email, password }` | `{ jwtToken, id, refreshToken }` |
| `POST /users/google-login` | `{ token }` (código OAuth do Google) | `{ token, refreshToken }` |
| `POST /users/refresh` | `{ refresh_token }` | `{ jwtToken, refreshToken }` (o refresh antigo deixa de valer) |
| `POST /users/check_jwt` | `{ token: "Bearer <jwt>" }` ou `{ refresh_token }` | `{ newToken, refreshToken? }` |
| `POST /users/logout` | `{ refresh_token? }` (exige `Authorization`) | `null`; sem `refresh_token` encerra todas as sessões |

- O access token dura `JWT_EXPIRES_IN` (padrão 8 h). O refresh token é **rotativo**, dura `REFRESH_TOKEN_TTL_DAYS` (30) e é de uso único. Se um refresh já usado for reapresentado, toda a família de sessões é revogada e o usuário precisa entrar de novo.
- O `check_jwt` não re-assina tokens expirados. Sem refresh, renova um token ainda válido até 7 dias depois do login original. O front deve guardar o `refreshToken` e, em caso de 401, chamar `/users/refresh`.
- Quando a senha é trocada ou redefinida, todos os refresh tokens são revogados e os access tokens emitidos antes da troca recebem `401 { mensagem: "Sessão expirada. Entre novamente." }`.
- Senhas novas, no cadastro e na redefinição, precisam de pelo menos 8 caracteres.
- Validação (Joi): `400 { errors: [{ message, field }] }`. Campos desconhecidos são rejeitados.
- Rate limit: `429 { message }` com o header `Retry-After` (em segundos). Vale para login, cadastro, reset, convite, check_jwt, refresh e criação de empresa. No core, `/public` é só estático e não tem rotas de API; futuras rotas públicas devem usar `rateLimit({ key, windowSec, max })`.

## Empresa selecionada

O header `Selected-company` precisa ser um inteiro positivo de uma empresa da qual o usuário é membro. Caso contrário, a resposta é `403 { error }`.

## Erros

Erros internos (SQL, provedores externos, bugs) devolvem `500 { message: "Erro interno...", correlation_id }`, ou o mesmo texto em rotas legadas que respondiam string. O `correlation_id` também aparece no log do servidor. Erros brutos do Asaas não chegam mais ao cliente. Erros de negócio mantêm a mensagem, com status 400, 404 ou 409.

## Agendamentos

`GET /appointments?start=YYYY-MM-DD&end=YYYY-MM-DD`:
- As datas são inclusivas. Também aceita `YYYY-MM-DD HH:mm[:ss]`.
- Pode ser combinado com `?today=`.
- Uma data inválida devolve `400`.
- O resultado é sempre filtrado pela empresa selecionada.

## Clientes

`birthday` é opcional: aceita `null`, `""` ou ausência, e é gravado como `NULL`.

## Arquivos (S3)

Com S3 privado (padrão), a URL salva é `<PUBLIC_API_URL>/files/s3/<chave>`. Um `GET` nela redireciona (302) para uma URL assinada válida por 5 minutos. Com `S3_PUBLIC_READ=true`, vale o comportamento legado (URL pública direta).

## LGPD (admin da empresa; exige `Authorization` + `Selected-company`)

- `GET /privacy/customers/:id/export`: `returnObj = { exported_at, customer, appointments, sales, payments, consents }`.
- `POST /privacy/customers/:id/consents` com `{ purpose, granted, source? }`. `purpose` aceita `whatsapp_reminders`, `whatsapp_bot`, `marketing` ou `data_processing`.
- `POST /privacy/customers/:id/anonymize`: remove os dados pessoais e mantém o histórico financeiro.
- `DELETE /privacy/customers/:id`: devolve `409` se o cliente tem histórico financeiro; nesse caso, use a anonimização.
- Um cliente de outra empresa devolve `404`.

## Rotas internas

- `POST /internal/jobs/tick`, com `Authorization: Bearer <JOBS_TICK_TOKEN>`. Devolve `{ ok, enqueued, claimed, done, retried, failed, released, remaining, durationMs }`. O gatilho é externo e horário.
- `GET /health`: leve, sem banco. `GET /health/deep`, com `Bearer <ADMIN_TOKEN>`: `{ status, database, jobs: { due, failed, running } }`.
- As rotas `/companies/admin/*` exigem `Bearer <ADMIN_TOKEN>`.
- Sem o token configurado, a resposta é `503`; com token errado, `401`. Token na query string não é aceito.

## WhatsApp

- Entrada: `POST /webhook/whatsapp`, com `Authorization: Bearer <WHATSAPP_INBOUND_TOKEN>` ou o header `apikey`, e corpo `{ phone, message }`.
- Mensagem sem texto (áudio, imagem, figurinha): `200` com `returnObj.reply` contendo uma resposta educada.
- Saída: `POST <WHATSAPP_API_URL>/message/sendText`, com `Bearer <WHATSAPP_OUTBOUND_TOKEN>`.
- O bot só consulta e reagenda agendamentos do telefone remetente; quando o cadastro tem CPF, o CPF precisa bater.

## Asaas

`POST /webhook/asaas` com o header `asaas-access-token`.
- Eventos tratados: `PAYMENT_RECEIVED`/`CONFIRMED` (baixa), `OVERDUE`/`DELETED` (limpa o Pix em aberto), `REFUNDED`, `PARTIALLY_REFUNDED`, `REFUND_IN_PROGRESS` e os de chargeback (marcam o pagamento; estorno total deixa o atendimento com `payment_status = 'estornado'`).
- Reentregas devolvem `200 { received: true, duplicate: true }`.
- Chaves Asaas nunca são devolvidas ao cliente.
