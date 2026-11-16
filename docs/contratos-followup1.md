# Contratos: Core follow-up 1

Ajustes do core após F1–F5. Todos são **compatíveis** com os contratos anteriores, salvo quando a seção diz "mudança de comportamento". As mudanças pontuais de F4, F5-A e F5-B também estão anotadas nos respectivos `contratos-*.md`; este arquivo reúne os itens novos.

## D1. Foto do profissional (upload no core)

O dyno do Heroku tem disco efêmero, e o fallback local de `config/s3.js` (`static/uploads`) perde arquivos a cada deploy. Por isso a foto do profissional fica no banco (`professional_photos`, migração 015), sem depender de S3.

| Método | Rota | Papel | Corpo / resposta |
| --- | --- | --- | --- |
| `POST` | `/professionals/:id/photo` | admin | `{ "image": "data:image/png;base64,..." }` → `200 {data: <profissional>}` com `photo_url` preenchida |
| `DELETE` | `/professionals/:id/photo` | admin | `200 {data: <profissional>}`; `photo_url` vira `null` se apontava para a foto do core |
| `GET` | `/files/professional-photo/:id/:hash` | pública | bytes da imagem |

Regras:

- **Formatos aceitos:** só PNG, JPEG e WebP, enviados como data URL base64.
- **Validação pelos bytes:** o tipo é conferido pelos primeiros bytes (magic number) e tem de bater com o tipo declarado. SVG, GIF, HTML disfarçado ou URL dão `400`.
- **Limite de tamanho:** `PROFESSIONAL_PHOTO_MAX_BYTES` (padrão 1 MiB decodificado). Acima disso a resposta é `413`. O corpo JSON dessa rota aceita até 2 MB, então valores acima de ~1,4 MiB não têm efeito.
- **URL:** `photo_url` = `<PUBLIC_API_URL>/files/professional-photo/<id>/<16 hex do sha256>`.
  - A URL muda a cada troca de imagem; a antiga passa a responder `404`.
  - Cache: `public, max-age=31536000, immutable`.
  - Cabeçalhos de segurança: `X-Content-Type-Options: nosniff` e `Content-Security-Policy: default-src 'none'; sandbox`.
- **Pública por design:** a foto já aparece na página pública. Sem o hash da versão atual, a rota dá `404`.
- **Isolamento:**
  - profissional de outra empresa: `404`;
  - membro não admin: `401` (mesmo comportamento das demais rotas admin de `/professionals`).
- **`photo_url` externa:** o `PATCH /professionals/:id` com `photo_url` continua aceito. `DELETE .../photo` não apaga uma URL externa.
- **Exclusão:** a foto some junto com o profissional ou a empresa (`ON DELETE CASCADE`).

## D2. Vínculo profissional ↔ usuário (`professionals.user_id`)

O campo `user_id` já era aceito em `POST`/`PATCH /professionals`. O que mudou:

| Método | Rota | Papel | Resposta |
| --- | --- | --- | --- |
| `GET` | `/professionals/members` | admin | `{data: [{user_id, name, email, professional_id}]}`: membros da empresa e o profissional **ativo** vinculado (ou `null`), para o seletor do painel |
| `GET` | `/professionals/me` | membro | `{data: <profissional> \| null}`: o profissional ativo do usuário logado nesta empresa |

Regras do vínculo:

- **Um vínculo por usuário:** cada usuário fica ligado a no máximo **um profissional ativo** por empresa. Se ele já estiver ligado a outro, a resposta é `409 {error: {code: "professional_user_taken", message, professional_id}}`, onde `professional_id` é o profissional que já tem o vínculo.
  - Isso vale para criar, para `PATCH` com `user_id` e para reativar (`active: true`).
  - A checagem roda com a empresa travada (`FOR UPDATE`), então duas requisições simultâneas não criam vínculo duplicado.
- **Desativar libera o usuário:** um profissional desativado não segura o vínculo.
- **Usuário de outra empresa:** `400`, como antes.
- **Saída da empresa:** quando o usuário é removido (`DELETE /companies/remove_user/:id`), o `user_id` dos profissionais dele vira `null`. O profissional continua existindo.
