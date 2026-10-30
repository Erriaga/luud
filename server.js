'use strict';

const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;

loadEnvFile();

const PUBLIC_DIR = path.join(ROOT, 'public');
// No Render, o sistema de arquivos é efêmero: dados gravados em disco
// somem a cada deploy. Para persistir, crie um Persistent Disk e defina
// a variável de ambiente DATA_DIR apontando para o ponto de montagem.
const DATA_DIR = path.join(process.env.DATA_DIR || ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const MATCHES_FILE = path.join(DATA_DIR, 'matches.json');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const COOKIE_NAME = 'luud_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/* -------------------------------------------------------------
   SALAS DE JOGO ONLINE (multiplayer entre computadores)
------------------------------------------------------------- */
// roomCode -> { players: [ws, ws], names: [str, str], userIds: [uid, uid], ready: [bool, bool] }
const rooms = new Map();
// Conexões ativas: ws -> { roomCode, playerIdx, userId, name }
const connections = new Map();
// Fila do Jogo Rápido: [{ ws, uid, name }]
const matchmakingQueue = [];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function sendTo(ws, message) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastRoom(roomCode, message, excludeWs = null) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const ws of room.players) {
    if (ws && ws !== excludeWs && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
}

function otherPlayerIndex(idx) {
  return idx === 0 ? 1 : 0;
}

// Remove a conexão da fila do Jogo Rápido (true se realmente estava lá)
function removeFromQueue(ws) {
  const index = matchmakingQueue.findIndex(entry => entry.ws === ws);
  if (index === -1) return false;
  matchmakingQueue.splice(index, 1);
  return true;
}

// Retira a conexão da sala atual, avisando quem ficou nela e
// removendo a sala quando fica vazia
function detachFromRoom(ws, notifyOpponent = true) {
  const conn = connections.get(ws);
  if (!conn || !conn.roomCode) return;

  const roomCode = conn.roomCode;
  const playerIdx = conn.playerIdx;
  conn.roomCode = null;
  conn.playerIdx = null;

  const room = rooms.get(roomCode);
  if (!room || room.players[playerIdx] !== ws) return;

  room.players[playerIdx] = null;
  room.names[playerIdx] = null;
  room.userIds[playerIdx] = null;
  room.ready[playerIdx] = false;

  if (notifyOpponent) {
    const opponent = room.players[otherPlayerIndex(playerIdx)];
    if (opponent && opponent.readyState === 1) {
      sendTo(opponent, { type: 'opponent_disconnected' });
    }
  }

  if (!room.players[0] && !room.players[1]) {
    rooms.delete(roomCode);
  }
}

// Pareia os dois primeiros jogadores de contas diferentes da fila,
// cria a sala e inicia a partida para ambos
function tryMatchmaking() {
  while (matchmakingQueue.length >= 2) {
    const first = matchmakingQueue[0];
    const firstKey = first.uid || first.ws; // sem login, a própria conexão é a chave
    let matchIndex = -1;
    for (let i = 1; i < matchmakingQueue.length; i++) {
      const candidate = matchmakingQueue[i];
      if ((candidate.uid || candidate.ws) !== firstKey) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) break;

    const second = matchmakingQueue[matchIndex];
    matchmakingQueue.splice(matchIndex, 1);
    matchmakingQueue.shift();
    startQuickMatchRoom(first, second);
  }
}

function startQuickMatchRoom(a, b) {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const users = readJsonFileSync(USERS_FILE);

  const room = {
    players: [a.ws, b.ws],
    names: [a.name || 'Jogador 1', b.name || 'Jogador 2'],
    userIds: [a.uid || null, b.uid || null],
    ready: [true, true]
  };
  rooms.set(code, room);

  const connA = connections.get(a.ws);
  const connB = connections.get(b.ws);
  if (connA) { connA.roomCode = code; connA.playerIdx = 0; }
  if (connB) { connB.roomCode = code; connB.playerIdx = 1; }

  // Perfis completos (id do Google, e-mail e foto) para que os clientes
  // possam exibir o oponente e enviar solicitações de amizade.
  const profileA = userProfileOf(users, room.userIds[0]) || {
    id: room.userIds[0] || null, uid: room.userIds[0] || null,
    name: room.names[0], email: '', picture: '', playerName: room.names[0]
  };
  const profileB = userProfileOf(users, room.userIds[1]) || {
    id: room.userIds[1] || null, uid: room.userIds[1] || null,
    name: room.names[1], email: '', picture: '', playerName: room.names[1]
  };

  const players = [
    { id: 0, uid: profileA.uid, name: profileA.name, email: profileA.email, picture: profileA.picture, playerName: profileA.playerName },
    { id: 1, uid: profileB.uid, name: profileB.name, email: profileB.email, picture: profileB.picture, playerName: profileB.playerName }
  ];

  sendTo(a.ws, { type: 'room_created', room: code, player: 0, name: room.names[0], quick: true, opponentProfile: profileB });
  sendTo(b.ws, { type: 'room_created', room: code, player: 1, name: room.names[1], quick: true, opponentProfile: profileA });
  sendTo(a.ws, { type: 'room_ready', players });
  sendTo(b.ws, { type: 'room_ready', players });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fss.existsSync(envPath)) return;

  const content = fss.readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function ensureDataFiles() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  if (!fss.existsSync(USERS_FILE)) {
    await fs.writeFile(USERS_FILE, JSON.stringify({}, null, 2), 'utf8');
  }

  if (!fss.existsSync(SESSIONS_FILE)) {
    await fs.writeFile(SESSIONS_FILE, JSON.stringify({}, null, 2), 'utf8');
  }

  if (!fss.existsSync(MATCHES_FILE)) {
    await fs.writeFile(MATCHES_FILE, JSON.stringify({}, null, 2), 'utf8');
  }
}

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

