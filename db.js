'use strict';

const { Pool } = require('pg');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// Diretório de fallback para arquivos JSON (desenvolvimento local sem DATABASE_URL)
const DATA_DIR = path.join(process.env.DATA_DIR || ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');

let pool = null;
let dbAvailable = false; // true quando o banco externo respondeu bem alguma vez
let dbLastError = null;  // último erro do banco (usado no diagnóstico)

/* O banco externo é usado SEMPRE que DATABASE_URL estiver definida.
   Nunca caímos silenciosamente no JSON local quando ele está configurado:
   o JSON local não tem os dados de produção e zeraria listas
   (ex.: a lista de amigos), parecendo que o dado foi apagado. */
function dbIsConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function useDatabase() {
  return dbIsConfigured();
}

// Remove credenciais/host de mensagens de erro antes de expor/logar
function sanitizeDbErrorMessage(message) {
  const text = String(message || '').replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://<oculto>');
  return text.slice(0, 200);
}

// Registra o erro do banco e devolve a exceção para o chamador tratar
function recordDbError(error, context) {
  const safeMessage = sanitizeDbErrorMessage(error && error.message);
  dbLastError = {
    context: String(context || 'consulta ao banco').slice(0, 120),
    code: error && error.code ? String(error.code) : null,
    message: safeMessage,
    at: new Date().toISOString()
  };
  try {
    error.dbError = true;
    error.safeMessage = safeMessage;
  } catch (ignored) {
    // erro sem propriedades graváveis: segue o fluxo normal
  }
  console.error(`[banco] falha em ${dbLastError.context}:`, error && error.message);
  return error;
}

// Estado do banco para o endpoint de diagnóstico (/healthz)
function getDbStatus() {
  return {
    configured: dbIsConfigured(),
    connected: dbAvailable,
    lastError: dbLastError
  };
}

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    try {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 10000
      });
      // O Pool reconecta sozinho; basta refletir o estado real no diagnóstico
      pool.on('connect', () => {
        dbAvailable = true;
      });
      pool.on('error', (error) => {
        recordDbError(error, 'pool');
      });
    } catch (error) {
      pool = null;
    }
  }
  return pool;
}

/* ------------------------------------------------------------------
   JSON fallback (desenvolvimento local ou banco externo inacessível)
------------------------------------------------------------------ */
async function readJsonFile(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content || '{}');
  } catch (error) {
    return {};
  }
}

