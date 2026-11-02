# AGENTS.md

Instruções para agentes que trabalham neste repositório.

## Repositório

- Repositório: https://github.com/Erriaga/luud
- Remote: `origin` → `https://github.com/Erriaga/luud.git`
- Branch de trabalho: `main`

## Fluxo obrigatório (commit e push)

Ao terminar **qualquer alteração** (correção, ajuste visual, nova feature, refactor):

1. Revise o diff (`git diff`) e confirme que só entram no commit os arquivos
   relacionados à tarefa (nada de arquivos temporários de teste).
2. Crie o commit com mensagem em **português**, no formato
   `feat:`, `fix:`, `chore:`, `refactor:`, `docs:` — resumo curto na primeira
   linha e, quando ajudar, uma lista de detalhes no corpo.
3. Envie para o repositório: `git push origin main`.

```bash
git add <arquivos alterados>
git commit -m "fix: descrição curta da mudança"
git push origin main
```

O usuário **não** precisa pedir o commit/push: ele já é esperado ao final de
cada tarefa. Se o push falhar (por exemplo, credenciais), avise claramente em
vez de tentar contornar de formas arriscadas.

## Projeto

- Node.js 20+, dependências: `ws` (WebSocket) e `pg` (Postgres).
- `server.js` — servidor HTTP + WebSocket (`/ws`), rotas `/api/*`.
- `db.js` — camada de dados: Postgres (quando `DATABASE_URL` está definido) ou
  fallback em arquivos JSON locais (`data/*.json`).
- `public/game.html` — SPA do jogo (Tailwind via CDN).
- `public/auth.js` — conta do usuário: topo da página, menu suspenso, perfil.

### Comandos

```bash
npm start          # ou: node server.js
node --check db.js # validação de sintaxe
```

A porta vem do `.env` (localmente `PORT=4000`).

## Regras de cuidado

- `data/*.json` guarda dados locais de desenvolvimento: **não** commitar dados
  de teste (contas, sessões) criados para validação local.
- O schema do Postgres é migrado no start do servidor
  (`ALTER TABLE ... IF NOT EXISTS` em `db.js`): novas colunas devem ser
  adicionadas tanto no `CREATE TABLE` quanto na migração.
- Ao mexer no cabeçalho/topo da página, conferir o layout em **celular**
  (sem nickname, sem rolagem horizontal) e em **desktop**.
