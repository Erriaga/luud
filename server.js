'use strict';

const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const pix = require('./pix');

const PUBLIC_DIR = path.join(__dirname, 'public');

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const COOKIE_NAME = 'luud_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

/* -------------------------------------------------------------
   CONTA PREMIUM (pagamento único via Pix, acesso vitalício)
------------------------------------------------------------- */
const PREMIUM_PLAN_NAME = process.env.PREMIUM_PLAN_NAME || 'Conta Premium';
const PREMIUM_PRICE_BRL = Number(process.env.PREMIUM_PRICE_BRL || 19.90);
const PREMIUM_CURRENCY = 'BRL';
const PREMIUM_TRIAL_NOTE = 'Pagamento único. Sem mensalidade. Acesso vitalício.';
const PREMIUM_BENEFITS = [
  'Cor terciária desbloqueada (3 cores no perfil)',
  'Nickname editável a qualquer momento',
  'Selo Premium no perfil e no placar',
  'Cores e personalizações exclusivas',
  'Acesso vitalício, sem renovação'
];

// Gateway de pagamento: 'mercadopago' | 'stub'
const PIX_GATEWAY = (process.env.PIX_GATEWAY || (NODE_ENV === 'production' ? '' : 'stub')).trim().toLowerCase();
const PIX_API_TOKEN = process.env.PIX_API_TOKEN || '';
const PIX_WEBHOOK_SECRET = process.env.PIX_WEBHOOK_SECRET || '';
const PIX_KEY = process.env.PIX_KEY || '';
const PIX_MERCHANT_NAME = process.env.PIX_MERCHANT_NAME || 'LUUD';
const PIX_MERCHANT_CITY = process.env.PIX_MERCHANT_CITY || 'SAO PAULO';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PAYMENT_EXPIRY_MINUTES = Number(process.env.PAYMENT_EXPIRY_MINUTES || 30);

/* -------------------------------------------------------------
   SALAS DE JOGO ONLINE (multiplayer entre computadores)
------------------------------------------------------------- */
// roomCode -> { players: [ws, ws], names: [str, str], userIds: [uid, uid], ready: [bool, bool] }
const rooms = new Map();
// Conexões ativas: ws -> { roomCode, playerIdx, userId, name }
const connections = new Map();
// Conexões por usuário: userId -> Set<ws> (para notificações em tempo real)
const userConnections = new Map();
// Fila do Jogo Rápido: [{ ws, uid, name }]
const matchmakingQueue = [];

/* -------------------------------------------------------------
   LOBBY DE DUPLA ONLINE (2 vs 2)
   - O lobby fica no servidor: quem cria é o host (dono).
   - Os amigos entram depois de aceitar o convite.
   - A fila aceita duplas incompletas (o usuário pode buscar sozinho).
------------------------------------------------------------- */
// hostUid -> { hostId, teamName, teamColor, teamColorName, members: [{ id, name, picture, playerName }] }
const duplaLobbies = new Map();
// Convites pendentes: inviteId -> { id, fromUid, toUid, teamName, teamColor, teamColorName, createdAt }
const duplaPendingInvites = new Map();
// Fila de duplas: [{ ws, uid, name, teamName, teamColor, teamColorName, players: [...] }]
const duplaQueue = [];
// Limpeza dos lobbies cuyo dono ficou offline: hostUid -> timeout
const duplaLobbyCleanupTimers = new Map();
const DUPLA_LOBBY_CLEANUP_MS = 2 * 60 * 1000;

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

function trackUserConnection(ws, userId) {
  if (!userId) return;
  let set = userConnections.get(userId);
  if (!set) {
    set = new Set();
    userConnections.set(userId, set);
  }
  set.add(ws);
}

function untrackUserConnection(ws, userId) {
  if (!userId) return;
  const set = userConnections.get(userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) userConnections.delete(userId);
  }
}

/**
 * Envia uma mensagem em tempo real para todas as abas abertas de um usuário.
 * Retorna true se pelo menos uma conexão estava aberta.
 */
function sendToUser(userId, message) {
  const set = userConnections.get(userId);
  if (!set) return false;
  const payload = JSON.stringify(message);
  let delivered = false;
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(payload);
      delivered = true;
    }
  }
  return delivered;
}

/**
 * Envia para todos os clientes conectados uma mudança de status online/offline.
 */
function broadcastUserStatus(userId, online) {
  const payload = JSON.stringify({
    type: online ? 'user_online' : 'user_offline',
    userId
  });
  for (const [ws, conn] of connections) {
    if (ws.readyState === 1) {
      ws.send(payload);
    }
  }
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
    // avisa todos os outros jogadores que ficaram na sala (1 vs 1 ou 2 vs 2)
    room.players.forEach(other => {
      if (other && other !== ws && other.readyState === 1) {
        sendTo(other, { type: 'opponent_disconnected' });
      }
    });
  }

  if (!room.players.some(player => player)) {
    rooms.delete(roomCode);
  }
}

// Pareia os dois primeiros jogadores de contas diferentes da fila,
// cria a sala e inicia a partida para ambos
async function tryMatchmaking() {
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
    await startQuickMatchRoom(first, second);
  }
}

async function startQuickMatchRoom(a, b) {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

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
  const profileA = await db.getUserProfile(room.userIds[0]) || {
    id: room.userIds[0] || null, uid: room.userIds[0] || null,
    name: room.names[0], email: '', picture: '', playerName: room.names[0]
  };
  const profileB = await db.getUserProfile(room.userIds[1]) || {
    id: room.userIds[1] || null, uid: room.userIds[1] || null,
    name: room.names[1], email: '', picture: '', playerName: room.names[1]
  };

  const players = [
    { id: 0, uid: profileA.uid, name: profileA.name, email: profileA.email, picture: profileA.picture, playerName: profileA.playerName },
    { id: 1, uid: profileB.uid, name: profileB.name, email: profileB.email, picture: profileB.picture, playerName: profileB.playerName }
  ];

  // SOLO 1 vs 1: quem começa usa a cor primária do perfil e o oponente
  // só usa a primária se ela não tiver o mesmo nome da cor do iniciante.
  const soloColors = await resolveSoloMatchColors([room.userIds[0], room.userIds[1]]);
  players[0].color = soloColors.starterColor;
  players[1].color = soloColors.opponentColor;

  sendTo(a.ws, { type: 'room_created', room: code, player: 0, name: room.names[0], quick: true, opponentProfile: { ...profileB, color: soloColors.opponentColor } });
  sendTo(b.ws, { type: 'room_created', room: code, player: 1, name: room.names[1], quick: true, opponentProfile: { ...profileA, color: soloColors.starterColor } });
  sendTo(a.ws, { type: 'room_ready', players });
  sendTo(b.ws, { type: 'room_ready', players });
}

