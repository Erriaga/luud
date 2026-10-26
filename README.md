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
