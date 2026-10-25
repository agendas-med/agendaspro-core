# AgendasPro — backend e banco local

Requer Node.js e Docker. O MariaDB 11.4 fica em `127.0.0.1:3307`, com volume persistente.

1. Copie `.env.example` para `.env` e preencha `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`, `JWT_KEY` e `WEBHOOK_SECRET_TOKEN` com segredos aleatórios. A branch de Mercado Pago usa `PAYMENT_PROVIDER=mercadopago` e `MP_ENV=test` por padrão. Credenciais de pagamentos são opcionais para agenda e pagamentos manuais.
2. Execute `npm ci` e `docker compose up -d --wait`.
3. Execute `npm run db:migrate`. Em banco vazio, cria a estrutura; em banco existente, acrescenta os campos e preserva os registros. Pode ser repetido. Faça backup antes de atualizar um banco com dados reais: DDL do MariaDB não tem rollback transacional.
4. Opcionalmente, execute `npm run db:seed-demo` para criar uma empresa, cliente, serviço, produto e agendamento locais. As credenciais ficam em `.local-access.md`, ignorado pelo Git.
5. Execute `npm start`. API: `http://localhost:3001`; verificação da conexão: `GET /health`.
6. No diretório irmão `agendaspro-system`, execute `npm ci` e `npm run dev`. Interface: `http://localhost:8080`. `NUXT_PUBLIC_API_BASE` define a URL da API.

No Windows, depois da configuração inicial, `./scripts/start-local.ps1` sobe o banco, aplica a migração, compila e inicia API/interface em segundo plano. Use `-SkipBuild` para reutilizar uma compilação já validada. Logs ficam em `logs/` e os PIDs iniciados em `.local-processes.json`. As portas 3001 e 8080 precisam estar livres ou já atender este sistema.

`npm test` executa os testes de regras e os testes HTTP com MariaDB quando `MYSQL_ROOT_PASSWORD` está configurado. Estes criam e removem somente um banco `agendaspro_test_<pid>`, sem utilizar os registros do banco da aplicação. `npm run test:integration` executa apenas os testes com banco.

O schema de referência é `sql/structure.sql`, com as tabelas de cobranças e repasses em `sql/mercadopago.sql`. A view canônica está em `sql/appointment-status-view.sql`; os dados de referência ficam em `sql/reference-data.sql`. `sql/inserts.sql` é um ponto de entrada compatível com o cliente MariaDB, executado a partir deste diretório. Para instalar ou atualizar o banco completo, use sempre a migração. Valores antigos de `accounts_receivable.value` são preservados como `amount`. O preço dos produtos de vendas antigas é inicializado a partir do cadastro atual, pois os dumps anteriores não guardavam o preço na venda.

Os status dos atendimentos são `agendado`, `pendente_pagamento`, `iniciado`, `realizado` e `cancelado`. O encerramento automático respeita a preferência `auto_finish_appointments` ativa. O status do atendimento é independente do pagamento; uma venda só fica `realizada` quando integralmente paga. Reservas, pagamentos e alterações de estoque usam transações.

Agenda, clientes, estoque, relatórios e pagamentos manuais funcionam sem Mercado Pago, Asaas, OpenAI ou AWS. Sem configuração S3, imagens são gravadas em `public/uploads`. O novo fluxo recebe Pix na conta central Mercado Pago, registra a comissão e envia o líquido à chave Pix do assinante por Payouts. Consulte [configuração e roteiro de teste](docs/mercadopago.md). O front preservado em `dev` ainda tem a interface Asaas; o teste desta branch é pela API. Para habilitar o assistente WhatsApp, configure `OPENAI_API_KEY` e a integração de mensagens. Lembretes são ativados por `ENABLE_REMINDERS=true`, após configurar o serviço de envio.

O Asaas fica disponível para compatibilidade com cobranças antigas. Para gerar novas cobranças Asaas, selecione explicitamente `PAYMENT_PROVIDER=asaas`. Seu endpoint é `/webhook/asaas`; `WEBHOOK_URL` precisa apontar para sua URL pública completa. O `authToken` configurado no provedor deve coincidir com `ASAAS_WEBHOOK_TOKEN` (32 a 255 caracteres sem espaços), recebido no cabeçalho `asaas-access-token`. Cobranças são conferidas pelo identificador, referência e valor; `payments.external_id` impede duplicações. Consulte a [documentação de webhooks do Asaas](https://docs.asaas.com/docs/receive-asaas-events-at-your-webhook-endpoint).

O cancelamento de um Pix consulta o provedor e cancela a cobrança antes de remover o vínculo local. Reembolsos de pagamentos recebidos precisam ser tratados no provedor; a interface não oferece um estorno sem implementação.
