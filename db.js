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

let pool = null;

function useDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!pool && useDatabase()) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

/* ------------------------------------------------------------------
   JSON fallback (desenvolvimento local)
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

  await p.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT,
      player_name TEXT,
      avatar_url TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      google_sub TEXT DEFAULT '',
      picture TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS matches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'local',
      result TEXT NOT NULL DEFAULT 'loss',
      player_score INTEGER NOT NULL DEFAULT 0,
      opponent_score INTEGER NOT NULL DEFAULT 0,
      opponent_name TEXT NOT NULL DEFAULT 'Oponente',
      finished_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (user_id, friend_id)
    );
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_matches_user_id ON matches(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_friends_user_id ON friends(user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_friends_friend_id ON friends(friend_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_from ON friend_requests(from_user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id);`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_friend_requests_status ON friend_requests(status);`);
}

/* ------------------------------------------------------------------
   Inicialização
------------------------------------------------------------------ */
async function ensureDataFiles() {
  if (useDatabase()) {
    await ensureDatabaseSchema();
  } else {
    await fs.mkdir(DATA_DIR, { recursive: true });
    if (!fss.existsSync(USERS_FILE)) await fs.writeFile(USERS_FILE, JSON.stringify({}, null, 2), 'utf8');
    if (!fss.existsSync(SESSIONS_FILE)) await fs.writeFile(SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf8');
    if (!fss.existsSync(MATCHES_FILE)) await fs.writeFile(MATCHES_FILE, JSON.stringify({}, null, 2), 'utf8');
  }
}

/* ------------------------------------------------------------------
   Normalização de usuário
------------------------------------------------------------------ */
function normalizeUserFromDb(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || row.email.split('@')[0],
    playerName: row.player_name || row.display_name || row.email.split('@')[0],
    avatarUrl: row.avatar_url || '',
    bio: row.bio || '',
    googleSub: row.google_sub || '',
    picture: row.picture || '',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString()
  };
}

function normalizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || user.email.split('@')[0],
    playerName: user.playerName || user.displayName || user.email.split('@')[0],
    avatarUrl: user.avatarUrl || '',
    bio: user.bio || '',
    googleSub: user.googleSub || '',
    picture: user.picture || '',
    friends: Array.isArray(user.friends) ? user.friends : [],
    friendRequestsSent: Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [],
    friendRequestsReceived: Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : [],
    createdAt: user.createdAt || new Date().toISOString(),
    updatedAt: user.updatedAt || new Date().toISOString()
  };
}

/* ------------------------------------------------------------------
   Perfil público de usuário (para mensagens do WebSocket)
------------------------------------------------------------------ */
async function getUserProfile(uid) {
  if (!uid) return null;
  const user = await getUserById(uid);
  if (!user) return null;
  return {
    id: user.id,
    uid: user.id,
    name: user.displayName || user.playerName || user.email.split('@')[0],
    email: user.email,
    picture: user.picture || user.avatarUrl || '',
    playerName: user.playerName || user.displayName || user.email.split('@')[0]
  };
}

/* ------------------------------------------------------------------
   Envio de notificação interna (usado pelo server.js)
------------------------------------------------------------------ */
function sendToUserInternal(userId, message) {
  // Essa função é chamada pelo server.js que tem acesso ao userConnections.
  // Exportamos um placeholder; o server.js usa sua própria sendToUser.
  return false;
}

/* ------------------------------------------------------------------
   Usuários
------------------------------------------------------------------ */
async function getUserById(id) {
  if (useDatabase()) {
    const p = getPool();
    const result = await p.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] ? normalizeUserFromDb(result.rows[0]) : null;
  }
  const users = await readJsonFile(USERS_FILE);
  const user = users[id];
  return user ? normalizeUser(user) : null;
}

