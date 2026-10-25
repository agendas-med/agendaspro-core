# Mercado Pago — contas conectadas, split 1:1 e planos

Os novos recebimentos usam Checkout Pro (API de Preferências). O vendedor autoriza sua conta Mercado Pago via OAuth com PKCE; cada cobrança usa o token desse vendedor e `marketplace_fee` para separar a comissão do AgendasPro. O restante fica na conta Mercado Pago do vendedor, sujeito às tarifas e aos prazos do provedor. O AgendasPro não transfere dinheiro por Payouts.

## Planos por empresa

| Plano | Mensalidade | Comissão AgendasPro |
| --- | --- | --- |
| Gratuito | R$ 0 | 5% do valor de cada pagamento online |
| Premium | R$ 49,90/mês | 1% do valor de cada pagamento online |

A comissão é arredondada para centavos e congelada na criação da cobrança, junto com o plano e a conta do vendedor. As tarifas do Mercado Pago são adicionais. Pagamentos manuais não geram comissão automática. O percentual e a mensalidade são determinados pelo servidor; o navegador não escolhe os valores nem ativa o Premium.

A assinatura Premium é uma cobrança recorrente separada na conta central do AgendasPro, pela API `/preapproval`. A autorização do cartão/assinatura, o clique no retorno e o status `authorized` não ativam o desconto. Uma fatura de R$ 49,90 com pagamento aprovado, moeda, recebedor e ambiente conferidos concede o período mensal. Faturas repetidas não estendem o período. Cancelar a renovação mantém o período já pago; vencimento, devolução ou contestação retiram o benefício. Novas cobranças usam então 5%; cobranças já criadas preservam seu percentual.

## Configuração

1. Na aplicação Mercado Pago, selecione Checkout Pro e modelo Marketplace quando essa opção estiver disponível. Permita leitura, escrita e acesso offline. Ative PKCE.
2. Cadastre a Redirect URL **exatamente** como `MP_OAUTH_REDIRECT_URI`. Para o teste local atual:
   `https://reclining-banknote-clumsily.ngrok-free.dev/payments/mercadopago/oauth/callback`.
3. Preencha no `.env`, sem publicar segredos:

```dotenv
PAYMENT_PROVIDER=mercadopago
MP_ENV=test
MP_ACCESS_TOKEN=<token central do AgendasPro, no ambiente correto>
MP_COLLECTOR_ID=<id da conta central>
MP_CLIENT_ID=<id da aplicação Marketplace>
MP_CLIENT_SECRET=<segredo da mesma aplicação>
MP_OAUTH_REDIRECT_URI=https://seu-dominio/payments/mercadopago/oauth/callback
MP_TOKEN_ENCRYPTION_KEY=<32 bytes aleatórios codificados em base64>
MP_WEBHOOK_URL=https://seu-dominio/webhook/mercadopago
MP_WEBHOOK_SECRET=<assinatura secreta de webhooks da mesma aplicação>
MP_RECONCILE_ENABLED=true
URL_SITE=http://localhost:8080
```

Guarde a chave de criptografia com o backup do banco. Trocar ou perder essa chave torna os tokens conectados ilegíveis e exige reconectar os vendedores. Tokens OAuth e refresh tokens são armazenados cifrados com AES-256-GCM e não são retornados ao frontend.

4. Configure os eventos de webhooks: `payment`, `subscription_preapproval` e `subscription_authorized_payment`. Mantenha `order` enquanto existirem cobranças antigas de Orders. Os rótulos do painel podem ser Pagamentos (legacy), Planos e assinaturas e Order (Mercado Pago). A URL é `/webhook/mercadopago`; **não** use o callback OAuth como webhook.
5. Execute `npm run db:migrate` e reinicie a API após alterar o `.env`. O túnel deve encaminhar para a porta da API (3001).
6. Em Configurações → Recebimentos, um administrador clica **Conectar Mercado Pago** e autoriza a conta do vendedor. O vendedor deve ser diferente da conta central e pertencer ao ambiente brasileiro configurado. No sandbox, use contas de teste distintas de integrador, vendedor e comprador.

Mudar a seleção no painel não preenche automaticamente o `.env`. Ao trocar de aplicação, atualize também token central, IDs e segredo de webhook conforme necessário. A conexão e a retenção de comissão ainda precisam ser homologadas com o provedor; o botão não comprova permissão de split nem verificação de identidade do recebedor.

