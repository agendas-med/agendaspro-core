# Contratos F5-core-B: assistente interno do painel

Assistente de IA para a equipe da empresa, dentro do painel. Ele responde perguntas sobre agenda, clientes, serviços, estoque e financeiro. No plano Premium, também **propõe** ações de escrita, que só são executadas depois que o usuário confirma explicitamente pelo botão.

## Ligar / desligar

- `ASSISTANT_ENABLED=true` liga as rotas. Sem essa flag, todas respondem `503 {error:{code:'assistant_disabled'}}`.
- `ASSISTANT_TOKEN_SECRET` (mínimo de 32 caracteres) é obrigatório para as ações de escrita. Sem ele, a proposta responde `503 assistant_actions_disabled`. Não existe segredo padrão.
- Sem `OPENAI_API_KEY`, o assistente responde só pelo roteador determinístico. Mensagens ambíguas recebem uma ajuda em texto fixo.
- O RAG exige `ASSISTANT_RAG_ENABLED=true` e `OPENAI_EMBEDDING_MODEL`.
- As demais variáveis estão em `.env.example`, seção F5-core-B.

## Autenticação e contexto

- Todas as rotas usam JWT e o header `Selected-company`, com o middleware `member` (dono ou membro).
- `company_id` e `user_id` vêm **sempre** do contexto autenticado. A IA nunca os escolhe: eles não existem no schema do classificador, e campos extras são rejeitados.
- O assistente age com as permissões do usuário. Ferramentas marcadas como admin exigem `checkCompanyPermission`, verificado na proposta e de novo na confirmação.
- Conversas e ações pertencem ao par (empresa, usuário). Um recurso de outro usuário ou de outra empresa responde `404`, indistinguível de um recurso inexistente.

## Rotas

| Método e rota | Corpo | Resposta (`data`) |
|---|---|---|
| `POST /assistant/conversations` | – | `201 {id, title, message_count, created_at, updated_at}` (`id` = 32 caracteres hex) |
| `GET /assistant/conversations` | – | lista das 50 conversas mais recentes do usuário |
| `GET /assistant/conversations/:id` | – | conversa + `messages[{role, content, intent, source, created_at}]` + `pending_actions[{action_id, tool, summary, risk, expires_at}]` (sem token) |
| `POST /assistant/conversations/:id/messages` | `{message}` (1 a 4000 caracteres; acima de `ASSISTANT_MAX_MESSAGE_CHARS` é truncado e a resposta traz `truncated:true`) | `{reply, citations?, proposed_actions?, usage:{interactions_used, interactions_limit}}` |
| `POST /assistant/actions/:action_id/confirm` | `{confirm_token}` | `{action_id, status:'executed', tool, summary, result}` |
| `POST /assistant/actions/:action_id/reject` | – | `{action_id, status:'rejected'}` |
| `GET/POST /assistant/knowledge`, `PUT/DELETE /assistant/knowledge/:id` (admin) | `{kind: faq\|policy\|rule\|template, title ≤160, content ≤4000}` | itens da base de conhecimento (até 500 por empresa) |

Formato de cada item de `proposed_actions`:

```
{action_id, tool, summary, risk: 'low'|'medium', params_preview, confirm_token, expires_at}
```

Formato de cada item de `citations`:

```
{source_type: 'knowledge'|'service'|'company'|'appointment_note', source_id, score}
```

Não há SSE nesta fase: a resposta é JSON. O pipeline é curto (no máximo duas chamadas à IA).

## Erros

Formato: `{error:{code, message, ...}}`.

| Status | `code` | Quando |
|---|---|---|
| 402 | `plan_upgrade_required` | Cota mensal esgotada (`quota:'assistant_monthly_interactions', limit, used, plan`) ou ação de escrita no Free (`feature:'assistant_actions'`). No Free, o 402 sai tanto na proposta quanto na confirmação. |
| 429 | `rate_limited` | Mais de `ASSISTANT_RATE_PER_MIN` mensagens por minuto (por usuário e empresa). Traz o header `Retry-After`. |
| 429 | `assistant_budget_exceeded` | Teto de tokens da IA atingido (diário da empresa ou do usuário, mensal da empresa, ou global). As perguntas determinísticas continuam funcionando. |
| 403 | `assistant_forbidden` | Ferramenta de admin pedida por um membro (na proposta ou na confirmação). |
| 403 | `invalid_confirm_token` | Token errado, de outra ação, ou payload alterado no banco. |
| 404 | `conversation_not_found`, `action_not_found` | Inclui recurso de outro usuário ou de outra empresa. |
| 409 | `action_already_processed` | Replay, corrida entre confirmações, ação já rejeitada ou que já falhou. |
| 410 | `action_expired` | Ação vencida (TTL de `ASSISTANT_ACTION_TTL_MIN`, padrão 10 min). |
| 422 | `action_failed` | O serviço recusou a execução (por exemplo, horário ocupado). Mensagem segura; a ação fica `failed`. |
| 503 | `assistant_disabled`, `assistant_actions_disabled` | Assistente ou ações de escrita desligados por configuração. |