async function writeJsonFile(filePath, data) {
  const temporary = `${filePath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temporary, filePath);
}

function readJsonFileSync(filePath) {
  try {
    return JSON.parse(fss.readFileSync(filePath, 'utf8') || '{}');
  } catch (error) {
    return {};
  }
}

/* ------------------------------------------------------------------
   Esquema do banco de dados
------------------------------------------------------------------ */
async function ensureDatabaseSchema() {
  const p = getPool();
  if (!p) return;

  dbLastError = null;

  // Cada tabela é criada por conta própria: uma tabela que falha não pode
  // derrubar o site inteiro (e sim aparecer no log/diagnóstico).
  let schemaProblems = 0;
  const createTable = async (label, sql) => {
    try {
      await p.query(sql);
      return true;
    } catch (error) {
      schemaProblems += 1;
      console.warn(`[banco] não foi possível preparar a tabela "${label}":`, error.message);
      recordDbError(error, `schema:${label}`);
      return false;
    }
  };

  try {
    // Tabelas essenciais: sem elas o servidor não funciona
    const usersReady = await createTable('users', `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        display_name TEXT,
        player_name TEXT,
        avatar_url TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        google_sub TEXT DEFAULT '',
        picture TEXT DEFAULT '',
        primary_color TEXT DEFAULT '#0096ff',
        secondary_color TEXT DEFAULT '#00a86b',
        tertiary_color TEXT DEFAULT '#ef233c',
        colors_customized BOOLEAN DEFAULT FALSE,
        is_paid BOOLEAN DEFAULT FALSE,
        plan TEXT DEFAULT 'free',
        paid_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const sessionsReady = await createTable('sessions', `
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      );
    `);

    if (!usersReady || !sessionsReady) {
      throw new Error('Tabelas essenciais (users/sessions) não puderam ser criadas.');
    }

    // Migra bancos antigos: cores do perfil e flag de conta paga
    try {
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#0096ff';`);
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_color TEXT DEFAULT '#00a86b';`);
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tertiary_color TEXT DEFAULT '#ef233c';`);
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS colors_customized BOOLEAN DEFAULT FALSE;`);
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_paid BOOLEAN DEFAULT FALSE;`);
      await p.query(`ALTER TABLE users ALTER COLUMN primary_color SET DEFAULT '#0096ff';`);
      await p.query(`ALTER TABLE users ALTER COLUMN secondary_color SET DEFAULT '#00a86b';`);
      await p.query(`ALTER TABLE users ALTER COLUMN tertiary_color SET DEFAULT '#ef233c';`);
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free';`);
      await p.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;`);
    } catch (migrationError) {
      console.warn('Não foi possível migrar as cores do perfil:', migrationError.message);
    }

    // Tabela de cobranças Pix (pagamento único da Conta Premium)
    await createTable('payments', `
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gateway TEXT DEFAULT 'pix',
        amount NUMERIC DEFAULT 0,
        status TEXT DEFAULT 'pending',
        gateway_ref TEXT DEFAULT '',
        copy_paste TEXT DEFAULT '',
        qr_code TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP
      );
    `);

    await createTable('matches', `
      CREATE TABLE IF NOT EXISTS matches (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'local',
        result TEXT NOT NULL DEFAULT 'loss',
        player_score INTEGER NOT NULL DEFAULT 0,
        opponent_score INTEGER NOT NULL DEFAULT 0,
        opponent_name TEXT NOT NULL DEFAULT 'Oponente',
        finished_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await createTable('friends', `
      CREATE TABLE IF NOT EXISTS friends (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, friend_id)
      );
    `);

    await createTable('friend_requests', `
      CREATE TABLE IF NOT EXISTS friend_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migra bancos antigos: finished_at era TIMESTAMP (sem fuso), o que desloca a data da partida
    try {
      await p.query(`
        DO $$ BEGIN
          IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'matches' AND column_name = 'finished_at') = 'timestamp without time zone' THEN
            ALTER TABLE matches ALTER COLUMN finished_at TYPE TIMESTAMPTZ USING finished_at AT TIME ZONE 'UTC';
          END IF;
        END $$;
      `);
    } catch (migrationError) {
      console.warn('Não foi possível migrar matches.finished_at:', migrationError.message);
    }

    try {
      await p.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_matches_user_id ON matches(user_id);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id);`);
      await p.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_status ON friend_requests(status);`);
    } catch (indexError) {
      console.warn('Não foi possível criar os índices do banco:', indexError.message);
    }

    dbAvailable = true;
    // Só limpa o último erro se nenhuma tabela deu problema
    if (!schemaProblems) dbLastError = null;
    console.log('Banco de dados externo conectado com sucesso.');
    if (schemaProblems) {
      console.warn(`[banco] ${schemaProblems} tabela(s) não puderam ser verificadas. Veja /healthz para o detalle.`);
    }
  } catch (error) {
    // Não abandona o pool: ele reconecta sozinho nas próximas tentativas.
    // Registra o erro para o diagnóstico (/healthz).
    dbAvailable = false;
    recordDbError(error, 'ensureDatabaseSchema');
    console.warn('AVISO: Não foi possível preparar o banco de dados externo (DATABASE_URL).');
    console.warn('O servidor NÃO usará os arquivos JSON locais enquanto DATABASE_URL estiver definido,');
    console.warn('porque eles não contêm os dados de produção (a lista de amigos apareceria vazia).');
  }
}

/* ------------------------------------------------------------------
   Inicialização
------------------------------------------------------------------ */
async function ensureDataFiles() {
  if (process.env.DATABASE_URL) {
    // Tenta algumas vezes: em deploys o banco pode demorar alguns segundos
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ensureDatabaseSchema();
      if (dbAvailable) break;
      if (attempt < 3) {
        console.warn(`Tentativa ${attempt} de conectar ao banco falhou. Tentando de novo...`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  // Sem DATABASE_URL o servidor usa os arquivos JSON locais.
  // (Com DATABASE_URL definido eles NUNCA são usados para dados de produção.)
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!fss.existsSync(USERS_FILE)) await fs.writeFile(USERS_FILE, JSON.stringify({}, null, 2), 'utf8');
  if (!fss.existsSync(SESSIONS_FILE)) await fs.writeFile(SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf8');
  if (!fss.existsSync(MATCHES_FILE)) await fs.writeFile(MATCHES_FILE, JSON.stringify({}, null, 2), 'utf8');
  if (!fss.existsSync(PAYMENTS_FILE)) await fs.writeFile(PAYMENTS_FILE, JSON.stringify({}, null, 2), 'utf8');
}

/* ------------------------------------------------------------------
   Normalização de usuário
------------------------------------------------------------------ */
/* Cores padrão do perfil (primária, secundária e terciária) */
const DEFAULT_PRIMARY_COLOR = '#0096ff';   // Azul
const DEFAULT_SECONDARY_COLOR = '#00a86b'; // Verde
const DEFAULT_TERTIARY_COLOR = '#ef233c';  // Vermelho

/* Contas que já nascem com o plano pago liberado (usadas em testes) */
const PAID_TEST_EMAILS = ['ifsp.raphael@gmail.com'];

/* Planos disponíveis: 'free' (padrão) e 'premium' (pagamento único vitalício) */
const PLAN_FREE = 'free';
const PLAN_PREMIUM = 'premium';

function isPaidEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  return PAID_TEST_EMAILS.includes(value);
}

function normalizePlan(plan, isPaid) {
  const value = String(plan || '').trim().toLowerCase();
  if (value === PLAN_PREMIUM) return PLAN_PREMIUM;
  return isPaid ? PLAN_PREMIUM : PLAN_FREE;
}

function normalizeHexColorValue(value, fallback) {
  const hex = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : fallback;
}

/**
 * Nome exibido no site: sempre o NICKNAME (apelido).
 * Contas antigas podem ter o nome completo no campo player_name
 * (gerado automaticamente a partir do Google): nesse caso o apelido
 * usado é o prefixo do e-mail.
 */
function nicknameFrom(playerName, displayName, email) {
  const nick = String(playerName || '').trim();
  const display = String(displayName || '').trim();
  const prefix = String(email || '').split('@')[0].trim();
  if (nick && nick !== display) return nick;
  return prefix || nick || display;
}

/**
 * Cores do perfil: enquanto o jogador não salvar as próprias
 * preferências, valem sempre os padrões (Azul, Verde e Vermelho).
 */
function profileColorsFor(user) {
  const customized = Boolean(user && user.colorsCustomized);
  return {
    primaryColor: customized
      ? normalizeHexColorValue(user.primaryColor, DEFAULT_PRIMARY_COLOR)
      : DEFAULT_PRIMARY_COLOR,
    secondaryColor: customized
      ? normalizeHexColorValue(user.secondaryColor, DEFAULT_SECONDARY_COLOR)
      : DEFAULT_SECONDARY_COLOR,
    tertiaryColor: customized
      ? normalizeHexColorValue(user.tertiaryColor, DEFAULT_TERTIARY_COLOR)
      : DEFAULT_TERTIARY_COLOR
  };
}

function normalizeUserFromDb(row) {
  if (!row) return null;
  const colors = profileColorsFor({
    colorsCustomized: row.colors_customized === true,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    tertiaryColor: row.tertiary_color
  });
  const paid = row.is_paid === true || row.plan === PLAN_PREMIUM || isPaidEmail(row.email);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.email.split('@')[0],
    playerName: nicknameFrom(row.player_name, row.display_name, row.email),
    avatarUrl: row.avatar_url || '',
    bio: row.bio || '',
    googleSub: row.google_sub || '',
    picture: row.picture || '',
    primaryColor: colors.primaryColor,
    secondaryColor: colors.secondaryColor,
    tertiaryColor: colors.tertiaryColor,
    colorsCustomized: row.colors_customized === true,
    isPaid: paid,
    plan: normalizePlan(row.plan, paid),
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
  };
}

function normalizeUser(user) {
  const colors = profileColorsFor(user);
  const paid = user.isPaid === true || user.plan === PLAN_PREMIUM || isPaidEmail(user.email);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || user.email.split('@')[0],
    playerName: nicknameFrom(user.playerName, user.displayName, user.email),
    avatarUrl: user.avatarUrl || '',
    bio: user.bio || '',
    googleSub: user.googleSub || '',
    picture: user.picture || '',
    primaryColor: colors.primaryColor,
    secondaryColor: colors.secondaryColor,
    tertiaryColor: colors.tertiaryColor,
    colorsCustomized: Boolean(user.colorsCustomized),
    isPaid: paid,
    plan: normalizePlan(user.plan, paid),
    paidAt: user.paidAt || null,
    friends: Array.isArray(user.friends) ? user.friends : [],
    friendRequestsSent: Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [],
    friendRequestsReceived: Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : [],
    createdAt: user.createdAt || new Date().toISOString(),
    updatedAt: user.updatedAt || new Date().toISOString()
  };
}

/* ------------------------------------------------------------------
   Perfil público de usuário (para mensagens do WebSocket)
   O nome exibido é sempre o NICKNAME (apelido), nunca o nome completo.
------------------------------------------------------------------ */
async function getUserProfile(uid) {
  if (!uid) return null;
  const user = await getUserById(uid);
  if (!user) return null;
  const nickname = nicknameFrom(user.playerName, user.displayName, user.email);
  return {
    id: user.id,
    uid: user.id,
    name: nickname,
    email: user.email,
    picture: user.picture || user.avatarUrl || '',
    playerName: nickname,
    primaryColor: user.primaryColor,
    secondaryColor: user.secondaryColor,
    tertiaryColor: user.tertiaryColor,
    isPaid: user.isPaid === true
  };
}

/* ------------------------------------------------------------------
   Usuários
------------------------------------------------------------------ */
async function getUserById(id) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query('SELECT * FROM users WHERE id = $1', [id]);
      return result.rows[0] ? normalizeUserFromDb(result.rows[0]) : null;
    } catch (error) {
      throw recordDbError(error, "getUserById");
    }
  }
  const users = await readJsonFile(USERS_FILE);
  const user = users[id];
  return user ? normalizeUser(user) : null;
}

async function getUserByEmail(email) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
      return result.rows[0] ? normalizeUserFromDb(result.rows[0]) : null;
    } catch (error) {
      throw recordDbError(error, "getUserByEmail");
    }
  }
  const users = await readJsonFile(USERS_FILE);
  for (const id of Object.keys(users)) {
    if (String(users[id].email || '').toLowerCase() === String(email || '').toLowerCase()) {
      return normalizeUser(users[id]);
    }
  }
  return null;
}

async function searchUsersByQuery(query, excludeUserId) {
  const qLower = String(query || '').trim().toLowerCase();
  if (!qLower) return null;

  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query(
        `SELECT * FROM users 
         WHERE id <> $1 
           AND (
             LOWER(email) = LOWER($2)
             OR LOWER(player_name) = LOWER($2)
             OR LOWER(display_name) = LOWER($2)
             OR LOWER(player_name) LIKE LOWER($3)
             OR LOWER(display_name) LIKE LOWER($3)
             OR LOWER(email) LIKE LOWER($3)
           )
         ORDER BY CASE
           WHEN LOWER(email) = LOWER($2) THEN 0
           WHEN LOWER(player_name) = LOWER($2) THEN 1
           WHEN LOWER(display_name) = LOWER($2) THEN 2
           ELSE 3
         END
         LIMIT 1`,
        [excludeUserId, qLower, `%${qLower}%`]
      );
      return result.rows[0] ? normalizeUserFromDb(result.rows[0]) : null;
    } catch (error) {
      throw recordDbError(error, "searchUsersByQuery");
    }
  }

  const users = await readJsonFile(USERS_FILE);
  let target = null;
  for (const id of Object.keys(users)) {
    if (id === excludeUserId) continue;
    if (String(users[id].email || '').toLowerCase() === qLower) { target = users[id]; break; }
  }
  if (!target) {
    for (const id of Object.keys(users)) {
      if (id === excludeUserId) continue;
      const u = users[id];
      const player = String(u.playerName || '').toLowerCase();
      const display = String(u.displayName || '').toLowerCase();
      if (player === qLower || display === qLower) { target = u; break; }
    }
  }
  if (!target) {
    for (const id of Object.keys(users)) {
      if (id === excludeUserId) continue;
      const u = users[id];
      const player = String(u.playerName || '').toLowerCase();
      const display = String(u.displayName || '').toLowerCase();
      const email = String(u.email || '').toLowerCase();
      if (player.includes(qLower) || display.includes(qLower) || email.includes(qLower)) { target = u; break; }
    }
  }
  return target ? normalizeUser(target) : null;
}

async function createOrUpdateUserFromGoogle(payload) {
  const userId = payload.sub || payload.email;
  const now = new Date().toISOString();
  const email = payload.email;
  const displayName = payload.name || email.split('@')[0];
  const picture = payload.picture || '';
  // O NICKNAME do jogo é o prefixo do e-mail (ex.: "ifsp.raphael").
  // O nome e sobrenome do Google ficam só em display_name e nunca são exibidos.
  const nickname = email.split('@')[0];

  if (useDatabase()) {
    try {
      const p = getPool();
      // Procura a conta pelo id do Google, pelo e-mail ou pelo google_sub.
      // Se a conta já existir com outro id (ex.: id antigo = e-mail), usamos
      // o id que já está no banco: é ele que guarda as friendships,
      // as sessões e o histórico. Trocar o id apagaria a lista de amigos.
      const existing = await p.query(
        `SELECT * FROM users
         WHERE id = $1
            OR LOWER(email) = LOWER($2)
            OR ($3 <> '' AND google_sub = $3)
         ORDER BY CASE WHEN id = $1 THEN 0 WHEN LOWER(email) = LOWER($2) THEN 1 ELSE 2 END
         LIMIT 1`,
        [userId, email, payload.sub || '']
      );

      if (existing.rows.length > 0) {
        const u = existing.rows[0];
        const existingId = u.id;
        // Mantém o nickname escolhido pelo jogador; se ele ainda for o nome
        // completo do Google (gerado automaticamente), troca pelo prefixo do e-mail.
        const currentPlayerName = u.player_name || '';
        const playerName = (currentPlayerName && currentPlayerName !== (u.display_name || ''))
          ? currentPlayerName
          : nickname;
        await p.query(
          `UPDATE users SET email = $1, display_name = COALESCE($2, display_name), player_name = $3, picture = COALESCE($4, picture), google_sub = COALESCE(NULLIF($5, ''), google_sub), updated_at = $6 WHERE id = $7`,
          [email, displayName, playerName, picture, payload.sub || '', now, existingId]
        );
        const row = await p.query('SELECT * FROM users WHERE id = $1', [existingId]);
        const updated = normalizeUserFromDb(row.rows[0]);
        if (existingId !== userId) {
          console.log(`[banco] conta ${email} encontrada com id ${existingId} (id do Google: ${userId}). Mantido o id original.`);
        }
        return updated;
      } else {
        await p.query(
          `INSERT INTO users (id, email, display_name, player_name, avatar_url, bio, google_sub, picture, created_at, updated_at) VALUES ($1, $2, $3, $4, '', '', $5, $6, $7, $8)`,
          [userId, email, displayName, nickname, payload.sub || '', picture, now, now]
        );
        const row = await p.query('SELECT * FROM users WHERE id = $1', [userId]);
        return normalizeUserFromDb(row.rows[0]);
      }
    } catch (error) {
      throw recordDbError(error, "createOrUpdateUserFromGoogle");
    }
  }

  // Fallback JSON
  const users = await readJsonFile(USERS_FILE);
  const existingUser = users[userId];
  const currentPlayerName = existingUser?.playerName || '';
  const playerName = (currentPlayerName && currentPlayerName !== (existingUser?.displayName || ''))
    ? currentPlayerName
    : nickname;
  const updatedUser = normalizeUser({
    id: userId,
    email,
    displayName: existingUser?.displayName || displayName,
    playerName,
    avatarUrl: existingUser?.avatarUrl || '',
    bio: existingUser?.bio || '',
    googleSub: payload.sub || '',
    picture: existingUser?.picture || picture,
    // Preserva as preferências de cor e a condição de conta paga
    primaryColor: existingUser?.primaryColor,
    secondaryColor: existingUser?.secondaryColor,
    tertiaryColor: existingUser?.tertiaryColor,
    colorsCustomized: existingUser?.colorsCustomized === true,
    isPaid: existingUser?.isPaid === true || isPaidEmail(email),
    createdAt: existingUser?.createdAt || now,
    updatedAt: now
  });
  users[userId] = updatedUser;
  await writeJsonFile(USERS_FILE, users);
  return updatedUser;
}

async function updateUserProfile(userId, fields) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const updates = [];
      const values = [];
      let idx = 1;
      if (fields.displayName !== undefined) { updates.push(`display_name = $${idx++}`); values.push(fields.displayName); }
      if (fields.playerName !== undefined) { updates.push(`player_name = $${idx++}`); values.push(fields.playerName); }
      if (fields.avatarUrl !== undefined) { updates.push(`avatar_url = $${idx++}`); values.push(fields.avatarUrl); }
      if (fields.bio !== undefined) { updates.push(`bio = $${idx++}`); values.push(fields.bio); }
      if (fields.primaryColor !== undefined) { updates.push(`primary_color = $${idx++}`); values.push(fields.primaryColor); }
      if (fields.secondaryColor !== undefined) { updates.push(`secondary_color = $${idx++}`); values.push(fields.secondaryColor); }
      if (fields.tertiaryColor !== undefined) { updates.push(`tertiary_color = $${idx++}`); values.push(fields.tertiaryColor); }
      if (fields.colorsCustomized !== undefined) { updates.push(`colors_customized = $${idx++}`); values.push(fields.colorsCustomized); }
      if (fields.isPaid !== undefined) { updates.push(`is_paid = $${idx++}`); values.push(fields.isPaid); }
      if (fields.plan !== undefined) { updates.push(`plan = $${idx++}`); values.push(fields.plan); }
      if (fields.paidAt !== undefined) { updates.push(`paid_at = $${idx++}`); values.push(fields.paidAt); }
      updates.push(`updated_at = $${idx++}`); values.push(new Date().toISOString());
      values.push(userId);

      await p.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
      const row = await p.query('SELECT * FROM users WHERE id = $1', [userId]);
      return normalizeUserFromDb(row.rows[0]);
    } catch (error) {
      throw recordDbError(error, "updateUserProfile");
    }
  }

  // Fallback JSON
  const users = await readJsonFile(USERS_FILE);
  const currentUser = users[userId];
  if (!currentUser) return null;
  users[userId] = normalizeUser({ ...currentUser, ...fields, updatedAt: new Date().toISOString() });
  await writeJsonFile(USERS_FILE, users);
  return users[userId];
}

/* ------------------------------------------------------------------
   CONTA PREMIUM
   Ativa o plano premium (pagamento único vitalício) do jogador.
   A operação é idempotente: chamar de novo não causa problema.
------------------------------------------------------------------ */
async function activatePremium(userId, paymentRef) {
  const paidAt = new Date().toISOString();
  const user = await updateUserProfile(userId, {
    isPaid: true,
    plan: PLAN_PREMIUM,
    paidAt
  });
  return { user, paymentRef: paymentRef || '' };
}

/* ------------------------------------------------------------------
   COBRANÇAS PIX
   Cada tentativa de compra gera um registro de pagamento. O registro
   é a fonte de verdade do servidor: o cliente nunca informa que pagou.
------------------------------------------------------------------ */

// Garante que a tabela de cobranças exista (auto-correção em tempo de execução)
let paymentsTableChecked = false;
async function ensurePaymentsTable() {
  if (!useDatabase()) return;
  if (paymentsTableChecked) return;
  const p = getPool();
  if (!p) return;
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        gateway TEXT DEFAULT 'pix',
        amount NUMERIC DEFAULT 0,
        status TEXT DEFAULT 'pending',
        gateway_ref TEXT DEFAULT '',
        copy_paste TEXT DEFAULT '',
        qr_code TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP DEFAULT NOW(),
        paid_at TIMESTAMP
      );
    `);
    paymentsTableChecked = true;
    dbLastError = null;
  } catch (error) {
    throw recordDbError(error, 'ensurePaymentsTable');
  }
}

function normalizePayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id || row.userId,
    gateway: row.gateway || 'pix',
    amount: Number(row.amount || 0),
    status: row.status || 'pending',
    gatewayRef: row.gateway_ref || row.gatewayRef || '',
    copyPaste: row.copy_paste || row.copyPaste || '',
    qrCode: row.qr_code || row.qrCode || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null
  };
}

async function createPayment(payment) {
  const record = {
    id: payment.id,
    userId: payment.userId,
    gateway: payment.gateway || 'pix',
    amount: Number(payment.amount || 0),
    status: payment.status || 'pending',
    gatewayRef: payment.gatewayRef || '',
    copyPaste: payment.copyPaste || '',
    qrCode: payment.qrCode || '',
    createdAt: new Date().toISOString(),
    expiresAt: payment.expiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    paidAt: null
  };

  if (useDatabase()) {
    try {
      const p = getPool();
      await ensurePaymentsTable();
      await p.query(
        `INSERT INTO payments (id, user_id, gateway, amount, status, gateway_ref, copy_paste, qr_code, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          record.id, record.userId, record.gateway, record.amount, record.status,
          record.gatewayRef, record.copyPaste, record.qrCode, record.createdAt, record.expiresAt
        ]
      );
      return record;
    } catch (error) {
      throw recordDbError(error, "createPayment");
    }
  }

  const payments = await readJsonFile(PAYMENTS_FILE);
  payments[record.id] = record;
  await writeJsonFile(PAYMENTS_FILE, payments);
  return record;
}

async function getPayment(paymentId) {
  if (!paymentId) return null;
  if (useDatabase()) {
    try {
      const p = getPool();
      await ensurePaymentsTable();
      const result = await p.query('SELECT * FROM payments WHERE id = $1', [paymentId]);
      return result.rows.length ? normalizePayment(result.rows[0]) : null;
    } catch (error) {
      throw recordDbError(error, "getPayment");
    }
  }
  const payments = await readJsonFile(PAYMENTS_FILE);
  return payments[paymentId] ? normalizePayment(payments[paymentId]) : null;
}

async function findPaymentByGatewayRef(gatewayRef) {
  if (!gatewayRef) return null;
  if (useDatabase()) {
    try {
      const p = getPool();
      await ensurePaymentsTable();
      const result = await p.query('SELECT * FROM payments WHERE gateway_ref = $1 ORDER BY created_at DESC LIMIT 1', [gatewayRef]);
      return result.rows.length ? normalizePayment(result.rows[0]) : null;
    } catch (error) {
      throw recordDbError(error, "findPaymentByGatewayRef");
    }
  }
  const payments = await readJsonFile(PAYMENTS_FILE);
  const ids = Object.keys(payments).sort((a, b) => String(payments[b].createdAt).localeCompare(String(payments[a].createdAt)));
  for (const id of ids) {
    if (payments[id].gatewayRef === gatewayRef) return normalizePayment(payments[id]);
  }
  return null;
}

async function updatePayment(paymentId, fields) {
  const current = await getPayment(paymentId);
  if (!current) return null;
  const updated = { ...current, ...fields };

  if (useDatabase()) {
    try {
      const p = getPool();
      await p.query(
        `UPDATE payments SET status = $1, gateway_ref = $2, copy_paste = $3, qr_code = $4, paid_at = $5 WHERE id = $6`,
        [
          updated.status,
          updated.gatewayRef,
          updated.copyPaste,
          updated.qrCode,
          updated.paidAt,
          paymentId
        ]
      );
      return updated;
    } catch (error) {
      throw recordDbError(error, "updatePayment");
    }
  }

  const payments = await readJsonFile(PAYMENTS_FILE);
  payments[paymentId] = updated;
  await writeJsonFile(PAYMENTS_FILE, payments);
  return updated;
}

async function listPaymentsForUser(userId) {
  if (!userId) return [];
  if (useDatabase()) {
    try {
      const p = getPool();
      await ensurePaymentsTable();
      const result = await p.query('SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]);
      return result.rows.map(normalizePayment);
    } catch (error) {
      throw recordDbError(error, "listPaymentsForUser");
    }
  }
  const payments = await readJsonFile(PAYMENTS_FILE);
  return Object.values(payments)
    .filter(payment => payment.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 20)
    .map(normalizePayment);
}

/* ------------------------------------------------------------------
   NICKNAME
   O nome exibido no site é sempre o apelido (prefixo do e-mail).
   Contas antigas ainda podem ter o nome completo no campo player_name:
   nesse caso o apelido é ajustado uma única vez.
------------------------------------------------------------------ */
async function ensureNickname(user) {
  if (!user) return null;
  const nickname = String(user.playerName || '').trim();
  const displayName = String(user.displayName || '').trim();
  const emailPrefix = String(user.email || '').split('@')[0];

  // Só troca quando o apelido ainda é o nome completo gerado automaticamente
  if (nickname && nickname !== displayName) return user;
  if (!emailPrefix || nickname === emailPrefix) return user;

  try {
    return await updateUserProfile(user.id, { playerName: emailPrefix });
  } catch (error) {
    return { ...user, playerName: emailPrefix };
  }
}

/* ------------------------------------------------------------------
   Sessões
------------------------------------------------------------------ */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;

  if (useDatabase()) {
    try {
      const p = getPool();
      await p.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expiresAt]);
    } catch (error) {
      throw recordDbError(error, "createSession");
    }
  } else {
    const sessions = await readJsonFile(SESSIONS_FILE);
    sessions[token] = { userId, expiresAt };
    await writeJsonFile(SESSIONS_FILE, sessions);
  }
  return token;
}

async function getSessionUser(token) {
  if (!token) return null;

  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query('SELECT * FROM sessions WHERE token = $1', [token]);
      if (result.rows.length === 0) return null;
      const session = result.rows[0];
      if (typeof session.expires_at === 'number' && session.expires_at < Date.now()) {
        await p.query('DELETE FROM sessions WHERE token = $1', [token]);
        return null;
      }
      return ensureNickname(await getUserById(session.user_id));
    } catch (error) {
      throw recordDbError(error, "getSessionUser");
    }
  } else {
    const sessions = await readJsonFile(SESSIONS_FILE);
    const session = sessions[token];
    if (!session) return null;
    if (typeof session.expiresAt === 'number' && session.expiresAt < Date.now()) {
      delete sessions[token];
      await writeJsonFile(SESSIONS_FILE, sessions);
      return null;
    }
    return ensureNickname(await getUserById(session.userId));
  }
}

async function destroySession(token) {
  if (!token) return;
  if (useDatabase()) {
    try {
      const p = getPool();
      await p.query('DELETE FROM sessions WHERE token = $1', [token]);
    } catch (error) {
      throw recordDbError(error, "destroySession");
    }
  } else {
    const sessions = await readJsonFile(SESSIONS_FILE);
    if (sessions[token]) {
      delete sessions[token];
      await writeJsonFile(SESSIONS_FILE, sessions);
    }
  }
}

/* ------------------------------------------------------------------
   Partidas
------------------------------------------------------------------ */
async function createMatchRecord(userId, record) {
  if (useDatabase()) {
    try {
      const p = getPool();
      await p.query(
        `INSERT INTO matches (id, user_id, mode, result, player_score, opponent_score, opponent_name, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [record.id, userId, record.mode, record.result, record.playerScore, record.opponentScore, record.opponentName, record.finishedAt]
      );
      await p.query(
        `DELETE FROM matches WHERE user_id = $1 AND id NOT IN (SELECT id FROM matches WHERE user_id = $1 ORDER BY finished_at DESC LIMIT 100)`,
        [userId]
      );
      return;
    } catch (error) {
      throw recordDbError(error, "createMatchRecord");
    }
  }

  const matches = await readJsonFile(MATCHES_FILE);
  const history = matches[userId] || [];
  history.unshift(record);
  matches[userId] = history.slice(0, 100);
  await writeJsonFile(MATCHES_FILE, matches);
}

async function listMatchRecords(userId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query(
        `SELECT id, finished_at AS "finishedAt", mode, result, player_score AS "playerScore", opponent_score AS "opponentScore", opponent_name AS "opponentName" FROM matches WHERE user_id = $1 ORDER BY finished_at DESC LIMIT 50`,
        [userId]
      );
      return { matches: result.rows };
    } catch (error) {
      throw recordDbError(error, "listMatchRecords");
    }
  }
  const matches = await readJsonFile(MATCHES_FILE);
  return { matches: (matches[userId] || []).slice(0, 50) };
}

