# LUUD Node.js

Versão Node.js do jogo **LUUD**, com:

- jogo original servido por um servidor Node.js;
- login com **Conta Google**;
- perfil do usuário no topo da página;
- menu suspenso com **Perfil** e **Sair**;
- edição das principais informações da conta.

## Como rodar

1. Instale o **Node.js 20 ou superior**.
2. Na pasta do projeto, crie um arquivo `.env` (ou copie `.env.example`):

   ```env
   PORT=3000
   GOOGLE_CLIENT_ID=seu-client-id
   NODE_ENV=development
   ```

3. Inicie o servidor:

   ```bash
   node server.js
   ```

   ou:

   ```bash
   npm start
   ```

4. Abra no navegador:

   ```text
   http://127.0.0.1:3000
   ```

> Se o PowerShell bloquear o comando `npm`, use `node server.js` diretamente.

## Como ativar o login Google

1. Acesse <https://console.cloud.google.com/>.
2. Crie um projeto.
3. Em **APIs e serviços > Credenciais**, crie um **ID do cliente OAuth 2.0**.
4. Em **Origens JavaScript autorizadas**, adicione:

   ```text
   http://127.0.0.1:3000
   ```

5. Copie o **Client ID** gerado.
6. Cole no arquivo `.env`:

   ```env
   GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
   ```

7. Reinicie o servidor.

O primeiro login com Google cria automaticamente a conta.
Os logins seguintes entram na mesma conta.

## Estrutura

- `server.js` — servidor Node.js e APIs de conta.
- `public/game.html` — jogo original.
- `public/login.html` — página de login/cadastro com Google.
- `public/auth.js` — perfil, menu da conta e logout.
- `public/assets/avatar.svg` — foto padrão do usuário.
- `data/users.json` — contas criadas.
- `data/sessions.json` — sessões ativas.
- `.env.example` — exemplo de configuração.

## Deploy no Render

1. No Render, use:
   - **Build Command:** `yarn install`
   - **Start Command:** `node server.js`
2. Em **Environment**, cadastre:
   - `GOOGLE_CLIENT_ID` — o Client ID do Google;
   - `NODE_ENV` — `production`.
3. O Render injeta automaticamente a variável `PORT`.
4. O servidor precisa escutar em `0.0.0.0`, não em `127.0.0.1`.

Este projeto já está configurado para usar:

```js
server.listen(PORT, '0.0.0.0');
```

Se você quiser um health check, use:

```text
/healthz
```

Exemplo:

```text
https://seu-app.onrender.com/healthz
```

### Origem autorizada no Google Cloud

Depois que o Render gerar o endereço final do app, adicione essa origem no Google Cloud Console:

```text
https://seu-app.onrender.com
```

Não use barra no final.

### Mantendo o banco de dados permanente (sobrevive a deploys)

O Render usa sistema de arquivos efêmero: os arquivos `data/users.json`,
`data/sessions.json` e `data/matches.json` são apagados a cada novo deploy.

Você tem duas opções para manter os dados permanentes:

#### Opção A: Banco de dados externo gratuito (recomendado — não precisa de plano pago)

O servidor agora suporta **PostgreSQL externo** via variável `DATABASE_URL`.
Quando definida, contas, sessões, histórico e amizades são gravados no banco
externo em vez de arquivos locais, sobrevivendo a deploys sem precisar de
Persistent Disk pago.

Provedores PostgreSQL com plano gratuito:

| Serviço | Free tier | Link |
|---------|-----------|------|
| **Supabase** | 500 MB | https://supabase.com/ |
| **Neon** | 3 GB | https://neon.tech/ |
| **Render PostgreSQL** | (teste gratuito) | https://render.com/ |
| **ElephantSQL** | 20 MB | https://elephantsql.com/ |

**Como configurar no Render:**

1. Crie um banco PostgreSQL em um dos provedores acima.
2. Copie a string de conexão (exemplo: `postgres://user:pass@host:port/db?sslmode=require`).
3. No painel do Render, acesse seu serviço > **Environment** e cadastre:
   - `DATABASE_URL` = a string de conexão completa
   - `NODE_ENV` = `production`
   - `GOOGLE_CLIENT_ID` = seu Client ID do Google
4. Faça um novo deploy. O servidor detecta `DATABASE_URL` e usa o banco externo
   automaticamente.

> Não é necessário criar Persistent Disk quando usa `DATABASE_URL`.

#### Opção B: Persistent Disk (plano pago do Render)

Se preferir continuar usando arquivos JSON locais, crie um **Persistent Disk**
no Render (requer plano pago):

1. No painel do Render, acesse seu serviço > **Disks** > **Add Disk**:
   - **Name:** `luud-data`;
   - **Mount Path:** `/var/data`;
   - **Size:** 1 GB (ou mais).
2. Em **Environment**, cadastre:
   - `DATA_DIR=/var/data`
3. Faça um novo deploy.

> Se nem `DATABASE_URL` nem `DATA_DIR` estiverem definidos em produção, o
> servidor exibe um aviso no log e os dados serão perdidos a cada deploy.