## Cota (plano)

- `assistant_monthly_interactions` vem do entitlement: Free = 30 e Premium = 1000 por mês.
- O consumo é contado em `usage_counters` (`metric='assistant_monthly_interactions'`, período `YYYY-MM`), com um claim atômico (`UPDATE ... WHERE used+1 <= limite`).
- **Cada mensagem aceita conta 1 interação**, seja respondida pelo roteador determinístico, seja pela IA. A cota é consumida antes de responder, e uma falha da IA também conta.
- `assistant_actions` é `true` só no Premium. No Free, o assistente é somente leitura.

## Fluxo da mensagem

1. Rate limit em banco, `sanitizeInput` e consumo da cota.
2. **Roteador determinístico** (`services/assistant/intents.js`). Perguntas frequentes viram consultas pré-definidas com template em pt-BR, sem IA:
   - agenda de hoje, amanhã ou da semana;
   - próximo atendimento;
   - estoque e estoque baixo;
   - faturamento do mês ou do mês passado;
   - quantidade de agendamentos;
   - serviços.

   Verbos de escrita nunca são resolvidos aqui. Texto de confirmação ("sim", "confirmo", "pode executar") recebe uma resposta fixa e **nunca executa** nada.
3. **Mensagem ambígua: IA** (`OPENAI_MODEL_DEFAULT`), em dois papéis apenas:
   - classificar o pedido em JSON estrito: `{tool, args}`, com `tool` da allowlist, `none` ou `refuse`;
   - redigir a resposta (`{reply}`) **somente** a partir do resultado da ferramenta.

   O contexto enviado é mínimo: resumo das ferramentas, últimas `ASSISTANT_HISTORY_WINDOW` mensagens e um resumo incremental, tudo delimitado como dado. Não há laço de ferramentas: são no máximo 1 leitura e 1 redação por mensagem, e uma escrita vira **proposta**.
4. Se a IA falhar (fora do ar, circuito aberto, resposta inválida), a resposta usa o template ou a ajuda fixa. Nunca sai um 500.

## Ferramentas (allowlist fechada, Joi)

**Leitura** (executam sem confirmação, com campos projetados e limitados):

| Ferramenta | Parâmetros e limites |
|---|---|
| `get_schedule` | até 31 dias |
| `next_appointment` | – |
| `find_customers` | telefone mascarado `***1234`; sem CPF nem e-mail |
| `list_services` | – |
| `list_stock` | `only_low` opcional |
| `financial_summary` | – |
| `appointments_report` | – |
| `check_availability` | até 7 dias |
| `search_knowledge` | busca no RAG |

**Escrita** (proposta, confirmação e execução):

| Ferramenta | Risco | Exige admin |
|---|---|---|
| `create_appointment` | médio | não |
| `update_appointment` | médio | não |
| `cancel_appointment` | médio | não |
| `adjust_stock` | baixo | não |
| `create_service` | baixo | sim |
| `update_service` | baixo | sim |
| `create_product` | baixo | sim |
| `update_product` | baixo | sim |
| `create_customer` | baixo | sim |
| `block_time` | baixo | sim |

- O payload final é revalidado com o **mesmo schema Joi da rota** correspondente.
- Os valores (nome do cliente, preço e duração do serviço) são resolvidos no banco, nunca tirados do texto da IA.
- A execução passa pela mesma camada de serviço das rotas, por exemplo `appointmentsService` (que verifica conflito de horário) e `companiesService`.
- **Fora da allowlist**: exclusões, anonimização ou exportação, pagamentos, estornos, cobranças, planos e assinaturas, membros e permissões, e serviços em domicílio (que exigem endereço; devem ser criados pelo painel).
- Não existe ferramenta de risco alto, então não há dupla confirmação nesta fase.

## Ações e `confirm_token`