async function getUserByEmail(email) {
  if (useDatabase()) {
    const p = getPool();
    const result = await p.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    return result.rows[0] ? normalizeUserFromDb(result.rows[0]) : null;
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
    const p = getPool();
    const result = await p.query(
      `SELECT * FROM users 
       WHERE id <> $1 
         AND (LOWER(email) = LOWER($2) OR LOWER(player_name) = LOWER($2) OR LOWER(display_name) = LOWER($2) OR LOWER(player_name) LIKE LOWER($3))
       LIMIT 1`,
      [excludeUserId, qLower, `%${qLower}%`]
    );
    return result.rows[0] ? normalizeUserFromDb(result.rows[0]) : null;
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
      const display = String(u.playerName || u.displayName || '').toLowerCase();
      if (display === qLower) { target = u; break; }
    }
  }
  if (!target) {
    for (const id of Object.keys(users)) {
      if (id === excludeUserId) continue;
      const u = users[id];
      const display = String(u.playerName || u.displayName || '').toLowerCase();
      if (display.includes(qLower)) { target = u; break; }
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

  if (useDatabase()) {
    const p = getPool();
    const existing = await p.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (existing.rows.length > 0) {
      const u = existing.rows[0];
      await p.query(
        `UPDATE users SET email = $1, display_name = COALESCE($2, display_name), player_name = COALESCE($3, player_name), picture = COALESCE($4, picture), google_sub = COALESCE($5, google_sub), updated_at = $6 WHERE id = $7`,
        [email, displayName, displayName, picture, payload.sub, now, userId]
      );
      const row = await p.query('SELECT * FROM users WHERE id = $1', [userId]);
      return normalizeUserFromDb(row.rows[0]);
    } else {
      await p.query(
        `INSERT INTO users (id, email, display_name, player_name, avatar_url, bio, google_sub, picture, created_at, updated_at) VALUES ($1, $2, $3, $4, '', '', $5, $6, $7, $8)`,
        [userId, email, displayName, displayName, payload.sub, picture, now, now]
      );
      const row = await p.query('SELECT * FROM users WHERE id = $1', [userId]);
      return normalizeUserFromDb(row.rows[0]);
    }
  } else {
    const users = await readJsonFile(USERS_FILE);
    const existingUser = users[userId];
    const updatedUser = normalizeUser({
      id: userId,
      email,
      displayName: existingUser?.displayName || displayName,
      playerName: existingUser?.playerName || existingUser?.displayName || displayName,
      avatarUrl: existingUser?.avatarUrl || '',
      bio: existingUser?.bio || '',
      googleSub: payload.sub || '',
      picture: existingUser?.picture || picture,
      createdAt: existingUser?.createdAt || now,
      updatedAt: now
    });
    users[userId] = updatedUser;
    await writeJsonFile(USERS_FILE, users);
    return updatedUser;
  }
}

async function updateUserProfile(userId, fields) {
  if (useDatabase()) {
    const p = getPool();
    const updates = [];
    const values = [];
    let idx = 1;
    if (fields.displayName !== undefined) { updates.push(`display_name = $${idx++}`); values.push(fields.displayName); }
    if (fields.playerName !== undefined) { updates.push(`player_name = $${idx++}`); values.push(fields.playerName); }
    if (fields.avatarUrl !== undefined) { updates.push(`avatar_url = $${idx++}`); values.push(fields.avatarUrl); }
    if (fields.bio !== undefined) { updates.push(`bio = $${idx++}`); values.push(fields.bio); }
    updates.push(`updated_at = $${idx++}`); values.push(new Date().toISOString());
    values.push(userId);

    await p.query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    const row = await p.query('SELECT * FROM users WHERE id = $1', [userId]);
    return normalizeUserFromDb(row.rows[0]);
  } else {
    const users = await readJsonFile(USERS_FILE);
    const currentUser = users[userId];
    if (!currentUser) return null;
    users[userId] = normalizeUser({ ...currentUser, ...fields, updatedAt: new Date().toISOString() });
    await writeJsonFile(USERS_FILE, users);
    return users[userId];
  }
}

/* ------------------------------------------------------------------
   Sessões
------------------------------------------------------------------ */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7;

  if (useDatabase()) {
    const p = getPool();
    await p.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)', [token, userId, expiresAt]);
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
    const p = getPool();
    const result = await p.query('SELECT * FROM sessions WHERE token = $1', [token]);
    if (result.rows.length === 0) return null;
    const session = result.rows[0];
    if (typeof session.expires_at === 'number' && session.expires_at < Date.now()) {
      await p.query('DELETE FROM sessions WHERE token = $1', [token]);
      return null;
    }
    return getUserById(session.user_id);
  } else {
    const sessions = await readJsonFile(SESSIONS_FILE);
    const session = sessions[token];
    if (!session) return null;
    if (typeof session.expiresAt === 'number' && session.expiresAt < Date.now()) {
      delete sessions[token];
      await writeJsonFile(SESSIONS_FILE, sessions);
      return null;
    }
    return getUserById(session.userId);
  }
}

