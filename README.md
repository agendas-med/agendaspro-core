# AgendasPro — backend e banco local

Requer Node.js 20+ e Docker. O MariaDB 11.4 fica em `127.0.0.1:3307`, com volume persistente.

1. Copie `.env.example` para `.env` e preencha `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `ASAAS_WEBHOOK_TOKEN` e `WHATSAPP_INBOUND_TOKEN` com segredos aleatórios (o arquivo explica cada variável). O token Asaas precisa ter de 32 a 255 caracteres sem espaços. Sem `JWT_SECRET` (ou o legado `JWT_KEY`) a API não sobe.
2. Execute `npm ci` e `docker compose up -d --wait`.
3. Execute `npm run db:migrate`. Aplica, em ordem, as migrations versionadas de `sql/migrations` (registradas em `schema_migrations`). Em banco vazio, cria a estrutura; em banco existente, acrescenta os campos e preserva os registros. Pode ser repetido. Faça backup antes de atualizar um banco com dados reais: DDL do MariaDB não tem rollback transacional.
4. Com `APP_ENCRYPTION_KEY` configurada, execute `npm run db:encrypt-secrets` para cifrar chaves Asaas antigas gravadas em texto puro (idempotente; `--dry-run` só conta).
5. Opcionalmente, execute `npm run db:seed-demo` para criar uma empresa, cliente, serviço, produto e agendamento locais. As credenciais ficam em `.local-access.md`, ignorado pelo Git.
6. Execute `npm start`. API: `http://localhost:3001`; `GET /health` é leve (sem banco); `GET /health/ready` confirma banco e última migration (503 se não); `GET /health/deep` checa banco e fila e exige `ADMIN_TOKEN`.
7. No diretório irmão `agendaspro-system`, execute `npm ci` e `npm run dev`. Interface: `http://localhost:8080`. `NUXT_PUBLIC_API_BASE` define a URL da API.

No Windows, depois da configuração inicial, `./scripts/start-local.ps1` sobe o banco, aplica a migração, compila e inicia API/interface em segundo plano. Use `-SkipBuild` para reutilizar uma compilação já validada. Logs ficam em `logs/` e os PIDs iniciados em `.local-processes.json`. As portas 3001 e 8080 precisam estar livres ou já atender este sistema.

`npm test` executa os testes unitários e os testes HTTP com MariaDB quando `MYSQL_ROOT_PASSWORD` está configurado. Estes criam e removem somente um banco `agendaspro_test_<pid>`, sem utilizar os registros do banco da aplicação. `npm run test:unit` executa só os unitários; `npm run test:integration`, só os com banco.

O schema de referência é `sql/structure.sql`. A view canônica está em `sql/appointment-status-view.sql`; os dados de referência ficam em `sql/reference-data.sql`. `sql/inserts.sql` é um ponto de entrada compatível com o cliente MariaDB, executado a partir deste diretório. Para atualização de banco existente, use sempre a migração. Valores antigos de `accounts_receivable.value` são preservados como `amount`. O preço dos produtos de vendas antigas é inicializado a partir do cadastro atual, pois os dumps anteriores não guardavam o preço na venda.

Os status dos atendimentos são `agendado`, `pendente_pagamento`, `iniciado`, `realizado` e `cancelado`. O encerramento automático respeita a preferência `auto_finish_appointments` ativa. O status do atendimento é independente do pagamento; uma venda só fica `realizada` quando integralmente paga. Reservas, pagamentos e alterações de estoque usam transações.

Agenda, clientes, estoque, relatórios e pagamentos manuais funcionam sem Asaas, OpenAI ou AWS. Sem configuração S3, imagens são gravadas em `public/uploads`. Com S3, o bucket é privado por padrão: a API devolve `/files/s3/<chave>`, que redireciona para uma URL assinada de 5 minutos (`S3_PUBLIC_READ=true` mantém o modo público legado). Para usar Pix automático, configure a integração sandbox, a conta da empresa e o webhook. Para habilitar o assistente WhatsApp, configure `OPENAI_API_KEY` e a integração de mensagens (`WHATSAPP_INBOUND_TOKEN` para entrada, `WHATSAPP_OUTBOUND_TOKEN` e `WHATSAPP_API_URL` para envio).

