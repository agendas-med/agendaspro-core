# Habilitação de Payouts — diagnóstico de 25/10/2026

> Histórico do fluxo anterior. Payouts foi substituído por split 1:1 e seus endpoints de envio estão desativados. Para a configuração atual, consulte [Mercado Pago](mercadopago.md). Não siga as etapas de ativação abaixo para a nova integração.

## Resultado observado

Foi executada uma solicitação isolada de teste para `POST https://api.mercadopago.com/v1/payouts`, com:

- `MP_ENV=test` e verificação prévia de `/users/me`: conta brasileira, `test_user`, ID correspondente ao collector configurado.
- Access Token de teste, `X-test-token: true`, `X-enforce-signature: false` e chave de idempotência persistida antes do envio.
- Destinatário fictício do exemplo oficial de Pix e valor simulado de R$ 10,00. Esse diagnóstico não corresponde ao repasse da venda 2.

Resposta do Mercado Pago, confirmada em duas tentativas com o mesmo corpo/chave:

```json
{
  "blocked_by": "PolicyAgent",
  "code": "PA_UNAUTHORIZED_RESULT_FROM_POLICIES",
  "message": "At least one policy returned UNAUTHORIZED.",
  "status": 403
}
```

Identificador da segunda requisição (`x-request-id`): `10b30ba6-3f48-4740-aa8d-661a47f2397b`, em 25/10/2026 às 03:03:16, horário de São Paulo.

Não foi retornado ID de payout/transação. Nenhum envio real foi realizado. As configurações do AgendasPro continuam `MP_PAYOUTS_ENABLED=false` e `MP_AUTO_PAYOUTS=false`.

O resultado comprova uma negativa de política para esta operação. Ele não identifica qual política falhou e não comprova, por si só, uma restrição a CPF ou a destinatário de outra titularidade.

## Solicitação ao suporte / equipe de Integrações

Acrescente o ID público da aplicação ao seguinte texto. Não envie Access Token nem chave privada no chamado.

> Preciso habilitar a API Payouts via Pix para o AgendasPro. O SaaS recebe pagamentos na conta central, retém sua comissão e repassa o líquido para as chaves Pix dos assinantes, que podem ter outra titularidade. A conta central é CPF. Esse modelo é permitido para minha conta ou exige CNPJ/contrato específico? A integração Orders está funcionando, mas o POST /v1/payouts em sandbox retorna HTTP 403, código PA_UNAUTHORIZED_RESULT_FROM_POLICIES. Solicito a análise das permissões da conta/aplicação e orientação para habilitar os ambientes de teste e produção. x-request-id: 10b30ba6-3f48-4740-aa8d-661a47f2397b. ID da aplicação: [preencher].

## Depois da liberação

1. Revalidar o acesso no sandbox. A chave Pix do destinatário deve estar cadastrada para uma conta de destino de teste. O destinatário cadastrado no teste anterior da interface contém dados fictícios e não deve ser usado para uma transferência real.
2. Configurar o callback de repasses em `MP_PAYOUT_WEBHOOK_URL=https://<dominio-publico>/webhook/mercadopago/payouts`.
3. Ativar `MP_PAYOUTS_ENABLED=true`, mantendo `MP_ENV=test` e `MP_AUTO_PAYOUTS=false` durante a homologação manual.
4. Para o fluxo completo da venda, obter o valor líquido verificado pelo relatório de liberações. A venda 2 já foi recebida, mas seu líquido ainda não foi confirmado; não preencher uma tarifa fictícia para destravar o envio.
5. Enviar um repasse preparado pelo backend e consultar até `success/accredited`. HTTP 202 confirma apenas que o pedido foi aceito para processamento.

Para produção, cadastrar a chave pública Ed25519 com a equipe de Integrações, guardar a chave privada fora do repositório e configurar `MP_PRIVATE_KEY_PATH`, credenciais produtivas e `MP_ENV=production`. Confirmar com o provedor a autorização do modelo da conta central, tarifas, limites e destinatários admitidos antes de movimentar dinheiro real.

## Documentação oficial consultada

- [Testar Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/integration-test)
- [Configurar transferências](https://www.mercadopago.com.br/developers/pt/docs/payouts/integration-configuration/money-transfers)
- [Status e erros de Payouts](https://www.mercadopago.com.br/developers/pt/docs/payouts/resources/transaction-status-and-errors)
- [Produção e cadastro da chave pública](https://www.mercadopago.com.br/developers/pt/docs/payouts/go-to-production)