async function destroySession(token) {
  if (!token) return;
  if (useDatabase()) {
    const p = getPool();
    await p.query('DELETE FROM sessions WHERE token = $1', [token]);
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
    const p = getPool();
    await p.query(
      `INSERT INTO matches (id, user_id, mode, result, player_score, opponent_score, opponent_name, finished_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [record.id, userId, record.mode, record.result, record.playerScore, record.opponentScore, record.opponentName, record.finishedAt]
    );
    await p.query(
      `DELETE FROM matches WHERE user_id = $1 AND id NOT IN (SELECT id FROM matches WHERE user_id = $1 ORDER BY finished_at DESC LIMIT 100)`,
      [userId]
    );
  } else {
    const matches = await readJsonFile(MATCHES_FILE);
    const history = matches[userId] || [];
    history.unshift(record);
    matches[userId] = history.slice(0, 100);
    await writeJsonFile(MATCHES_FILE, matches);
  }
}

async function listMatchRecords(userId) {
  if (useDatabase()) {
    const p = getPool();
    const result = await p.query(
      `SELECT id, finished_at, mode, result, player_score AS "playerScore", opponent_score AS "opponentScore", opponent_name AS "opponentName" FROM matches WHERE user_id = $1 ORDER BY finished_at DESC LIMIT 50`,
      [userId]
    );
    return { matches: result.rows };
  } else {
    const matches = await readJsonFile(MATCHES_FILE);
    return { matches: (matches[userId] || []).slice(0, 50) };
  }
}

async function listMatchRecordsForUser(targetUserId) {
  return listMatchRecords(targetUserId);
}

/* ------------------------------------------------------------------
   Amizades
------------------------------------------------------------------ */
async function getFriends(userId) {
  if (useDatabase()) {
    const p = getPool();
    const result = await p.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.player_name AS "playerName", u.picture, u.avatar_url AS "avatarUrl" 
       FROM friends f 
       JOIN users u ON u.id = f.friend_id 
       WHERE f.user_id = $1 
       ORDER BY u.player_name ASC, u.display_name ASC`,
      [userId]
    );
    return result.rows.map(normalizeUserFromDb);
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[userId];
    if (!current) return [];
    current.friends = Array.isArray(current.friends) ? current.friends : [];
    return current.friends
      .map(id => users[id] ? normalizeUser(users[id]) : null)
      .filter(Boolean)
      .sort((a, b) => (a.playerName || a.displayName || a.email).localeCompare(b.playerName || b.displayName || b.email));
  }
}