async function listMatchRecordsForUser(targetUserId) {
  return listMatchRecords(targetUserId);
}

/* ------------------------------------------------------------------
   Amizades
------------------------------------------------------------------ */
async function getFriends(userId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.player_name AS "playerName", u.picture, u.avatar_url AS "avatarUrl" 
         FROM friends f 
         JOIN users u ON u.id = f.friend_id 
         WHERE f.user_id = $1 
         ORDER BY 
           split_part(u.player_name, ' ', 1) ASC,
           split_part(u.player_name, ' ', 2) ASC,
           u.email ASC`,
        [userId]
      );
      return result.rows.map(normalizeUserFromDb);
    } catch (error) {
      throw recordDbError(error, "getFriends");
    }
  }

  const users = await readJsonFile(USERS_FILE);
  const current = users[userId];
  if (!current) return [];
  current.friends = Array.isArray(current.friends) ? current.friends : [];
  return current.friends
    .map(id => users[id] ? normalizeUser(users[id]) : null)
    .filter(Boolean)
    .sort((a, b) => {
      const getFirstName = (name) => (name || '').split(' ')[0] || '';
      const getLastName = (name) => (name || '').split(' ').slice(1).join(' ') || '';
      const firstA = getFirstName(a.playerName || a.displayName);
      const firstB = getFirstName(b.playerName || b.displayName);
      if (firstA !== firstB) return firstA.localeCompare(firstB);
      const lastA = getLastName(a.playerName || a.displayName);
      const lastB = getLastName(b.playerName || b.displayName);
      if (lastA !== lastB) return lastA.localeCompare(lastB);
      return (a.email || '').localeCompare(b.email || '');
    });
}

async function getSentRequests(userId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.player_name AS "playerName", u.picture, u.avatar_url AS "avatarUrl"
         FROM friend_requests fr
         JOIN users u ON u.id = fr.to_user_id
         WHERE fr.from_user_id = $1 AND fr.status = 'pending'`,
        [userId]
      );
      return result.rows.map(normalizeUserFromDb);
    } catch (error) {
      throw recordDbError(error, "getSentRequests");
    }
  }

  const users = await readJsonFile(USERS_FILE);
  const current = users[userId];
  if (!current) return [];
  current.friendRequestsSent = Array.isArray(current.friendRequestsSent) ? current.friendRequestsSent : [];
  return current.friendRequestsSent
    .map(id => users[id] ? normalizeUser(users[id]) : null)
    .filter(Boolean);
}

