# Homologação pelo navegador — 25/10/2026

Teste executado no AgendasPro local com MariaDB em Docker e a API real de **Orders do Mercado Pago em ambiente de teste**. Nenhum dinheiro real foi movimentado. O cliente `APRO` segue o cenário oficial de aprovação automática de Pix no sandbox.

## Fluxo realizado na interface

1. Login com a conta local de demonstração.
2. Criação da empresa **Ateliê Aurora · Teste Pix**, ID 2. A tela redirecionou para Configurações → Recebimentos.
3. Cadastro da conta pelo card e modal: banco de testes, titular de demonstração e chave Pix de documento de teste. O card exibe somente `***4725`. Também foi validada a edição com a chave em branco, preservando a chave existente.
4. Cadastro do serviço **Atendimento Aurora**, R$ 30,00, duração de 30 minutos.
5. Cadastro do produto **Kit Aurora**, R$ 20,00, e entrada de dez unidades no estoque.
6. Cadastro do cliente de sandbox `APRO` e do agendamento 2 para **26/10/2026, às 10h**, inicialmente aguardando pagamento.
7. Inclusão de uma unidade do produto na venda 2 vinculada ao agendamento. Resumo e total conferidos: R$ 30,00 + R$ 20,00 = **R$ 50,00**.
8. Geração do Pix pela interface, com credenciais de teste. A aprovação ocorreu no provedor e a tela exibiu **Pagamento confirmado! R$ 50,00** sem acionar o botão de reconciliação manual.
9. Conferência da venda, do agendamento, do estoque, do financeiro e do painel de recebimentos no navegador.

## Evidência do provedor e webhook

Order: `ORDTST01M5RS2KBZ0MYRXVB7E5XEP7N4`.

As requisições foram observadas no inspetor do ngrok, encaminhando para a API na porta 3001. Ambas tinham `type=order` e `live_mode=false`:

| Horário de São Paulo | Evento | Resposta HTTP | Corpo da resposta |
|---|---|---|---|
| 25/10/2026 02:38:33 | `order.action_required` | 200 | `{"received":false,"status":"pending"}` |
| 25/10/2026 02:38:35 | `order.processed` | 200 | `{"received":true,"payout_id":null}` |

Uma chamada de diagnóstico sem assinatura foi rejeitada com HTTP 401 antes da compra. O handler mantém a validação HMAC e consulta o recurso autenticado antes de registrar o pagamento.

## Estado final conferido

- Cobrança local 1: `environment=test`, `api_version=orders`, `status=approved`, R$ 50,00.
- Venda 2: `realizada`, sem cobrança pendente.
- Exatamente um recebimento de R$ 50,00, pagamento 2, `external_id=mp:ORDTST01M5RS2KBZ0MYRXVB7E5XEP7N4`.
- Agendamento 2: `payment_status=pago`, status `agendado`. O serviço ainda não foi iniciado.
- Produto 2: estoque de dez para **nove unidades**.
- Financeiro: **Pago, R$ 50,00**, incluindo serviço e produto.
- Recebimentos: **Confirmado**, repasse **Aguardando liberação**.

## Correções verificadas durante o teste

- Cadastro da conta e consulta dos recebimentos na interface, com chave Pix mascarada.
- Redirecionamento após criar a empresa e preservação da aba correta ao abrir configurações por URL.
- Inclusão reativa dos produtos e atualização do resumo antes de cobrar.
- Contrato da venda aceita ID e quantidade; os preços vêm do banco, mesmo se o navegador enviar um preço diferente.
- Financeiro soma serviços e produtos e considera todos os pagamentos parciais sem duplicar os valores.
- Cobrança com idempotência conservada após falhas de conexão e confirmação no navegador baseada no recebimento registrado pelo backend.

Os 33 testes automatizados do backend passaram, incluindo autorização, dados bancários mascarados, valores, idempotência, reentregas, pagamentos parciais e Payouts com provedor isolado. O frontend foi compilado e o fluxo acima foi validado pela interface.

## Limite desta homologação

O teste valida a cobrança e o recebimento por webhook. **Não foi enviado um repasse bancário.** `MP_PAYOUTS_ENABLED` permanece desativado e o valor líquido desta order ainda não está confirmado no relatório de liberações. O sistema conserva o recebimento e aguarda essa informação, sem estimar taxas. A habilitação de Payouts e o modelo comercial da conta central precisam de homologação própria.

Capturas salvas no workspace, em `.codex/artifacts/`: `mercadopago-conta-modal.png`, `mercadopago-pagamento-confirmado.png` e `mercadopago-recebimentos.png`.