async function getSentRequests(userId) {
  if (useDatabase()) {
    const p = getPool();
    const result = await p.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.player_name AS "playerName", u.picture, u.avatar_url AS "avatarUrl"
       FROM friend_requests fr
       JOIN users u ON u.id = fr.to_user_id
       WHERE fr.from_user_id = $1 AND fr.status = 'pending'`,
      [userId]
    );
    return result.rows.map(normalizeUserFromDb);
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[userId];
    if (!current) return [];
    current.friendRequestsSent = Array.isArray(current.friendRequestsSent) ? current.friendRequestsSent : [];
    return current.friendRequestsSent
      .map(id => users[id] ? normalizeUser(users[id]) : null)
      .filter(Boolean);
  }
}

async function getReceivedRequests(userId) {
  if (useDatabase()) {
    const p = getPool();
    const result = await p.query(
      `SELECT u.id, u.email, u.display_name AS "displayName", u.player_name AS "playerName", u.picture, u.avatar_url AS "avatarUrl"
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending'`,
      [userId]
    );
    return result.rows.map(normalizeUserFromDb);
  } else {
    const users = await readJsonFile(USERS_FILE);
    const current = users[userId];
    if (!current) return [];
    current.friendRequestsReceived = Array.isArray(current.friendRequestsReceived) ? current.friendRequestsReceived : [];
    return current.friendRequestsReceived
      .map(id => users[id] ? normalizeUser(users[id]) : null)
      .filter(Boolean);
  }
}

async function getRelation(currentUserId, targetUserId) {
  if (currentUserId === targetUserId) return 'self';
  if (useDatabase()) {
    const p = getPool();
    const friendRes = await p.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [currentUserId, targetUserId]);
    if (friendRes.rows.length > 0) return 'friend';
    const sentRes = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [currentUserId, targetUserId, 'pending']);
    if (sentRes.rows.length > 0) return 'sent';
    const receivedRes = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [targetUserId, currentUserId, 'pending']);
    if (receivedRes.rows.length > 0) return 'received';
    return 'none';
  } else {
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
}

async function sendFriendRequest(fromUserId, toUserId) {
  if (fromUserId === toUserId) throw new Error('Você não pode adicionar a si mesmo.');

  if (useDatabase()) {
    const p = getPool();
    const rel = await getRelation(fromUserId, toUserId);
    if (rel === 'friend') throw new Error('Esta conta já é seu amigo.');
    if (rel === 'sent') throw new Error('Solicitação de amizade já enviada para esta conta.');
    if (rel === 'received') throw new Error('Esta conta já lhe enviou uma solicitação de amizade.');

    await p.query(
      `INSERT INTO friend_requests (from_user_id, to_user_id, status) VALUES ($1, $2, 'pending')`,
      [fromUserId, toUserId]
    );
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
    const p = getPool();
    const res = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [fromUserId, toUserId, 'pending']);
    if (res.rows.length === 0) throw new Error('Solicitação de amizade não encontrada.');

    await p.query('UPDATE friend_requests SET status = $1 WHERE from_user_id = $2 AND to_user_id = $3 AND status = $4', ['accepted', fromUserId, toUserId, 'pending']);
    await p.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [toUserId, fromUserId]);
    await p.query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fromUserId, toUserId]);
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
    const p = getPool();
    const res = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [fromUserId, toUserId, 'pending']);
    if (res.rows.length === 0) throw new Error('Solicitação de amizade não encontrada.');
    await p.query('UPDATE friend_requests SET status = $1 WHERE from_user_id = $2 AND to_user_id = $3 AND status = $4', ['declined', fromUserId, toUserId, 'pending']);
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
    const p = getPool();
    const res = await p.query('SELECT 1 FROM friend_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = $3', [fromUserId, toUserId, 'pending']);
    if (res.rows.length === 0) throw new Error('Solicitação de amizade não encontrada.');
    await p.query('UPDATE friend_requests SET status = $1 WHERE from_user_id = $2 AND to_user_id = $3 AND status = $4', ['cancelled', fromUserId, toUserId, 'pending']);
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
    const p = getPool();
    const res = await p.query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [userId, friendId]);
    if (res.rows.length === 0) throw new Error('Esta conta não está na sua lista de amigos.');
    await p.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [userId, friendId]);
    await p.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [friendId, userId]);
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
   Exportações
------------------------------------------------------------------ */
module.exports = {
  useDatabase,
  ensureDataFiles,
  normalizeUser,
  normalizeUserFromDb,
  getUserById,
  getUserByEmail,
  getUserProfile,
  searchUsersByQuery,
  createOrUpdateUserFromGoogle,
  updateUserProfile,
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