async function getReceivedRequests(userId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const result = await p.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.player_name AS "playerName", u.picture, u.avatar_url AS "avatarUrl"
         FROM friend_requests fr
         JOIN users u ON u.id = fr.from_user_id
         WHERE fr.to_user_id = $1 AND fr.status = 'pending'`,
        [userId]
      );
      return result.rows.map(normalizeUserFromDb);
    } catch (error) {
      throw recordDbError(error, "getReceivedRequests");
    }
  }

  const users = await readJsonFile(USERS_FILE);
  const current = users[userId];
  if (!current) return [];
  current.friendRequestsReceived = Array.isArray(current.friendRequestsReceived) ? current.friendRequestsReceived : [];
  return current.friendRequestsReceived
    .map(id => users[id] ? normalizeUser(users[id]) : null)
    .filter(Boolean);
}

async function getRelation(currentUserId, targetUserId) {
  if (currentUserId === targetUserId) return 'self';
  if (useDatabase()) {
    try {
      const p = getPool();
      const friendRes = await p.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [currentUserId, targetUserId]);
      if (friendRes.rows.length > 0) return 'friend';
      const sentRes = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [currentUserId, targetUserId, 'pending']);
      if (sentRes.rows.length > 0) return 'sent';
      const receivedRes = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [targetUserId, currentUserId, 'pending']);
      if (receivedRes.rows.length > 0) return 'received';
      return 'none';
    } catch (error) {
      throw recordDbError(error, "getRelation");
    }
  }

  const users = await readJsonFile(USERS_FILE);
  const current = users[currentUserId];
  if (!current) return 'none';
  current.friends = Array.isArray(current.friends) ? current.friends : [];
  current.friendRequestsSent = Array.isArray(current.friendRequestsSent) ? current.friendRequestsSent : [];
  current.friendRequestsReceived = Array.isArray(current.friendRequestsReceived) ? current.friendRequestsReceived : [];
  if (current.friends.includes(targetUserId)) return 'friend';
  if (current.friendRequestsSent.includes(targetUserId)) return 'sent';
  if (current.friendRequestsReceived.includes(targetUserId)) return 'received';
  return 'none';
}

async function sendFriendRequest(fromUserId, toUserId) {
  if (fromUserId === toUserId) throw new Error('Você não pode adicionar a si mesmo.');

  if (useDatabase()) {
    try {
      const p = getPool();
      const rel = await getRelation(fromUserId, toUserId);
      if (rel === 'friend') throw new Error('Esta conta já é seu amigo.');
      if (rel === 'sent') throw new Error('Solicitação de amizade já enviada para esta conta.');
      if (rel === 'received') throw new Error('Esta conta já lhe enviou uma solicitação de amizade.');

      await p.query(
        `INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES ($1, $2, 'pending')`,
        [fromUserId, toUserId]
      );
    } catch (error) {
      if (error.message.includes('já') || error.message.includes('não encontrada')) throw error;
      throw recordDbError(error, "sendFriendRequest");
    }
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[fromUserId];
    const target = users[toUserId];
    if (!current || !target) throw new Error('Conta não encontrada.');

    current.friends = Array.isArray(current.friends) ? current.friends : [];
    current.friendRequestsSent = Array.isArray(current.friendRequestsSent) ? current.friendRequestsSent : [];
    current.friendRequestsReceived = Array.isArray(current.friendRequestsReceived) ? current.friendRequestsReceived : [];
    target.friendRequestsReceived = Array.isArray(target.friendRequestsReceived) ? target.friendRequestsReceived : [];
    target.friendRequestsSent = Array.isArray(target.friendRequestsSent) ? target.friendRequestsSent : [];

    if (current.friends.includes(toUserId)) throw new Error('Esta conta já é seu amigo.');
    if (current.friendRequestsSent.includes(toUserId)) throw new Error('Solicitação de amizade já enviada para esta conta.');
    if (current.friendRequestsReceived.includes(toUserId)) throw new Error('Esta conta já lhe enviou uma solicitação de amizade.');

    current.friendRequestsSent.push(toUserId);
    target.friendRequestsReceived.push(fromUserId);
    current.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    await writeJsonFile(USERS_FILE, users);
  }
}

async function acceptFriendRequest(toUserId, fromUserId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const res = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [fromUserId, toUserId, 'pending']);
      if (res.rows.length === 0) throw new Error('Solicitação de amizade não encontrada.');

      await p.query('UPDATE friend_requests SET status = $1 WHERE from_user_id = $2 AND to_user_id = $3 AND status = $4', ['accepted', fromUserId, toUserId, 'pending']);
      await p.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [toUserId, fromUserId]);
      await p.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fromUserId, toUserId]);
    } catch (error) {
      if (error.message === 'Solicitação de amizade não encontrada.') throw error;
      throw recordDbError(error, "acceptFriendRequest");
    }
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[toUserId];
    const target = users[fromUserId];
    if (!current || !target) throw new Error('Conta não encontrada.');

    current.friendRequestsReceived = Array.isArray(current.friendRequestsReceived) ? current.friendRequestsReceived : [];
    current.friends = Array.isArray(current.friends) ? current.friends : [];
    target.friendRequestsSent = Array.isArray(target.friendRequestsSent) ? target.friendRequestsSent : [];
    target.friends = Array.isArray(target.friends) ? target.friends : [];

    if (!current.friendRequestsReceived.includes(fromUserId) || !target.friendRequestsSent.includes(toUserId)) {
      throw new Error('Solicitação de amizade não encontrada.');
    }

    current.friendRequestsReceived = current.friendRequestsReceived.filter(id => id !== fromUserId);
    target.friendRequestsSent = target.friendRequestsSent.filter(id => id !== toUserId);
    if (!current.friends.includes(fromUserId)) current.friends.push(fromUserId);
    if (!target.friends.includes(toUserId)) target.friends.push(toUserId);
    current.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    await writeJsonFile(USERS_FILE, users);
  }
}

async function declineFriendRequest(toUserId, fromUserId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const res = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [fromUserId, toUserId, 'pending']);
      if (res.rows.length === 0) throw new Error('Solicitação de amizade não encontrada.');
      await p.query('UPDATE friend_requests SET status = $1 WHERE from_user_id = $2 AND to_user_id = $3 AND status = $4', ['declined', fromUserId, toUserId, 'pending']);
    } catch (error) {
      if (error.message === 'Solicitação de amizade não encontrada.') throw error;
      throw recordDbError(error, "declineFriendRequest");
    }
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[toUserId];
    const target = users[fromUserId];
    if (!current || !target) throw new Error('Conta não encontrada.');

    current.friendRequestsReceived = Array.isArray(current.friendRequestsReceived) ? current.friendRequestsReceived : [];
    target.friendRequestsSent = Array.isArray(target.friendRequestsSent) ? target.friendRequestsSent : [];

    if (!current.friendRequestsReceived.includes(fromUserId)) throw new Error('Solicitação de amizade não encontrada.');
    current.friendRequestsReceived = current.friendRequestsReceived.filter(id => id !== fromUserId);
    target.friendRequestsSent = target.friendRequestsSent.filter(id => id !== toUserId);
    current.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    await writeJsonFile(USERS_FILE, users);
  }
}

async function cancelFriendRequest(fromUserId, toUserId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const res = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [fromUserId, toUserId, 'pending']);
      if (res.rows.length === 0) throw new Error('Solicitação de amizade não encontrada.');
      await p.query('UPDATE friend_requests SET status = $1 WHERE from_user_id = $2 AND to_user_id = $3 AND status = $4', ['cancelled', fromUserId, toUserId, 'pending']);
    } catch (error) {
      if (error.message === 'Solicitação de amizade não encontrada.') throw error;
      throw recordDbError(error, "cancelFriendRequest");
    }
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[fromUserId];
    const target = users[toUserId];
    if (!current || !target) throw new Error('Conta não encontrada.');

    current.friendRequestsSent = Array.isArray(current.friendRequestsSent) ? current.friendRequestsSent : [];
    target.friendRequestsReceived = Array.isArray(target.friendRequestsReceived) ? target.friendRequestsReceived : [];

    if (!current.friendRequestsSent.includes(toUserId)) throw new Error('Solicitação de amizade não encontrada.');
    current.friendRequestsSent = current.friendRequestsSent.filter(id => id !== toUserId);
    target.friendRequestsReceived = target.friendRequestsReceived.filter(id => id !== fromUserId);
    current.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    await writeJsonFile(USERS_FILE, users);
  }
}

async function removeFriend(userId, friendId) {
  if (useDatabase()) {
    try {
      const p = getPool();
      const res = await p.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [userId, friendId]);
      if (res.rows.length === 0) throw new Error('Esta conta não está na sua lista de amigos.');
      await p.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [userId, friendId]);
      await p.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [friendId, userId]);
    } catch (error) {
      if (error.message === 'Esta conta não está na sua lista de amigos.') throw error;
      throw recordDbError(error, "removeFriend");
    }
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[userId];
    const target = users[friendId];
    if (!current || !target) throw new Error('Conta não encontrada.');

    current.friends = Array.isArray(current.friends) ? current.friends : [];
    target.friends = Array.isArray(target.friends) ? target.friends : [];

    if (!current.friends.includes(friendId)) throw new Error('Esta conta não está na sua lista de amigos.');
    current.friends = current.friends.filter(id => id !== friendId);
    target.friends = target.friends.filter(id => id !== userId);
    current.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    await writeJsonFile(USERS_FILE, users);
  }
}

/* ------------------------------------------------------------------
   Envio de notificação interna (usado pelo server.js)
------------------------------------------------------------------ */
function sendToUserInternal(userId, message) {
  // Placeholder: o server.js tem sua própria sendToUser
  return false;
}

/* ------------------------------------------------------------------
   Exportações
------------------------------------------------------------------ */
module.exports = {
  useDatabase,
  ensureDataFiles,
  getDbStatus,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  DEFAULT_TERTIARY_COLOR,
  normalizeUser,
  normalizeUserFromDb,
  getUserById,
  getUserByEmail,
  getUserProfile,
  searchUsersByQuery,
  createOrUpdateUserFromGoogle,
  updateUserProfile,
  activatePremium,
  createPayment,
  getPayment,
  findPaymentByGatewayRef,
  updatePayment,
  listPaymentsForUser,
  createSession,
  getSessionUser,
  destroySession,
  createMatchRecord,
  listMatchRecords,
  listMatchRecordsForUser,
  getFriends,
  getSentRequests,
  getReceivedRequests,
  getRelation,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend,
  sendToUserInternal,
  readJsonFileSync,
  USERS_FILE,
  SESSIONS_FILE,
  MATCHES_FILE,
  DATA_DIR
};