# Mercado Pago: Pix central e repasse ao assinante

Branch `feature/mercado-pago-payouts`. A API cria o Pix na conta central do AgendasPro pela Payments API (`/v1/payments`). Após confirmação consultada no provedor, registra o pagamento da venda e prepara um repasse pela API brasileira de Payouts (`/v1/payouts`). O assinante informa sua chave Pix; não precisa conectar uma conta Mercado Pago neste modelo.

Esta implementação não comprova a aprovação comercial de uma conta central CPF para receber por vários prestadores. O teste real exige credenciais e liberação do produto para a conta. A [documentação de produção](https://www.mercadopago.com.br/developers/pt/docs/payouts/go-to-production) exige enviar a chave pública à equipe de Integrações. Uma resposta 403 deve ser tratada como ausência de permissão; não trocar o endpoint por uma transferência não documentada.

## Configuração de teste

Use o `.env` ignorado pelo Git. Não coloque tokens em arquivos do front, scripts compartilhados ou commits.

```dotenv
PAYMENT_PROVIDER=mercadopago
MP_ENV=test
MP_ACCESS_TOKEN=credencial_de_teste_da_aplicacao
MP_COLLECTOR_ID=id_da_conta_central
MP_WEBHOOK_SECRET=assinatura_secreta_do_painel_de_webhooks
MP_WEBHOOK_URL=https://sua-url-publica/webhook/mercadopago
MP_PAYOUT_WEBHOOK_URL=https://sua-url-publica/webhook/mercadopago/payouts
MP_COMMISSION_BPS=500
MP_PAYOUTS_ENABLED=false
MP_AUTO_PAYOUTS=false
MP_PRIVATE_KEY_PATH=
```

`MP_COMMISSION_BPS=500` significa 5% sobre o valor bruto. A porcentagem é congelada na criação da cobrança. O custo real do recebimento é obtido de `transaction_details.net_received_amount`; não se presume tarifa de 0,99%. Exemplo: pagamento de R$ 100, líquido de R$ 99,01, comissão de R$ 5: repasse de R$ 94,01. Eventual tarifa adicional de Payouts é custo da plataforma e precisa ser confirmada no contrato, não é estimada ou cobrada do assinante pelo código.

Execute `npm run payments:check` para consultar `/users/me` e obter o ID a preencher em `MP_COLLECTOR_ID`. Essa consulta não libera nem comprova permissão de Payouts. Execute `npm run db:migrate` e reinicie o servidor após configurar o ambiente. A conta central precisa ter Pix habilitado para gerar cobranças.

O front em `dev` continua com o formulário Asaas anterior. Os endpoints abaixo permitem homologar o novo back pelo Postman, Insomnia ou outro cliente HTTP. O WhatsApp usa Mercado Pago quando o provedor selecionado é `mercadopago` e o recebimento online está configurado.

## Roteiro HTTP

Use `Authorization: Bearer <JWT do AgendasPro>` e `Selected-company: <ID da empresa>` nos endpoints `/payments/mercadopago`. Webhooks não usam o JWT do usuário. Administradores podem configurar o destino e enviar repasses; membros só consultam ou cobram as vendas da própria empresa.

1. `GET /payments/mercadopago/status`: confira ambiente, configuração, comissão e destino mascarado.
2. `PUT /payments/mercadopago/destination`: cadastre um destino. O documento deve coincidir com o CPF/CNPJ da empresa; os tipos de chave aceitos são `CPF`, `CNPJ`, `EMAIL`, `PHONE` (formato `+5511999999999`) e `PIX_CODE` (UUID). A titularidade das chaves de e-mail/telefone/aleatória precisa ser conferida no onboarding; a validação local de formato não consulta o DICT.

```json
{
  "holder_name": "Nome do assinante",
  "holder_document": "CPF ou CNPJ valido, somente digitos",
  "pix_key_type": "CPF",
  "pix_key": "mesmo CPF"
}
```

3. Crie uma venda e obtenha seu `sale_id` e `customer_id`. O cliente deve ter e-mail cadastrado.
4. `POST /payments/mercadopago/charges`, com header `Idempotency-Key: <UUID único da operação>`. O endpoint `/sales/insert_payment` também aceita o mesmo corpo/header. Reutilize essa chave após timeout; uma operação diferente exige nova chave.

```json
{
  "sale_id": 1,
  "customer_id": 1,
  "amount": 100,
  "payment_type": "pix_mercadopago"
}
```

5. A resposta contém `id` da cobrança local, `pix.payload`, `pix.encodedImage`, `pix.url` e vencimento em uma hora. `GET /payments/mercadopago/charges/:id` recupera o QR. Salve o ID local; ele difere do ID do provedor. Para cancelar, use `POST /sales/cancel_pix` com `{"sale_id":1}`; o cancelamento só libera a venda depois de confirmado no provedor.
6. Configure o evento `payment` no painel Mercado Pago. O webhook valida HMAC de `data.id`, `x-request-id` e `ts`; depois consulta a Payments API, conferindo ID, referência, valor, moeda, conta central e ambiente. Para recuperação, use `POST /payments/mercadopago/charges/:id/reconcile` com corpo `{}`. Em teste, siga o fluxo de pagamentos/contas de teste oferecido para sua aplicação; o back não fornece um endpoint para simular aprovação em produção.
7. `GET /payments/mercadopago/payouts` lista os repasses preparados e mostra bruto, tarifa de recebimento, comissão, líquido e situação. Só é preparado um repasse por cobrança. A conta de destino é congelada no registro e não muda ao editar o cadastro depois.
8. Quando Payouts estiver habilitado para a conta de teste, configure `MP_PAYOUTS_ENABLED=true` e reinicie a API. Execute `POST /payments/mercadopago/payouts/:id/submit` com `{}`. O back usa o valor/destino persistidos, consulta novamente o pagamento, verifica ausência de devolução e exige `money_release_status=released`.
9. O envio aceito retorna `pending`. Use `POST /payments/mercadopago/payouts/:id/reconcile` ou receba o callback para consultar o status. Somente `success/accredited` marca `paid`; `success/in_progress` permanece pendente. Notificações de Payouts são tratadas como aviso e nunca como prova de pagamento: a transação precisa corresponder a um repasse local e ser consultada pela API autenticada.

## Reexecução e automação

Intenção, chave de idempotência e corpo exato são commitados antes de criar a cobrança ou enviar o repasse. Em falha de conexão após envio, reexecute a mesma operação; não é criada nova chave. Estados rejeitados/devolvidos ficam para revisão e não geram um segundo envio automático. Alteração do valor líquido também bloqueia o envio. Um pagamento recebido permanece registrado mesmo se a preparação do repasse depender de taxas ainda indisponíveis.

`npm run payments:reconcile` executa uma rodada de recuperação de cobranças e consulta de repasses. Com `MP_AUTO_PAYOUTS=true` e `MP_PAYOUTS_ENABLED=true`, a API executa essa rodada a cada minuto e também envia repasses prontos, após as mesmas validações. O padrão é desligado. Não inicie múltiplos agendadores desnecessariamente; bloqueios transacionais e idempotência protegem reexecuções concorrentes.

Devolução/contestação após recebimento ou repasse marca `needs_review`. A compensação contábil e o reembolso ao cliente precisam ser resolvidos pelo operador; esta branch não implementa estorno automático nem recuperação de valores já enviados. As tabelas preservam o histórico financeiro, inclusive após cancelamento. A chave Pix fica no banco; respostas públicas retornam somente a forma mascarada. Proteja acesso e backups do banco como os demais dados pessoais do sistema.

## Produção

Após homologação e confirmação comercial do modelo, use credenciais de produção, `MP_ENV=production` e `MP_PRIVATE_KEY_PATH` apontando para uma chave privada Ed25519 fora do repositório. Cadastre a chave pública com Mercado Pago. O backend assina os bytes exatos do corpo em base64 e usa `X-enforce-signature:true`; o modo de teste envia explicitamente `X-test-token:true`. Credenciais e registros de ambientes diferentes não são misturados. Os arquivos `.pem` e `.key` são ignorados pelo Git.

## Validação e fontes

`npm test` cobre MariaDB e APIs HTTP locais, usando um servidor de pagamentos simulado e sem movimentar dinheiro. Inclui respostas perdidas, reentregas, concorrência, autorização, valores divergentes, destino congelado, assinatura Ed25519 e confirmação final. Isso valida a aplicação; a homologação na conta Mercado Pago continua necessária.

- [Pix pela Payments API](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix)
- [Criar e consultar Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/integration-configuration/money-transfers)
- [Notificações de Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/notifications)
- [Estados do repasse](https://www.mercadopago.com.br/developers/pt/docs/payouts/resources/transaction-status-and-errors)
- [Homologar Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/integration-test)