/* -------------------------------------------------------------
   LOBBY DE DUPLA ONLINE - funções auxiliares
------------------------------------------------------------- */
function sanitizeTeamName(value) {
  // O nome pode ficar vazio no lobby: apenas a busca de partida exige um nome.
  // Quem exibe o nome da dupla usa "Dupla" como valor padrão.
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
}

function sanitizeTeamColor(value) {
  const hex = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : '#ef233c';
}

function sanitizeColorName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}

function getUserSockets(userId) {
  const set = userConnections.get(userId);
  if (!set) return [];
  return Array.from(set).filter(ws => ws.readyState === 1);
}

function findUserSocket(userId) {
  return getUserSockets(userId)[0] || null;
}

async function getLobbyMemberProfile(userId, fallbackName) {
  const profile = await db.getUserProfile(userId);
  const name = (profile && (profile.playerName || profile.name)) || fallbackName || 'Jogador';
  return {
    id: userId,
    name,
    picture: (profile && profile.picture) || '',
    playerName: name
  };
}

// Perfil do membro com a conexão usada por ele (para saber em qual aba ele está)
async function getLobbyMemberWithSocket(userId, fallbackName, socket) {
  const profile = await getLobbyMemberProfile(userId, fallbackName);
  profile.ws = socket || null;
  return profile;
}

// Atualiza nome/apelido/foto dos membros a partir do banco (o nickname
// pode ter mudado depois que o membro entrou no lobby)
async function refreshDuplaLobbyMembers(lobby) {
  await Promise.all(lobby.members.map(async member => {
    try {
      const profile = await getLobbyMemberProfile(member.id, member.name);
      if (!profile) return;
      member.name = profile.name;
      member.picture = profile.picture || member.picture;
      member.playerName = profile.playerName;
    } catch (error) {
      /* mantém os dados que já tinha */
    }
  }));
}

function buildDuplaLobbyPayload(lobby) {
  return {
    type: 'dupla_lobby',
    lobby: {
      hostId: lobby.hostId,
      teamName: lobby.teamName,
      teamColor: lobby.teamColor,
      teamColorName: lobby.teamColorName,
      members: lobby.members.map(member => ({
        id: member.id,
        name: member.name,
        picture: member.picture,
        playerName: member.playerName,
        isHost: member.id === lobby.hostId,
        online: Boolean(member.ws && member.ws.readyState === 1)
      }))
    }
  };
}

async function broadcastDuplaLobby(lobby) {
  await refreshDuplaLobbyMembers(lobby);
  const payload = buildDuplaLobbyPayload(lobby);
  sendToUser(lobby.hostId, payload);
  lobby.members.forEach(member => {
    if (member.id !== lobby.hostId) sendToUser(member.id, payload);
  });
}

// Envia o lobby atual (se existir) para o usuário
async function sendDuplaLobbyToUser(userId) {
  if (!userId) return;
  for (const lobby of duplaLobbies.values()) {
    if (lobby.hostId === userId || lobby.members.some(member => member.id === userId)) {
      await refreshDuplaLobbyMembers(lobby);
      sendToUser(userId, buildDuplaLobbyPayload(lobby));
      return;
    }
  }
}