- A proposta grava uma linha em `assistant_actions` (status `pending`) com os parâmetros imutáveis, `payload_hash` (sha256 do JSON canônico) e `expires_at_ms`.
- `confirm_token` = HMAC-SHA256(`ASSISTANT_TOKEN_SECRET`, JSON canônico de {ação, ferramenta, payload_hash, usuário, empresa, expiração}), codificado em base64url. Ele é devolvido uma única vez, na resposta da mensagem.
- Na confirmação, o sistema revalida nesta ordem:
  1. ação do mesmo usuário e da mesma empresa;
  2. hash do payload armazenado;
  3. token (comparação em tempo constante);
  4. status e expiração;
  5. plano Premium;
  6. RBAC;
  7. Joi.

  Depois vem o **claim atômico** `pending → executing`, de uso único. Por fim, a execução usa os parâmetros **armazenados**, e o status passa a `executed` ou `failed`.
- Estados possíveis: `pending | executing | executed | failed | rejected | expired`.

## Auditoria

`assistant_audit` registra quem, o quê, a ferramenta, os parâmetros, o resultado e os tokens de cada evento:

- `message`
- `injection_flagged`
- `message_denied`
- `action_proposed`
- `action_denied` (detalhe: `token`, `payload_mismatch`, `plan`, `rbac`, `race`...)
- `action_executed`
- `action_failed`
- `action_rejected`

O uso de IA também fica em `ai_usage`, com `feature` = `assistant_classify`, `assistant_compose`, `assistant_rag_index` ou `assistant_rag_query`.

## Orçamento de IA

As chamadas passam por `services/ai/client` (reserva atômica, circuit breaker, `ai_usage`), com estes tetos:

- global: `AI_GLOBAL_*`;
- empresa por dia: `ASSISTANT_COMPANY_DAILY_TOKENS`, escopo `company`, chave `assistant:{id}`;
- usuário por dia: `ASSISTANT_USER_DAILY_TOKENS`;
- empresa por mês: `ASSISTANT_COMPANY_MONTHLY_TOKENS`, calculado pela soma em `ai_usage` com `feature LIKE 'assistant%'`.

Os embeddings usam o mesmo orçamento global e da empresa, além do mesmo circuito.

## RAG (só texto não estruturado)

- **Interface** `vectorStore`: `upsert`, `removeSource`, `removeKeys`, `hashes`, `count`, `search`. Ela pode ser trocada com `rag.setStore`.
- **Implementação padrão**: `assistant_embeddings`, com vetor Float32 em `MEDIUMBLOB` e similaridade de cosseno calculada no Node. Sempre filtra `company_id`; o top-k é pequeno (`ASSISTANT_RAG_TOP_K`, padrão 4) e há um score mínimo.
- **Fontes**:
  - `assistant_knowledge`;
  - observações e `public_description` dos serviços;
  - `public_description` e `public_hours` da empresa;
  - observações de agendamentos, excluindo clientes anonimizados (até 500).

  Dados estruturados (agenda, financeiro, estoque) **não** entram no RAG: são consultados pelas ferramentas.
- **Indexação incremental** pelo hash do conteúdo de cada chunk (no máximo 5 chunks por fonte e `ASSISTANT_RAG_MAX_CHUNKS` por empresa):
  - job `assistant_rag_reconcile`, com dedupe por empresa e por hora;
  - producer horário para as empresas que usam o assistente;
  - gatilhos de escrita: CRUD da base de conhecimento e ações confirmadas.

  Edições feitas fora do assistente (serviços, agendamentos) entram no reconcile horário seguinte.
- **LGPD**:
  - anonimizar ou excluir um cliente remove na hora os vetores das observações dos agendamentos dele (`privacyService`);
  - excluir um item da base de conhecimento remove os vetores do item;
  - o reconcile apaga vetores cuja fonte sumiu.

## Segurança (resumo)

- Texto não confiável (mensagem do usuário, histórico, dados do banco, trechos do RAG) vai delimitado e escapado (`wrapData`). As regras de sistema dizem que esse conteúdo é dado, nunca instrução.
- A saída da IA é validada por Joi e passa por `filterOutput`:
  - canário e trechos do prompt bloqueiam a resposta;
  - links fora da allowlist, CPF, e-mails e telefones desconhecidos são removidos;
  - padrões de segredo (`sk-`, `$aact_`, JWT, bcrypt) são removidos.
- `detectInjection`: o sinal é auditado. Mensagem marcada como injeção cuja classificação é uma escrita recebe `refuse`, sem gerar proposta.
- Não há escrita encadeada, a IA nunca confirma e confirmação por texto é ignorada.
- Erros internos nunca vazam: a mensagem é genérica e o log registra só o código.

## Limitações conhecidas

- As mensagens do assistente (`assistant_messages`) e a auditoria **não** são limpas na anonimização de um cliente. Se o usuário digitou dados do cliente no chat, eles permanecem até a exclusão da conversa ou da empresa.
- As observações dos agendamentos são enviadas ao provedor de embeddings (OpenAI) quando o RAG está ligado.
- Não há SSE.