/* -------------------------------------------------------------
   PERFIL PÚBLICO DE USUÁRIO (para mensagens do WebSocket)
------------------------------------------------------------- */
function userProfileOf(users, uid) {
  if (!uid) return null;
  const user = users[uid];
  if (!user) return null;
  const n = normalizeUser(user);
  return {
    id: n.id,
    uid: n.id,
    name: n.displayName || n.playerName || n.email.split('@')[0],
    email: n.email,
    picture: n.picture || n.avatarUrl || '',
    playerName: n.playerName || n.displayName || n.email.split('@')[0]
  };
}

function parseCookies(request) {
  const cookies = {};
  const header = request.headers.cookie;
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function createSessionCookie(token) {
  const attributes = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];

  if (NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

function createClearSessionCookie() {
  const attributes = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (NODE_ENV === 'production') attributes.push('Secure');
  return attributes.join('; ');
}

async function createSession(userId) {
  const sessions = await readJsonFile(SESSIONS_FILE);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;

  sessions[token] = { userId, expiresAt };
  await writeJsonFile(SESSIONS_FILE, sessions);
  return token;
}

async function getSessionUser(request) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  const sessions = await readJsonFile(SESSIONS_FILE);
  const session = sessions[token];
  if (!session) return null;

  if (typeof session.expiresAt === 'number' && session.expiresAt < Date.now()) {
    delete sessions[token];
    await writeJsonFile(SESSIONS_FILE, sessions);
    return null;
  }

  const users = await readJsonFile(USERS_FILE);
  const user = users[session.userId];
  return user ? normalizeUser(user) : null;
}

async function destroySession(request) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return;

  const sessions = await readJsonFile(SESSIONS_FILE);
  if (sessions[token]) {
    delete sessions[token];
    await writeJsonFile(SESSIONS_FILE, sessions);
  }
}

function sendJson(response, statusCode, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Payload too large');
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

async function verifyGoogleIdToken(idToken) {
  if (!GOOGLE_CLIENT_ID) {
    throw new Error('GOOGLE_CLIENT_ID não configurado.');
  }

  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) throw new Error('Token Google inválido.');

  const payload = await response.json();
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error('Token destinado a outro Client ID.');
  if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') {
    throw new Error('Emissor do token inválido.');
  }

  const expiresAt = Number(payload.exp || 0);
  if (!expiresAt || expiresAt * 1000 < Date.now()) throw new Error('Token expirado.');
  if (payload.email_verified !== 'true' && payload.email_verified !== true) {
    throw new Error('E-mail Google não verificado.');
  }
  if (!payload.email) throw new Error('Token sem e-mail.');

  return payload;
}

