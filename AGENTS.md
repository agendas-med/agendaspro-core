# agendaspro-core

Back-end e banco local do AgendasPro (Node/Express; MariaDB 11.4 em `127.0.0.1:3307` via Docker). Setup completo, Mercado Pago e payouts: `README.md` e `docs/` (`mercadopago.md`, `payouts-activation.md`). Regras de publicação e de interface da pasta pai: `../AGENTS.md`.

Scripts: `test` (`node --test`), `test:integration`, `db:migrate`, `db:seed-demo`, `payments:reconcile`, `payments:check`, `start`, `dev` (nodemon).

- `db:migrate` altera o banco (README: faça backup antes em base com dados reais; DDL do MariaDB não tem rollback). Não rode contra base real sem pedido.
- `MP_ENV=test` é o padrão da branch de Mercado Pago; credenciais de pagamento não vão para o chat nem para o git.
- Repo **público** no GitHub (org `agendas-med`).

## Regras comuns

- `.env*` nunca é lido, impresso nem commitado (nomes das variáveis: `.env.example`, quando existir).
- Sem `git push`/deploy sem pedido; commits com caminhos explícitos (nada de `git add .`).
- Os comandos citados vêm do `package.json` (quando o repo tem um) e **não foram executados** (`node`/`npm` fora do PATH nesta máquina). Confirme antes de afirmar que passam.