## Fluxo e endpoints

- `GET /payments/mercadopago/status`: configuração pública, conta conectada e plano vigente da empresa.
- `POST /payments/mercadopago/connect`: inicia OAuth, apenas administrador. O estado aleatório é persistido como hash, expira em 10 minutos e só pode ser utilizado uma vez. A permissão é conferida novamente no callback.
- `GET /payments/mercadopago/oauth/callback`: troca o código no servidor e redireciona para Recebimentos. Não registra códigos OAuth no log HTTP.
- `POST /payments/mercadopago/disconnect`: impede novas cobranças; preserva tokens necessários à conciliação de pagamentos anteriores. Não revoga o aplicativo no painel do Mercado Pago.
- `POST /sales/insert_payment` ou `POST /payments/mercadopago/charges`, com `payment_type=mercadopago` e `Idempotency-Key`: gera o checkout com a comissão vigente.
- `GET /payments/mercadopago/charges/:id` e `POST .../:id/reconcile`: consulta local e conciliação autenticada com o token do vendedor original.
- `POST /payments/mercadopago/plans/premium`: prepara a assinatura mensal; não ativa o desconto.
- `POST /payments/mercadopago/plans/:id/reconcile` e `POST .../:id/cancel`: confere faturas e cancela a renovação, apenas administrador.
- `/payments/mercadopago/payouts*`, `/destination` e `/webhook/mercadopago/payouts` retornam HTTP 410. Nenhuma flag antiga reativa envios.

O checkout retorna um link para Pix ou cartão no Mercado Pago. O webhook assinado é um aviso: o backend consulta o pagamento autenticado e valida referência, vendedor, ambiente, moeda, valor e comissão da aplicação. Só então registra o pagamento. O retorno do comprador não comprova pagamento. Em caso de timeout na criação, pesquisa a intenção persistida pela referência; não envia cegamente um segundo POST. Se o provedor ainda não localizar o recurso, a cobrança permanece pendente para recuperação, sem gerar outra chave.

Encerrar o checkout impede novas tentativas na preferência. Um Pix/boleto já emitido ainda pode ser confirmado posteriormente; o backend continua aceitando sua conciliação. Recebimentos para vendas canceladas, com saldo insuficiente, pagamentos adicionais ou devoluções são sinalizados para revisão financeira, sem nova saída de dinheiro. Estornos devem ser realizados no provedor e reconciliados; não existe botão de estorno implementado no sistema.

## Banco, compatibilidade e testes

`sql/mercadopago-split.sql` acrescenta conexões, estados OAuth, assinaturas e faturas. A migração acrescenta à cobrança a conta de origem, a preferência, o plano e a comissão congelada. Não remove dados de cobranças, destinos ou repasses históricos. As cobranças antigas continuam sendo consultadas pelo contrato original, mas não geram novos payouts.

`npm test` usa MariaDB isolado e um servidor HTTP local simulando o Mercado Pago; nunca utiliza contas reais nesses testes. Cobre isolamento de empresa e permissões, OAuth/PKCE e replay, criptografia e renovação, cobrança de 5%/1%, resposta perdida, assinatura sem pagamento, webhook duplicado, cancelamento e expiração do Premium. Execute também o build do frontend.

Esses testes não substituem homologação real. Para homologar: conectar vendedor de teste via navegador, criar uma venda, pagar pelo comprador de teste, receber o webhook real e verificar a comissão nas duas contas. Assinar Premium no sandbox, conferir a fatura e gerar uma nova cobrança com 1%. Nenhum pagamento real deve ser necessário para esse roteiro.

## Fontes oficiais

- [Configurar split e OAuth](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/create-configuration)
- [Comissão no Checkout Pro](https://www.mercadopago.com.br/developers/pt/docs/split-payments/split-1-1/integration-configuration/integrate-marketplace)
- [Limitação de split na migração do Checkout Transparente para Orders](https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/resources/migrate-payments-to-orders)
- [Assinaturas com pagamento pendente](https://www.mercadopago.com.br/developers/pt/docs/subscriptions/integration-configuration/subscription-no-associated-plan/pending-payments)
- [Referência de faturas e pagamentos da assinatura](https://www.mercadopago.com.br/developers/pt/reference/online-payments/subscriptions/overview)