// Encerra o lobby do dono que ficou offline (se ele não voltar a tempo)
function scheduleDuplaLobbyCleanup(hostUid) {
  clearDuplaLobbyCleanup(hostUid);
  const timer = setTimeout(() => {
    duplaLobbyCleanupTimers.delete(hostUid);
    const lobby = duplaLobbies.get(hostUid);
    if (!lobby) return;
    const host = lobby.members.find(member => member.id === hostUid);
    if (host && host.ws && host.ws.readyState === 1) return; // o dono voltou
    duplaLobbies.delete(hostUid);
    lobby.members.forEach(member => {
      if (member.id !== hostUid) {
        sendToUser(member.id, {
          type: 'dupla_lobby_left',
          message: 'O criador do lobby saiu. O lobby foi encerrado.'
        });
      }
    });
  }, DUPLA_LOBBY_CLEANUP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  duplaLobbyCleanupTimers.set(hostUid, timer);
}

function clearDuplaLobbyCleanup(hostUid) {
  const timer = duplaLobbyCleanupTimers.get(hostUid);
  if (timer) {
    clearTimeout(timer);
    duplaLobbyCleanupTimers.delete(hostUid);
  }
}

// Lobby em que o usuário participa (criador ou convidado)
function findDuplaLobbyForUser(uid) {
  if (!uid) return null;
  const owned = duplaLobbies.get(uid);
  if (owned) return owned;
  for (const lobby of duplaLobbies.values()) {
    if (lobby.members.some(member => member.id === uid)) return lobby;
  }
  return null;
}

async function ensureDuplaLobby(hostUid, teamName, teamColor, teamColorName, socket) {
  let lobby = duplaLobbies.get(hostUid);
  if (!lobby) {
    const host = await getLobbyMemberWithSocket(hostUid, null, socket);
    lobby = {
      hostId: hostUid,
      teamName: sanitizeTeamName(teamName),
      teamColor: sanitizeTeamColor(teamColor),
      teamColorName: sanitizeColorName(teamColorName),
      members: [host]
    };
    duplaLobbies.set(hostUid, lobby);
    return lobby;
  }
  if (typeof teamName === 'string') lobby.teamName = sanitizeTeamName(teamName);
  if (teamColor) lobby.teamColor = sanitizeTeamColor(teamColor);
  if (teamColorName) lobby.teamColorName = sanitizeColorName(teamColorName);
  // Mantém a aba do dono do lobby conectada
  const host = lobby.members.find(member => member.id === hostUid);
  if (host && socket && (!host.ws || host.ws.readyState !== 1)) host.ws = socket;
  return lobby;
}

function removeFromDuplaQueue(ws) {
  const index = duplaQueue.findIndex(entry => entry.ws === ws);
  if (index === -1) return false;
  duplaQueue.splice(index, 1);
  return true;
}

// Descobre as conexões abertas de cada jogador da dupla
function resolveDuplaPlayers(members, fallbackUid, fallbackWs) {
  const players = [];
  members.forEach(member => {
    let socket = null;
    if (member.id === fallbackUid && fallbackWs && fallbackWs.readyState === 1) {
      // quem entrou na fila joga na própria aba
      socket = fallbackWs;
    } else if (member.ws && member.ws.readyState === 1) {
      // o parceiro joga na aba em que aceitou o convite
      socket = member.ws;
    } else {
      socket = findUserSocket(member.id);
    }
    if (socket) {
      players.push({ id: member.id, name: member.name, picture: member.picture, ws: socket });
    }
  });
  return players;
}

async function tryDuplaMatchmaking() {
  // Resolve quem está online em cada dupla que está na fila
  const valid = [];
  duplaQueue.forEach(entry => {
    const players = resolveDuplaPlayers(entry.members, entry.uid, entry.ws);
    if (!players.length) return; // ninguém da dupla está online
    entry.players = players;
    valid.push(entry);
  });

  duplaQueue.length = 0;
  valid.forEach(entry => duplaQueue.push(entry));

  while (duplaQueue.length >= 2) {
    const first = duplaQueue[0];
    let matchIndex = -1;
    for (let i = 1; i < duplaQueue.length; i++) {
      // Duplas do mesmo tamanho enfrentam duplas do mesmo tamanho
      if (duplaQueue[i].players.length === first.players.length) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex === -1) break;

    const second = duplaQueue[matchIndex];
    duplaQueue.splice(matchIndex, 1);
    duplaQueue.shift();
    await startDuplaMatch(first, second);
  }
}

async function startDuplaMatch(entryA, entryB) {
  const teamA = entryA.players || [];
  const teamB = entryB.players || [];
  if (!teamA.length || !teamB.length) return;

  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const soloMatch = teamA.length === 1 && teamB.length === 1;
  const seats = [];

  if (soloMatch) {
    // Cada lado é uma dupla com apenas um jogador (1 vs 1)
    seats.push({ player: teamA[0], team: 0, slot: 0 });
    seats.push({ player: teamB[0], team: 1, slot: 1 });
  } else {
    // 2 vs 2: slots 0 e 2 são do time 0; slots 1 e 3 são do time 1
    const a = teamA.slice(0, 2);
    const b = teamB.slice(0, 2);
    seats.push({ player: a[0], team: 0, slot: 0 });
    seats.push({ player: b[0], team: 1, slot: 1 });
    if (a[1]) seats.push({ player: a[1], team: 0, slot: 2 });
    if (b[1]) seats.push({ player: b[1], team: 1, slot: 3 });
  }

  const room = {
    players: [],
    names: [],
    userIds: [],
    teams: [],
    ready: [],
    mode: 'dupla'
  };

  seats.forEach(seat => {
    room.players[seat.slot] = seat.player.ws;
    room.names[seat.slot] = seat.player.name;
    room.userIds[seat.slot] = seat.player.id;
    room.teams[seat.slot] = seat.team;
    room.ready[seat.slot] = true;
    const conn = connections.get(seat.player.ws);
    if (conn) {
      conn.roomCode = code;
      conn.playerIdx = seat.slot;
    }
  });

  rooms.set(code, room);

  const roster = seats.map(seat => {
    const source = seat.team === 0 ? entryA : entryB;
    return {
      slot: seat.slot,
      id: seat.player.id,
      uid: seat.player.id,
      name: seat.player.name,
      picture: seat.player.picture || '',
      playerName: seat.player.name,
      team: seat.team,
      teamName: source.teamName,
      teamColor: source.teamColor,
      teamColorName: source.teamColorName
    };
  });

  // SOLO 1 vs 1 (lobby de dupla com um jogador de cada lado): as cores
  // vêm das preferências do perfil. Quem começa usa a cor primária e o
  // oponente só usa a primária se ela não tiver o mesmo nome.
  if (soloMatch) {
    const soloColors = await resolveSoloMatchColors([
      seats[0].player.id,
      seats[1].player.id
    ]);
    roster[0].teamColor = soloColors.starterColor.hex;
    roster[0].teamColorName = soloColors.starterColor.name;
    roster[1].teamColor = soloColors.opponentColor.hex;
    roster[1].teamColorName = soloColors.opponentColor.name;
  }

  seats.forEach(seat => {
    const matchMessage = {
      type: 'dupla_match_found',
      room: code,
      slot: seat.slot,
      team: seat.team,
      solo: soloMatch,
      players: roster
    };
    // A partida começa na aba do jogador; as outras abas só são avisadas
    sendTo(seat.player.ws, matchMessage);
    getUserSockets(seat.player.id).forEach(socket => {
      if (socket !== seat.player.ws) {
        sendTo(socket, {
          type: 'dupla_match_started_elsewhere',
          message: 'A partida de dupla começou em outra aba.'
        });
      }
    });
  });
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
  const envPath = path.join(__dirname, '.env');
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
  return db.createSession(userId);
}

async function getSessionUser(request) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  return db.getSessionUser(token);
}