async function handleGoogleLogin(request, response) {
  try {
    const body = await readJsonBody(request);
    const idToken = body.credential || body.id_token;
    if (!idToken) throw new Error('Credencial Google ausente.');

    const payload = await verifyGoogleIdToken(idToken);
    const users = await readJsonFile(USERS_FILE);
    const userId = payload.sub || payload.email;
    const now = new Date().toISOString();
    const existingUser = users[userId];

    const updatedUser = normalizeUser({
      id: userId,
      email: payload.email,
      displayName: existingUser?.displayName || payload.name || payload.email.split('@')[0],
      playerName: existingUser?.playerName || existingUser?.displayName || payload.name || payload.email.split('@')[0],
      avatarUrl: existingUser?.avatarUrl || '',
      bio: existingUser?.bio || '',
      googleSub: payload.sub || '',
      picture: payload.picture || existingUser?.picture || '',
      createdAt: existingUser?.createdAt || now,
      updatedAt: now
    });

    users[userId] = updatedUser;
    await writeJsonFile(USERS_FILE, users);

    const token = await createSession(userId);
    sendJson(response, 200, { user: updatedUser }, { 'Set-Cookie': createSessionCookie(token) });
  } catch (error) {
    sendJson(response, 401, { error: error.message });
  }
}

async function handleLogout(request, response) {
  await destroySession(request);
  sendJson(response, 200, { ok: true }, { 'Set-Cookie': createClearSessionCookie() });
}

async function handleSession(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { authenticated: false });
    return;
  }
  sendJson(response, 200, { authenticated: true, user });
}

async function handleProfileUpdate(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const users = await readJsonFile(USERS_FILE);
    const currentUser = users[user.id];
    if (!currentUser) {
      sendJson(response, 404, { error: 'Conta não encontrada.' });
      return;
    }

    const cleanText = (value, maxLength) => String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLength);

    const avatarUrl = cleanText(body.avatarUrl, 500);
    if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
      sendJson(response, 400, { error: 'A URL da foto deve começar com http:// ou https://.' });
      return;
    }

    users[user.id] = normalizeUser({
      ...currentUser,
      displayName: cleanText(body.displayName, 60) || currentUser.displayName,
      playerName: cleanText(body.playerName, 24) || currentUser.playerName,
      avatarUrl,
      bio: cleanText(body.bio, 280),
      updatedAt: new Date().toISOString()
    });

    await writeJsonFile(USERS_FILE, users);
    sendJson(response, 200, { user: users[user.id] });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

async function handleAuthConfig(request, response) {
  sendJson(response, 200, {
    clientId: GOOGLE_CLIENT_ID,
    configured: Boolean(GOOGLE_CLIENT_ID)
  });
}

/* -------------------------------------------------------------
   HISTÓRICO DE PARTIDAS
   Cada jogador registra a partida em que participou (fim normal,
   vitória/derrota por desistência ou W.O.), com sua própria visão
   do resultado; o servidor guarda por usuário.
------------------------------------------------------------- */
const MATCH_RECORD_LIMIT = 100;
const MATCH_MODES = new Set(['quick', 'invite', 'local']);