## Produção (Heroku Eco)

Um dyno web Eco, sem worker (`Procfile`/`app.json`):
- a release phase roda `npm run db:migrate` (lock + idempotente; falha aborta o deploy);
- o web sobe com `node server.js`, em Node 24.x.

Em `NODE_ENV=production`, o boot valida as variáveis e aborta se faltar algo obrigatório; o log mostra só os nomes. O SIGTERM faz desligamento gracioso.

O banco pode vir de `MYSQL_*` ou da URL do add-on (`JAWSDB_MARIA_URL`/`DATABASE_URL`).

Variáveis, go-live das integrações, checklist, runbook, backup, custos e LGPD estão em [`docs/OPERACAO.md`](docs/OPERACAO.md).

A CI (`.github/workflows/ci.yml`) faz o seguinte:
- sobe o MariaDB 11.4;
- aplica as migrations duas vezes com usuário não root;
- roda `npm run test:ci` (suíte serial, sem skips);
- roda `npm audit --omit=dev`, em modo informativo.

## Jobs e lembretes (gatilho horário)

Tarefas em segundo plano ficam na tabela `jobs` e são processadas por `POST /internal/jobs/tick` (header `Authorization: Bearer <JOBS_TICK_TOKEN>`). O gatilho é **horário** (não a cada 5 minutos) e roda fora do web dyno: o dyno Eco dorme e não deve depender de cron interno. O recomendado é o **Heroku Scheduler** (add-on nativo) executando `npm run jobs:run`, que drena a fila direto no banco. Cada tick processa em lote por até ~20 s (`JOBS_TICK_BUDGET_MS`); itens não processados voltam para a fila e seguem no próximo tick. Falhas são repetidas com backoff exponencial (até 6 h) e os jobs têm chave de deduplicação.

O lembrete de WhatsApp é janela-based e tolerante a atraso: cada tick enfileira os agendamentos com início entre agora+1 h e agora+24 h 30 min ainda sem lembrete, e o lembrete só é marcado como enviado após sucesso. O que é imediato chega por webhook; qualquer webhook recebido (Asaas, WhatsApp) também drena jobs vencidos de forma não bloqueante, com throttle no banco. `ENABLE_INPROCESS_CRON=true` liga um agendador interno só para desenvolvimento local.

Formas de disparar o tick (detalhes em `docs/OPERACAO.md` §3.3):
- **Heroku Scheduler** (principal): comando `npm run jobs:run`, de hora em hora. Não usa HTTP nem `JOBS_TICK_TOKEN`.
- **`.github/workflows/jobs-tick.yml`** (reserva HTTP): usa os secrets `API_BASE_URL` e `JOBS_TICK_TOKEN`.
- **`npm run jobs:tick`** (manual via HTTP): aquece `/health` e chama o tick sem imprimir o token.

## Webhooks Asaas

O endpoint Asaas é `/webhook/asaas`; `WEBHOOK_URL` precisa apontar para sua URL pública completa. O `authToken` configurado no provedor deve coincidir com `ASAAS_WEBHOOK_TOKEN`, recebido no cabeçalho `asaas-access-token`. Cada evento é registrado em `inbound_events` pelo id externo: reentregas de eventos já processados são ignoradas e eventos que falharam são reprocessados quando o Asaas reenvia. Cobranças são conferidas pelo identificador, referência e valor; `payments.external_id` impede duplicações. Eventos de vencimento/remoção limpam o Pix em aberto; estornos e chargebacks marcam o pagamento e o atendimento como `estornado`. Consulte a [documentação de webhooks do Asaas](https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint).

O cancelamento de um Pix consulta o provedor e cancela a cobrança antes de remover o vínculo local. Reembolsos precisam ser iniciados no provedor; a interface não oferece um estorno sem implementação.

Contratos de autenticação (refresh token rotativo, logout) e de LGPD estão em `docs/contratos-f1.md`.