async function destroySession(request) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE_NAME];
  if (!token) return;
  await db.destroySession(token);
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
    const user = await db.createOrUpdateUserFromGoogle(payload);

    const token = await db.createSession(user.id);
    sendJson(response, 200, { user }, { 'Set-Cookie': createSessionCookie(token) });
  } catch (error) {
    if (error && error.dbError) {
      console.error('[login] erro de banco de dados:', error.message);
      sendJson(response, 503, { error: 'Não foi possível acessar o banco de dados. Tente novamente em instantes.' });
      return;
    }
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

/* -------------------------------------------------------------
   CONTA PREMIUM - COMPRA VIA PIX
   O servidor é a fonte de verdade: o cliente apenas pede a cobrança
   e consulta o status. O Premium só é liberado depois que o gateway
   confirma o pagamento (webhook ou consulta de status).
------------------------------------------------------------- */
function premiumPublicInfo() {
  return {
    planName: PREMIUM_PLAN_NAME,
    price: PREMIUM_PRICE_BRL,
    currency: PREMIUM_CURRENCY,
    note: PREMIUM_TRIAL_NOTE,
    benefits: PREMIUM_BENEFITS,
    gatewayReady: Boolean(PIX_GATEWAY === 'mercadopago' && PIX_API_TOKEN) || (PIX_GATEWAY === 'stub' && NODE_ENV !== 'production')
  };
}

function generatePaymentId() {
  return `pix_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

// Ativa o Premium e devolve o usuário atualizado
async function grantPremium(userId, paymentId) {
  const { user } = await db.activatePremium(userId, paymentId);
  await db.updatePayment(paymentId, { status: 'paid', paidAt: new Date().toISOString() });
  return user;
}

// Consulta o status da cobrança no gateway e libera o Premium se aprovado
async function refreshPaymentStatus(payment) {
  if (!payment || payment.status === 'paid') return payment;

  if (payment.gateway === 'mercadopago' && PIX_API_TOKEN && payment.gatewayRef) {
    const data = await pix.getMercadoPagoPayment({ token: PIX_API_TOKEN, paymentId: payment.gatewayRef });
    if (data && data.status === 'approved') {
      await grantPremium(payment.userId, payment.id);
      return db.getPayment(payment.id);
    }
    if (data && data.status && data.status !== 'pending') {
      return db.updatePayment(payment.id, { status: data.status });
    }
  }

  // Cobrança expirada
  if (payment.expiresAt && new Date(payment.expiresAt).getTime() < Date.now() && payment.status === 'pending') {
    return db.updatePayment(payment.id, { status: 'expired' });
  }

  return payment;
}

async function handlePremiumInfo(request, response) {
  sendJson(response, 200, { premium: premiumPublicInfo() });
}

async function handlePremiumCheckout(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada. Entre com a conta Google para assinar.' });
    return;
  }

  if (user.isPaid) {
    sendJson(response, 200, { alreadyPaid: true, user, premium: premiumPublicInfo() });
    return;
  }

  if (!PIX_GATEWAY) {
    sendJson(response, 503, { error: 'O pagamento via Pix ainda não está disponível.' });
    return;
  }

  if (PIX_GATEWAY === 'mercadopago' && !PIX_API_TOKEN) {
    sendJson(response, 503, { error: 'O gateway Pix não está configurado.' });
    return;
  }

  if (PIX_GATEWAY === 'stub' && NODE_ENV === 'production') {
    sendJson(response, 503, { error: 'O gateway Pix não está configurado.' });
    return;
  }

  // Qualquer gateway desconhecido (erro de digitação) é recusado
  if (PIX_GATEWAY !== 'mercadopago' && PIX_GATEWAY !== 'stub') {
    sendJson(response, 503, { error: 'O gateway Pix não está configurado.' });
    return;
  }

  try {
    const paymentId = generatePaymentId();
    const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MINUTES * 60 * 1000).toISOString();

    let qrCode = '';
    let copyPaste = '';
    let gatewayRef = '';

    if (PIX_GATEWAY === 'mercadopago') {
      const notificationUrl = PUBLIC_URL ? `${PUBLIC_URL}/api/premium/webhook` : undefined;
      const created = await pix.createMercadoPagoPayment({
        token: PIX_API_TOKEN,
        amount: PREMIUM_PRICE_BRL,
        description: `${PREMIUM_PLAN_NAME} LUUD - pagamento unico`,
        email: user.email,
        externalReference: paymentId,
        notificationUrl,
        metadata: { user_id: user.id, payment_id: paymentId }
      });
      qrCode = created.qrCode || '';
      copyPaste = created.copyPaste || '';
      gatewayRef = created.id || '';
    } else {
      // Modo de desenvolvimento: gera um BR Code estático para testar a interface
      const key = PIX_KEY || 'luud.premium@pix.test';
      copyPaste = pix.buildPixPayload({
        key,
        name: PIX_MERCHANT_NAME,
        city: PIX_MERCHANT_CITY,
        amount: PREMIUM_PRICE_BRL,
        txid: paymentId
      });
      gatewayRef = paymentId;
    }

    const payment = await db.createPayment({
      id: paymentId,
      userId: user.id,
      gateway: PIX_GATEWAY,
      amount: PREMIUM_PRICE_BRL,
      status: 'pending',
      gatewayRef,
      copyPaste,
      qrCode,
      expiresAt
    });

    sendJson(response, 200, {
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: PREMIUM_CURRENCY,
        status: payment.status,
        qrCode: payment.qrCode,
        copyPaste: payment.copyPaste,
        expiresAt: payment.expiresAt,
        gateway: payment.gateway,
        testMode: PIX_GATEWAY === 'stub'
      },
      premium: premiumPublicInfo()
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message || 'Não foi possível gerar a cobrança Pix.' });
  }
}

async function handlePremiumStatus(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const paymentId = requestUrl.searchParams.get('id');

  try {
    // A consulta das cobranças não pode derrubar a resposta:
    // se o armazenamento de pagamentos falhar, o jogador ainda vê o
    // status do plano (e o site continua funcionando).
    let payment = null;
    try {
      payment = paymentId ? await db.getPayment(paymentId) : null;
      if (!payment && !paymentId) {
        const payments = await db.listPaymentsForUser(user.id);
        payment = payments.find(item => item.status === 'pending') || payments[0] || null;
      }
    } catch (paymentError) {
      console.error('[premium] não foi possível consultar as cobranças:', paymentError.message);
      payment = null;
    }

    // A cobrança precisa pertencer ao jogador logado
    if (payment && payment.userId !== user.id) {
      sendJson(response, 403, { error: 'Cobrança não encontrada.' });
      return;
    }

    if (payment) {
      payment = await refreshPaymentStatus(payment);
    }

    const currentUser = await getSessionUser(request);
    sendJson(response, 200, {
      status: payment ? payment.status : 'none',
      paid: Boolean(currentUser && currentUser.isPaid),
      plan: currentUser ? currentUser.plan : 'free',
      user: currentUser,
      payment: payment ? {
        id: payment.id,
        amount: payment.amount,
        status: payment.status,
        expiresAt: payment.expiresAt,
        qrCode: payment.qrCode,
        copyPaste: payment.copyPaste
      } : null,
      premium: premiumPublicInfo()
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Confirmação manual de pagamento (somente em desenvolvimento/testes)
async function handlePremiumDevConfirm(request, response) {
  if (NODE_ENV === 'production' || PIX_GATEWAY !== 'stub') {
    sendJson(response, 404, { error: 'Rota não disponível.' });
    return;
  }

  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const paymentId = body.id;
    const payment = paymentId ? await db.getPayment(paymentId) : null;
    if (!payment || payment.userId !== user.id) {
      sendJson(response, 404, { error: 'Cobrança não encontrada.' });
      return;
    }

    const updatedUser = await grantPremium(user.id, payment.id);
    sendJson(response, 200, { paid: true, plan: updatedUser.plan, user: updatedUser });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Webhook do gateway: confirma o pagamento e libera o Premium
async function handlePremiumWebhook(request, response) {
  try {
    const body = await readJsonBody(request);
    const gatewayPaymentId = (body && body.data && body.data.id) || (body && body.id) || '';
    const signature = request.headers['x-signature'];
    const requestId = request.headers['x-request-id'];

    if (!pix.verifyMercadoPagoSignature({
      secret: PIX_WEBHOOK_SECRET,
      signatureHeader: signature,
      requestId,
      paymentId: gatewayPaymentId
    })) {
      sendJson(response, 401, { error: 'Assinatura inválida.' });
      return;
    }

    if (!gatewayPaymentId) {
      sendJson(response, 400, { error: 'Pagamento não informado.' });
      return;
    }

    // Confirma o pagamento direto no gateway (nunca confia no corpo do webhook)
    let approved = false;
    if (PIX_GATEWAY === 'mercadopago' && PIX_API_TOKEN) {
      const data = await pix.getMercadoPagoPayment({ token: PIX_API_TOKEN, paymentId: gatewayPaymentId });
      approved = Boolean(data && data.status === 'approved');
    } else if (PIX_GATEWAY === 'stub' && NODE_ENV !== 'production') {
      approved = true;
    }

    if (approved) {
      const payment = await db.findPaymentByGatewayRef(String(gatewayPaymentId));
      if (payment) {
        await grantPremium(payment.userId, payment.id);
      }
    }

    sendJson(response, 200, { ok: true });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

/* -------------------------------------------------------------
   CORES DO PERFIL
   As cores do perfil (primária, secundária e terciária) só podem
   ser salvas quando pertencem a categorias diferentes.
   A categoria é identificada pelo matiz/saturação/luminosidade,
   espelhando a mesma identificação usada na interface.
------------------------------------------------------------- */
function sanitizeProfileColor(value) {
  const hex = String(value || '').trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}

function profileColorCategory(hex) {
  const normalized = sanitizeProfileColor(hex);
  if (!normalized) return '';
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 510;

  if (delta < 18) {
    if (lightness < 0.16) return 'Preto';
    if (lightness < 0.38) return 'Cinza Escuro';
    if (lightness < 0.68) return 'Cinza';
    if (lightness < 0.9) return 'Cinza Claro';
    return 'Branco';
  }

  const saturation = max === 0 ? 0 : delta / max;
  let hue;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * (((b - r) / delta) + 2);
  else hue = 60 * (((r - g) / delta) + 4);
  if (hue < 0) hue += 360;

  if (hue < 12 || hue >= 345) return lightness < 0.3 ? 'Vermelho Escuro' : 'Vermelho';
  if (hue < 40) return lightness < 0.38 ? 'Marrom' : 'Laranja';
  if (hue < 68) return lightness < 0.3 ? 'Marrom' : 'Amarelo';
  if (hue < 95) return 'Verde-limão';
  if (hue < 160) return lightness < 0.32 ? 'Verde Escuro' : 'Verde';
  if (hue < 190) return 'Ciano';
  if (hue < 215) return 'Azul-claro';
  if (hue < 250) return lightness < 0.3 ? 'Azul-marinho' : 'Azul';
  if (hue < 285) return lightness < 0.35 && hue > 260 ? 'Roxo' : 'Violeta';
  if (hue < 320) {
    if (lightness < 0.35) return 'Roxo';
    return lightness > 0.68 ? 'Rosa' : 'Magenta';
  }
  return 'Rosa';
}

/* -------------------------------------------------------------
   CORES DA PARTIDA SOLO (1 vs 1)
   Quem começa a partida usa a cor primária do seu perfil.
   O oponente só usa a cor primária se ela não tiver o mesmo nome
   (mesma categoria) da cor de quem começou: nesse caso passa para
   a cor secundária e, se ainda assim repetir, para a terciária.
------------------------------------------------------------- */
async function getProfileColorPreferences(userId) {
  const user = userId ? await db.getUserById(userId) : null;
  return {
    primary: (user && user.primaryColor) || db.DEFAULT_PRIMARY_COLOR,
    secondary: (user && user.secondaryColor) || db.DEFAULT_SECONDARY_COLOR,
    tertiary: (user && user.tertiaryColor) || db.DEFAULT_TERTIARY_COLOR
  };
}

// playerIds[0] é quem começa a partida
async function resolveSoloMatchColors(playerIds) {
  const preferences = [];
  for (const uid of playerIds) {
    preferences.push(await getProfileColorPreferences(uid));
  }

  const starter = preferences[0] || {};
  const starterHex = sanitizeProfileColor(starter.primary) || db.DEFAULT_PRIMARY_COLOR;
  const starterColor = { hex: starterHex, name: profileColorCategory(starterHex) };

  const opponent = preferences[1] || {};
  const candidates = [opponent.primary, opponent.secondary, opponent.tertiary]
    .map(hex => sanitizeProfileColor(hex))
    .filter(Boolean);

  // A cor do oponente não pode ter o mesmo nome da cor de quem começou
  const usedNames = new Set([starterColor.name]);
  const opponentHex = candidates.find(hex => !usedNames.has(profileColorCategory(hex)))
    || candidates[0]
    || db.DEFAULT_PRIMARY_COLOR;
  const opponentColor = { hex: opponentHex, name: profileColorCategory(opponentHex) };

  return { starterColor, opponentColor };
}

async function handleProfileUpdate(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);

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

    // Só os campos enviados são atualizados: assim o salvamento das
    // cores do perfil não apaga as demais informações da conta.
    const fields = {};
    if (body.displayName !== undefined) {
      fields.displayName = cleanText(body.displayName, 60) || user.displayName;
    }
    // O nickname (playerName) não pode ser alterado pelo jogador:
    // a alteração será liberada apenas para contas pagas.
    if (body.avatarUrl !== undefined) {
      fields.avatarUrl = avatarUrl;
    }
    if (body.bio !== undefined) {
      fields.bio = cleanText(body.bio, 280);
    }

    // CORES DO PERFIL
    const colorRoles = [
      { field: 'primaryColor', key: 'primary' },
      { field: 'secondaryColor', key: 'secondary' },
      { field: 'tertiaryColor', key: 'tertiary' }
    ];
    const colors = {
      primary: user.primaryColor || db.DEFAULT_PRIMARY_COLOR,
      secondary: user.secondaryColor || db.DEFAULT_SECONDARY_COLOR,
      tertiary: user.tertiaryColor || db.DEFAULT_TERTIARY_COLOR
    };

    let hasColorChange = false;
    for (const role of colorRoles) {
      if (body[role.field] === undefined) continue;
      const hex = sanitizeProfileColor(body[role.field]);
      if (!hex) {
        sendJson(response, 400, { error: `Cor ${role.key} inválida.` });
        return;
      }
      // A cor terciária só pode ser alterada por contas pagas
      if (role.key === 'tertiary' && hex !== colors.tertiary && !user.isPaid) {
        sendJson(response, 400, { error: 'A cor terciária está disponível apenas para contas pagas.' });
        return;
      }
      colors[role.key] = hex;
      fields[role.field] = hex;
      hasColorChange = true;
    }

    // As três cores precisam pertencer a categorias diferentes
    const categories = colorRoles.map(role => profileColorCategory(colors[role.key]));
    if (new Set(categories).size !== colorRoles.length) {
      sendJson(response, 400, { error: 'As cores do perfil precisam ser de categorias diferentes.' });
      return;
    }

    // A partir de agora as cores salvas são as preferências do jogador
    if (hasColorChange) fields.colorsCustomized = true;

    const updatedUser = await db.updateUserProfile(user.id, fields);

    sendJson(response, 200, { user: updatedUser });
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
------------------------------------------------------------- */
const MATCH_RECORD_LIMIT = 100;
const MATCH_MODES = new Set(['quick', 'invite', 'local', 'dupla']);

function sanitizeMatchRecord(body) {
  const mode = MATCH_MODES.has(body.mode) ? body.mode : 'local';
  const result = body.result === 'win' ? 'win' : 'loss';
  const toScore = (value) => {
    const num = Math.floor(Number(value));
    return Number.isFinite(num) && num >= 0 ? num : 0;
  };
  const opponentName = String(body.opponentName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Oponente';
  return {
    id: require('crypto').randomUUID(),
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

    await db.createMatchRecord(user.id, record);

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

  const data = await db.listMatchRecords(user.id);
  sendJson(response, 200, { matches: data.matches });
}

/* -------------------------------------------------------------
   AMIZADES
------------------------------------------------------------- */

async function listFriends(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  const friends = await db.getFriends(user.id);
  const sent = await db.getSentRequests(user.id);
  const received = await db.getReceivedRequests(user.id);

  // Adiciona status online baseado nas conexões WebSocket ativas
  const friendsWithStatus = friends.map(f => ({
    ...f,
    online: userConnections.has(f.id) && userConnections.get(f.id).size > 0
  }));

  sendJson(response, 200, { friends: friendsWithStatus, sent, received });
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

    const target = await db.searchUsersByQuery(query, user.id);

    if (!target) {
      sendJson(response, 200, { found: false });
      return;
    }

    const relation = await db.getRelation(user.id, target.id);

    sendJson(response, 200, {
      found: true,
      account: {
        id: target.id,
        email: target.email,
        displayName: target.displayName,
        playerName: target.playerName,
        picture: target.picture || target.avatarUrl || ''
      },
      relation
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

    if (action === 'request') {
      await db.sendFriendRequest(user.id, targetId);
    } else if (action === 'accept') {
      await db.acceptFriendRequest(user.id, targetId);
    } else if (action === 'decline') {
      await db.declineFriendRequest(user.id, targetId);
    } else if (action === 'cancel') {
      await db.cancelFriendRequest(user.id, targetId);
    } else if (action === 'remove') {
      await db.removeFriend(user.id, targetId);
    } else {
      sendJson(response, 400, { error: 'Ação inválida.' });
      return;
    }

    // Notificação em tempo real para o alvo quando uma solicitação é enviada
    if (action === 'request') {
      const fromProfile = await db.getUserProfile(user.id);
      sendToUser(targetId, {
        type: 'friend_request_received',
        fromId: user.id,
        from: fromProfile || { id: user.id, name: user.playerName || user.email.split('@')[0], email: user.email, picture: '', playerName: user.playerName || user.email.split('@')[0] }
      });
    }

    // Notificação em tempo real para o solicitante quando a solicitação é aceita
    if (action === 'accept') {
      const toProfile = await db.getUserProfile(user.id);
      sendToUser(targetId, {
        type: 'friend_request_accepted',
        fromId: user.id,
        from: toProfile || { id: user.id, name: user.playerName || user.email.split('@')[0], email: user.email, picture: '', playerName: user.playerName || user.email.split('@')[0] }
      });
    }

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

  const relation = await db.getRelation(user.id, targetId);
  if (relation !== 'friend') {
    sendJson(response, 403, { error: 'Você só pode ver o histórico de partidas de amigos.' });
    return;
  }

  const data = await db.listMatchRecordsForUser(targetId);
  sendJson(response, 200, { matches: data.matches, targetId });
}

/* -------------------------------------------------------------
   SERVIDOR ESTÁTICO E ROTAS
------------------------------------------------------------- */
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

    // Em desenvolvimento os arquivos não são cacheados (evita servir
    // versões antigas depois de uma alteração); em produção o cache
    // continua valendo para os arquivos estáticos.
    const cacheControl = NODE_ENV === 'production'
      ? (extension === '.html' ? 'no-store' : 'public, max-age=3600')
      : 'no-store';

    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl
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
      // Diagnóstico do banco: mostra se o PostgreSQL está em uso e o último erro
      const dbStatus = db.getDbStatus();
      sendJson(response, 200, {
        ok: true,
        db: dbStatus
      });
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

    // CONTA PREMIUM (Pix)
    if (request.method === 'GET' && urlPath === '/api/premium/info') {
      await handlePremiumInfo(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/premium/checkout') {
      await handlePremiumCheckout(request, response);
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/premium/status') {
      await handlePremiumStatus(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/premium/webhook') {
      await handlePremiumWebhook(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/premium/dev/confirm') {
      await handlePremiumDevConfirm(request, response);
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

    // AMIZADES
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

    // Página de login descontinuada: redireciona para a página inicial
    if (request.method === 'GET' && urlPath === '/login') {
      response.writeHead(302, { Location: '/' });
      response.end();
      return;
    }

    if (request.method === 'GET') {
      await serveStatic(request, response, urlPath);
      return;
    }

    response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Method not allowed');
  } catch (error) {
    console.error('[servidor] erro ao tratar requisição:', error && error.message);
    // Erros de banco não expõem dados sensíveis: usamos a mensagem já sanitizada
    const message = error && error.safeMessage ? error.safeMessage : (error && error.message) || 'Erro interno do servidor.';
    sendJson(response, 500, { error: message });
  }
}

async function main() {
  loadEnvFile();
  await db.ensureDataFiles();

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

    ws.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        return;
      }

      /* --- IDENTIFICAÇÃO DE USUÁRIO (notificações em tempo real) -------- */
      if (data.type === 'identify') {
        const uid = data.uid || null;
        const prevConn = connections.get(ws);
        if (prevConn && prevConn.userId) {
          untrackUserConnection(ws, prevConn.userId);
        }
        if (uid) {
          trackUserConnection(ws, uid);
          if (prevConn) prevConn.userId = uid;
          broadcastUserStatus(uid, true);
          // O dono do lobby voltou: não encerra mais o lobby
          clearDuplaLobbyCleanup(uid);
          // Reenvia o lobby de dupla atual (se o usuário estiver em um)
          // e reanexa a aba que voltou a estar online
          for (const lobby of duplaLobbies.values()) {
            const member = lobby.members.find(entry => entry.id === uid);
            if (!member) continue;
            // Mantém a aba em que o jogador entrou no lobby
            if (!member.ws || member.ws.readyState !== 1) member.ws = ws;
            await broadcastDuplaLobby(lobby);
          }
          await sendDuplaLobbyToUser(uid);
        }
        sendTo(ws, { type: 'ack', original: 'identify' });
        return;
      }

      /* --- MATCHMAKING (Jogo Rápido) ------------------------------------ */
      if (data.type === 'quick_match') {
        const uid = data.uid || null;
        const name = String(data.name || 'Jogador').slice(0, 24);
        conn.userId = uid;
        conn.name = name;

        // A mesma conta não pode ficar na fila duas vezes
        if (uid && matchmakingQueue.some(entry => entry.uid === uid)) {
          sendTo(ws, { type: 'error', error: 'Esta conta já está na fila de partida.' });
          return;
        }

        removeFromQueue(ws);
        // Sai de qualquer sala anterior (o oponente que fica é notificado)
        detachFromRoom(ws);

        matchmakingQueue.push({ ws, uid, name });
        sendTo(ws, { type: 'queued' });
        await tryMatchmaking();
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

        // Busca o perfil do oponente já presente na sala (criador do convite)
        const opponentIdx = otherPlayerIndex(0); // o novo jogador sempre entra no índice 1 ou 0
        // Determina o índice do novo jogador
        const playerIdx = room.players[0] ? 1 : 0;
        const opponentIdxFinal = otherPlayerIndex(playerIdx);
        const opponentUid = room.userIds[opponentIdxFinal];

        const opponentProfile = opponentUid ? await db.getUserProfile(opponentUid) : null;

        room.players[playerIdx] = ws;
        room.names[playerIdx] = cleanName || `Jogador ${playerIdx + 1}`;
        room.userIds[playerIdx] = uid || null;
        room.ready[playerIdx] = true;

        conn.roomCode = code;
        conn.playerIdx = playerIdx;
        conn.userId = uid || null;

        sendTo(ws, {
          type: 'room_joined',
          room: code,
          player: playerIdx,
          name: room.names[playerIdx],
          opponent: room.names[opponentIdxFinal],
          opponentProfile: opponentProfile || null
        });

        // Notifica ambos que a sala está pronta quando tiver 2 jogadores
        if (room.players[0] && room.players[1]) {
          room.ready = [true, true];
          const profile0 = await db.getUserProfile(room.userIds[0]) || {
            id: room.userIds[0] || null, uid: room.userIds[0] || null,
            name: room.names[0], email: '', picture: '', playerName: room.names[0]
          };
          const profile1 = await db.getUserProfile(room.userIds[1]) || {
            id: room.userIds[1] || null, uid: room.userIds[1] || null,
            name: room.names[1], email: '', picture: '', playerName: room.names[1]
          };
          // SOLO 1 vs 1: cores resolvidas pelo servidor (quem começa usa a
          // cor primária; o oponente só usa a primária se o nome diferir)
          const soloColors = await resolveSoloMatchColors([room.userIds[0], room.userIds[1]]);
          broadcastRoom(code, {
            type: 'room_ready',
            players: [
              { id: 0, uid: profile0.uid, name: profile0.name, email: profile0.email, picture: profile0.picture, playerName: profile0.playerName, color: soloColors.starterColor },
              { id: 1, uid: profile1.uid, name: profile1.name, email: profile1.email, picture: profile1.picture, playerName: profile1.playerName, color: soloColors.opponentColor }
            ]
          });
        }
        return;
      }

      /* --- LOBBY DE DUPLA ONLINE ---------------------------------------- */
      if (data.type === 'dupla_lobby_request') {
        await sendDuplaLobbyToUser(conn.userId);
        return;
      }

      if (data.type === 'dupla_invite') {
        const hostUid = conn.userId;
        const targetId = String(data.targetId || '').trim();

        if (!hostUid) {
          sendTo(ws, { type: 'dupla_invite_result', status: 'error', message: 'Entre na sua conta para convidar amigos.' });
          return;
        }
        if (!targetId || targetId === hostUid) {
          sendTo(ws, { type: 'dupla_invite_result', status: 'error', message: 'Convite inválido.' });
          return;
        }

        // O convidado precisa estar online para receber o convite
        if (!getUserSockets(targetId).length) {
          sendTo(ws, {
            type: 'dupla_invite_result',
            status: 'offline',
            targetId,
            message: 'Não foi possível enviar convite: o amigo está offline.'
          });
          return;
        }

        // Só amigos podem ser convidados para a dupla
        const relation = await db.getRelation(hostUid, targetId);
        if (relation !== 'friend') {
          sendTo(ws, {
            type: 'dupla_invite_result',
            status: 'error',
            targetId,
            message: 'Você só pode convidar amigos.'
          });
          return;
        }

        const inviteId = require('crypto').randomUUID();
        const teamName = sanitizeTeamName(data.teamName);
        const teamColor = sanitizeTeamColor(data.teamColor);
        const teamColorName = sanitizeColorName(data.teamColorName);

        duplaPendingInvites.set(inviteId, {
          id: inviteId,
          fromUid: hostUid,
          toUid: targetId,
          teamName,
          teamColor,
          teamColorName,
          createdAt: Date.now()
        });

        const hostProfile = await getLobbyMemberProfile(hostUid, conn.name);
        sendToUser(targetId, {
          type: 'dupla_invite',
          inviteId,
          fromId: hostUid,
          fromName: hostProfile.name,
          fromPicture: hostProfile.picture,
          teamName,
          teamColor,
          teamColorName,
          matchType: 'dupla',
          matchTypeLabel: 'DUPLA • 2 vs 2'
        });

        sendTo(ws, {
          type: 'dupla_invite_result',
          status: 'sent',
          targetId,
          inviteId,
          message: 'Convite enviado! Aguardando resposta...'
        });
        return;
      }

      if (data.type === 'dupla_invite_response') {
        const inviteId = String(data.inviteId || '');
        const invite = duplaPendingInvites.get(inviteId);
        if (!invite || invite.toUid !== conn.userId) {
          sendTo(ws, { type: 'dupla_invite_result', status: 'error', message: 'Convite inválido ou expirado.' });
          return;
        }
        duplaPendingInvites.delete(inviteId);

        if (!data.accept) {
          sendToUser(invite.fromUid, {
            type: 'dupla_invite_result',
            status: 'declined',
            targetId: invite.toUid,
            message: 'O convite foi recusado.'
          });
          return;
        }

        const lobby = await ensureDuplaLobby(invite.fromUid, invite.teamName, invite.teamColor, invite.teamColorName, findUserSocket(invite.fromUid));
        if (!lobby.members.some(member => member.id === invite.toUid) && lobby.members.length >= 2) {
          sendTo(ws, { type: 'dupla_invite_result', status: 'error', message: 'A dupla já está completa (2/2).' });
          return;
        }

        const member = await getLobbyMemberWithSocket(invite.toUid, conn.name, ws);
        if (!lobby.members.some(entry => entry.id === invite.toUid)) {
          lobby.members.push(member);
        } else {
          // Atualiza a aba em que o parceiro está
          const existing = lobby.members.find(entry => entry.id === invite.toUid);
          if (existing) existing.ws = ws;
        }

        await broadcastDuplaLobby(lobby);
        // Avisa quem convidou que o convite foi aceito
        sendToUser(invite.fromUid, {
          type: 'dupla_invite_result',
          status: 'accepted',
          targetId: invite.toUid,
          message: 'Convite aceito! O amigo entrou no lobby.'
        });
        sendTo(ws, {
          type: 'dupla_invite_result',
          status: 'accepted',
          message: 'Você entrou no lobby da dupla.'
        });
        return;
      }

      if (data.type === 'dupla_lobby_remove') {
        const lobby = findDuplaLobbyForUser(conn.userId);
        if (!lobby || lobby.hostId !== conn.userId) return;
        const memberId = String(data.memberId || '');
        if (memberId === lobby.hostId) return;
        lobby.members = lobby.members.filter(member => member.id !== memberId);
        await broadcastDuplaLobby(lobby);
        sendToUser(memberId, { type: 'dupla_lobby_left', message: 'Você foi removido da dupla.' });
        return;
      }

      if (data.type === 'dupla_lobby_leave') {
        const uid = conn.userId;
        const lobby = findDuplaLobbyForUser(uid);
        if (!lobby) return;
        if (lobby.hostId === uid) {
          // O criador saiu: o lobby é encerrado
          duplaLobbies.delete(uid);
          clearDuplaLobbyCleanup(uid);
          lobby.members.forEach(member => {
            if (member.id !== uid) {
              sendToUser(member.id, {
                type: 'dupla_lobby_left',
                message: 'O criador do lobby saiu. O lobby foi encerrado.'
              });
            }
          });
          return;
        }
        // O convidado saiu: o lobby continua com o criador
        lobby.members = lobby.members.filter(member => member.id !== uid);
        await broadcastDuplaLobby(lobby);
        sendToUser(uid, { type: 'dupla_lobby_left', message: 'Você saiu do lobby da dupla.' });
        return;
      }

      if (data.type === 'dupla_lobby_update') {
        // Criador do lobby alterando nome/cor da dupla em tempo real
        const lobby = duplaLobbies.get(conn.userId);
        if (!lobby) return;
        // O nome da dupla pode ser apagado (fica vazio até o criador definir)
        if (typeof data.teamName === 'string') lobby.teamName = sanitizeTeamName(data.teamName);
        if (data.teamColor) lobby.teamColor = sanitizeTeamColor(data.teamColor);
        if (data.teamColorName) lobby.teamColorName = sanitizeColorName(data.teamColorName);
        await broadcastDuplaLobby(lobby);
        return;
      }

      if (data.type === 'dupla_queue') {
        const uid = conn.userId;
        if (!uid) {
          sendTo(ws, { type: 'dupla_queue_error', error: 'Entre na sua conta para buscar partida.' });
          return;
        }

        removeFromDuplaQueue(ws);

        // Somente o criador do lobby pode colocar a dupla na fila
        const existingLobby = findDuplaLobbyForUser(uid);
        if (existingLobby && existingLobby.hostId !== uid) {
          sendTo(ws, { type: 'dupla_queue_error', error: 'Apenas o criador do lobby pode buscar partida.' });
          return;
        }

        const lobby = existingLobby || await ensureDuplaLobby(uid, data.teamName, data.teamColor, data.teamColorName, ws);

        // O nome enviado pelo criador tem prioridade (evita corrida com a
        // atualização do lobby que acontece enquanto o jogador digita)
        if (typeof data.teamName === 'string') lobby.teamName = sanitizeTeamName(data.teamName);

        // É obrigatório ter um nome registrado para a dupla
        if (!lobby.teamName) {
          sendTo(ws, { type: 'dupla_queue_error', error: 'Informe o nome da dupla antes de buscar partida.' });
          return;
        }

        const members = lobby.members.slice();
        const players = resolveDuplaPlayers(members, uid, ws);
        if (!players.length) {
          sendTo(ws, { type: 'dupla_queue_error', error: 'Não foi possível entrar na fila.' });
          return;
        }

        const entry = {
          ws,
          uid,
          name: conn.name,
          teamName: lobby.teamName,
          teamColor: lobby.teamColor,
          teamColorName: lobby.teamColorName,
          members,
          players
        };
        duplaQueue.push(entry);

        sendTo(ws, {
          type: 'dupla_queued',
          size: players.length,
          message: players.length >= 2
            ? 'Na fila: procurando outra dupla...'
            : 'Na fila: procurando uma dupla adversária...'
        });

        await tryDuplaMatchmaking();
        return;
      }

      if (data.type === 'dupla_leave_queue') {
        removeFromDuplaQueue(ws);
        return;
      }

      if (conn.roomCode === null || conn.playerIdx === null) return;

      // Relay de mensagens de jogo para os outros jogadores da sala
      // (1 vs 1 envia para o oponente; 2 vs 2 envia para todos os demais)
      const room = rooms.get(conn.roomCode);
      if (!room) return;

      const forward = {
        type: data.type,
        from: conn.playerIdx,
        ...data
      };

      const payload = JSON.stringify(forward);
      room.players.forEach(other => {
        if (other && other !== ws && other.readyState === 1) {
          other.send(payload);
        }
      });

      // Eco de confirmação para o remetente (opcional)
      sendTo(ws, { type: 'ack', original: data.type });
    });

    ws.on('close', () => {
      const conn = connections.get(ws);
      const userId = conn ? conn.userId : null;
      // Sai da fila e da sala; quem ficou é notificado
      removeFromQueue(ws);
      removeFromDuplaQueue(ws);
      detachFromRoom(ws);
      connections.delete(ws);
      if (userId) {
        // Se o usuário era o dono de um lobby de dupla, o lobby continua
        // existindo por um tempo (o dono pode recarregar a página):
        // os membros só são avisados e o lobby é dissolvido depois.
        const ownedLobby = duplaLobbies.get(userId);
        if (ownedLobby) {
          const host = ownedLobby.members.find(member => member.id === userId);
          if (host) host.ws = null;
          ownedLobby.members.forEach(member => {
            if (member.id !== userId) {
              sendToUser(member.id, {
                type: 'dupla_lobby_left',
                message: 'O criador do lobby está offline. O lobby será encerrado se ele não voltar.'
              });
            }
          });
          scheduleDuplaLobbyCleanup(userId);
        }
        // O membro que saiu continua no lobby, mas marcado como offline
        duplaLobbies.forEach(lobby => {
          const member = lobby.members.find(entry => entry.id === userId);
          if (!member) return;
          member.ws = null;
          broadcastDuplaLobby(lobby).catch(() => {});
        });

        untrackUserConnection(ws, userId);
        // Só envia offline se não houver mais conexões para este usuário
        const remaining = userConnections.get(userId);
        if (!remaining || remaining.size === 0) {
          broadcastUserStatus(userId, false);
        }
      }
    });

    ws.on('error', () => {});
  });

  server.listen(PORT, HOST, () => {
    if (NODE_ENV === 'production' && !process.env.DATABASE_URL) {
      console.warn('AVISO: DATABASE_URL não definido. Os dados serão armazenados em arquivos JSON locais e serão perdidos a cada deploy no Render.');
    }
    console.log(`LUUD Node.js rodando em http://${HOST}:${PORT}`);
    console.log(GOOGLE_CLIENT_ID ? 'Login Google configurado.' : 'Login Google aguardando GOOGLE_CLIENT_ID no arquivo .env.');
    console.log(db.useDatabase() ? `Banco de dados: PostgreSQL (DATABASE_URL)` : `Banco de dados: arquivos JSON locais`);
  });
}

main().catch(error => {
  console.error('Erro ao iniciar o servidor:', error);
  process.exit(1);
});