function sanitizeMatchRecord(body) {
  const mode = MATCH_MODES.has(body.mode) ? body.mode : 'local';
  const result = body.result === 'win' ? 'win' : 'loss';
  const toScore = (value) => {
    const num = Math.floor(Number(value));
    return Number.isFinite(num) && num >= 0 ? num : 0;
  };
  const opponentName = String(body.opponentName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Oponente';
  return {
    id: crypto.randomUUID(),
    finishedAt: new Date().toISOString(),
    mode,
    result,
    playerScore: toScore(body.playerScore),
    opponentScore: toScore(body.opponentScore),
    opponentName
  };
}

async function createMatchRecord(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const record = sanitizeMatchRecord(body);

    const matches = await readJsonFile(MATCHES_FILE);
    const history = matches[user.id] || [];
    history.unshift(record);
    matches[user.id] = history.slice(0, MATCH_RECORD_LIMIT);
    await writeJsonFile(MATCHES_FILE, matches);

    sendJson(response, 201, { ok: true, record });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

async function listMatchRecords(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  const matches = await readJsonFile(MATCHES_FILE);
  sendJson(response, 200, { matches: (matches[user.id] || []).slice(0, 50) });
}

/* -------------------------------------------------------------
   AMIZADES
   Lista de amigos, solicitações enviadas/recebidas e busca de
   contas por Gmail ou nome no jogo. Tudo gravado em users.json,
   que (com DATA_DIR em disco persistente) sobrevive a deploys.
------------------------------------------------------------- */

function ensureFriendFields(user) {
  user.friends = Array.isArray(user.friends) ? user.friends : [];
  user.friendRequestsSent = Array.isArray(user.friendRequestsSent) ? user.friendRequestsSent : [];
  user.friendRequestsReceived = Array.isArray(user.friendRequestsReceived) ? user.friendRequestsReceived : [];
  return user;
}

function publicUserProfile(user) {
  const n = normalizeUser(user);
  return {
    id: n.id,
    email: n.email,
    displayName: n.displayName,
    playerName: n.playerName,
    picture: n.picture || n.avatarUrl || ''
  };
}

function relationOf(currentUser, targetId) {
  if (targetId === currentUser.id) return 'self';
  if (currentUser.friends.includes(targetId)) return 'friend';
  if (currentUser.friendRequestsSent.includes(targetId)) return 'sent';
  if (currentUser.friendRequestsReceived.includes(targetId)) return 'received';
  return 'none';
}

function arrayRemove(array, value) {
  const index = array.indexOf(value);
  if (index === -1) return false;
  array.splice(index, 1);
  return true;
}

async function listFriends(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  const users = await readJsonFile(USERS_FILE);
  const current = users[user.id];
  if (!current) {
    sendJson(response, 404, { error: 'Conta não encontrada.' });
    return;
  }
  ensureFriendFields(current);

  const friends = current.friends
    .map(id => users[id] ? publicUserProfile(users[id]) : null)
    .filter(Boolean)
    .sort((a, b) => (a.playerName || a.displayName || a.email).localeCompare(b.playerName || b.displayName || b.email));

  const sent = current.friendRequestsSent
    .map(id => users[id] ? publicUserProfile(users[id]) : null)
    .filter(Boolean);

  const received = current.friendRequestsReceived
    .map(id => users[id] ? publicUserProfile(users[id]) : null)
    .filter(Boolean);

  sendJson(response, 200, { friends, sent, received });
}

async function searchFriend(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const query = String(body.query || '').trim();
    if (!query) {
      sendJson(response, 400, { error: 'Informe um Gmail ou nome no jogo.' });
      return;
    }

    const users = await readJsonFile(USERS_FILE);
    const current = users[user.id];
    if (!current) {
      sendJson(response, 404, { error: 'Conta não encontrada.' });
      return;
    }
    ensureFriendFields(current);

    const qLower = query.toLowerCase();
    let target = null;

    // 1. E-mail exato (Gmail da Conta Google)
    for (const id of Object.keys(users)) {
      if (id === user.id) continue;
      if (String(users[id].email || '').toLowerCase() === qLower) {
        target = users[id];
        break;
      }
    }
    // 2. Nome no jogo / nome da conta exato
    if (!target) {
      for (const id of Object.keys(users)) {
        if (id === user.id) continue;
        const u = users[id];
        const display = String(u.playerName || u.displayName || '').toLowerCase();
        if (display === qLower) {
          target = u;
          break;
        }
      }
    }
    // 3. Nome que contenha o termo digitado
    if (!target) {
      for (const id of Object.keys(users)) {
        if (id === user.id) continue;
        const u = users[id];
        const display = String(u.playerName || u.displayName || '').toLowerCase();
        if (display.includes(qLower)) {
          target = u;
          break;
        }
      }
    }

    if (!target) {
      sendJson(response, 200, { found: false });
      return;
    }

    sendJson(response, 200, {
      found: true,
      account: publicUserProfile(target),
      relation: relationOf(current, target.id)
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

async function withFriendship(request, response, action) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const targetId = body.targetId;
    if (!targetId) {
      sendJson(response, 400, { error: 'Conta alvo não informada.' });
      return;
    }

    const users = await readJsonFile(USERS_FILE);
    const current = users[user.id];
    const target = users[targetId];
    if (!current || !target) {
      sendJson(response, 404, { error: 'Conta não encontrada.' });
      return;
    }

    ensureFriendFields(current);
    ensureFriendFields(target);

    if (action === 'request') {
      if (targetId === user.id) throw new Error('Você não pode adicionar a si mesmo.');
      if (relationOf(current, targetId) === 'friend') throw new Error('Esta conta já é seu amigo.');
      if (current.friendRequestsSent.includes(targetId)) throw new Error('Solicitação de amizade já enviada para esta conta.');
      if (current.friendRequestsReceived.includes(targetId)) throw new Error('Esta conta já lhe enviou uma solicitação de amizade.');
      current.friendRequestsSent.push(targetId);
      target.friendRequestsReceived.push(user.id);
    } else if (action === 'accept') {
      if (!current.friendRequestsReceived.includes(targetId) || !target.friendRequestsSent.includes(user.id)) {
        throw new Error('Solicitação de amizade não encontrada.');
      }
      arrayRemove(current.friendRequestsReceived, targetId);
      arrayRemove(target.friendRequestsSent, user.id);
      if (!current.friends.includes(targetId)) current.friends.push(targetId);
      if (!target.friends.includes(user.id)) target.friends.push(user.id);
    } else if (action === 'decline') {
      if (!current.friendRequestsReceived.includes(targetId)) {
        throw new Error('Solicitação de amizade não encontrada.');
      }
      arrayRemove(current.friendRequestsReceived, targetId);
      arrayRemove(target.friendRequestsSent, user.id);
    } else if (action === 'cancel') {
      if (!current.friendRequestsSent.includes(targetId)) {
        throw new Error('Solicitação de amizade não encontrada.');
      }
      arrayRemove(current.friendRequestsSent, targetId);
      arrayRemove(target.friendRequestsReceived, user.id);
    } else if (action === 'remove') {
      if (!current.friends.includes(targetId)) {
        throw new Error('Esta conta não está na sua lista de amigos.');
      }
      arrayRemove(current.friends, targetId);
      arrayRemove(target.friends, user.id);
    } else {
      sendJson(response, 400, { error: 'Ação inválida.' });
      return;
    }

    current.updatedAt = new Date().toISOString();
    target.updatedAt = new Date().toISOString();
    await writeJsonFile(USERS_FILE, users);
    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

async function sendFriendRequest(request, response) {
  await withFriendship(request, response, 'request');
}

async function acceptFriendRequest(request, response) {
  await withFriendship(request, response, 'accept');
}

async function declineFriendRequest(request, response) {
  await withFriendship(request, response, 'decline');
}

async function cancelFriendRequest(request, response) {
  await withFriendship(request, response, 'cancel');
}

async function removeFriend(request, response) {
  await withFriendship(request, response, 'remove');
}

async function listUserMatches(request, response, targetId) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  const users = await readJsonFile(USERS_FILE);
  const current = users[user.id];
  if (!current) {
    sendJson(response, 404, { error: 'Conta não encontrada.' });
    return;
  }
  ensureFriendFields(current);

  if (!current.friends.includes(targetId)) {
    sendJson(response, 403, { error: 'Você só pode ver o histórico de partidas de amigos.' });
    return;
  }

  const matches = await readJsonFile(MATCHES_FILE);
  sendJson(response, 200, { matches: (matches[targetId] || []).slice(0, 50), targetId });
}

function isSafePublicPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  const relativePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, relativePath);
  return filePath.startsWith(PUBLIC_DIR) ? filePath : null;
}

async function serveStatic(request, response, urlPath) {
  const filePath = isSafePublicPath(urlPath);
  if (!filePath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('Not a file');

    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[extension] || 'application/octet-stream';
    const data = await fs.readFile(filePath);

    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    response.end(data);
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const urlPath = requestUrl.pathname;

  try {
    if (request.method === 'GET' && urlPath === '/healthz') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/auth/config') {
      await handleAuthConfig(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/auth/google') {
      await handleGoogleLogin(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/auth/logout') {
      await handleLogout(request, response);
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/session') {
      await handleSession(request, response);
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/matches') {
      await listMatchRecords(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/matches') {
      await createMatchRecord(request, response);
      return;
    }

    if (request.method === 'PATCH' && urlPath === '/api/profile') {
      await handleProfileUpdate(request, response);
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/friends') {
      await listFriends(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/friends/search') {
      await searchFriend(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/friends/request') {
      await sendFriendRequest(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/friends/accept') {
      await acceptFriendRequest(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/friends/decline') {
      await declineFriendRequest(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/friends/cancel') {
      await cancelFriendRequest(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/friends/remove') {
      await removeFriend(request, response);
      return;
    }

    const userMatches = urlPath.match(/^\/api\/users\/([^/]+)\/matches$/);
    if (request.method === 'GET' && userMatches) {
      await listUserMatches(request, response, userMatches[1]);
      return;
    }

    if (request.method === 'GET' && (urlPath === '/' || urlPath === '/game')) {
      await serveStatic(request, response, '/game.html');
      return;
    }

    if (request.method === 'GET' && urlPath === '/login') {
      await serveStatic(request, response, '/login.html');
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(request, response, urlPath);
      return;
    }

    response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Method not allowed');
  } catch (error) {
    sendJson(response, 500, { error: error.message });
  }
}

async function main() {
  loadEnvFile();
  await ensureDataFiles();

  const server = http.createServer(handleRequest);

  /* -------------------------------------------------------------
     WEBSOCKET - Salas multiplayer online
  ------------------------------------------------------------- */
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const conn = {
      roomCode: null,
      playerIdx: null,
      userId: null,
      name: null
    };
    connections.set(ws, conn);

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        return;
      }

      /* --- MATCHMAKING (Jogo Rápido) ------------------------------------ */
      if (data.type === 'quick_match') {
        const uid = data.uid || null;
        const name = String(data.name || 'Jogador').slice(0, 24);
        conn.userId = uid;
        conn.name = name;

        // A mesma conta não pode ficar na fila duas vezes
        // (ex.: duas abas abertas com o mesmo perfil)
        if (uid && matchmakingQueue.some(entry => entry.uid === uid)) {
          sendTo(ws, { type: 'error', error: 'Esta conta já está na fila de partida.' });
          return;
        }

        removeFromQueue(ws);
        // Sai de qualquer sala anterior (o oponente que fica é notificado)
        detachFromRoom(ws);

        matchmakingQueue.push({ ws, uid, name });
        sendTo(ws, { type: 'queued' });
        tryMatchmaking();
        return;
      }

      if (data.type === 'leave_queue') {
        removeFromQueue(ws);
        return;
      }

      /* --- SALA COM CÓDIGO (Convite) ------------------------------------ */
      if (data.type === 'join_room') {
        let { room: code, name, uid } = data || {};

        removeFromQueue(ws);
        // Sai de qualquer sala anterior antes de entrar/criar outra,
        // avisando quem ficou nela e removendo salas vazias.
        detachFromRoom(ws);

        const cleanName = String(name || '').slice(0, 24);
        conn.name = cleanName || `Jogador`;

        // Se não houver código, gera um novo (criar sala)
        if (!code || String(code).trim() === '') {
          let newCode;
          do {
            newCode = generateRoomCode();
          } while (rooms.has(newCode));
          code = newCode;

          const room = {
            players: [ws, null],
            names: [cleanName || 'Jogador 1', null],
            userIds: [uid || null, null],
            ready: [false, false]
          };
          rooms.set(code, room);
          conn.roomCode = code;
          conn.playerIdx = 0;
          conn.userId = uid || null;
          sendTo(ws, {
            type: 'room_created',
            room: code,
            player: 0,
            name: room.names[0]
          });
          return;
        }

        code = String(code).trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          sendTo(ws, { type: 'error', error: 'Sala não encontrada.' });
          return;
        }

        if (room.players[0] && room.players[1]) {
          sendTo(ws, { type: 'error', error: 'Sala cheia.' });
          return;
        }

        // A mesma conta Google não pode entrar numa partida em que
        // ela própria já é um dos jogadores (nem por convite)
        if (uid && (room.userIds[0] === uid || room.userIds[1] === uid)) {
          sendTo(ws, { type: 'error', error: 'Esta conta já está nesta partida.' });
          return;
        }

        const users = readJsonFileSync(USERS_FILE);

        const playerIdx = room.players[0] ? 1 : 0;
        room.players[playerIdx] = ws;
        room.names[playerIdx] = cleanName || `Jogador ${playerIdx + 1}`;
        room.userIds[playerIdx] = uid || null;
        room.ready[playerIdx] = true;

        conn.roomCode = code;
        conn.playerIdx = playerIdx;
        conn.userId = uid || null;

        // Perfil do oponente já presente na sala (criador do convite)
        const opponentIdx = otherPlayerIndex(playerIdx);
        const opponentUid = room.userIds[opponentIdx];

        sendTo(ws, {
          type: 'room_joined',
          room: code,
          player: playerIdx,
          name: room.names[playerIdx],
          opponent: room.names[opponentIdx],
          opponentProfile: opponentUid ? userProfileOf(users, opponentUid) : null
        });

        // Notifica ambos que a sala está pronta quando tiver 2 jogadores
        if (room.players[0] && room.players[1]) {
          room.ready = [true, true];
          const profile0 = userProfileOf(users, room.userIds[0]) || {
            id: room.userIds[0] || null, uid: room.userIds[0] || null,
            name: room.names[0], email: '', picture: '', playerName: room.names[0]
          };
          const profile1 = userProfileOf(users, room.userIds[1]) || {
            id: room.userIds[1] || null, uid: room.userIds[1] || null,
            name: room.names[1], email: '', picture: '', playerName: room.names[1]
          };
          broadcastRoom(code, {
            type: 'room_ready',
            players: [
              { id: 0, uid: profile0.uid, name: profile0.name, email: profile0.email, picture: profile0.picture, playerName: profile0.playerName },
              { id: 1, uid: profile1.uid, name: profile1.name, email: profile1.email, picture: profile1.picture, playerName: profile1.playerName }
            ]
          });
        }
        return;
      }

      if (conn.roomCode === null || conn.playerIdx === null) return;

      // Relay de mensagens de jogo para o oponente
      const room = rooms.get(conn.roomCode);
      if (!room) return;

      const forward = {
        type: data.type,
        from: conn.playerIdx,
        to: otherPlayerIndex(conn.playerIdx),
        ...data
      };

      const target = room.players[otherPlayerIndex(conn.playerIdx)];
      sendTo(target, forward);

      // Eco de confirmação para o remetente (opcional)
      sendTo(ws, { type: 'ack', original: data.type });
    });

    ws.on('close', () => {
      // Sai da fila e da sala; quem ficou é notificado
      removeFromQueue(ws);
      detachFromRoom(ws);
      connections.delete(ws);
    });

    ws.on('error', () => {});
  });

  if (NODE_ENV === 'production' && !process.env.DATA_DIR) {
    console.warn('AVISO: DATA_DIR não definido. Em produção (Render), os dados serão perdidos a cada deploy. Crie um Persistent Disk e defina DATA_DIR com o caminho do ponto de montagem.');
  }

  server.listen(PORT, HOST, () => {
    console.log(`LUUD Node.js rodando em http://${HOST}:${PORT}`);
    console.log(`Banco de dados em: ${DATA_DIR}`);
    console.log(GOOGLE_CLIENT_ID ? 'Login Google configurado.' : 'Login Google aguardando GOOGLE_CLIENT_ID no arquivo .env.');
  });
}

main().catch(error => {
  console.error('Erro ao iniciar o servidor:', error);
  process.exit(1);
});
