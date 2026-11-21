'use strict';

const http = require('http');
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const pix = require('./pix');
const rules = require('./game-rules');
const league = require('./league');
const rewards = require('./rewards');
const season = require('./season');
const shop = require('./shop');
const versions = require('./versions');
const tournaments = require('./tournaments');
const namePolicy = require('./name-policy');

const PUBLIC_DIR = path.join(__dirname, 'public');

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const NODE_ENV = process.env.NODE_ENV || 'development';
const COOKIE_NAME = 'luud_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

// CSRF tokens por sessão (em memória)
const csrfTokens = new Map();

// Rate limiting HTTP por IP
const httpRateLimits = new Map();
const HTTP_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto
const HTTP_RATE_LIMIT_MAX_REQUESTS = 120; // 120 req/min por IP

// Jogadores ausentes em partidas online (key: roomCode): aguardam o
// take-over durante TAKEOVER_WINDOW_MS antes do abandono definitivo
const absentPlayers = new Map();

// Limpeza periódica de mapas antigos (evita memory leak)
setInterval(() => {
  const now = Date.now();
  // CSRF tokens antigos (> 1 hora)
  for (const [token, { createdAt }] of csrfTokens) {
    if (now - createdAt > 60 * 60 * 1000) csrfTokens.delete(token);
  }
  // Rate limits HTTP antigos (> 5 minutos)
  for (const [ip, { windowStart }] of httpRateLimits) {
    if (now - windowStart > 5 * 60 * 1000) httpRateLimits.delete(ip);
  }
  // absentPlayers órfãos (timers já dispararam mas mapa não limpo)
  for (const [absenceKey, data] of absentPlayers) {
    if (data.timer && data.timer._destroyed) {
      // Timer já executou, limpar entrada órfã
      absentPlayers.delete(absenceKey);
    }
  }
  // Convites de dupla/lobby expirados (sem resposta em 10 minutos)
  const INVITE_TTL_MS = 10 * 60 * 1000;
  for (const invites of [duplaPendingInvites, lobbyPendingInvites]) {
    for (const [inviteId, invite] of invites) {
      if (invite.createdAt && Date.now() - invite.createdAt > INVITE_TTL_MS) {
        invites.delete(inviteId);
      }
    }
  }
}, 5 * 60 * 1000); // A cada 5 minutos

/* -------------------------------------------------------------
   PROVA SOCIAL (roadmap #25)
   Contadores públicos (partidas jogadas, contas criadas, jogadores
   online agora) e depoimentos exibidos na tela inicial.

   ATENÇÃO: os depoimentos abaixo são textos de exemplo. Troque-os
   pelos depoimentos reais dos jogadores (ou esvazie a lista para
   esconder o bloco de depoimentos na tela inicial).
------------------------------------------------------------- */
const SOCIAL_TESTIMONIALS = [
  {
    quote: 'Jogo uma partida no intervalo do trabalho. É rápido e dá vontade de jogar mais uma.',
    author: 'Jogadora de DUPLA'
  },
  {
    quote: 'O link de convite salvou a gente: só mandei no WhatsApp e meu amigo entrou direto na sala.',
    author: 'Jogador de TORNEIO'
  },
  {
    quote: 'A cada partida eu subo de tier na Liga. Já conquerri a table com meus amigos.',
    author: 'Jogador de LIGA'
  }
];

// Jogadores conectados agora (contas únicas + visitantes sem conta)
function countOnlinePlayers() {
  const users = new Set();
  let anonymous = 0;
  for (const conn of connections.values()) {
    if (conn && conn.userId) users.add(conn.userId);
    else anonymous += 1;
  }
  return users.size + anonymous;
}

// API pública da prova social (não exige login)
async function handleSocialStats(request, response) {
  let matches = 0;
  let players = 0;
  try {
    matches = await db.countMatchRecords();
  } catch (error) {
    console.error('[prova social] erro ao contar as partidas:', error && error.message);
  }
  try {
    players = await db.countRegisteredPlayers();
  } catch (error) {
    console.error('[prova social] erro ao contar os jogadores:', error && error.message);
  }

  sendJson(response, 200, {
    matches,
    players,
    online: countOnlinePlayers(),
    testimonials: SOCIAL_TESTIMONIALS
  });
}

/* -------------------------------------------------------------
   CONTA PREMIUM (pagamento único via Pix, acesso vitalício)
------------------------------------------------------------- */
const PREMIUM_PLAN_NAME = process.env.PREMIUM_PLAN_NAME || 'Conta Premium';
const PREMIUM_PRICE_BRL = Number(process.env.PREMIUM_PRICE_BRL || 19.90);
const PREMIUM_CURRENCY = 'BRL';
const PREMIUM_TRIAL_NOTE = 'Acesso vitalício e sem mensalidades';

/* -------------------------------------------------------------
   BENEFÍCIOS CONCRETOS DO PREMIUM (roadmap #20)
   A lista precisa falar a língua do jogador: o que muda na
   prática quando ele assina. Cada item existe de verdade no
   jogo — nada de promessa que o produto não entregue.
   ------------------------------------------------------------- */
const PREMIUM_BENEFIT_GROUPS = [
  {
    icon: '⭐',
    title: 'EVOLUIR MAIS RÁPIDO',
    items: [
      'Dobro de XP no Passe de Temporada',
      'Trilha PREMIUM do Passe: 30 níveis com moedas e boosters',
      'Baú diário com mais XP em toda partida'
    ]
  },
  {
    icon: '🏆',
    title: 'COMPETIR DE VERDADE',
    items: [
      'Liga completa: partidas classificativas, tier e ranking',
      'Torneios com horário marcado com premiação em dobro',
      'Selo PREMIUM no perfil, no placar e na Liga'
    ]
  },
  {
    icon: '🎨',
    title: 'SEU JEITO DE JOGAR',
    items: [
      'Cores exclusivas: 3 cores no perfil + cores personalizadas',
      'Nickname editável a qualquer momento',
      'Histórico completo: todas as suas partidas, sem prazo'
    ]
  },
  {
    icon: '💳',
    title: 'SEM DOR DE CABEÇA',
    items: [
      'Sem anúncios: jogue sem interrupções',
      'Pagamento único via Pix: acesso vitalício',
      'Sem mensalidade e sem cobrança recorrente'
    ]
  }
];

// Lista plana (usada nos resumos curtos do perfil e do checkout)
const PREMIUM_BENEFITS = PREMIUM_BENEFIT_GROUPS.reduce(
  (all, group) => all.concat(group.items),
  []
);

/* Desconto temporário do plano Premium (até o fim do ano).
   O preço normal continua sendo exibido (riscado) ao lado do preço
   promocional, que é o valor efetivamente cobrado. */
const PREMIUM_PROMO_UNTIL_DEFAULT = (() => {
  const year = new Date().getFullYear();
  // 31 de dezembro do ano corrente, às 23:59:59 (UTC)
  return new Date(Date.UTC(year, 11, 31, 23, 59, 59)).toISOString();
})();
const PREMIUM_PROMO_PRICE_BRL = Number(process.env.PREMIUM_PROMO_PRICE_BRL || 9.90);
const PREMIUM_PROMO_UNTIL = process.env.PREMIUM_PROMO_UNTIL || PREMIUM_PROMO_UNTIL_DEFAULT;
const PREMIUM_PROMO_LABEL = process.env.PREMIUM_PROMO_LABEL || 'Desconto temporário';

// Gateway de pagamento: 'mercadopago' | 'pixkey' | 'stub'
// - mercadopago: QR Code oficial e confirmação automática (webhook)
// - pixkey:      BR Code gerado com a chave Pix do próprio projeto.
//                Não existe gateway para avisar o servidor, então a
//                confirmação do pagamento é manual (PREMIUM_ADMIN_TOKEN).
// - stub:        simulação de teste (nunca funciona em produção)
const PIX_GATEWAY = (process.env.PIX_GATEWAY || (NODE_ENV === 'production' ? '' : 'stub')).trim().toLowerCase();
const PIX_API_TOKEN = process.env.PIX_API_TOKEN || '';
const PIX_WEBHOOK_SECRET = process.env.PIX_WEBHOOK_SECRET || '';
const PIX_KEY = process.env.PIX_KEY || '';
const PIX_MERCHANT_NAME = process.env.PIX_MERCHANT_NAME || 'LUUD';
const PIX_MERCHANT_CITY = process.env.PIX_MERCHANT_CITY || 'SAO PAULO';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PAYMENT_EXPIRY_MINUTES = Number(process.env.PAYMENT_EXPIRY_MINUTES || 30);
// Token do administrador: confirma manualmente o pagamento quando o gateway
// não avisa o servidor (modo 'pixkey'). Sem esse token a rota fica desativada.
const PREMIUM_ADMIN_TOKEN = String(process.env.PREMIUM_ADMIN_TOKEN || '').trim();

// Avisos de configuração do Mercado Pago (não derrubam o servidor)
if (PIX_GATEWAY === 'mercadopago') {
  if (!PIX_API_TOKEN) {
    console.warn('[premium] PIX_API_TOKEN não configurado: o checkout do Premium ficará indisponível.');
  }
  if (!PIX_WEBHOOK_SECRET) {
    console.warn('[premium] PIX_WEBHOOK_SECRET não configurado: webhooks sem assinatura serão aceitos (o pagamento ainda é conferido no gateway).');
  }
}

/* -------------------------------------------------------------
   SALAS DE JOGO ONLINE (multiplayer entre computadores)
   - O servidor guarda o estado autoritativo da partida (turno, dado,
     posições das peças e placar) em room.game.
   - O cliente só pede "rolar" e informa qual peça escolheu: qualquer
     valor, posição ou turno enviado pelo cliente é ignorado.
------------------------------------------------------------- */
// roomCode -> { players: [ws, ws], names: [str, str], userIds: [uid, uid], ready: [bool, bool], game: {...} }
const rooms = new Map();
// Conexões ativas: ws -> { roomCode, playerIdx, userId, name }
const connections = new Map();
// Conexões por usuário: userId -> Set<ws> (para notificações em tempo real)
const userConnections = new Map();
// Fila do Jogo Rápido: [{ ws, uid, name }]
const matchmakingQueue = [];
// Sala atual de cada usuário autenticado: userId -> roomCode
const userRoom = new Map();

/* -------------------------------------------------------------
   PROTEÇÃO CONTRA QUEBRA (anti-cheat)
   - Limite de mensagens por conexão (evita spam e inundação do log)
   - Tempo máximo de turno (o servidor passa a vez se o jogador sumir)
   - Log de mensagens rejeitadas para detectar tentativas de manipulação
------------------------------------------------------------- */
const RATE_LIMIT_WINDOW_MS = 10 * 1000;
const RATE_LIMIT_MAX_MESSAGES = 60;
const ROOM_TURN_TIMEOUT_MS = 30 * 1000;
// Tempo máximo de turno para partidas classificatorias da Liga (mais curto)
const LEAGUE_TURN_TIMEOUT_MS = 10 * 1000;
// Janela de graça depois que o relógio do turno acaba: quando o tempo do
// jogador acaba, o cliente liga o modo AUTOMÁTICO e a jogada da CPU chega
// logo em seguida (o relógio do cliente roda um pouco atrasado em relação
// ao do servidor, por causa da latência da rede). Sem essa janela, o
// servidor passaria a vez antes de a jogada automática chegar.
const TURN_GRACE_MS = 5 * 1000;
// Janela para o jogador autenticado reconectar e retomar a partida
// (take-over) antes de ser declarado como abandono definitivo
const TAKEOVER_WINDOW_MS = 60 * 1000;
// Tempo que o bot "pensa" antes de jogar o turno dele (roadmap #12)
const BOT_THINK_MS = 1200;
// Mensagens que o cliente NÃO pode mais enviar: o dado, o movimento e a
// passagem de turno são decididos pelo servidor.
const FORBIDDEN_CLIENT_MESSAGES = new Set(['dice_roll', 'token_move', 'pass_turn']);
// Único tipo de mensagem que ainda é repassada pela sala.
const RELAYABLE_ROOM_MESSAGES = new Set(['color_info']);
// Cores dos slots no 1 vs 1 (diagonais, como no tabuleiro)
const SOLO_SLOT_COLORS = ['BLUE', 'GREEN'];

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

/* -------------------------------------------------------------
   LOBBIES ONLINE (arena e partida normal)
   O lobby fica no servidor: quem cria é o host (dono) e os amigos
   entram depois de aceitar o convite.
   - kind 'arena': até 4 jogadores no lobby, partida com 4 jogadores
     (cada um por si, ninguém divide tabuleiro com ninguém);
   - kind 'normal': até 2 jogadores no lobby, partida 1 vs 1.
   A fila é por jogador: a partida começa quando a fila completa.
------------------------------------------------------------- */
const LOBBY_KINDS = {
  arena: {
    maxMembers: 4,
    matchSize: 4,
    label: 'ARENA',
    matchTypeLabel: 'ARENA • Cada um por si'
  },
  normal: {
    maxMembers: 2,
    matchSize: 2,
    label: 'NORMAL',
    matchTypeLabel: 'NORMAL • 1 vs 1'
  }
};
// Cores dos slots da arena (mesma ordem horária do tabuleiro)
const ARENA_SLOT_COLORS = ['BLUE', 'RED', 'GREEN', 'YELLOW'];
// "kind:hostUid" -> { hostId, kind, members: [{ id, name, picture, playerName, ws }] }
const onlineLobbies = new Map();
// Convites pendentes: inviteId -> { id, fromUid, toUid, kind, createdAt }
const lobbyPendingInvites = new Map();
// Fila de busca por tipo de lobby: [{ ws, uid, name, picture }] (uma entrada por jogador)
const lobbyQueues = { arena: [], normal: [] };
// Limpeza dos lobbies cujo dono ficou offline: "kind:hostUid" -> timeout
const lobbyCleanupTimers = new Map();

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

/* -------------------------------------------------------------
   BOT SUBSTITUI QUEM ABANDONA (roadmap #12)
   Em partidas com mais de 2 jogadores (arena e dupla), quem sai
   não encerra a partida: um bot controlado pelo servidor assume
   o slot e joga normalmente, para que os demais não fiquem
   parados esperando.
------------------------------------------------------------- */

// Modos em que o abandono vira bot (partidas com 3 ou 4 jogadores)
function modeSupportsBotTakeover(room) {
  if (!room) return false;
  return room.mode === 'arena' || room.mode === 'dupla';
}

// O slot está sendo jogado por um bot?
function isBotSlot(room, slot) {
  if (!room || !Array.isArray(room.botSlots)) return false;
  return room.botSlots.includes(Number(slot));
}

// Instala um bot no slot abandonado e avisa a sala
function installBotForSlot(room, playerIdx, leftName) {
  if (!room || !room.game) return false;
  const slot = Number(playerIdx);
  if (!Number.isInteger(slot)) return false;
  if (isBotSlot(room, slot)) return false;
  if (!Array.isArray(room.botSlots)) room.botSlots = [];

  const state = room.game;
  const color = rules.colorOfSlot(state, slot);
  room.botSlots.push(slot);

  // Nome do bot no placar: mantém o nome do jogador que saiu para
  // o placar não ficar com um espaço vazio
  const baseName = leftName || (room.botSourceNames || [])[slot] || '';
  const botName = baseName ? `CPU (${baseName})` : 'CPU';
  if (!Array.isArray(room.botNames)) room.botNames = [];
  room.botNames[slot] = botName;

  console.log(`[bot] sala ${room.code || ''} slot=${slot} assumiu a partida (${botName})`);

  broadcastRoomGame(room, {
    type: 'bot_takeover',
    slot,
    color,
    name: botName,
    leftName: baseName || null,
    mode: room.mode
  });

  // Se a vez é do bot agora, o servidor joga por ele
  if (Number(state.turn) === slot) {
    startRoomTurnTimer(room);
  }
  return true;
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
    if (set.size === 0) {
      userConnections.delete(userId);
      // Não remove userRoom se o usuário está em uma partida que pode ser retomada via take-over
      const estaEmPartidaParaTakeover = Array.from(absentPlayers.values()).some(
        entry => entry.userId === userId
      );
      if (!estaEmPartidaParaTakeover) {
        userRoom.delete(userId);
      }
    }
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
 * Otimizado: usa apenas conexões autenticadas.
 */
function broadcastUserStatus(userId, online) {
  const payload = JSON.stringify({
    type: online ? 'user_online' : 'user_offline',
    userId
  });
  for (const [ws, conn] of connections) {
    if (conn.authenticated && ws.readyState === 1) {
      ws.send(payload);
    }
  }
}

// Retira a conexão da sala atual, avisando quem ficou nela e
// removendo a sala quando fica vazia.
// Para usuários autenticados, o slot não é limpo imediatamente: o jogador
// é marcado como ausente para permitir take-over em outro dispositivo
// (ex.: começa no desktop, continua no celular). Se não retornar dentro
// do TAKEOVER_WINDOW_MS, o abandono é aplicado.
function detachFromRoom(ws, notifyOpponent = true) {
  const conn = connections.get(ws);
  if (!conn || !conn.roomCode) return;

  const roomCode = conn.roomCode;
  const playerIdx = conn.playerIdx;
  const userId = conn.userId;
  conn.roomCode = null;
  conn.playerIdx = null;

  const room = rooms.get(roomCode);
  if (!room || room.players[playerIdx] !== ws) return;

  // Para usuários autenticados, não limpa o slot imediatamente:
  // marca o jogador como ausente para permitir take-over.
  if (userId) {
    // Cancela timer de abandono anterior para este slot (se houver).
    // A chave inclui o slot: em salas com 2+ humanos (dupla/arena), dois
    // jogadores podem estar ausentes ao mesmo tempo — uma chave única por
    // sala fazia o 2º registro sobrescrever o 1º (e o timer do 1º apagar
    // a entrada do 2º antes da hora).
    const absenceKey = `${roomCode}:${playerIdx}`;
    const existing = absentPlayers.get(absenceKey);
    if (existing) {
      clearTimeout(existing.timer);
      absentPlayers.delete(absenceKey);
    }

    // Mantém o userId no slot para que o take-over possa reanexar o jogador
    room.players[playerIdx] = null;
    // Guarda o nome de quem saiu: se um bot assumir o slot, o placar
    // mostra "CPU (nome)" em vez de um espaço vazio
    if (!Array.isArray(room.botSourceNames)) room.botSourceNames = [];
    room.botSourceNames[playerIdx] = room.names[playerIdx] || conn.name || null;
    room.names[playerIdx] = null;
    room.ready[playerIdx] = false;
    // room.userIds[playerIdx] continua = userId (slot reservado)

    // O abandono (W.O. na Liga/Arena, desistência no 1x1) só é aplicado
    // DEPOIS da janela de reconexão: enquanto o jogador pode voltar, a
    // vaga continua reservada e a partida não é encerrada.
    const abandonAt = Date.now() + TAKEOVER_WINDOW_MS;
    const timer = setTimeout(() => {
      absentPlayers.delete(absenceKey);
      userRoom.delete(userId);

      // A janela de reconexão acabou: agora o abandono é definitivo
      let botTookOver = false;
      if (room.game && room.game.started && !room.game.over) {
        if (modeSupportsBotTakeover(room)) {
          // Arena/dupla: um bot assume o slot e a partida continua
          installBotForSlot(room, playerIdx);
          botTookOver = true;
        } else if (room.mode === 'liga') {
          applyLeagueAbandonResult(room, playerIdx);
        } else if (room.mode === 'tournament') {
          // Torneio: quem ficou vence por desistência e avança na chave
          applyTournamentAbandonResult(room, playerIdx);
        } else if (room.mode === 'solo' || room.mode === 'quick') {
          // 1x1: quem ficou vence por desistência
          room.game.over = true;
          room.game.winner = otherPlayerIndex(playerIdx);
          clearRoomTurnTimer(room);
        }
      }

      room.userIds[playerIdx] = null;
      if (!botTookOver) {
        room.players.forEach(other => {
          if (other && other.readyState === 1) {
            sendTo(other, { type: 'opponent_left', playerIdx, reason: 'abandon' });
          }
        });
      }

      // Avisa a sala de que a partida acabou por abandono (1x1 e Liga)
      if (room.game && room.game.over) {
        broadcastRoomGame(room, {
          type: 'match_finished',
          over: true,
          winner: room.game.winner,
          scores: room.game.scores,
          reason: 'abandon',
          playerIdx
        });
      }

      if (!room.players.some(player => player) && !botTookOver) {
        clearRoomTurnTimer(room);
        rooms.delete(roomCode);
      } else if (room.game && room.game.started && !room.game.over) {
        // A partida continua (dupla 2x2 ou bot no lugar do ausente):
        // o relógio do turno volta a correr
        startRoomTurnTimer(room);
      }
    }, TAKEOVER_WINDOW_MS);

    absentPlayers.set(absenceKey, { roomCode, playerIdx, userId, abandonAt, timer });

    if (notifyOpponent) {
      room.players.forEach(other => {
        if (other && other !== ws && other.readyState === 1) {
          sendTo(other, {
            type: 'opponent_offline',
            playerIdx,
            userId,
            canTakeover: true,
            room: roomCode,
            mode: room.mode
          });
        }
      });
    }

    // Reinicia o timer de turno se a partida já começou e ainda está ativa
    if (room.game && room.game.started && !room.game.over) {
      startRoomTurnTimer(room);
    }

    // Não remove o rastreamento de userRoom: o usuário ainda tem uma sala
    // em andamento que pode ser retomada em outro dispositivo.
    return;
  }

  // Usuário não autenticado: comportamento original (limpa o slot)
  room.players[playerIdx] = null;
  room.names[playerIdx] = null;
  room.userIds[playerIdx] = null;
  room.ready[playerIdx] = false;

  if (notifyOpponent) {
    room.players.forEach(other => {
      if (other && other !== ws && other.readyState === 1) {
        sendTo(other, { type: 'opponent_disconnected' });
      }
    });
  }

  if (!room.players.some(player => player)) {
    clearRoomTurnTimer(room);
    rooms.delete(roomCode);
  }
}

/* -------------------------------------------------------------
   PARTIDA ONLINE AUTORITATIVA
   O servidor guarda o estado real da partida (turno, dado, posições
   das peças e placar) e decide tudo. O cliente só recebe o que
   aconteceu: ele pede para rolar e informa qual peça escolheu.
------------------------------------------------------------- */

// Envia uma mensagem para todos os jogadores da sala
function broadcastRoomGame(room, message) {
  const payload = JSON.stringify(message);
  room.players.forEach(player => {
    if (player && player.readyState === 1) player.send(payload);
  });
}

// Cria (ou recria) o estado autoritativo da sala
function setupRoomGame(room, options = {}) {
  const slots = options.slots || [];
  // Guarda a configuração de slots: a revanche remonta a MESMA mesa
  // (mesmas cores e times) sem recalcular nada no cliente.
  room.slotConfig = slots.map(entry => ({ ...entry }));
  room.game = rules.createGameState({
    slots,
    mode: options.mode || room.mode || 'solo',
    target: options.target || (options.mode === 'dupla' ? 8 : 4)
  });
  room.slotColors = slots.map(entry => entry.color);
  // Contador de capturas por slot (usado pelas missões do jogador)
  room.captures = slots.map(() => 0);
  // O relógio do turno só começa a contar quando os clientes avisam que a
  // partida começou (ver handleGameStart).
  room.game.started = false;
  return room.game;
}

/* -------------------------------------------------------------
   RECONEXÃO TRANSPARENTE (take-over)
   O estado da partida mora no servidor. Quando a conexão cai, o
   slot do jogador fica reservado por TAKEOVER_WINDOW_MS: ao voltar
   (mesma aba, outro dispositivo ou recarregando a página), o cliente
   recebe um snapshot completo e continua de onde parou.
------------------------------------------------------------- */

// Snapshot do estado da sala enviado ao jogador que reconectou
function buildRoomSnapshot(room, playerIdx) {
  const state = room.game;
  const legal = (state && state.dice !== null && Number(state.turn) === Number(playerIdx))
    ? rules.validTokenIndices(state, playerIdx, state.dice)
    : [];

  const teamColors = room.teamColors || {};
  const players = (room.names || []).map((name, idx) => {
    const team = (room.teams || [])[idx];
    const teamInfo = teamColors[team] || null;
    const bot = isBotSlot(room, idx);
    const botName = (room.botNames || [])[idx] || 'CPU';
    return {
      id: idx,
      uid: (room.userIds || [])[idx] || null,
      name: bot ? botName : (name || null),
      playerName: bot ? botName : (name || null),
      team,
      teamName: teamInfo ? teamInfo.teamName : null,
      teamColor: teamInfo ? teamInfo.hex : null,
      teamColorName: teamInfo ? teamInfo.name : null,
      color: (room.slotColorInfo || [])[idx] || null,
      isBot: bot
    };
  });

  return {
    type: 'game_state',
    room: room.code,
    player: playerIdx,
    mode: room.mode,
    slotColors: Array.isArray(room.slotColors) ? room.slotColors.slice() : [],
    players,
    turn: state.turn,
    dice: state.dice,
    sixes: state.sixes,
    tokens: state.tokens,
    scores: state.scores,
    over: state.over,
    winner: state.winner,
    target: state.target,
    legal,
    started: state.started,
    botSlots: Array.isArray(room.botSlots) ? room.botSlots.slice() : [],
    // Capturas acumuladas por slot (missões do jogador): o contador é do
    // servidor, então não se perde quando o jogador reconecta
    captures: Array.isArray(room.captures) ? room.captures.slice() : []
  };
}

// Reanexa o jogador à sala (take-over) e devolve o estado atual da partida
function attachPlayerToRoom(ws, conn, room, playerIdx, userId) {
  // Reentrada no próprio slot cancela a contagem de abandono
  const absenceKey = `${room.code}:${playerIdx}`;
  const absence = absentPlayers.get(absenceKey);
  if (absence) {
    clearTimeout(absence.timer);
    absentPlayers.delete(absenceKey);
  }

  room.players[playerIdx] = ws;
  room.ready[playerIdx] = true;
  if (!room.names[playerIdx]) room.names[playerIdx] = conn.name || `Jogador ${playerIdx + 1}`;
  conn.roomCode = room.code;
  conn.playerIdx = playerIdx;
  if (userId) {
    conn.userId = userId;
    room.userIds[playerIdx] = userId;
    userRoom.set(userId, room.code);
  }

  // O relógio do turno volta a correr para quem voltou
  if (room.game && room.game.started && !room.game.over) {
    startRoomTurnTimer(room);
  }

  // Avisa o oponente que o jogador voltou
  broadcastRoom(room.code, { type: 'opponent_reconnected', playerIdx }, ws);

  // Estado completo para o cliente que reconectou
  sendTo(ws, buildRoomSnapshot(room, playerIdx));
  return true;
}

// Tenta retomar a partida em que o usuário estava antes da queda
function tryResumeRoomForUser(ws, conn, userId) {
  if (!userId || !conn) return false;
  if (conn.roomCode) return false; // já está numa sala

  const roomCode = userRoom.get(userId);
  if (!roomCode) return false;

  const room = rooms.get(roomCode);
  if (!room || !room.game) {
    userRoom.delete(userId);
    return false;
  }

  const playerIdx = (room.userIds || []).indexOf(userId);
  if (playerIdx === -1) {
    userRoom.delete(userId);
    return false;
  }

  if (room.game.over) {
    sendTo(ws, { type: 'game_unavailable', reason: 'finished', room: roomCode });
    return false;
  }

  // Outro dispositivo/aba do MESMO jogador ainda ocupa o slot: não rouba
  // a vaga (duas abas jogando o mesmo turno causa jogadas conflitantes).
  const current = room.players[playerIdx];
  if (current && current !== ws && current.readyState === 1) {
    // A conexão antiga pode estar apenas fechando (recarga da página):
    // espera alguns instantes e tenta de novo antes de desistir.
    setTimeout(() => {
      if (!ws || ws.readyState !== 1) return;
      const holder = room.players[playerIdx];
      if (holder && holder !== ws && holder.readyState === 1) {
        sendTo(ws, { type: 'game_unavailable', reason: 'active_elsewhere', room: roomCode });
        return;
      }
      tryResumeRoomForUser(ws, conn, userId);
    }, 2500);
    return false;
  }

  return attachPlayerToRoom(ws, conn, room, playerIdx, userId);
}

// Relógio do turno: se o jogador não agir a tempo, o servidor passa a vez
function clearRoomTurnTimer(room) {
  if (room && room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function startRoomTurnTimer(room) {
  clearRoomTurnTimer(room);
  clearBotTurnTimer(room);
  if (!room || !room.game || room.game.over) return;
  if (!room.game.started) return;

  // Vez do bot: o servidor joga por ele (sem relógio de turno humano)
  const turnSlot = Number(room.game.turn);
  if (isBotSlot(room, turnSlot)) {
    scheduleBotTurn(room, turnSlot);
    return;
  }

  // Cada fase do turno (sortear o dado, escolher a peça) começa com a
  // janela de graça disponível
  room.graceUsed = false;

  // Partidas da Liga usam um tempo de turno mais curto (10 segundos)
  const turnTimeout = room.mode === 'liga' ? LEAGUE_TURN_TIMEOUT_MS : ROOM_TURN_TIMEOUT_MS;

  console.log(`[timer] sala ${room.code || ''} mode=${room.mode} turnTimeout=${turnTimeout / 1000}s`);

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    const state = room.game;
    if (!state || state.over) return;

    const slot = state.turn;

    // Janela de graça: o tempo do jogador acabou no cliente (que liga o
    // automático para a CPU jogar por ele) e a jogada está a caminho.
    // Espera alguns instantes antes de passar a vez.
    if (!room.graceUsed) {
      room.graceUsed = true;
      room.turnTimer = setTimeout(() => passTurnAfterTimeout(room, slot), TURN_GRACE_MS);
      return;
    }

    passTurnAfterTimeout(room, slot);
  }, turnTimeout);
}

/* -------------------------------------------------------------
   TURNO DO BOT (roadmap #12)
   O bot joga com as mesmas regras do servidor: sorteia o dado,
   escolhe a melhor peça e a jogada é aplicada e transmitida
   exatamente como a de um jogador humano.
------------------------------------------------------------- */

function clearBotTurnTimer(room) {
  if (room && room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

// Agenda a jogada do bot (ele "pensa" por um instante antes de rolar)
function scheduleBotTurn(room, slot) {
  clearBotTurnTimer(room);
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    runBotTurn(room, slot);
  }, BOT_THINK_MS);
}

// O bot joga o turno dele
function runBotTurn(room, slot) {
  const state = room.game;
  if (!state || state.over || !state.started) return;
  if (Number(state.turn) !== Number(slot) || !isBotSlot(room, slot)) return;
  if (state.dice !== null) return; // o dado já foi sorteado neste turno

  const result = rules.rollForTurn(state, slot);
  if (!result) return;

  broadcastRoomGame(room, {
    type: 'dice_rolled',
    slot,
    value: result.value,
    sixes: result.sixes,
    turn: slot,
    legal: result.legal,
    bot: true
  });

  if (result.turnPassed) {
    // 3 seis seguidos ou nenhum movimento possível: a vez passa
    broadcastRoomGame(room, {
      type: 'turn_passed',
      slot,
      reason: result.reason,
      turn: result.turn,
      scores: state.scores,
      bot: true
    });
    if (!state.over) startRoomTurnTimer(room);
    return;
  }

  const tokenIdx = rules.chooseBotTokenIndex(state, slot, result.value);
  if (!Number.isInteger(tokenIdx) || tokenIdx < 0) {
    // Sem jogada possível (não deveria acontecer): passa a vez
    state.dice = null;
    state.sixes = 0;
    state.turn = rules.nextSlot(state, slot);
    broadcastRoomGame(room, {
      type: 'turn_passed',
      slot,
      reason: 'no_move',
      turn: state.turn,
      scores: state.scores,
      bot: true
    });
    if (!state.over) startRoomTurnTimer(room);
    return;
  }

  applyRoomMove(room, slot, tokenIdx, { bot: true });
}

// Passa a vez do jogador que deixou o tempo acabar (chamado depois da
// janela de graça, quando nenhuma jogada chegou)
function passTurnAfterTimeout(room, slot) {
  const state = room.game;
  if (!state || state.over) return;
  if (Number(state.turn) !== Number(slot)) return; // o turno já mudou

  state.dice = null;
  state.sixes = 0;
  const next = rules.nextSlot(state, slot);
  state.turn = next;

  console.warn(`[anti-cheat] tempo do turno esgotado - sala ${room.code || ''} slot=${slot}`);
  broadcastRoomGame(room, {
    type: 'turn_passed',
    slot,
    reason: 'timeout',
    turn: next,
    scores: state.scores
  });
  startRoomTurnTimer(room);
}

// Passa a vez do jogador que deixou o tempo acabar (chamado depois da
// janela de graça, quando nenhuma jogada chegou)

// Registro das mensagens rejeitadas (tentativas de manipulação)
function logRejectedMessage(conn, type, reason) {
  const userId = conn && conn.userId ? conn.userId : 'anônimo';
  console.warn(`[anti-cheat] mensagem rejeitada: tipo=${type} jogador=${userId} motivo=${reason}`);
}

function rejectClientMessage(ws, conn, type, reason, room) {
  logRejectedMessage(conn, type, reason);
  const payload = { type: 'game_rejected', action: type, reason };
  // Devolve o turno autoritativo para que o cliente se sincronize de novo
  if (room && room.game && Number.isInteger(Number(room.game.turn))) {
    payload.turn = room.game.turn;
    payload.scores = room.game.scores;
  }
  sendTo(ws, payload);
}

// Limite de mensagens por conexão (anti-spam)
function allowMessageByRate(conn) {
  const now = Date.now();
  if (!conn.rateWindow || now - conn.rateWindow.startedAt > RATE_LIMIT_WINDOW_MS) {
    conn.rateWindow = { startedAt: now, count: 0 };
  }
  conn.rateWindow.count++;
  return conn.rateWindow.count <= RATE_LIMIT_MAX_MESSAGES;
}

/**
 * Aviso de que a partida começou no cliente. O relógio do turno do servidor
 * só começa a contar a partir daqui (a contagem regressiva que antecede a
 * partida não pode consumir o tempo do primeiro jogador).
 * A mensagem é aceita apenas uma vez por sala.
 */
function handleGameStart(ws, conn, room) {
  const state = room.game;
  if (!state) return;
  if (state.started) return;
  state.started = true;
  startRoomTurnTimer(room);
}

/**
 * Pedido de rolar o dado. O valor é sorteado pelo servidor.
 */
function handleRollRequest(ws, conn, room) {
  const state = room.game;
  const slot = Number(conn.playerIdx);

  if (!state) {
    rejectClientMessage(ws, conn, 'roll_request', 'Partida não encontrada.', room);
    return;
  }
  if (state.over) {
    rejectClientMessage(ws, conn, 'roll_request', 'A partida já terminou.', room);
    return;
  }
  // Defesa: a rolagem é possível mesmo sem 'game_start' (mensagem enviada
  // pelo cliente). Se nenhum cliente avisou que a partida começou, arma o
  // relógio aqui — o limite de tempo do turno nunca pode ficar inerte.
  if (!state.started) {
    state.started = true;
    startRoomTurnTimer(room);
  }
  if (state.turn !== slot) {
    rejectClientMessage(ws, conn, 'roll_request', 'Não é a vez deste jogador.', room);
    return;
  }
  if (state.dice !== null) {
    rejectClientMessage(ws, conn, 'roll_request', 'O dado já foi sorteado neste turno.', room);
    return;
  }

  // O sorteio e as regras de turno (3 seis, fim de turno sem movimento)
  // ficam no módulo de regras: o servidor é a única fonte da verdade.
  const result = rules.rollForTurn(state, slot);
  if (!result) {
    rejectClientMessage(ws, conn, 'roll_request', 'Não foi possível sortear o dado.', room);
    return;
  }

  broadcastRoomGame(room, {
    type: 'dice_rolled',
    slot,
    value: result.value,
    sixes: result.sixes,
    turn: slot,
    legal: result.legal
  });

  if (result.turnPassed) {
    // 3 seis seguidos ou nenhum movimento possível: o turno passa
    broadcastRoomGame(room, {
      type: 'turn_passed',
      slot,
      reason: result.reason,
      turn: result.turn,
      scores: state.scores
    });
  }

  startRoomTurnTimer(room);
}

/* -------------------------------------------------------------
   LIGA (tiers, pontuação e promoção)
   O servidor é a fonte da verdade da classificação: os pontos de
   cada partida e a progressão de tier são calculados aqui, a
   partir do placar oficial da partida.
   ------------------------------------------------------------- */

// Tier S -> SS: além dos 100 pontos é preciso estar entre os 100
// melhores jogadores do tier S (o ranking é do próprio tier).
async function refreshLeaguePromotion(userId, standing) {
  if (!standing || standing.tier !== 'S' || !standing.promotionPending) return standing;
  try {
    const rank = await db.getLeagueTierRank(userId, 'S');
    if (rank && rank <= league.SS_RANKING_SIZE) {
      return await db.saveLeagueStanding(userId, {
        ...standing,
        tier: 'SS',
        points: 0,
        promotionPending: false
      });
    }
  } catch (error) {
    console.error('[liga] erro ao calcular o ranking do tier S:', error && error.message);
  }
  return standing;
}

// Classificação atual do jogador na Liga (cria no tier F se for a primeira vez)
async function getLeagueStandingFor(userId) {
  if (!userId) return null;
  try {
    const standing = await db.ensureLeagueStanding(userId);
    if (!standing) return null;
    // O tier SS depende do ranking do tier S: reavalia a cada leitura
    return await refreshLeaguePromotion(userId, standing);
  } catch (error) {
    console.error('[liga] erro ao carregar a classificação:', error && error.message);
    return null;
  }
}

// Tier do jogador (usado pelo matchmaking da Liga)
async function getLeagueTierFor(userId) {
  const standing = await getLeagueStandingFor(userId);
  return standing ? league.normalizeTier(standing.tier) : league.TIERS[0];
}

// Aplica o resultado de uma partida da Liga para um jogador
async function updateLeaguePlayer(userId, playerScore, opponentScore) {
  const standing = await getLeagueStandingFor(userId);
  if (!standing) return null;

  let next = league.applyMatchResult(standing, playerScore, opponentScore);
  let protectionUsed = false;

  // Proteção de tier comprada na loja (PRO-007): o jogador não perde
  // pontos de tier nas próximas 3 derrotas (cada uso gasta 1 proteção).
  const lost = Number(playerScore) < Number(opponentScore);
  const lostPoints = Math.max(0, Number(standing.points || 0) - Number(next.points || 0));
  if (lost && lostPoints > 0) {
    const progress = await db.getPlayerProgress(userId);
    const state = shop.ensureShopState(progress.shopState);
    if (state.tierProtection > 0) {
      await db.updatePlayerProgress(userId, (current) => {
        const currentState = shop.ensureShopState(current.shopState);
        if (currentState.tierProtection <= 0) return { ok: false, progress: current };
        return {
          ok: true,
          progress: {
            ...current,
            shopState: { ...currentState, tierProtection: currentState.tierProtection - 1 }
          }
        };
      });
      next = { ...next, points: standing.points };
      protectionUsed = true;
    }
  }

  let saved = await db.saveLeagueStanding(userId, next);

  // Tier S -> SS: além dos 100 pontos é preciso estar entre os 100
  // melhores jogadores do tier S (o ranking é do próprio tier).
  saved = await refreshLeaguePromotion(userId, saved);
  if (saved && protectionUsed) saved.protectionUsed = true;

  return saved;
}

// Aplica o resultado da partida para os dois jogadores da sala da Liga
async function applyLeagueMatchResult(room, state) {
  if (!room || room.mode !== 'liga' || !state) return;
  const uids = Array.isArray(room.userIds) ? room.userIds : [];
  const colors = Array.isArray(room.slotColors) ? room.slotColors : [];
  if (uids.length < 2 || colors.length < 2) return;

  const [uidA, uidB] = uids;
  if (!uidA || !uidB) return;

  const scoreA = Number(state.scores[colors[0]]) || 0;
  const scoreB = Number(state.scores[colors[1]]) || 0;

  try {
    const [standingA, standingB] = await Promise.all([
      updateLeaguePlayer(uidA, scoreA, scoreB),
      updateLeaguePlayer(uidB, scoreB, scoreA)
    ]);

    // Avisa os dois jogadores sobre a nova classificação
    const payloadA = standingA ? league.describeStanding(standingA) : null;
    const payloadB = standingB ? league.describeStanding(standingB) : null;
    if (payloadA) {
      payloadA.protectionUsed = Boolean(standingA.protectionUsed);
      sendToUser(uidA, {
        type: 'league_update',
        standing: payloadA,
        match: { playerScore: scoreA, opponentScore: scoreB, won: scoreA > scoreB }
      });
    }
    if (payloadB) {
      payloadB.protectionUsed = Boolean(standingB.protectionUsed);
      sendToUser(uidB, {
        type: 'league_update',
        standing: payloadB,
        match: { playerScore: scoreB, opponentScore: scoreA, won: scoreB > scoreA }
      });
    }
  } catch (error) {
    console.error('[liga] erro ao aplicar o resultado da partida:', error && error.message);
  }
}

// Desistência/abandono em partida da Liga: quem ficou vence por 4-0.
// Precisa ser chamado antes de limpar room.userIds em detachFromRoom.
function applyLeagueAbandonResult(room, leaverIdx) {
  if (!room || room.mode !== 'liga') return;
  if (leaverIdx !== 0 && leaverIdx !== 1) return;

  const state = room.game;
  if (!state || !state.started || state.over) return;

  const uids = Array.isArray(room.userIds) ? room.userIds : [];
  const colors = Array.isArray(room.slotColors) ? room.slotColors : [];
  if (!uids[0] || !uids[1] || !colors[0] || !colors[1]) return;

  const winnerIdx = leaverIdx === 0 ? 1 : 0;

  // Encerra a partida para não aplicar os pontos duas vezes
  state.over = true;
  state.winner = winnerIdx;

  // Placar de desistência: 4 - 0 para quem ficou
  state.scores[colors[winnerIdx]] = 4;
  state.scores[colors[leaverIdx]] = 0;

  applyLeagueMatchResult(room, state);
}

// Desistência/abandono em partida ARENA: atribui colocações na ordem de abandono
// 1º a abandonar = 4º lugar, 2º = 3º lugar, 3º = 2º lugar, último restante = 1º lugar
function applyArenaAbandonResult(room, leaverIdx) {
  if (!room || room.mode !== 'arena') return;

  const state = room.game;
  if (!state || !state.started || state.over) return;

  // Inicializa a ordem de abandono da sala
  if (!Array.isArray(room.arenaAbandonOrder)) {
    room.arenaAbandonOrder = [];
  }
  // Evita processar abandono duplicado
  if (room.arenaAbandonOrder.includes(leaverIdx)) return;
  room.arenaAbandonOrder.push(leaverIdx);

  const abandonedCount = room.arenaAbandonOrder.length;

  // Colocação calculada pelo total de slots da sala (fixo na criação) e
  // não pela contagem de conexões: quem abandona já foi removido de
  // room.players antes desta função, e misturar as duas bases fazia o
  // 2º a abandonar receber "1º lugar" (4-2+... com bases diferentes).
  // 1º a abandonar = 4º lugar, 2º = 3º, 3º = 2º, último = 1º.
  const slotCount = room.players ? room.players.length : 4;
  const placement = Math.max(1, slotCount - abandonedCount + 1);

  // NOTA: hoje o estado compartilhado é encerrado para TODOS os jogadores
  // da sala (limitação conhecida). O ideal seria a partida continuar para
  // quem ficou, com o fim apenas quando restar 1 jogador — exigiria que
  // nextSlot ignorasse slots ausentes em game-rules.js.
  state.over = true;
  // Armazena a colocação do jogador que abandonou para o cliente ler
  state.abandonedPlacement = placement;
  state.winner = { team: leaverIdx, score: 0, placement };

  clearRoomTurnTimer(room);
}

/**
 * Aplica uma jogada na sala e avisa os clientes. Usado tanto pelos
 * jogadores humanos quanto pelo bot que assume um slot abandonado.
 */
function applyRoomMove(room, slot, tokenIdx, options = {}) {
  const state = room.game;
  if (!state) return null;

  const result = rules.applyMove(state, slot, tokenIdx);
  if (!result) return null;

  // Quem tirou 6 no dado, ou salvou uma peça, ou capturou uma peça adversária, joga novamente
  const extraTurn = state.dice === 6 || Boolean(result.points) || result.captured.length > 0;
  state.dice = null;
  if (!extraTurn) {
    state.turn = rules.nextSlot(state, slot);
  }

  const winner = rules.checkWinner(state, room.mode === 'arena');
  if (winner) {
    state.over = true;
    state.winner = winner;
    clearRoomTurnTimer(room);
    // Partida da Liga: o servidor aplica os pontos e a progressão de tier
    applyLeagueMatchResult(room, state);
    // Partida de torneio: o vencedor avança na chave
    applyTournamentMatchResult(room, state);
  }

  // Contador de capturas do slot (missões do jogador)
  if (!Array.isArray(room.captures)) room.captures = [];
  room.captures[slot] = (Number(room.captures[slot]) || 0) + result.captured.length;

  broadcastRoomGame(room, {
    type: 'token_moved',
    slot,
    color: result.color,
    tokenIdx: result.tokenIdx,
    from: result.from,
    to: result.to,
    roll: result.roll,
    captured: result.captured,
    points: result.points,
    scores: state.scores,
    turn: state.turn,
    extraTurn,
    over: state.over,
    winner: state.winner,
    // Total de capturas do slot até agora (fonte da verdade das missões)
    totalCaptures: room.captures[slot],
    bot: Boolean(options.bot)
  });

  if (!state.over) startRoomTurnTimer(room);
  return result;
}

/**
 * Pedido de movimento. O cliente informa apenas a peça escolhida:
 * o servidor recalcula a jogada com o dado que ele mesmo sorteou.
 */
function handleMoveRequest(ws, conn, room, data) {
  const state = room.game;
  const slot = Number(conn.playerIdx);

  if (!state) {
    rejectClientMessage(ws, conn, 'move_request', 'Partida não encontrada.', room);
    return;
  }
  if (state.over) {
    rejectClientMessage(ws, conn, 'move_request', 'A partida já terminou.', room);
    return;
  }
  if (state.turn !== slot) {
    rejectClientMessage(ws, conn, 'move_request', 'Não é a vez deste jogador.', room);
    return;
  }
  if (state.dice === null) {
    rejectClientMessage(ws, conn, 'move_request', 'O dado ainda não foi sorteado.', room);
    return;
  }

  const tokenIdx = Number(data.tokenIdx);
  const result = applyRoomMove(room, slot, tokenIdx);
  if (!result) {
    rejectClientMessage(ws, conn, 'move_request', 'Jogada ilegal para o dado sorteado.', room);
    return;
  }
}

// Pareia dois jogadores de contas diferentes da MESMA fila (Jogo Rápido ou
// Liga), cria a sala e inicia a partida para ambos
async function tryMatchmaking() {
  let matched = true;
  while (matched) {
    matched = false;
    for (let i = 0; i < matchmakingQueue.length && !matched; i++) {
      const first = matchmakingQueue[i];
      const firstKey = first.uid || first.ws; // sem login, a própria conexão é a chave
      const isLeague = queueMode(first) === 'liga';
      // Na Liga a partida é sempre entre jogadores do mesmo tier: primeiro
      // busca alguém na mesma situação da melhor de 3 e, se não houver,
      // aceita qualquer outro jogador do mesmo tier.
      let fallbackIndex = -1;
      for (let j = i + 1; j < matchmakingQueue.length; j++) {
        const candidate = matchmakingQueue[j];
        // Cada fila só encontra oponente do mesmo modo: quem joga a Liga
        // nunca entra na partida de Jogo Rápido (e vice-versa)
        if (queueMode(candidate) !== queueMode(first)) continue;
        if ((candidate.uid || candidate.ws) === firstKey) continue;
        if (isLeague) {
          if (queueLeagueTier(candidate) !== queueLeagueTier(first)) continue;
          if (queueLeaguePending(candidate) !== queueLeaguePending(first)) {
            if (fallbackIndex === -1) fallbackIndex = j;
            continue;
          }
        }
        matchmakingQueue.splice(j, 1);
        matchmakingQueue.splice(i, 1);
        await startQuickMatchRoom(first, candidate);
        matched = true;
        break;
      }
      if (!matched && fallbackIndex !== -1) {
        const candidate = matchmakingQueue[fallbackIndex];
        matchmakingQueue.splice(fallbackIndex, 1);
        matchmakingQueue.splice(i, 1);
        await startQuickMatchRoom(first, candidate);
        matched = true;
      }
    }
  }
}

// Modo da fila do jogador: 'quick' (Jogo Rápido) ou 'liga' (partida classificatória)
function queueMode(entry) {
  return entry && entry.mode === 'liga' ? 'liga' : 'quick';
}

// Tier do jogador na fila da Liga (usado para parear apenas jogadores do mesmo tier)
function queueLeagueTier(entry) {
  return league.normalizeTier(entry && entry.tier);
}

// O jogador está disputando a melhor de 3 da promoção?
function queueLeaguePending(entry) {
  return Boolean(entry && entry.pending);
}

// Verifica se a conta do jogador tem o plano Premium liberado.
// O servidor é a fonte de verdade da permissão (usado pela fila da Liga).
async function isPremiumPlayer(uid) {
  if (!uid) return false;
  try {
    const profile = await db.getUserProfile(uid);
    if (profile && profile.isPaid === true) return true;
    // Fallback: o cliente pode enviar o e-mail em vez do id da conta
    if (String(uid).includes('@')) {
      const user = await db.getUserByEmail(uid);
      return Boolean(user && user.isPaid === true);
    }
  } catch (error) {
    console.error('[servidor] erro ao verificar o plano Premium:', error && error.message);
  }
  return false;
}

async function startQuickMatchRoom(a, b, forcedMode, options = {}) {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  // O modo da partida define a fila de origem: 'quick' ou 'liga'
  const mode = forcedMode || (queueMode(a) === 'liga' || queueMode(b) === 'liga' ? 'liga' : 'quick');

  const room = {
    code,
    players: [a.ws, b.ws],
    names: [a.name || 'Jogador 1', b.name || 'Jogador 2'],
    userIds: [a.uid || null, b.uid || null],
    ready: [true, true],
    teams: [0, 1],
    mode,
    tournament: options.tournament || null,
    // BLITZ: partida rápida (velocidade das animações). Só vale quando os
    // dois jogadores escolheram BLITZ no lobby.
    blitz: options.blitz === true
  };
  rooms.set(code, room);

  // Estado autoritativo da partida: o servidor controla dado, turno e peças
  setupRoomGame(room, {
    slots: [
      { slot: 0, color: SOLO_SLOT_COLORS[0], team: 0 },
      { slot: 1, color: SOLO_SLOT_COLORS[1], team: 1 }
    ],
    mode,
    target: 4
  });

  const connA = connections.get(a.ws);
  const connB = connections.get(b.ws);
  if (connA) { connA.roomCode = code; connA.playerIdx = 0; }
  if (connB) { connB.roomCode = code; connB.playerIdx = 1; }
  // Sala de cada jogador autenticado: permite retomar a partida se a
  // conexão cair (reconexão transparente)
  if (room.userIds[0]) userRoom.set(room.userIds[0], code);
  if (room.userIds[1]) userRoom.set(room.userIds[1], code);

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
  // Guarda as cores da mesa: a revanche joga na mesma mesa (roadmap #13)
  room.soloColors = soloColors;
  players[0].color = soloColors.starterColor;
  players[1].color = soloColors.opponentColor;

  const tournamentInfo = room.tournament || null;
  sendTo(a.ws, { type: 'room_created', room: code, player: 0, name: room.names[0], quick: true, mode, slotColors: room.slotColors, turn: room.game.turn, opponentProfile: { ...profileB, color: soloColors.opponentColor }, tournament: tournamentInfo, blitz: room.blitz });
  sendTo(b.ws, { type: 'room_created', room: code, player: 1, name: room.names[1], quick: true, mode, slotColors: room.slotColors, turn: room.game.turn, opponentProfile: { ...profileA, color: soloColors.starterColor }, tournament: tournamentInfo, blitz: room.blitz });
  sendTo(a.ws, { type: 'room_ready', players, slotColors: room.slotColors, turn: room.game.turn });
  sendTo(b.ws, { type: 'room_ready', players, slotColors: room.slotColors, turn: room.game.turn });

  return room;
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
async function refreshLobbyMembers(lobby) {
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
      // O lobby fica bloqueado enquanto o criador busca uma partida
      searching: isDuplaLobbySearching(lobby),
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

// O lobby da dupla está na fila de busca de partida?
function isDuplaLobbySearching(lobby) {
  if (!lobby) return false;
  return duplaQueue.some(entry => entry.uid === lobby.hostId);
}

// Avisa todos os jogadores do lobby que a busca foi encerrada
function notifyDuplaQueueCanceled(lobby) {
  if (!lobby) return;
  const payload = { type: 'dupla_queue_canceled' };
  sendToUser(lobby.hostId, payload);
  lobby.members.forEach(member => {
    if (member.id !== lobby.hostId) sendToUser(member.id, payload);
  });
}

async function broadcastDuplaLobby(lobby) {
  await refreshLobbyMembers(lobby);
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
      await refreshLobbyMembers(lobby);
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
    code,
    players: [],
    names: [],
    userIds: [],
    teams: [],
    ready: [],
    mode: 'dupla'
  };

  // Cores dos slots: no 1 vs 1 são diagonais, no 2 vs 2 seguem a ordem horária
  const slotColors = soloMatch ? SOLO_SLOT_COLORS.slice() : rules.CLOCKWISE_COLORS.slice();

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
    // Sala do jogador: reconexão transparente
    if (seat.player.id) userRoom.set(seat.player.id, code);
  });

  rooms.set(code, room);

  // Estado autoritativo da partida (o servidor controla dado, turno e peças)
  setupRoomGame(room, {
    slots: seats.map(seat => ({
      slot: seat.slot,
      color: slotColors[seat.slot] || rules.CLOCKWISE_COLORS[seat.slot],
      team: seat.team
    })),
    mode: soloMatch ? 'solo' : 'dupla',
    target: soloMatch ? 4 : 8
  });

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

  // Cores dos times guardadas na sala: quem reconecta recebe essa
  // informação no snapshot e o tabuleiro continua igual
  room.teamColors = soloMatch
    ? {
      0: { hex: roster[0].teamColor, name: roster[0].teamColorName },
      1: { hex: roster[1].teamColor, name: roster[1].teamColorName }
    }
    : {
      0: { hex: entryA.teamColor, name: entryA.teamColorName, teamName: entryA.teamName },
      1: { hex: entryB.teamColor, name: entryB.teamColorName, teamName: entryB.teamName }
    };

  seats.forEach(seat => {
    const matchMessage = {
      type: 'dupla_match_found',
      room: code,
      slot: seat.slot,
      team: seat.team,
      solo: soloMatch,
      players: roster,
      slotColors: room.slotColors,
      turn: room.game.turn
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

/* -------------------------------------------------------------
   LOBBIES ONLINE - funções auxiliares
   O lobby é mantido pelo servidor (o dono cria, os amigos entram
   depois de aceitar o convite) e a fila é por jogador: quando a
   fila completa a partida, ela começa com um jogador em cada slot.
------------------------------------------------------------- */
function lobbyKindConfig(kind) {
  return LOBBY_KINDS[kind] || LOBBY_KINDS.arena;
}

// Normaliza o tipo de lobby recebido do cliente (sempre devolve um válido)
function normalizeLobbyKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  return LOBBY_KINDS[value] ? value : 'arena';
}

function lobbyMapKey(kind, hostUid) {
  return `${kind}:${hostUid}`;
}

function buildLobbyPayload(lobby) {
  return {
    type: 'lobby',
    kind: lobby.kind,
    lobby: {
      hostId: lobby.hostId,
      // O lobby fica bloqueado enquanto o criador busca uma partida
      searching: isLobbySearching(lobby),
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

// O lobby está na fila de busca de partida?
function isLobbySearching(lobby) {
  if (!lobby) return false;
  const queue = lobbyQueues[lobby.kind] || [];
  const ids = new Set(lobby.members.map(member => member.id));
  return queue.some(entry => ids.has(entry.uid));
}

// Avisa todos os jogadores do lobby que a busca foi encerrada
function notifyLobbyQueueCanceled(lobby) {
  if (!lobby) return;
  const payload = { type: 'lobby_queue_canceled', kind: lobby.kind };
  sendToUser(lobby.hostId, payload);
  lobby.members.forEach(member => {
    if (member.id !== lobby.hostId) sendToUser(member.id, payload);
  });
}

async function broadcastLobby(lobby) {
  await refreshLobbyMembers(lobby);
  const payload = buildLobbyPayload(lobby);
  sendToUser(lobby.hostId, payload);
  lobby.members.forEach(member => {
    if (member.id !== lobby.hostId) sendToUser(member.id, payload);
  });
}

// Envia o lobby atual (se existir) para o usuário
async function sendLobbyToUser(userId, kind) {
  if (!userId) return;
  for (const lobby of onlineLobbies.values()) {
    if (kind && lobby.kind !== kind) continue;
    if (lobby.hostId === userId || lobby.members.some(member => member.id === userId)) {
      await refreshLobbyMembers(lobby);
      sendToUser(userId, buildLobbyPayload(lobby));
      return;
    }
  }
}

// Encerra o lobby do dono que ficou offline (se ele não voltar a tempo)
function scheduleLobbyCleanup(kind, hostUid) {
  clearLobbyCleanup(kind, hostUid);
  const key = lobbyMapKey(kind, hostUid);
  const timer = setTimeout(() => {
    lobbyCleanupTimers.delete(key);
    const lobby = onlineLobbies.get(key);
    if (!lobby) return;
    const host = lobby.members.find(member => member.id === hostUid);
    if (host && host.ws && host.ws.readyState === 1) return; // o dono voltou
    onlineLobbies.delete(key);
    lobby.members.forEach(member => {
      if (member.id !== hostUid) {
        sendToUser(member.id, {
          type: 'lobby_left',
          kind: lobby.kind,
          message: 'O criador do lobby saiu. O lobby foi encerrado.'
        });
      }
    });
  }, DUPLA_LOBBY_CLEANUP_MS);
  if (typeof timer.unref === 'function') timer.unref();
  lobbyCleanupTimers.set(key, timer);
}

function clearLobbyCleanup(kind, hostUid) {
  const key = lobbyMapKey(kind, hostUid);
  const timer = lobbyCleanupTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    lobbyCleanupTimers.delete(key);
  }
}

// Lobby em que o usuário participa (criador ou convidado)
function findLobbyForUser(uid, kind) {
  if (!uid) return null;
  for (const lobby of onlineLobbies.values()) {
    if (kind && lobby.kind !== kind) continue;
    if (lobby.hostId === uid) return lobby;
    if (lobby.members.some(member => member.id === uid)) return lobby;
  }
  return null;
}

async function ensureLobby(kind, hostUid, socket) {
  const key = lobbyMapKey(kind, hostUid);
  let lobby = onlineLobbies.get(key);
  if (!lobby) {
    const host = await getLobbyMemberWithSocket(hostUid, null, socket);
    lobby = {
      hostId: hostUid,
      kind,
      members: [host]
    };
    onlineLobbies.set(key, lobby);
    return lobby;
  }
  // Mantém a aba do dono do lobby conectada
  const host = lobby.members.find(member => member.id === hostUid);
  if (host && socket && (!host.ws || host.ws.readyState !== 1)) host.ws = socket;
  return lobby;
}

// Remove a conexão da fila de busca do lobby
function removeFromLobbyQueue(kind, ws) {
  const queue = lobbyQueues[kind];
  if (!queue) return false;
  const index = queue.findIndex(entry => entry.ws === ws);
  if (index === -1) return false;
  queue.splice(index, 1);
  return true;
}

// Remove da fila as entradas de um usuário (e do lobby dele, se for o dono)
function removeLobbyQueueForUser(kind, uid) {
  if (!uid) return;
  const queue = lobbyQueues[kind];
  if (!queue) return;
  const ids = new Set([uid]);
  const lobby = findLobbyForUser(uid, kind);
  if (lobby && lobby.hostId === uid) {
    lobby.members.forEach(member => ids.add(member.id));
  }
  for (let i = queue.length - 1; i >= 0; i--) {
    if (ids.has(queue[i].uid)) queue.splice(i, 1);
  }
}

// Descobre as conexões abertas de cada jogador do lobby
function resolveLobbyPlayers(members, fallbackUid, fallbackWs) {
  const players = [];
  members.forEach(member => {
    let socket = null;
    if (member.id === fallbackUid && fallbackWs && fallbackWs.readyState === 1) {
      // quem entrou na fila joga na própria aba
      socket = fallbackWs;
    } else if (member.ws && member.ws.readyState === 1) {
      // o convidado joga na aba em que aceitou o convite
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

// Junta os jogadores da fila e inicia a partida do lobby
async function tryLobbyMatchmaking(kind) {
  const config = lobbyKindConfig(kind);
  const queue = lobbyQueues[kind];
  if (!queue) return;

  // Resolve quem está online em cada entrada da fila
  const valid = [];
  queue.forEach(entry => {
    const socket = (entry.ws && entry.ws.readyState === 1) ? entry.ws : findUserSocket(entry.uid);
    if (!socket) return; // o jogador ficou offline
    valid.push({ ...entry, ws: socket });
  });

  queue.length = 0;
  valid.forEach(entry => queue.push(entry));

  while (queue.length >= config.matchSize) {
    const seats = [];
    const usedIndexes = [];
    for (let i = 0; i < queue.length && seats.length < config.matchSize; i++) {
      const entry = queue[i];
      seats.push({
        id: entry.uid,
        uid: entry.uid,
        name: entry.name,
        picture: entry.picture || '',
        ws: entry.ws,
        blitz: entry.blitz === true,
        slot: seats.length
      });
      usedIndexes.push(i);
    }
    if (seats.length < config.matchSize) break;

    // Tira da fila os jogadores que entraram na partida
    usedIndexes.reverse().forEach(index => queue.splice(index, 1));
    if (kind === 'normal') {
      // Partida normal: 1 vs 1 com as cores resolvidas pelo perfil.
      // BLITZ só vale quando os dois jogadores escolheram BLITZ.
      const blitz = seats.every(seat => seat.blitz === true);
      await startQuickMatchRoom(seats[0], seats[1], 'quick', { blitz });
    } else {
      await startArenaMatch(seats);
    }
  }
}

async function startArenaMatch(seats) {
  if (!seats || seats.length < LOBBY_KINDS.arena.matchSize) return;

  let code;
  do {
    code = generateRoomCode();
  } while (rooms.has(code));

  const room = {
    code,
    players: [],
    names: [],
    userIds: [],
    teams: [],
    ready: [],
    mode: 'arena'
  };

  seats.forEach(seat => {
    room.players[seat.slot] = seat.ws;
    room.names[seat.slot] = seat.name;
    room.userIds[seat.slot] = seat.uid;
    room.teams[seat.slot] = seat.slot; // cada um por si: um time por jogador
    room.ready[seat.slot] = true;
    const conn = connections.get(seat.ws);
    if (conn) {
      conn.roomCode = code;
      conn.playerIdx = seat.slot;
    }
    // Sala do jogador: reconexão transparente
    if (seat.uid) userRoom.set(seat.uid, code);
  });

  rooms.set(code, room);

  // Estado autoritativo da partida (o servidor controla dado, turno e peças)
  setupRoomGame(room, {
    slots: seats.map(seat => ({
      slot: seat.slot,
      color: ARENA_SLOT_COLORS[seat.slot] || rules.CLOCKWISE_COLORS[seat.slot],
      team: seat.slot
    })),
    mode: 'arena',
    target: 4
  });

  const roster = seats.map(seat => ({
    slot: seat.slot,
    id: seat.uid,
    uid: seat.uid,
    name: seat.name,
    picture: seat.picture || '',
    playerName: seat.name,
    team: seat.slot,
    color: ARENA_SLOT_COLORS[seat.slot]
  }));

  seats.forEach(seat => {
    sendTo(seat.ws, {
      type: 'arena_match_found',
      room: code,
      slot: seat.slot,
      players: roster,
      slotColors: room.slotColors,
      turn: room.game.turn
    });
    // A partida começa na aba do jogador; as outras abas só são avisadas
    getUserSockets(seat.uid).forEach(socket => {
      if (socket !== seat.ws) {
        sendTo(socket, {
          type: 'arena_match_started_elsewhere',
          message: 'A partida de arena começou em outra aba.'
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

// Carrega a configuração dos arquivos .env
// - .env:       configuração compartilhada do projeto
// - .env.local: configuração local (segredos), sobrescreve o .env
// As variáveis já existentes no ambiente (Render, CI, terminal) sempre
// têm prioridade: nada aqui sobrescreve o que vem da plataforma.
function loadEnvFile() {
  const externalKeys = new Set(Object.keys(process.env));
  const fileValues = {};

  const readEnvFile = (fileName) => {
    const envPath = path.join(__dirname, fileName);
    if (!fss.existsSync(envPath)) return;

    const content = fss.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;

      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      fileValues[match[1]] = value;
    }
  };

  readEnvFile('.env');
  readEnvFile('.env.local');

  for (const [key, value] of Object.entries(fileValues)) {
    if (!externalKeys.has(key)) process.env[key] = value;
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

// Verifica proteção CSRF para rotas mutáveis (POST, PATCH, DELETE, PUT)
// Exige header X-CSRF-Token ou cookie de sessão com SameSite=Strict
function checkCsrf(request) {
  const method = (request.method || '').toUpperCase();
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  if (safeMethods.has(method)) return true;

  const cookies = parseCookies(request);
  const sessionId = cookies[COOKIE_NAME];
  
  // Verifica token CSRF no header
  const csrfToken = request.headers['x-csrf-token'];
  if (sessionId && csrfToken && validateCsrfToken(sessionId, csrfToken)) {
    return true;
  }
  
  // Fallback: verifica origem (menos seguro mas compatível)
  const origin = request.headers.origin || '';
  const referer = request.headers.referer || request.headers.referrer || '';
  const host = request.headers.host || '';

  if (!origin && !referer) return true;

  try {
    const originHost = origin ? new URL(origin).host : '';
    const refererHost = referer ? new URL(referer).host : '';
    if (originHost && originHost !== host) return false;
    if (refererHost && refererHost !== host) return false;
  } catch (error) {
    return false;
  }
  return true;
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

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getCsrfToken(sessionId) {
  const entry = csrfTokens.get(sessionId);
  if (!entry) return null;
  return entry.token;
}

function validateCsrfToken(sessionId, token) {
  const entry = csrfTokens.get(sessionId);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > 60 * 60 * 1000) {
    csrfTokens.delete(sessionId);
    return false;
  }
  // timingSafeEqual para evitar timing attacks
  const provided = Buffer.from(String(token || ''), 'utf8');
  const expected = Buffer.from(entry.token, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function checkHttpRateLimit(ip) {
  const now = Date.now();
  let entry = httpRateLimits.get(ip);
  if (!entry || now - entry.windowStart > HTTP_RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    httpRateLimits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= HTTP_RATE_LIMIT_MAX_REQUESTS;
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

/* -------------------------------------------------------------
   LOGIN DE DESENVOLVIMENTO (conta RH de teste)
   Neste ambiente o botão do Google Identity Services responde 403,
   então existe uma rota de desenvolvimento que entra direto na
   conta de testes (a mesma lista PAID_TEST_EMAILS do db.js, que
   já é Premium).
   A rota só existe fora da produção: em produção responde 404.
------------------------------------------------------------- */
async function handleDevLogin(request, response, requestUrl) {
  if (NODE_ENV === 'production') {
    sendJson(response, 404, { error: 'Rota não disponível.' });
    return;
  }

  const requested = String(requestUrl.searchParams.get('email') || '').trim().toLowerCase();
  const email = requested || String(db.PAID_TEST_EMAILS[0] || '').trim().toLowerCase();
  if (!email || !db.PAID_TEST_EMAILS.includes(email)) {
    sendJson(response, 403, { error: 'Conta de teste não autorizada.' });
    return;
  }

  try {
    // Payload no mesmo formato do Google, para o usuário ser criado
    // (ou atualizado) exatamente como no login normal.
    const user = await db.createOrUpdateUserFromGoogle({
      sub: `dev:${email}`,
      email,
      email_verified: 'true',
      name: 'RH',
      picture: ''
    });
    const token = await db.createSession(user.id);
    const headers = { 'Set-Cookie': createSessionCookie(token) };

    // Navegação (abriu a rota no navegador): volta para o jogo.
    if (String(request.headers.accept || '').includes('text/html')) {
      response.writeHead(302, { ...headers, Location: '/' });
      response.end();
      return;
    }

    sendJson(response, 200, { user }, headers);
  } catch (error) {
    if (error && error.dbError) {
      console.error('[dev-login] erro de banco de dados:', error.message);
      sendJson(response, 503, { error: 'Não foi possível acessar o banco de dados. Tente novamente em instantes.' });
      return;
    }
    sendJson(response, 400, { error: error.message });
  }
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
   LIGA - CLASSIFICAÇÃO DO JOGADOR
   Devolve o tier (e os pontos) do jogador logado. A Liga é
   exclusiva para contas Premium: as contas gratuitas não têm tier.
   ------------------------------------------------------------- */
async function handleLeagueStanding(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para ver a sua classificação.' });
    return;
  }

  const premium = await isPremiumPlayer(user.id);
  if (!premium) {
    sendJson(response, 200, { premium: false, standing: null });
    return;
  }

  const standing = await getLeagueStandingFor(user.id);
  sendJson(response, 200, {
    premium: true,
    standing: standing ? league.describeStanding(standing) : null
  });
}

/* -------------------------------------------------------------
   CONTA PREMIUM - COMPRA VIA PIX
   O servidor é a fonte de verdade: o cliente apenas pede a cobrança
   e consulta o status. O Premium só é liberado depois que o gateway
   confirma o pagamento (webhook ou consulta de status).
------------------------------------------------------------- */
// Estado do desconto temporário do plano Premium
function premiumPromoState(now = Date.now()) {
  const until = Date.parse(PREMIUM_PROMO_UNTIL);
  const hasDeadline = Number.isFinite(until);
  const active = Boolean(
    hasDeadline
    && now <= until
    && PREMIUM_PROMO_PRICE_BRL > 0
    && PREMIUM_PROMO_PRICE_BRL < PREMIUM_PRICE_BRL
  );
  return {
    active,
    // Preço efetivamente cobrado
    price: active ? PREMIUM_PROMO_PRICE_BRL : PREMIUM_PRICE_BRL,
    originalPrice: PREMIUM_PRICE_BRL,
    promoPrice: PREMIUM_PROMO_PRICE_BRL,
    promoUntil: active ? new Date(until).toISOString() : ''
  };
}

function premiumPublicInfo() {
  const promo = premiumPromoState();
  return {
    planName: PREMIUM_PLAN_NAME,
    price: promo.price,
    originalPrice: promo.originalPrice,
    promoPrice: promo.promoPrice,
    promoActive: promo.active,
    promoUntil: promo.promoUntil,
    promoLabel: PREMIUM_PROMO_LABEL,
    currency: PREMIUM_CURRENCY,
    note: PREMIUM_TRIAL_NOTE,
    benefits: PREMIUM_BENEFITS,
    groups: PREMIUM_BENEFIT_GROUPS,
    gateway: PIX_GATEWAY,
    // No modo 'pixkey' o servidor não recebe aviso do pagamento:
    // a liberação do Premium é feita manualmente pelo administrador.
    manualConfirmation: PIX_GATEWAY === 'pixkey',
    gatewayReady: Boolean(
      (PIX_GATEWAY === 'mercadopago' && PIX_API_TOKEN)
      || (PIX_GATEWAY === 'pixkey' && PIX_KEY)
      || (PIX_GATEWAY === 'stub' && NODE_ENV !== 'production')
    )
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

  // Modo 'pixkey': não existe gateway para consultar e o BR Code gerado
  // continua válido depois do prazo. A cobrança fica "pending" até o
  // administrador confirmar o pagamento manualmente.
  if (payment.gateway === 'pixkey') return payment;

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

  // Chave Pix do próprio projeto: sem a chave não há como gerar o BR Code
  if (PIX_GATEWAY === 'pixkey' && !PIX_KEY) {
    sendJson(response, 503, { error: 'A chave Pix não está configurada.' });
    return;
  }

  if (PIX_GATEWAY === 'stub' && NODE_ENV === 'production') {
    sendJson(response, 503, { error: 'O gateway Pix não está configurado.' });
    return;
  }

  // Qualquer gateway desconhecido (erro de digitação) é recusado
  if (PIX_GATEWAY !== 'mercadopago' && PIX_GATEWAY !== 'pixkey' && PIX_GATEWAY !== 'stub') {
    sendJson(response, 503, { error: 'O gateway Pix não está configurado.' });
    return;
  }

  try {
    const paymentId = generatePaymentId();
    const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MINUTES * 60 * 1000).toISOString();
    // Preço cobrado: o promocional enquanto o desconto estiver valendo
    const promo = premiumPromoState();
    const amount = promo.price;

    let qrCode = '';
    let copyPaste = '';
    let gatewayRef = '';

    if (PIX_GATEWAY === 'mercadopago') {
      const notificationUrl = PUBLIC_URL ? `${PUBLIC_URL}/api/premium/webhook` : undefined;
      const created = await pix.createMercadoPagoPayment({
        token: PIX_API_TOKEN,
        amount: amount,
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
      // BR Code estático. No modo 'pixkey' é a chave Pix real do projeto
      // (o pagamento é conferido no extrato e liberado manualmente). No
      // modo 'stub' (teste) a chave é SEMPRE fictícia: usar a chave real
      // aqui tornaria falso o aviso de "nenhuma cobrança real" - um
      // teste em ambiente de desenvolvimento poderia cobrar alguém.
      const isTestMode = PIX_GATEWAY === 'stub';
      const key = isTestMode
        ? 'luud.premium@pix.test'
        : (PIX_KEY || 'luud.premium@pix.test');
      copyPaste = pix.buildPixPayload({
        key,
        name: PIX_MERCHANT_NAME,
        city: PIX_MERCHANT_CITY,
        amount: amount,
        txid: paymentId
      });
      gatewayRef = paymentId;
    }

    const payment = await db.createPayment({
      id: paymentId,
      userId: user.id,
      gateway: PIX_GATEWAY,
      amount: amount,
      status: 'pending',
      gatewayRef,
      copyPaste,
      qrCode,
      expiresAt,
      // Produto do Premium: distingue das cobranças de Cristais da loja
      productType: 'premium',
      productId: 'premium',
      productAmount: 1
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
      if (payment && !isPremiumPayment(payment)) payment = null;
      if (!payment && !paymentId) {
        const payments = await db.listPaymentsForUser(user.id);
        // Só as cobranças do Premium interessam aqui: as de Cristais
        // (produto 'crystals') pertencem ao fluxo da loja.
        const premiumPayments = payments.filter(isPremiumPayment);
        payment = premiumPayments.find(item => item.status === 'pending') || premiumPayments[0] || null;
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

/* -------------------------------------------------------------
   PRODUTOS DE PAGAMENTO
   Uma cobrança é do Premium ou da loja (Cristais). Os handlers
   nunca podem misturar os dois: comprar Cristais NÃO pode
   ativar o Premium e pagar o Premium NÃO pode entregar Cristais.
------------------------------------------------------------------ */
function paymentProductType(payment) {
  return String((payment && payment.productType) || 'premium').toLowerCase();
}

function isPremiumPayment(payment) {
  return Boolean(payment) && paymentProductType(payment) === 'premium';
}

function isCrystalPayment(payment) {
  return Boolean(payment) && paymentProductType(payment) === 'crystals';
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
    // Uma cobrança de Cristais não ativa o Premium (ela é confirmada
    // no fluxo da loja, em /api/shop/dev/confirm).
    if (!isPremiumPayment(payment)) {
      sendJson(response, 409, { error: 'Esta cobrança não é do Premium.' });
      return;
    }

    const updatedUser = await grantPremium(user.id, payment.id);
    sendJson(response, 200, { paid: true, plan: updatedUser.plan, user: updatedUser });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// -------------------------------------------------------------
// ADMINISTRAÇÃO DO PREMIUM (confirmação manual de pagamento)
// Usado quando o Pix é recebido numa chave do próprio projeto
// (modo 'pixkey'): não existe gateway para avisar o servidor, então
// o dono da conta confere o pagamento no banco e confirma aqui.
//
// O acesso exige o token definido em PREMIUM_ADMIN_TOKEN (header
// "x-admin-token" ou o campo "token" do corpo). Sem o token
// configurado as rotas nem existem.
// -------------------------------------------------------------
function safeTokenMatch(value) {
  const provided = Buffer.from(String(value || ''), 'utf8');
  const expected = Buffer.from(PREMIUM_ADMIN_TOKEN, 'utf8');
  if (!expected.length || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

async function requirePremiumAdmin(request, response) {
  if (!PREMIUM_ADMIN_TOKEN) {
    sendJson(response, 404, { error: 'Rota não disponível.' });
    return null;
  }

  let body = {};
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, 400, { error: 'Corpo da requisição inválido.' });
    return null;
  }

  const token = request.headers['x-admin-token'] || body.token || '';
  if (!safeTokenMatch(token)) {
    sendJson(response, 401, { error: 'Token de administrador inválido.' });
    return null;
  }

  return body;
}

// Lista as cobranças de uma conta (para o administrador conferir o Pix pago)
async function handlePremiumAdminPayments(request, response) {
  const body = await requirePremiumAdmin(request, response);
  if (!body) return;

  const email = String(body.email || '').trim();
  if (!email) {
    sendJson(response, 400, { error: 'Informe o e-mail da conta.' });
    return;
  }

  try {
    const user = await db.getUserByEmail(email);
    if (!user) {
      sendJson(response, 404, { error: 'Conta não encontrada.' });
      return;
    }

    const payments = await db.listPaymentsForUser(user.id);
    sendJson(response, 200, {
      user: { id: user.id, email: user.email, isPaid: Boolean(user.isPaid), plan: user.plan },
      payments: payments.map(payment => ({
        id: payment.id,
        amount: payment.amount,
        status: payment.status,
        gateway: payment.gateway,
        productType: paymentProductType(payment),
        productId: payment.productId || '',
        productAmount: Number(payment.productAmount) || 0,
        createdAt: payment.createdAt,
        expiresAt: payment.expiresAt,
        paidAt: payment.paidAt,
        deliveredAt: payment.deliveredAt || null
      }))
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Confirma o pagamento e libera o Premium da conta
async function handlePremiumAdminConfirm(request, response) {
  const body = await requirePremiumAdmin(request, response);
  if (!body) return;

  const email = String(body.email || '').trim();
  const paymentId = String(body.paymentId || '').trim();

  if (!email && !paymentId) {
    sendJson(response, 400, { error: 'Informe o e-mail da conta ou o id da cobrança.' });
    return;
  }

  try {
    let user = email ? await db.getUserByEmail(email) : null;
    if (!user && paymentId) {
      const payment = await db.getPayment(paymentId);
      if (payment) user = await db.getUserById(payment.userId);
    }
    if (!user) {
      sendJson(response, 404, { error: 'Conta não encontrada.' });
      return;
    }

    // Sem id informado, confirma a cobrança pendente mais recente
    let payment = null;
    if (paymentId) {
      payment = await db.getPayment(paymentId);
      if (!payment || payment.userId !== user.id) {
        sendJson(response, 404, { error: 'Cobrança não encontrada para esta conta.' });
        return;
      }
    } else {
      const payments = await db.listPaymentsForUser(user.id);
      payment = payments.find(item => item.status === 'pending') || payments[0] || null;
      if (!payment) {
        sendJson(response, 404, { error: 'Esta conta não tem nenhuma cobrança registrada.' });
        return;
      }
    }

    // Cobrança da loja (Cristais): a confirmação manual entrega o
    // pacote de Cristais — e NÃO ativa o Premium.
    if (isCrystalPayment(payment)) {
      const delivery = await deliverCrystalPackage(payment);
      const progress = await db.getPlayerProgress(user.id);
      console.log(`[loja] confirmação manual: ${user.email} | cobrança ${payment.id} | ${payment.productAmount} Cristais`);
      sendJson(response, 200, {
        ok: true,
        productType: 'crystals',
        delivered: Boolean(delivery.delivered),
        duplicate: Boolean(delivery.duplicate),
        crystals: Math.max(0, Number(progress.crystals) || 0),
        payment: { id: payment.id, amount: payment.amount, status: 'paid' },
        user
      });
      return;
    }

    if (!isPremiumPayment(payment)) {
      sendJson(response, 409, { error: 'Produto de pagamento desconhecido.' });
      return;
    }

    const updatedUser = await grantPremium(user.id, payment.id);
    console.log(`[premium] confirmação manual: ${user.email} | cobrança ${payment.id} | R$ ${Number(payment.amount || 0).toFixed(2)}`);

    sendJson(response, 200, {
      paid: true,
      plan: updatedUser.plan,
      payment: { id: payment.id, amount: payment.amount, status: 'paid' },
      user: updatedUser
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Limpeza do histórico de partidas do próprio usuário (somente contas Premium)
async function handleClearAllMatches(request, response) {
  try {
    const user = await getSessionUser(request);
    if (!user) {
      sendJson(response, 401, { error: 'Sessão expirada.' });
      return;
    }
    if (!user.isPaid) {
      sendJson(response, 403, { error: 'A limpeza de histórico está disponível apenas para contas Premium.' });
      return;
    }

    const result = await db.clearMatchRecordsForUser(user.id);
    console.log('[usuário] histórico de partidas limpo para o usuário', user.id);
    sendJson(response, 200, { ok: true, cleared: result.cleared });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Webhook do gateway: confirma o pagamento e libera o Premium
async function handlePremiumWebhook(request, response) {
  try {
    const body = await readJsonBody(request);
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    // O Mercado Pago assina o "data.id" que vem na query string; o corpo
    // também traz o id, mas usamos o da query como fonte principal.
    const gatewayPaymentId = String(
      requestUrl.searchParams.get('data.id')
      || requestUrl.searchParams.get('id')
      || (body && body.data && body.data.id)
      || (body && body.id)
      || ''
    );
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
      // Só a cobrança do Premium libera o Premium: as cobranças de
      // Cristais (produto 'crystals') são entregues pelo webhook da loja.
      if (payment && isPremiumPayment(payment)) {
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
    // O nickname (playerName) só pode ser alterado por contas Premium
    // ou por quem tem uma renomeação comprada na loja (item PRO-008).
    let useRenameToken = false;
    if (body.playerName !== undefined) {
      if (!user.isPaid) {
        const progress = await db.getPlayerProgress(user.id);
        const state = shop.ensureShopState(progress.shopState);
        useRenameToken = state.renameTokens > 0;
        if (!useRenameToken) {
          sendJson(response, 400, { error: 'A alteração do nickname está disponível para contas Premium ou com uma renomeação da loja.' });
          return;
        }
      }
      const playerName = cleanText(body.playerName, 24);
      if (!playerName) {
        sendJson(response, 400, { error: 'Informe um nickname.' });
        return;
      }
      // Bloqueia nomes ofensivos segundo a política de nomes do jogo.
      const nameCheck = namePolicy.checkName(playerName);
      if (!nameCheck.allowed) {
        sendJson(response, 400, { error: nameCheck.reason || 'Esse nickname não é permitido. Escolha outro.' });
        return;
      }
      fields.playerName = playerName;
      // Marca o nickname como escolhido pelo jogador: assim ele é
      // preservado mesmo quando coincide com o nome da conta Google.
      fields.playerNameCustomized = true;
    }
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

    // A renomeação comprada na loja (item PRO-008) é gasta ANTES de
    // salvar o perfil: o débito é atômico (lock do progresso) e o
    // token volta se a gravação do perfil falhar.
    if (useRenameToken) {
      const debit = await db.updatePlayerProgress(user.id, (progress) => {
        const state = shop.ensureShopState(progress.shopState);
        if (state.renameTokens <= 0) return { ok: false, progress };
        return {
          ok: true,
          progress: {
            ...progress,
            shopState: { ...state, renameTokens: state.renameTokens - 1 }
          }
        };
      });
      if (!debit.ok) {
        sendJson(response, 409, { error: 'Você não tem renomeações disponíveis na loja.' });
        return;
      }
    }

    let updatedUser;
    try {
      updatedUser = await db.updateUserProfile(user.id, fields);
    } catch (profileError) {
      // Devolve a renomeação: o nickname não foi salvo.
      if (useRenameToken) {
        try {
          await db.updatePlayerProgress(user.id, (progress) => {
            const state = shop.ensureShopState(progress.shopState);
            return {
              ok: true,
              progress: {
                ...progress,
                shopState: { ...state, renameTokens: state.renameTokens + 1 }
              }
            };
          });
        } catch (refundError) {
          console.error('[perfil] erro ao devolver a renomeação:', refundError && refundError.message);
        }
      }
      throw profileError;
    }

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
const MATCH_MODES = new Set(['quick', 'invite', 'local', 'multiplayer', 'dupla', 'arena', 'liga', 'tournament']);

function sanitizeMatchRecord(body, userId) {
  const mode = MATCH_MODES.has(body.mode) ? body.mode : 'local';
  const result = body.result === 'win' ? 'win' : 'loss';
  const toScore = (value) => {
    const num = Math.floor(Number(value));
    return Number.isFinite(num) && num >= 0 && num <= 4 ? num : 0;
  };
  const opponentName = String(body.opponentName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Oponente';

  // Partidas contra a CPU (SINGLE PLAYER) não entram no histórico
  if (mode === 'local' || opponentName.toLowerCase() === 'cpu') {
    throw new Error('Partidas contra a CPU não são registradas no histórico.');
  }

  // Modo Liga requer conta premium
  if (mode === 'liga' && userId) {
    // A verificação de premium será feita no chamador
  }

  // Scores não podem exceder o alvo da partida (4 pontos)
  if (toScore(body.playerScore) > 4 || toScore(body.opponentScore) > 4) {
    throw new Error('Placar inválido.');
  }

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
    const record = sanitizeMatchRecord(body, user.id);

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

  // Histórico padrão: 15 dias. Com o item CON-002 (90 dias) o jogador
  // enxerga o histórico completo.
  let days = 15;
  try {
    const progress = await db.getPlayerProgress(user.id);
    if (shop.hasExtendedHistory(progress.shopState, new Date())) days = 90;
  } catch (error) {
    console.error('[histórico] erro ao verificar o histórico estendido:', error && error.message);
  }

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const matches = (data.matches || []).filter(item => {
    const stamp = new Date(item.finishedAt || item.createdAt || 0).getTime();
    return !Number.isFinite(stamp) || stamp >= cutoff;
  });

  sendJson(response, 200, { matches, days, extended: days > 15 });
}

/* -------------------------------------------------------------
   RECOMPENSAS — baú diário e missões (roadmap #6/#7)
   As regras (valores, metas e ciclos) ficam em rewards.js; aqui
   só autenticamos, sanitizamos e persistimos.
------------------------------------------------------------- */

const PROGRESS_MODES = new Set(['quick', 'invite', 'local', 'multiplayer', 'dupla', 'arena', 'liga', 'tournament']);

function clampProgressCount(value, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(max, number);
}

async function handleProgressOverview(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para ver as suas recompensas.' });
    return;
  }

  try {
    const progress = await db.getPlayerProgress(user.id);
    sendJson(response, 200, rewards.describeProgress(progress, new Date()));
  } catch (error) {
    console.error('[recompensas] erro ao carregar o progresso:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível carregar as recompensas. Tente novamente.' });
  }
}

async function handleDailyRewardClaim(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para resgatar o baú diário.' });
    return;
  }

  try {
    // Sem body: resgata o baú de hoje. Com { date }: compensa um dia
    // que já passou (gasta 1 compensador do passe).
    const body = await readJsonBody(request);
    const date = String((body && body.date) || '').trim();

    // Conta Premium ganha o dobro de XP no passe (roadmap #20)
    const premium = Boolean(user.isPaid) || user.plan === 'premium';
    const outcome = await db.updatePlayerProgress(user.id, (progress) => {
      const chestOutcome = date
        ? rewards.claimMissedDailyReward(progress, date, new Date())
        : rewards.claimDailyReward(progress, new Date());
      // O XP do baú também alimenta o passe de temporada (#9)
      if (chestOutcome.ok) {
        season.applySeasonXp(chestOutcome.progress, chestOutcome.reward.xp, new Date(), { isPremium: premium });
      }
      return chestOutcome;
    });
    const view = rewards.describeProgress(outcome.progress, new Date());

    if (!outcome.ok) {
      sendJson(response, 409, { error: outcome.error, progress: view });
      return;
    }
    sendJson(response, 200, { ok: true, reward: outcome.reward, progress: view });
  } catch (error) {
    console.error('[recompensas] erro ao resgatar o baú diário:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível resgatar o baú diário. Tente novamente.' });
  }
}

async function handleMatchProgress(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para guardar o seu progresso.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const mode = PROGRESS_MODES.has(body.mode) ? body.mode : 'local';
    // Resultado: vitória, empate ou derrota (o empate paga menos que a
    // vitória e mais que a derrota — roadmap "Economia").
    const result = body.result === 'win' ? 'win' : body.result === 'draw' ? 'draw' : 'loss';
    const captures = clampProgressCount(body.captures, 40);
    const pieces = clampProgressCount(body.pieces, 8);
    const matchId = String(body.matchId || '').trim().slice(0, 64) || null;

    const outcome = await db.updatePlayerProgress(user.id, (progress) => {
      const matchOutcome = rewards.applyMatchProgress(progress, { id: matchId, mode, result, captures, pieces }, new Date());
      // O XP da partida também alimenta o passe de temporada (#9)
      if (matchOutcome.ok && matchOutcome.gains) {
        // Conta Premium ganha o dobro de XP no passe (roadmap #20)
        const premium = Boolean(user.isPaid) || user.plan === 'premium';
        season.applySeasonXp(matchOutcome.progress, matchOutcome.gains.xp, new Date(), { isPremium: premium });
      }
      return matchOutcome;
    });
    const view = rewards.describeProgress(outcome.progress, new Date());

    if (!outcome.ok && outcome.duplicate) {
      // A mesma partida não pode ser contabilizada duas vezes
      sendJson(response, 200, { ok: true, duplicate: true, progress: view });
      return;
    }
    sendJson(response, 200, { ok: true, duplicate: false, progress: view });
  } catch (error) {
    console.error('[recompensas] erro ao registrar a partida:', error && error.message);
    sendJson(response, 400, { error: 'Não foi possível registrar o progresso da partida.' });
  }
}

async function handleMissionClaim(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para resgatar as missões.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const missionId = String(body.missionId || '').trim().slice(0, 64);

    const outcome = await db.updatePlayerProgress(user.id, (progress) => {
      const missionOutcome = rewards.claimMissionReward(progress, missionId, new Date());
      // O XP da missão também alimenta o passe de temporada (#9)
      if (missionOutcome.ok) {
        // Conta Premium ganha o dobro de XP no passe (roadmap #20)
        const premium = Boolean(user.isPaid) || user.plan === 'premium';
        season.applySeasonXp(missionOutcome.progress, missionOutcome.reward.xp, new Date(), { isPremium: premium });
      }
      return missionOutcome;
    });
    const view = rewards.describeProgress(outcome.progress, new Date());

    if (!outcome.ok) {
      sendJson(response, 409, { error: outcome.error, progress: view });
      return;
    }
    sendJson(response, 200, { ok: true, reward: outcome.reward, progress: view });
  } catch (error) {
    console.error('[recompensas] erro ao resgatar a missão:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível resgatar a missão. Tente novamente.' });
  }
}

/* -------------------------------------------------------------
   PASSE DE BATALHA — 50 dias (roadmap #9)
   O XP conquistado no jogo libera os níveis do passe. A trilha
   Premium exige conta Premium; a FREE é para todo mundo.
------------------------------------------------------------- */

async function handleSeasonOverview(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para ver o seu passe de temporada.' });
    return;
  }

  try {
    const progress = await db.getPlayerProgress(user.id);
    const premium = await isPremiumPlayer(user.id);
    // A trilha premium do passe também pode vir da loja (item PRO-001)
    const hasPremiumPass = shop.hasPremiumPass(progress.shopState, season.currentSeason(new Date()).id);
    const view = season.describeSeason(progress, new Date(), { isPremium: premium, hasPremiumPass });
    sendJson(response, 200, view);
  } catch (error) {
    console.error('[passe] erro ao carregar a temporada:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível carregar o passe de temporada.' });
  }
}

async function handleSeasonClaim(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para resgatar as recompensas do passe.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const level = Number(body.level);
    // track: 'all' resgata a trilha gratuita e a premium de uma vez
    // (é o que o botão único do passe usa).
    const track = body.track === 'premium' ? 'premium'
      : body.track === 'free' ? 'free'
        : 'all';
    const premium = await isPremiumPlayer(user.id);

    const outcome = await db.updatePlayerProgress(user.id, (progress) => {
      const hasPremiumPass = shop.hasPremiumPass(progress.shopState, season.currentSeason(new Date()).id);
      const options = { now: new Date(), isPremium: premium, hasPremiumPass };
      return track === 'all'
        ? season.claimLevelRewards(progress, level, options)
        : season.claimLevelReward(progress, level, track, options);
    });
    const view = season.describeSeason(outcome.progress, new Date(), { isPremium: premium });

    if (!outcome.ok) {
      sendJson(response, 409, { error: outcome.error, season: view });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      reward: outcome.reward,
      rewards: outcome.rewards || (outcome.reward ? [outcome.reward] : []),
      season: view
    });
  } catch (error) {
    console.error('[passe] erro ao resgatar o nível:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível resgatar a recompensa do nível.' });
  }
}

/* -------------------------------------------------------------
   LOJA — catálogo, compras, baús e pacotes de Cristais
   As regras (preço, moeda, efeito) ficam em shop.js; aqui só
   autenticamos, sanitizamos e persistimos.

   Duas moedas:
   - LUDAS   (coins): gratuita, conquistada jogando.
   - CRISTAIS (crystals): premium, comprada via Pix.
   Ludas nunca compram Cristais e Cristais nunca viram Ludas.
   ------------------------------------------------------------- */

async function handleShopOverview(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para abrir a loja.' });
    return;
  }

  try {
    const progress = await db.getPlayerProgress(user.id);
    const current = season.currentSeason(new Date());
    const view = shop.describeShop(progress, new Date(), { seasonId: current.id });
    sendJson(response, 200, view);
  } catch (error) {
    console.error('[loja] erro ao carregar a loja:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível carregar a loja. Tente novamente.' });
  }
}

async function handleShopBuy(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para comprar na loja.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const itemId = String(body.itemId || '').trim().slice(0, 32);
    const current = season.currentSeason(new Date());

    const outcome = await db.updatePlayerProgress(user.id, (progress) => (
      shop.purchaseItem(progress, itemId, { now: new Date(), seasonId: current.id })
    ));
    const view = shop.describeShop(outcome.progress, new Date(), { seasonId: current.id });
    const progress = rewards.describeProgress(outcome.progress, new Date());

    if (!outcome.ok) {
      sendJson(response, 409, { error: outcome.error, shop: view });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      item: outcome.item,
      spent: outcome.spent,
      shop: view,
      progress
    });
  } catch (error) {
    console.error('[loja] erro ao comprar o item:', error && error.message);
    sendJson(response, 400, { error: error.message || 'Não foi possível concluir a compra.' });
  }
}

async function handleShopEquip(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para equipar itens.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const itemId = String(body.itemId || '').trim().slice(0, 32);
    const current = season.currentSeason(new Date());

    const outcome = await db.updatePlayerProgress(user.id, (progress) => {
      if (!itemId) {
        // Sem item: desequipa o slot informado
        const slot = String(body.slot || '').trim().slice(0, 16);
        const state = shop.ensureShopState(progress.shopState);
        if (!state.equipped[slot]) {
          return { ok: false, error: 'Nada equipado neste slot.', progress };
        }
        const fallback = shop.ITEMS.find(item => item.slot === slot && item.currency === 'free');
        const equipped = { ...state.equipped };
        equipped[slot] = fallback ? fallback.id : null;
        return {
          ok: true,
          error: null,
          item: fallback ? shop.describeItem(fallback, { ...state, equipped }, {
            ludas: Number(progress.coins) || 0,
            crystals: Number(progress.crystals) || 0
          }) : null,
          progress: { ...progress, shopState: { ...state, equipped } }
        };
      }
      return shop.equipItem(progress, itemId);
    });

    const view = shop.describeShop(outcome.progress, new Date(), { seasonId: current.id });
    if (!outcome.ok) {
      sendJson(response, 409, { error: outcome.error, shop: view });
      return;
    }
    sendJson(response, 200, { ok: true, item: outcome.item || null, shop: view });
  } catch (error) {
    console.error('[loja] erro ao equipar o item:', error && error.message);
    sendJson(response, 400, { error: error.message || 'Não foi possível equipar o item.' });
  }
}

async function handleShopChest(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para abrir baús.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const chestId = String(body.chest || '').trim().slice(0, 16);
    const current = season.currentSeason(new Date());

    const outcome = await db.updatePlayerProgress(user.id, (progress) => (
      shop.openChest(progress, chestId, { now: new Date() })
    ));
    const view = shop.describeShop(outcome.progress, new Date(), { seasonId: current.id });
    const progress = rewards.describeProgress(outcome.progress, new Date());

    if (!outcome.ok) {
      sendJson(response, 409, { error: outcome.error, shop: view });
      return;
    }
    sendJson(response, 200, { ok: true, reward: outcome.reward, shop: view, progress });
  } catch (error) {
    console.error('[loja] erro ao abrir o baú:', error && error.message);
    sendJson(response, 400, { error: error.message || 'Não foi possível abrir o baú.' });
  }
}

/* -------------------------------------------------------------
   PACOTES DE CRISTAIS (Pix)
   O pacote é resolvido no servidor: o cliente manda só o id.
------------------------------------------------------------- */

function shopGatewayReady() {
  if (!PIX_GATEWAY) return false;
  if (PIX_GATEWAY === 'mercadopago' && !PIX_API_TOKEN) return false;
  if (PIX_GATEWAY === 'pixkey' && !PIX_KEY) return false;
  if (PIX_GATEWAY === 'stub' && NODE_ENV === 'production') return false;
  return true;
}

// Gera a cobrança Pix de um produto da loja (pacote de Cristais)
async function createShopCharge(user, pkg) {
  const paymentId = generatePaymentId();
  const expiresAt = new Date(Date.now() + PAYMENT_EXPIRY_MINUTES * 60 * 1000).toISOString();
  const amount = pkg.priceBrl;

  let qrCode = '';
  let copyPaste = '';
  let gatewayRef = '';

  if (PIX_GATEWAY === 'mercadopago') {
    const notificationUrl = PUBLIC_URL ? `${PUBLIC_URL}/api/shop/webhook` : undefined;
    const created = await pix.createMercadoPagoPayment({
      token: PIX_API_TOKEN,
      amount,
      description: `${pkg.total} Cristais LUUD - ${pkg.name}`,
      email: user.email,
      externalReference: paymentId,
      notificationUrl,
      metadata: { user_id: user.id, payment_id: paymentId, product_id: pkg.id, product_amount: pkg.total }
    });
    qrCode = created.qrCode || '';
    copyPaste = created.copyPaste || '';
    gatewayRef = created.id || '';
  } else {
    const isTestMode = PIX_GATEWAY === 'stub';
    const key = isTestMode ? 'luud.cristais@pix.test' : (PIX_KEY || 'luud.cristais@pix.test');
    copyPaste = pix.buildPixPayload({
      key,
      name: PIX_MERCHANT_NAME,
      city: PIX_MERCHANT_CITY,
      amount,
      txid: paymentId
    });
    gatewayRef = paymentId;
  }

  return db.createPayment({
    id: paymentId,
    userId: user.id,
    gateway: PIX_GATEWAY,
    amount,
    status: 'pending',
    gatewayRef,
    copyPaste,
    qrCode,
    expiresAt,
    productType: 'crystals',
    productId: pkg.id,
    productAmount: pkg.total
  });
}

async function handleShopCheckout(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para comprar Cristais.' });
    return;
  }

  const body = await readJsonBody(request);
  const packageId = String(body.packageId || '').trim().slice(0, 32);
  const pkg = shop.CRYSTAL_PACKAGES.find(item => item.id === packageId);
  if (!pkg) {
    sendJson(response, 400, { error: 'Pacote de Cristais desconhecido.' });
    return;
  }

  if (!shopGatewayReady()) {
    sendJson(response, 503, { error: 'O pagamento via Pix ainda não está disponível.' });
    return;
  }

  try {
    const payment = await createShopCharge(user, pkg);
    sendJson(response, 200, {
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: 'BRL',
        status: payment.status,
        qrCode: payment.qrCode,
        copyPaste: payment.copyPaste,
        expiresAt: payment.expiresAt,
        gateway: payment.gateway,
        testMode: PIX_GATEWAY === 'stub'
      },
      package: {
        id: pkg.id,
        name: pkg.name,
        total: pkg.total,
        priceBrl: pkg.priceBrl
      }
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message || 'Não foi possível gerar a cobrança Pix.' });
  }
}

/* Entrega os Cristais de uma cobrança paga.
   A entrega acontece dentro de updatePlayerProgress (transação com
   lock), e o id da cobrança fica guardado no estado: mesmo que o
   webhook e a verificação cheguem juntos, os Cristais entram uma vez. */
async function deliverCrystalPackage(payment) {
  if (!payment) return { delivered: false, payment };
  const pkg = shop.CRYSTAL_PACKAGES.find(item => item.id === payment.productId);
  if (!pkg) return { delivered: false, payment };

  const amount = Math.max(0, Math.floor(Number(payment.productAmount) || 0)) || pkg.total;

  const outcome = await db.updatePlayerProgress(payment.userId, (progress) => {
    const state = shop.ensureShopState(progress.shopState);
    const delivered = Array.isArray(state.deliveredOrders) ? state.deliveredOrders : [];
    if (delivered.includes(payment.id)) {
      return { ok: false, duplicate: true, progress, deliveredOrders: delivered };
    }
    const next = {
      ...progress,
      crystals: (Number(progress.crystals) || 0) + amount,
      shopState: {
        ...state,
        // A lista de pedidos entregues é a trava de idempotência:
        // guarda os últimos 200 pedidos (o webhook e a verificação
        // podem chegar ao mesmo tempo).
        deliveredOrders: delivered.concat(payment.id).slice(-200)
      }
    };
    return { ok: true, duplicate: false, progress: next };
  });

  if (!outcome.ok) {
    return { delivered: true, duplicate: true, payment };
  }

  await db.updatePayment(payment.id, {
    status: 'paid',
    paidAt: payment.paidAt || new Date().toISOString(),
    deliveredAt: new Date().toISOString()
  });
  return { delivered: true, duplicate: false, payment: await db.getPayment(payment.id) };
}

// Consulta o gateway de uma cobrança de Cristais
async function refreshShopPaymentStatus(payment) {
  if (!payment || payment.status === 'paid') return payment;

  if (payment.gateway === 'mercadopago' && PIX_API_TOKEN && payment.gatewayRef) {
    const data = await pix.getMercadoPagoPayment({ token: PIX_API_TOKEN, paymentId: payment.gatewayRef });
    if (data && data.status === 'approved') {
      await deliverCrystalPackage(payment);
      return db.getPayment(payment.id);
    }
    if (data && data.status && data.status !== 'pending') {
      return db.updatePayment(payment.id, { status: data.status });
    }
  }

  if (payment.gateway === 'pixkey') return payment;

  if (payment.expiresAt && new Date(payment.expiresAt).getTime() < Date.now() && payment.status === 'pending') {
    return db.updatePayment(payment.id, { status: 'expired' });
  }

  return payment;
}

async function handleShopStatus(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const paymentId = requestUrl.searchParams.get('id');

  try {
    let payment = null;
    try {
      payment = paymentId ? await db.getPayment(paymentId) : null;
      if (payment && !isCrystalPayment(payment)) payment = null;
      if (!payment && !paymentId) {
        const payments = await db.listPaymentsForUser(user.id);
        const crystalPayments = payments.filter(isCrystalPayment);
        payment = crystalPayments.find(item => item.status === 'pending')
          || crystalPayments[0]
          || null;
      }
    } catch (paymentError) {
      console.error('[loja] não foi possível consultar as cobranças:', paymentError.message);
      payment = null;
    }

    if (payment && payment.userId !== user.id) {
      sendJson(response, 403, { error: 'Cobrança não encontrada.' });
      return;
    }

    if (payment) payment = await refreshShopPaymentStatus(payment);

    const progress = await db.getPlayerProgress(user.id);
    const current = season.currentSeason(new Date());

    sendJson(response, 200, {
      status: payment ? payment.status : 'none',
      paid: Boolean(payment && payment.status === 'paid'),
      crystals: Math.max(0, Number(progress.crystals) || 0),
      payment: payment ? {
        id: payment.id,
        amount: payment.amount,
        status: payment.status,
        expiresAt: payment.expiresAt,
        qrCode: payment.qrCode,
        copyPaste: payment.copyPaste,
        productId: payment.productId,
        productAmount: payment.productAmount
      } : null,
      shop: shop.describeShop(progress, new Date(), { seasonId: current.id })
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Confirmação manual (somente em desenvolvimento/testes)
async function handleShopDevConfirm(request, response) {
  if (NODE_ENV === 'production' || PIX_GATEWAY !== 'stub') {
    sendJson(response, 404, { error: 'Rota indisponível.' });
    return;
  }

  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Sessão expirada.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const paymentId = String(body.id || '').trim().slice(0, 80);
    const payment = await db.getPayment(paymentId);
    if (!payment || payment.userId !== user.id) {
      sendJson(response, 404, { error: 'Cobrança não encontrada.' });
      return;
    }
    if (!isCrystalPayment(payment)) {
      sendJson(response, 409, { error: 'Esta cobrança não é de Cristais.' });
      return;
    }

    await deliverCrystalPackage(payment);
    const progress = await db.getPlayerProgress(user.id);
    const current = season.currentSeason(new Date());

    sendJson(response, 200, {
      ok: true,
      crystals: Math.max(0, Number(progress.crystals) || 0),
      shop: shop.describeShop(progress, new Date(), { seasonId: current.id })
    });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

// Webhook do gateway: entrega o pacote quando o pagamento é aprovado
async function handleShopWebhook(request, response) {
  try {
    const body = await readJsonBody(request);
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const payload = body && body.data && body.data.id ? body.data : body;
    const gatewayRef = String(
      requestUrl.searchParams.get('data.id')
      || requestUrl.searchParams.get('id')
      || payload.id
      || ''
    ).trim();
    if (!gatewayRef) {
      sendJson(response, 400, { error: 'Pagamento não identificado.' });
      return;
    }

    const payment = await db.findPaymentByGatewayRef(gatewayRef);
    if (!payment || !isCrystalPayment(payment)) {
      sendJson(response, 404, { error: 'Cobrança não encontrada.' });
      return;
    }

    // Assinatura do Mercado Pago: mesma conferência do webhook Premium
    const signature = request.headers['x-signature'];
    const requestId = request.headers['x-request-id'];
    if (!pix.verifyMercadoPagoSignature({
      secret: PIX_WEBHOOK_SECRET,
      signatureHeader: signature,
      requestId,
      paymentId: gatewayRef
    })) {
      sendJson(response, 401, { error: 'Assinatura inválida.' });
      return;
    }

    if (PIX_GATEWAY === 'mercadopago' && PIX_API_TOKEN) {
      const data = await pix.getMercadoPagoPayment({ token: PIX_API_TOKEN, paymentId: gatewayRef });
      if (!data || data.status !== 'approved') {
        sendJson(response, 202, { ok: true, delivered: false });
        return;
      }
    } else if (PIX_GATEWAY === 'pixkey') {
      // No modo 'pixkey' não existe gateway para confirmar o pagamento:
      // a entrega é feita pela confirmação manual do administrador
      // (POST /api/premium/admin/confirm). Nunca entrega sem conferir.
      sendJson(response, 202, { ok: true, delivered: false, manualConfirmation: true });
      return;
    }

    await deliverCrystalPackage(payment);
    sendJson(response, 200, { ok: true, delivered: true });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
}

/* -------------------------------------------------------------
   TORNEIOS COM HORÁRIO MARCADO (roadmap #10)
   Torneios eliminatórios (8 ou 16 jogadores) em horário fixo.
   O servidor é responsável por: receber as inscrições, agendar o
   início da edição, criar as salas 1x1 do chaveamento, avançar o
   vencedor e pagar a premiação em moedas.
------------------------------------------------------------- */

const TOURNAMENT_TICK_MS = 30000;
let tournamentSchedulerBusy = false;
let tournamentKickTimer = null;

// Carrega (ou cria) a edição de um torneio a partir do id informado
async function ensureTournamentEdition(editionId) {
  const resolved = tournaments.resolveEditionId(editionId);
  if (!resolved) return null;
  let edition = await db.getTournamentEdition(resolved.id);
  const expectedStart = new Date(resolved.startsAt).getTime();

  if (edition) {
    // Edição salva com outro horário (dado antigo): recria no horário
    // oficial da definição, preservando as inscrições apenas se a
    // edição ainda nem começou.
    const storedStart = new Date(edition.startsAt).getTime();
    if (edition.status === 'scheduled' && storedStart !== expectedStart) {
      const fresh = tournaments.createEdition(resolved.definition, resolved.startsAt, resolved.dayKey);
      fresh.entrants = Array.isArray(edition.entrants) ? edition.entrants : [];
      edition = fresh;
      await db.saveTournamentEdition(edition);
    }
    return { edition, definition: resolved.definition };
  }

  edition = tournaments.createEdition(resolved.definition, resolved.startsAt, resolved.dayKey);
  await db.saveTournamentEdition(edition);
  return { edition, definition: resolved.definition };
}

function tournamentPlayerName(user) {
  if (!user) return 'Jogador';
  return String(user.playerName || user.name || user.email || 'Jogador').slice(0, 24);
}

// Avisa os participantes do torneio sobre o estado da edição
function notifyTournamentPlayers(edition, definition, payload, userIds) {
  const view = tournaments.describeEdition(edition, definition, new Date(), {});
  const targets = userIds || (edition.entrants || []).map(item => item.userId);
  targets.forEach(userId => {
    sendToUser(userId, { ...payload, tournament: view });
  });
}

async function handleTournamentList(request, response) {
  const user = await getSessionUser(request);
  const now = new Date();

  try {
    const editions = [];
    const upcoming = tournaments.upcomingEditions(now, 2);
    for (const item of upcoming) {
      const ensured = await ensureTournamentEdition(item.id);
      if (!ensured) continue;
      editions.push(tournaments.describeEdition(ensured.edition, ensured.definition, now, {
        userId: user ? user.id : null
      }));
    }

    // Edições em andamento (a partida do jogador pode estar esperando)
    const stored = await db.listTournamentEditions();
    stored.forEach(edition => {
      if (edition.status !== 'running') return;
      const definition = tournaments.definitionById(edition.tournamentId);
      if (!definition) return;
      const already = editions.some(item => item.id === edition.id);
      if (already) return;
      editions.push(tournaments.describeEdition(edition, definition, now, {
        userId: user ? user.id : null
      }));
    });

    sendJson(response, 200, { editions, serverTime: now.toISOString() });
  } catch (error) {
    console.error('[torneios] erro ao listar os torneios:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível carregar os torneios. Tente novamente.' });
  }
}

async function handleTournamentRegister(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para se inscrever nos torneios.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const editionId = String(body.editionId || '').trim().slice(0, 64);
    const ensured = await ensureTournamentEdition(editionId);
    if (!ensured) {
      sendJson(response, 400, { error: 'Torneio inválido.' });
      return;
    }

    const outcome = tournaments.registerFor(
      ensured.edition,
      ensured.definition,
      user.id,
      tournamentPlayerName(user),
      new Date()
    );
    if (!outcome.ok) {
      sendJson(response, 409, {
        error: outcome.error,
        edition: tournaments.describeEdition(ensured.edition, ensured.definition, new Date(), { userId: user.id })
      });
      return;
    }

    // Entrada do torneio: 1 entrada grátis por tipo e dia. Quando a
    // grátis já foi usada, é preciso uma entrada comprada na loja.
    const entryType = ensured.definition.id === 'domingo' ? 'weekly' : 'daily';
    const entryOutcome = await db.updatePlayerProgress(user.id, (progress) => {
      const prepared = shop.prepareTournamentEntry(progress.shopState, entryType, new Date());
      if (!prepared.ok) return { ok: false, error: prepared.error, progress };
      return { ok: true, free: prepared.free, kind: prepared.kind, progress: { ...progress, shopState: prepared.state } };
    });
    if (!entryOutcome.ok) {
      sendJson(response, 409, {
        error: entryOutcome.error,
        edition: tournaments.describeEdition(ensured.edition, ensured.definition, new Date(), { userId: user.id })
      });
      return;
    }

    // Guarda qual entrada foi usada: se o jogador cancelar a
    // inscrição antes do torneio, a entrada volta para ele.
    const entrant = (ensured.edition.entrants || []).find(item => item.userId === user.id);
    if (entrant) {
      entrant.entry = {
        source: entryOutcome.free ? 'free' : 'paid',
        kind: entryOutcome.kind || 'free',
        tournamentType: entryType
      };
    }

    await db.saveTournamentEdition(ensured.edition);
    const view = tournaments.describeEdition(ensured.edition, ensured.definition, new Date(), { userId: user.id });
    sendJson(response, 200, { ok: true, edition: view, usedFreeEntry: Boolean(entryOutcome.free) });
  } catch (error) {
    console.error('[torneios] erro ao inscrever o jogador:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível concluir a inscrição. Tente novamente.' });
  }
}

async function handleTournamentUnregister(request, response) {
  const user = await getSessionUser(request);
  if (!user) {
    sendJson(response, 401, { error: 'Faça login com o Google para cancelar a inscrição.' });
    return;
  }

  try {
    const body = await readJsonBody(request);
    const editionId = String(body.editionId || '').trim().slice(0, 64);
    const ensured = await ensureTournamentEdition(editionId);
    if (!ensured) {
      sendJson(response, 400, { error: 'Torneio inválido.' });
      return;
    }

    // Entrada usada na inscrição (para devolver se o jogador cancelar)
    const entrant = (ensured.edition.entrants || []).find(item => item.userId === user.id);

    const outcome = tournaments.unregisterFrom(ensured.edition, user.id, new Date());
    if (!outcome.ok) {
      sendJson(response, 409, {
        error: outcome.error,
        edition: tournaments.describeEdition(ensured.edition, ensured.definition, new Date(), { userId: user.id })
      });
      return;
    }

    await db.saveTournamentEdition(ensured.edition);

    // Devolve a entrada (grátis do dia ou comprada na loja)
    let refunded = false;
    if (entrant && entrant.entry) {
      try {
        await db.updatePlayerProgress(user.id, (progress) => {
          const refund = shop.refundTournamentEntry(progress.shopState, entrant.entry, new Date());
          if (!refund.ok) return { ok: false, progress };
          return { ok: true, progress: { ...progress, shopState: refund.state } };
        });
        refunded = true;
      } catch (refundError) {
        console.error('[torneios] erro ao devolver a entrada:', refundError && refundError.message);
      }
    }

    const view = tournaments.describeEdition(ensured.edition, ensured.definition, new Date(), { userId: user.id });
    sendJson(response, 200, { ok: true, edition: view, entryRefunded: refunded });
  } catch (error) {
    console.error('[torneios] erro ao cancelar a inscrição:', error && error.message);
    sendJson(response, 500, { error: 'Não foi possível cancelar a inscrição. Tente novamente.' });
  }
}

/* --- Agendador: inicia as edições na hora e monta as partidas ------ */

async function startTournamentEdition(edition, now) {
  const definition = tournaments.definitionById(edition.tournamentId);
  if (!definition) return;

  const entrants = Array.isArray(edition.entrants) ? edition.entrants : [];
  if (entrants.length < 2) {
    edition.status = 'cancelled';
    edition.cancelReason = 'Poucos jogadores inscritos.';
    edition.finishedAt = now.toISOString();
    await db.saveTournamentEdition(edition);
    notifyTournamentPlayers(edition, definition, { type: 'tournament_cancelled' });
    return;
  }

  tournaments.buildBracket(edition);
  edition.status = 'running';
  edition.startedAt = now.toISOString();
  tournaments.resolveByes(edition);
  await db.saveTournamentEdition(edition);

  notifyTournamentPlayers(edition, definition, { type: 'tournament_started' });
  await tryStartTournamentMatches(edition);
}

// Cria as salas 1x1 dos confrontos prontos (ambos os jogadores online)
async function tryStartTournamentMatches(edition) {
  const definition = tournaments.definitionById(edition.tournamentId);
  if (!definition || edition.status !== 'running') return;

  const rounds = Array.isArray(edition.rounds) ? edition.rounds : [];
  let changed = false;

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    for (const match of rounds[roundIndex]) {
      if (!match) continue;

      // Recuperação: a sala do confronto sumiu (os dois saíram) antes do
      // resultado — o confronto volta para a fila para ser recriado.
      if (match.status === 'playing' && match.roomCode && !rooms.has(match.roomCode)) {
        match.status = 'pending';
        match.roomCode = null;
        changed = true;
      }

      if (match.status !== 'pending' || !match.a || !match.b) continue;

      const wsA = findUserSocket(match.a.userId);
      const wsB = findUserSocket(match.b.userId);
      if (!wsA || !wsB) {
        // Oponente ainda não conectou: avisa quem está online que a
        // partida do torneio está esperando o adversário.
        sendToUser(match.a.userId, { type: 'tournament_match_waiting' });
        sendToUser(match.b.userId, { type: 'tournament_match_waiting' });
        continue;
      }

      // Sai de qualquer sala anterior antes de criar a sala do torneio
      detachFromRoom(wsA);
      detachFromRoom(wsB);

      const room = await startQuickMatchRoom(
        { ws: wsA, uid: match.a.userId, name: match.a.name },
        { ws: wsB, uid: match.b.userId, name: match.b.name },
        'tournament',
        { tournament: { editionId: edition.id, roundIndex, matchIndex: match.index } }
      );
      if (!room) continue;

      match.status = 'playing';
      match.roomCode = room.code;
      changed = true;

      sendToUser(match.a.userId, { type: 'tournament_match_ready', round: roundIndex });
      sendToUser(match.b.userId, { type: 'tournament_match_ready', round: roundIndex });
    }
  }

  if (changed) await db.saveTournamentEdition(edition);
}

// Índice do vencedor da sala (1x1 do torneio)
function tournamentWinnerIndex(room, state) {
  const winner = state ? state.winner : null;
  if (typeof winner === 'number' && (winner === 0 || winner === 1)) return winner;
  if (winner && typeof winner.team === 'number') return winner.team;
  const colors = Array.isArray(room.slotColors) ? room.slotColors : [];
  const scoreA = Number(state && state.scores && state.scores[colors[0]]) || 0;
  const scoreB = Number(state && state.scores && state.scores[colors[1]]) || 0;
  if (scoreA === scoreB) return null;
  return scoreA > scoreB ? 0 : 1;
}

// Resultado da partida do torneio: avança o vencedor na chave
async function applyTournamentMatchResult(room, state) {
  if (!room || room.mode !== 'tournament' || !room.tournament || !state) return;

  const { editionId, roundIndex, matchIndex } = room.tournament;
  const uids = Array.isArray(room.userIds) ? room.userIds : [];
  if (uids.length < 2) return;

  const winnerIdx = tournamentWinnerIndex(room, state);
  if (winnerIdx === null) return;
  const winnerId = uids[winnerIdx];
  const loserId = uids[winnerIdx === 0 ? 1 : 0];
  if (!winnerId || !loserId) return;

  try {
    const edition = await db.getTournamentEdition(editionId);
    if (!edition) return;
    const definition = tournaments.definitionById(edition.tournamentId);
    if (!definition) return;

    const round = Array.isArray(edition.rounds) ? edition.rounds[roundIndex] : null;
    const match = round ? round[matchIndex] : null;
    if (!match || match.status === 'finished' || match.status === 'empty') return;

    // Colocação de quem foi eliminado nesta rodada
    const range = tournaments.placementRange(edition.size, roundIndex);
    edition.placements = edition.placements && typeof edition.placements === 'object' ? edition.placements : {};
    edition.placements[loserId] = { from: range.from, to: range.to, round: roundIndex };

    const winner = tournaments.playerById(edition, winnerId) || match.a || match.b;
    tournaments.advanceFromMatch(edition, roundIndex, matchIndex, winner);
    tournaments.resolveByes(edition);
    await db.saveTournamentEdition(edition);

    const view = tournaments.describeEdition(edition, definition, new Date(), {});
    sendToUser(winnerId, { type: 'tournament_match_result', won: true, tournament: view });
    sendToUser(loserId, {
      type: 'tournament_match_result',
      won: false,
      placement: range,
      tournament: view
    });

    if (edition.status === 'finished') {
      await awardTournamentPrizes(edition, definition);
    } else {
      await tryStartTournamentMatches(edition);
    }
  } catch (error) {
    console.error('[torneios] erro ao aplicar o resultado da partida:', error && error.message);
  }
}

// Desistência em partida de torneio: quem ficou vence por 4-0
function applyTournamentAbandonResult(room, leaverIdx) {
  if (!room || room.mode !== 'tournament') return;
  if (leaverIdx !== 0 && leaverIdx !== 1) return;

  const state = room.game;
  if (!state || !state.started || state.over) return;

  const winnerIdx = leaverIdx === 0 ? 1 : 0;
  state.over = true;
  state.winner = winnerIdx;

  const colors = Array.isArray(room.slotColors) ? room.slotColors : [];
  if (colors[0] && colors[1]) {
    state.scores[colors[winnerIdx]] = 4;
    state.scores[colors[leaverIdx]] = 0;
  }

  applyTournamentMatchResult(room, state).catch(error => {
    console.error('[torneios] erro ao aplicar o abandono:', error && error.message);
  });
}

// Paga a premiação em moedas de cada participante
async function awardTournamentPrizes(edition, definition) {
  const prizes = {};
  const placements = edition.placements && typeof edition.placements === 'object' ? edition.placements : {};

  for (const entrant of (edition.entrants || [])) {
    let place = null;
    if (entrant.userId === edition.winnerId) place = 1;
    else if (placements[entrant.userId]) place = placements[entrant.userId].from;
    if (!place) continue;

    const coins = tournaments.prizeForPlace(definition, place);
    if (!coins) continue;
    // Conta Premium recebe a premiação em dobro (roadmap #20)
    let premium = false;
    try {
      premium = await isPremiumPlayer(entrant.userId);
    } catch (error) {
      premium = false;
    }
    const prizeCoins = premium ? coins * 2 : coins;
    prizes[entrant.userId] = prizeCoins;

    try {
      await db.updatePlayerProgress(entrant.userId, (progress) => {
        progress.coins = (Number(progress.coins) || 0) + prizeCoins;
        return { ok: true, progress };
      });
    } catch (error) {
      console.error('[torneios] erro ao pagar a premiação:', error && error.message);
    }
  }

  edition.prizesPaid = prizes;
  await db.saveTournamentEdition(edition);

  const view = tournaments.describeEdition(edition, definition, new Date(), {});
  (edition.entrants || []).forEach(entrant => {
    sendToUser(entrant.userId, {
      type: 'tournament_finished',
      prize: prizes[entrant.userId] || 0,
      winner: entrant.userId === edition.winnerId,
      tournament: view
    });
  });
}

// Verifica as edições a cada intervalo: inicia as que já chegaram no horário
async function runTournamentScheduler() {
  if (tournamentSchedulerBusy) return;
  tournamentSchedulerBusy = true;
  try {
    const now = new Date();
    const editions = await db.listTournamentEditions();

    for (const edition of editions) {
      if (edition.status !== 'scheduled') continue;
      const startsAt = new Date(edition.startsAt).getTime();
      if (!Number.isFinite(startsAt) || startsAt > now.getTime()) continue;
      await startTournamentEdition(edition, now);
    }

    for (const edition of editions) {
      if (edition.status !== 'running') continue;
      await tryStartTournamentMatches(edition);
    }
  } catch (error) {
    console.error('[torneios] erro no agendador:', error && error.message);
  } finally {
    tournamentSchedulerBusy = false;
  }
}

// Dispara o agendador (com atraso) quando um jogador entra no jogo:
// assim a partida pendente dele começa assim que o adversário aparecer
function kickTournamentScheduler() {
  if (tournamentKickTimer) return;
  tournamentKickTimer = setTimeout(() => {
    tournamentKickTimer = null;
    runTournamentScheduler();
  }, 1500);
}

/* -------------------------------------------------------------
   MENSAGENS RÁPIDAS / EMOTES (roadmap #14)
   O cliente só pode enviar frases da lista abaixo: o servidor
   valida e repassa para a sala, então ninguém digita texto livre
   durante a partida.
------------------------------------------------------------- */

const QUICK_CHAT_MESSAGES = new Set([
  'Boa! 🎉',
  'Puts! 😤',
  'Vamos! 🔥',
  'Quase! 😮',
  'GG! 👏',
  'Lindo! 😎',
  'Valeu! 🙏',
  '👍',
  // Pacotes de emotes da loja (COS-026, COS-027 e COS-028)
  'Socorro! 🆘', 'Reverte! 🔄', 'Ladrão! 🤫', 'Eu sabia! 😏', 'Azar! 🍀',
  'Mão de Deus! 🙏', 'Calma! 😌', 'Foco! 🎯',
  'Gol! ⚽', 'Gols! 🥅', 'Festa! 🎉', 'Chopp! 🍺', 'Samba! 💃', 'Roxo! 💜',
  'Tricolor! 💚', 'Alô? 📞', 'Craque! ⭐', 'Penta! 🖐️',
  'Lendário! 🐉', 'Coroa! 👑', 'Diamante! 💎', 'Trovão! ⚡', 'Fênix! 🔥',
  'Meteoro! ☄️', 'Dragão! 🐲', 'Estrela! 🌟', 'Tempestade! 🌪️', 'Eclipse! 🌑',
  'Infinito! ♾️', 'Poder! 💪'
]);

// Intervalo mínimo entre duas mensagens do mesmo jogador (anti-spam)
const QUICK_CHAT_MIN_INTERVAL_MS = 900;

function handleQuickChat(ws, conn, room, data) {
  const text = String((data && data.text) || '').trim().slice(0, 24);
  // Fora da lista: ignorado em silêncio (não interfere no dado/jogada)
  if (!QUICK_CHAT_MESSAGES.has(text)) return;

  const now = Date.now();
  if (now - (conn.lastQuickChatAt || 0) < QUICK_CHAT_MIN_INTERVAL_MS) return;
  conn.lastQuickChatAt = now;

  const slot = Number(conn.playerIdx);
  broadcastRoom(room.code, {
    type: 'quick_chat',
    slot,
    text,
    name: room.names[slot] || 'Jogador'
  });
}

/* -------------------------------------------------------------
   REVANCHE EM UM CLIQUE (roadmap #13)
   Ao fim de uma partida online 1x1, o jogador propõe revanche:
   o servidor valida o pedido, avisa o oponente e, com o aceite,
   remonta a MESMA mesa (mesma sala, mesmos jogadores e cores).
------------------------------------------------------------- */

const REMATCH_TIMEOUT_MS = 30000;

// Só o 1x1 comum aceita revanche: a Liga e o Torneio têm progressão
// própria (pontos, tier e chaveamento) e não podem ser repetidos.
function modeSupportsRematch(room) {
  if (!room) return false;
  return room.mode === 'solo' || room.mode === 'quick';
}

function rematchPlayersOnline(room) {
  if (!room || !Array.isArray(room.players)) return false;
  return Boolean(room.players[0] && room.players[1]
    && room.players[0].readyState === 1 && room.players[1].readyState === 1);
}

function clearRematchState(room) {
  if (!room || !room.rematch) return;
  if (room.rematch.timer) clearTimeout(room.rematch.timer);
  room.rematch = null;
}

// Monta a lista de jogadores no mesmo formato do 'room_ready'
async function buildRematchPlayers(room) {
  const profile0 = await db.getUserProfile(room.userIds[0]) || {
    id: room.userIds[0] || null, uid: room.userIds[0] || null,
    name: room.names[0], email: '', picture: '', playerName: room.names[0]
  };
  const profile1 = await db.getUserProfile(room.userIds[1]) || {
    id: room.userIds[1] || null, uid: room.userIds[1] || null,
    name: room.names[1], email: '', picture: '', playerName: room.names[1]
  };
  const soloColors = room.soloColors || await resolveSoloMatchColors([room.userIds[0], room.userIds[1]]);
  return [
    {
      id: 0, uid: profile0.uid, name: profile0.name, email: profile0.email,
      picture: profile0.picture, playerName: profile0.playerName, color: soloColors.starterColor
    },
    {
      id: 1, uid: profile1.uid, name: profile1.name, email: profile1.email,
      picture: profile1.picture, playerName: profile1.playerName, color: soloColors.opponentColor
    }
  ];
}

/* -------------------------------------------------------------
   REVANCHE (roadmap #13 / item CON-001 da loja)
   Por padrão, cada conta pode pedir 3 revanches por dia. Quem
   compra "Revanche Ilimitada 7 dias" (CON-001) fica sem limite
   durante o período do item. O contador é do servidor: o cliente
   não pode burlar o limite.
------------------------------------------------------------------ */
const REMATCH_DAILY_LIMIT = 3;
const REMATCH_USAGE = new Map(); // userId -> { date, count }

function brazilDayKey(now) {
  const stamp = (now instanceof Date) ? now.getTime() : new Date(now || Date.now()).getTime();
  // Fuso do Brasil (UTC-3): o dia do jogo começa às 00h de Brasília
  const shifted = new Date(stamp - 180 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function rematchUsageFor(userId, now) {
  const key = String(userId || '');
  if (!key) return { date: '', count: 0 };
  const today = brazilDayKey(now);
  const current = REMATCH_USAGE.get(key);
  if (!current || current.date !== today) return { date: today, count: 0 };
  return current;
}

function registerRematchUsage(userId, now) {
  const key = String(userId || '');
  if (!key) return;
  const today = brazilDayKey(now);
  const current = rematchUsageFor(key, now);
  REMATCH_USAGE.set(key, { date: today, count: current.count + 1 });
}

// Pedido de revanche: quem pede propõe, o oponente decide
async function handleRematchRequest(ws, conn, room) {
  const playerIdx = Number(conn.playerIdx);
  if (!modeSupportsRematch(room) || (playerIdx !== 0 && playerIdx !== 1)) {
    sendTo(ws, { type: 'rematch_error', error: 'Revanche indisponível nesta partida.' });
    return;
  }
  if (!room.game || !room.game.over) {
    sendTo(ws, { type: 'rematch_error', error: 'A revanche só pode ser pedida depois que a partida termina.' });
    return;
  }
  if (!rematchPlayersOnline(room)) {
    sendTo(ws, { type: 'rematch_error', error: 'O oponente não está mais conectado.' });
    return;
  }

  // Limite diário de revanches (liberado pelo item CON-001 da loja)
  const userId = conn.userId || null;
  if (userId) {
    let unlimited = false;
    try {
      const progress = await db.getPlayerProgress(userId);
      unlimited = shop.hasUnlimitedRematch(progress.shopState, new Date());
    } catch (error) {
      console.error('[revanche] erro ao consultar o limite diário:', error && error.message);
    }
    if (!unlimited) {
      const usage = rematchUsageFor(userId, new Date());
      if (usage.count >= REMATCH_DAILY_LIMIT) {
        sendTo(ws, {
          type: 'rematch_error',
          error: `Você usou suas ${REMATCH_DAILY_LIMIT} revanches de hoje. Na LOJA, "Revanche Ilimitada 7 dias" remove o limite.`
        });
        return;
      }
      registerRematchUsage(userId, new Date());
    }
  }

  const opponentIdx = otherPlayerIndex(playerIdx);
  clearRematchState(room);

  const timer = setTimeout(() => {
    if (!room.rematch) return;
    room.rematch = null;
    broadcastRoom(room.code, { type: 'rematch_expired' });
  }, REMATCH_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  room.rematch = { from: playerIdx, to: opponentIdx, timer };

  sendTo(ws, { type: 'rematch_pending' });
  sendTo(room.players[opponentIdx], {
    type: 'rematch_offer',
    from: playerIdx,
    name: room.names[playerIdx] || 'Oponente'
  });
}

// Resposta do oponente: aceitar remonta a mesma mesa
async function handleRematchResponse(ws, conn, room, data) {
  const playerIdx = Number(conn.playerIdx);
  const pending = room.rematch;
  if (!pending || pending.to !== playerIdx) {
    sendTo(ws, { type: 'rematch_error', error: 'Não há pedido de revanche pendente.' });
    return;
  }
  clearRematchState(room);

  const accept = Boolean(data && data.accept === true);
  if (!accept) {
    sendTo(ws, { type: 'rematch_declined' });
    sendTo(room.players[pending.from], { type: 'rematch_declined' });
    return;
  }

  if (!modeSupportsRematch(room) || !rematchPlayersOnline(room)) {
    broadcastRoom(room.code, { type: 'rematch_error', error: 'Não foi possível iniciar a revanche.' });
    return;
  }

  // Remonta a partida na MESMA sala: novo estado autoritativo, mesma mesa
  const slots = Array.isArray(room.slotConfig) && room.slotConfig.length
    ? room.slotConfig
    : [
      { slot: 0, color: SOLO_SLOT_COLORS[0], team: 0 },
      { slot: 1, color: SOLO_SLOT_COLORS[1], team: 1 }
    ];
  setupRoomGame(room, { slots, mode: room.mode, target: 4 });

  const players = await buildRematchPlayers(room);
  broadcastRoom(room.code, {
    type: 'rematch_started',
    players,
    slotColors: room.slotColors,
    turn: room.game.turn,
    // A revanche joga na mesma mesa: mantém a velocidade (BLITZ/NORMAL)
    blitz: room.blitz === true
  });
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

  // Adiciona status online e a classificação da Liga (contas Premium)
  const friendsWithStatus = await Promise.all(friends.map(async (f) => {
    const premium = f.plan === 'premium' || f.isPaid === true;
    let standing = null;
    if (premium) {
      try {
        const raw = await db.getLeagueStanding(f.id);
        standing = league.describeStanding(raw || { tier: 'F', points: 0 });
      } catch (error) {
        console.error('[amigos] erro ao carregar a classificação:', error && error.message);
      }
    }

    // Feed de amigos: última partida do amigo. Quem comprou o item
    // SOC-016 ("Destaque de vitória") recebe a animação especial
    // quando a última partida foi uma vitória.
    let lastMatch = null;
    try {
      const records = await db.listMatchRecordsForUser(f.id);
      const record = (records && records.matches && records.matches[0]) || null;
      if (record) {
        let highlight = false;
        try {
          const friendProgress = await db.getPlayerProgress(f.id);
          highlight = shop.hasItem(friendProgress.shopState, 'SOC-016');
        } catch (error) {
          console.error('[amigos] erro ao verificar o destaque de vitória:', error && error.message);
        }
        lastMatch = {
          result: record.result,
          opponentName: record.opponentName || 'Oponente',
          finishedAt: record.finishedAt || null,
          highlight: highlight && record.result === 'win'
        };
      }
    } catch (error) {
      console.error('[amigos] erro ao carregar a última partida:', error && error.message);
    }

    return {
      ...f,
      plan: premium ? 'premium' : 'free',
      standing,
      lastMatch,
      online: userConnections.has(f.id) && userConnections.get(f.id).size > 0
    };
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

  const target = await db.getUserById(targetId);
  const premium = Boolean(target && (target.plan === 'premium' || target.isPaid === true));
  let standing = null;
  if (premium) {
    try {
      const raw = await db.getLeagueStanding(targetId);
      standing = league.describeStanding(raw || { tier: 'F', points: 0 });
    } catch (error) {
      console.error('[amigos] erro ao carregar a classificação:', error && error.message);
    }
  }

  const data = await db.listMatchRecordsForUser(targetId);
  sendJson(response, 200, {
    matches: data.matches,
    targetId,
    profile: target ? { id: target.id, plan: premium ? 'premium' : 'free', isPaid: premium } : null,
    standing
  });
}

/* -------------------------------------------------------------
   SERVIDOR ESTÁTICO E ROTAS
------------------------------------------------------------- */
function isSafePublicPath(urlPath) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  } catch (error) {
    // Sequência de escape inválida (ex.: %zz): trata como não encontrado
    return null;
  }
  const relativePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, relativePath);
  // O sufixo path.sep impede que um diretório irmão (ex.: public-evil)
  // passe na checagem de prefixo
  return filePath.startsWith(PUBLIC_DIR + path.sep) ? filePath : null;
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

    // Os ícones da guia (favicon) nunca podem ficar "presos" no cache do
    // navegador: são revalidados a cada carregamento para que uma nova
    // versão do ícone apareça assim que for publicada.
    const isFavicon = /favicon\.(ico|svg)$/i.test(filePath);

    // HTML, JS e CSS nunca ficam em cache longo: assim uma nova versão
    // publicada aparece imediatamente no navegador do usuário (sem precisar
    // recarregar com cache limpo). Só os demais arquivos (imagens, ícones)
    // aproveitam o cache longo.
    const cacheControl = NODE_ENV === 'production'
      ? (isFavicon
        ? 'no-cache'
        : (extension === '.html' || extension === '.js' || extension === '.css'
          ? 'no-store'
          : 'public, max-age=3600'))
      : 'no-store';

    // ETag simples (tamanho + data de modificação): o navegador revalida o
    // arquivo sem baixar o conteúdo de novo quando ele não mudou.
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, {
        'ETag': etag,
        'Cache-Control': cacheControl
      });
      response.end();
      return;
    }

    const data = await fs.readFile(filePath);

    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
      'ETag': etag
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

  // Rate limiting por IP: apenas rotas de API (login, perfil, partidas...).
  // Arquivos estáticos e o próprio HTML não contam: recarregar a tela
  // inicial dispara dezenas de pedidos de assets e estourava o limite
  // global, travando a página com HTTP 429.
  // x-forwarded-for só é aceito quando a conexão chega de um proxy local
  // (loopback): direto do cliente o header é forjável e zera o limite.
  const peer = request.socket?.remoteAddress || 'unknown';
  const forwarded = request.headers['x-forwarded-for'];
  const clientIp = (forwarded && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'))
    ? String(forwarded).split(',')[0].trim()
    : peer;
  if (urlPath.startsWith('/api/') && !checkHttpRateLimit(clientIp)) {
    sendJson(response, 429, { error: 'Muitas requisições. Tente novamente em um minuto.' });
    return;
  }

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

    // Endpoint para obter token CSRF (necessário para rotas mutáveis)
    if (request.method === 'GET' && urlPath === '/api/csrf-token') {
      const cookies = parseCookies(request);
      const sessionId = cookies[COOKIE_NAME];
      if (!sessionId) {
        sendJson(response, 401, { error: 'Sessão não encontrada.' });
        return;
      }
      const token = generateCsrfToken();
      csrfTokens.set(sessionId, { token, createdAt: Date.now() });
      sendJson(response, 200, { csrfToken: token });
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

    // LOGIN DE DESENVOLVIMENTO (conta RH de teste): só existe fora da
    // produção. No navegador redireciona para o jogo já logado.
    if (request.method === 'GET' && (urlPath === '/api/dev/login' || urlPath === '/dev/login')) {
      await handleDevLogin(request, response, requestUrl);
      return;
    }

    // Proteção CSRF para rotas mutáveis
    if (!checkCsrf(request)) {
      sendJson(response, 403, { error: 'Requisição bloqueada por política de origem (CSRF).' });
      return;
    }

    // CONTA PREMIUM (Pix)
    if (request.method === 'GET' && urlPath === '/api/premium/info') {
      await handlePremiumInfo(request, response);
      return;
    }

    // PROVA SOCIAL (roadmap #25): contadores públicos da tela inicial
    if (request.method === 'GET' && urlPath === '/api/stats') {
      await handleSocialStats(request, response);
      return;
    }

    // CLASSIFICAÇÃO DA LIGA (tier do jogador)
    if (request.method === 'GET' && urlPath === '/api/league/standing') {
      await handleLeagueStanding(request, response);
      return;
    }

    // REGRAS DA LIGA (tela explicativa do sistema de tiers).
    // Rota pública: o jogador precisa entender o tier antes de assinar.
    if (request.method === 'GET' && urlPath === '/api/league/guide') {
      sendJson(response, 200, { guide: league.describeGuide() });
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

    // ADMINISTRAÇÃO DO PREMIUM (confirmação manual do pagamento)
    if (request.method === 'POST' && urlPath === '/api/premium/admin/payments') {
      await handlePremiumAdminPayments(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/premium/admin/confirm') {
      await handlePremiumAdminConfirm(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/admin/clear-matches') {
      await handleClearAllMatches(request, response);
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

    // RECOMPENSAS — baú diário e missões (roadmap #6/#7)
    if (request.method === 'GET' && urlPath === '/api/progress') {
      await handleProgressOverview(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/progress/daily-reward') {
      await handleDailyRewardClaim(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/progress/match') {
      await handleMatchProgress(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/progress/mission') {
      await handleMissionClaim(request, response);
      return;
    }

    // PASSE DE BATALHA — 50 dias, tiedos à versão em curso (roadmap #9)
    if (request.method === 'GET' && urlPath === '/api/season') {
      await handleSeasonOverview(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/season/claim') {
      await handleSeasonClaim(request, response);
      return;
    }

    // LOJA — duas moedas (Ludas e Cristais)
    if (request.method === 'GET' && urlPath === '/api/shop') {
      await handleShopOverview(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/shop/buy') {
      await handleShopBuy(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/shop/equip') {
      await handleShopEquip(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/shop/chest') {
      await handleShopChest(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/shop/checkout') {
      await handleShopCheckout(request, response);
      return;
    }

    if (request.method === 'GET' && urlPath === '/api/shop/status') {
      await handleShopStatus(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/shop/dev/confirm') {
      await handleShopDevConfirm(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/shop/webhook') {
      await handleShopWebhook(request, response);
      return;
    }

    // CALENDÁRIO DE VERSÕES (Servidor de Testes)
    // O cliente usa esta rota para saber qual versão está NO AR e
    // marcar as outras como PROGRAMADA/ENCERRADA.
    if (request.method === 'GET' && urlPath === '/api/version') {
      sendJson(response, 200, versions.describeVersions(new Date()));
      return;
    }

    // TORNEIOS COM HORÁRIO MARCADO (roadmap #10)
    if (request.method === 'GET' && urlPath === '/api/tournaments') {
      await handleTournamentList(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/tournaments/register') {
      await handleTournamentRegister(request, response);
      return;
    }

    if (request.method === 'POST' && urlPath === '/api/tournaments/unregister') {
      await handleTournamentUnregister(request, response);
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

    // Favicon (servido diretamente da pasta public/assets)
    if (request.method === 'GET' && (urlPath === '/favicon.ico' || urlPath === '/assets/favicon.ico')) {
      await serveStatic(request, response, '/assets/favicon.ico');
      return;
    }

    if (request.method === 'GET' && (urlPath === '/favicon.svg' || urlPath === '/assets/favicon.svg')) {
      await serveStatic(request, response, '/assets/favicon.svg');
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
    // Mensagem genérica no corpo da resposta: erros internos (ex.:
    // "Cannot read properties of undefined") não podem vazar detalhes
    // para o cliente. Erros de banco usam a mensagem já sanitizada
    // (error.safeMessage); o detalhe completo fica só no log.
    const message = error && error.safeMessage ? error.safeMessage : 'Erro interno do servidor.';
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
  const wss = new WebSocketServer({ 
    server, 
    path: '/ws',
    verifyClient: (info) => {
      // Valida origem do WebSocket (previne cross-site WebSocket hijacking)
      const origin = info.origin || info.req.headers.origin || '';
      const host = info.req.headers.host || '';
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          if (originHost !== host) {
            return false;
          }
        } catch (e) {
          return false;
        }
      }
      return true;
    }
  });

  wss.on('connection', (ws, request) => {
    const conn = {
      roomCode: null,
      playerIdx: null,
      userId: null,
      name: null,
      rateWindow: { startedAt: Date.now(), count: 0 },
      authenticated: false,
      // Promessa da validação da sessão do handshake: as mensagens do
      // cliente esperam ela antes de serem atendidas (sem isso, um
      // 'join_room' que chega logo após o connect pode entrar sem uid
      // e o jogador perde a reconexão transparente).
      authReady: Promise.resolve(null)
    };
    connections.set(ws, conn);

    // Valida a sessão do usuário via cookie no handshake do WebSocket
    const cookies = parseCookies(request);
    const token = cookies[COOKIE_NAME];
    if (token) {
      conn.authReady = db.getSessionUser(token).then(sessionUser => {
        if (sessionUser) {
          conn.userId = sessionUser.id;
          conn.user = sessionUser;
          conn.authenticated = true;
          trackUserConnection(ws, sessionUser.id);
          broadcastUserStatus(sessionUser.id, true);
          // Torneio: tenta iniciar a partida pendente deste jogador
          kickTournamentScheduler();
          // RECONEXÃO TRANSPARENTE: se o jogador caiu no meio de uma
          // partida, ele volta para a mesma sala e recebe o estado atual
          tryResumeRoomForUser(ws, conn, sessionUser.id);
        }
        return sessionUser;
      }).catch(error => {
        console.error('[ws] erro ao autenticar sessão:', error && error.message);
        return null;
      });
    }

    ws.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch (error) {
        return;
      }

      // Espera a validação da sessão do handshake: mensagens como
      // 'join_room' precisam do uid do usuário (sem isso o jogador
      // entraria na sala sem identidade e não poderia retomar a
      // partida depois de uma queda de conexão).
      if (conn.authReady) {
        try {
          await conn.authReady;
        } catch (error) {
          // falha na validação: segue sem sessão autenticada
        }
      }

      // Limite de mensagens por conexão (anti-spam)
      if (!allowMessageByRate(conn)) {
        logRejectedMessage(conn, data && data.type ? data.type : 'desconhecida', 'limite de mensagens excedido');
        return;
      }

      /* --- IDENTIFICAÇÃO DE USUÁRIO (notificações em tempo real) -------- */
      if (data.type === 'identify') {
        // O uid vem da sessão autenticada no handshake, não pode ser
        // sobrescrito pelo cliente. Usa apenas para re-sincronizar.
        const uid = conn.userId || (data.uid || null);
        const prevConn = connections.get(ws);
        if (prevConn && prevConn.userId && prevConn.userId !== uid) {
          untrackUserConnection(ws, prevConn.userId);
        }
        if (uid && !conn.authenticated) {
          // Sem sessão válida, não permite identificar como outro usuário
          sendTo(ws, { type: 'error', error: 'Sessão não autenticada.' });
          return;
        }
        if (uid) {
          trackUserConnection(ws, uid);
          if (prevConn) prevConn.userId = uid;
          conn.userId = uid;
          broadcastUserStatus(uid, true);
          // Torneio: se houver uma partida pendente deste jogador, ela
          // começa assim que o adversário estiver online.
          kickTournamentScheduler();
          // O dono do lobby voltou: não encerra mais o lobby
          clearDuplaLobbyCleanup(uid);
          Object.keys(LOBBY_KINDS).forEach(kind => clearLobbyCleanup(kind, uid));
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
          // Reenvia o lobby atual (se o usuário estiver em um)
          for (const lobby of onlineLobbies.values()) {
            const member = lobby.members.find(entry => entry.id === uid);
            if (!member) continue;
            if (!member.ws || member.ws.readyState !== 1) member.ws = ws;
            await broadcastLobby(lobby);
          }
          await sendLobbyToUser(uid);
          // RECONEXÃO TRANSPARENTE: se o jogador caiu no meio de uma
          // partida, ele volta para a mesma sala e recebe o estado atual
          tryResumeRoomForUser(ws, conn, uid);
        }
        sendTo(ws, { type: 'ack', original: 'identify' });
        return;
      }

      /* --- MATCHMAKING DA LIGA (partida classificatória) ---------------- */
      if (data.type === 'liga_match') {
        // A identidade vem da sessão autenticada (mensagem 'identify'),
        // nunca do corpo: o cliente não pode entrar na fila jogando na
        // conta de outro usuário (uid forjado aplicaria pontos/derrotas
        // na conta da vítima)
        const uid = conn.userId || null;
        const name = String(data.name || 'Jogador').slice(0, 24);
        conn.name = name;

        if (!uid) {
          sendTo(ws, { type: 'error', error: 'Entre na sua conta para jogar na Liga.' });
          return;
        }

        // A Liga é exclusiva para contas Premium: o servidor é a fonte da
        // verdade (o botão desabilitado no cliente é só a primeira camada)
        const premium = await isPremiumPlayer(uid);
        if (!premium) {
          sendTo(ws, { type: 'error', error: 'A Liga é exclusiva para contas Premium.' });
          return;
        }

        // A mesma conta não pode ficar na fila da Liga duas vezes
        if (uid && matchmakingQueue.some(entry => entry.uid === uid && queueMode(entry) === 'liga')) {
          sendTo(ws, { type: 'error', error: 'Esta conta já está na fila de partida.' });
          return;
        }

        // Trocar de fila é permitido: sai da fila do Jogo Rápido (se estiver nela)
        removeFromQueue(ws);
        // Sai de qualquer sala anterior (o oponente que fica é notificado)
        detachFromRoom(ws);

        // A classificação define o tier (e a situação da melhor de 3):
        // a fila da Liga só pareia jogadores do mesmo tier.
        const standing = await getLeagueStandingFor(uid);
        const tier = standing ? league.normalizeTier(standing.tier) : league.TIERS[0];
        const pending = standing ? Boolean(standing.promotionPending) : false;

        matchmakingQueue.push({ ws, uid, name, mode: 'liga', tier, pending });
        sendTo(ws, { type: 'queued', mode: 'liga' });
        // O cliente mostra o tier, os pontos e a melhor de 3 na tela da Liga
        if (standing) {
          sendTo(ws, { type: 'league_standing', standing: league.describeStanding(standing) });
        }
        await tryMatchmaking();
        return;
      }

      if (data.type === 'leave_queue') {
        removeFromQueue(ws);
        return;
      }

      /* --- SALA COM CÓDIGO (Convite) ------------------------------------ */
      if (data.type === 'join_room') {
        let { room: code, name } = data || {};
        // O uid vem da sessão autenticada, não do cliente
        const uid = conn.userId || null;

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
            code,
            players: [ws, null],
            names: [cleanName || 'Jogador 1', null],
            userIds: [uid || null, null],
            teams: [0, 1],
            ready: [false, false],
            mode: 'solo'
          };
          rooms.set(code, room);
          conn.roomCode = code;
          conn.playerIdx = 0;
          conn.userId = uid || null;
          // Guarda a sala do usuário: permite retomar a partida se a
          // conexão cair (reconexão transparente)
          if (uid) userRoom.set(uid, code);
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

        // A mesma conta Google não pode controlar os dois slots da
        // partida. Se o uid está num slot cuja conexão caiu, é o dono
        // voltando (take-over do próprio slot): reentrada permitida.
        if (uid) {
          const ownSlot = room.userIds.indexOf(uid);
          if (ownSlot !== -1 && room.players[ownSlot]) {
            sendTo(ws, { type: 'error', error: 'Esta conta já está nesta partida.' });
            return;
          }
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
        if (uid) userRoom.set(uid, code);

        // Reentrada no próprio slot cancela a contagem de abandono
        // (take-over): sem isso o timer dispararia depois e aplicaria o
        // abandono de um jogador que já voltou
        const rejoinAbsenceKey = `${code}:${playerIdx}`;
        const rejoinAbsence = absentPlayers.get(rejoinAbsenceKey);
        if (rejoinAbsence) {
          clearTimeout(rejoinAbsence.timer);
          absentPlayers.delete(rejoinAbsenceKey);
        }

        // Reentrada no próprio slot cancela a contagem de abandono
        // (take-over): sem isso o timer dispararia depois e aplicaria o

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
          // Guarda as cores da mesa: a revanche joga na mesma mesa (roadmap #13)
          room.soloColors = soloColors;

          // Estado autoritativo da partida (dado, turno e peças no servidor)
          setupRoomGame(room, {
            slots: [
              { slot: 0, color: SOLO_SLOT_COLORS[0], team: 0 },
              { slot: 1, color: SOLO_SLOT_COLORS[1], team: 1 }
            ],
            mode: 'solo',
            target: 4
          });

          broadcastRoom(code, {
            type: 'room_ready',
            players: [
              { id: 0, uid: profile0.uid, name: profile0.name, email: profile0.email, picture: profile0.picture, playerName: profile0.playerName, color: soloColors.starterColor },
              { id: 1, uid: profile1.uid, name: profile1.name, email: profile1.email, picture: profile1.picture, playerName: profile1.playerName, color: soloColors.opponentColor }
            ],
            slotColors: room.slotColors,
            turn: room.game.turn
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

        // Bloqueia nomes de dupla ofensivos segundo a política de nomes.
        if (teamName && !namePolicy.isNameAllowed(teamName)) {
          sendTo(ws, {
            type: 'dupla_invite_result',
            status: 'error',
            targetId,
            message: 'Esse nome de dupla não é permitido. Escolha outro.'
          });
          return;
        }

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
          matchTypeLabel: 'DUO • 2 vs 2'
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
        // Quem aceitou abre automaticamente o lobby da dupla
        sendTo(ws, {
          type: 'dupla_invite_result',
          status: 'joined',
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
        if (typeof data.teamName === 'string') {
          const nextTeamName = sanitizeTeamName(data.teamName);
          if (nextTeamName && !namePolicy.isNameAllowed(nextTeamName)) {
            sendTo(ws, {
              type: 'error',
              message: 'Esse nome de dupla não é permitido. Escolha outro.'
            });
            return;
          }
          lobby.teamName = nextTeamName;
        }
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

        // Bloqueia nomes de dupla ofensivos segundo a política de nomes.
        if (lobby.teamName && !namePolicy.isNameAllowed(lobby.teamName)) {
          sendTo(ws, { type: 'dupla_queue_error', error: 'Esse nome de dupla não é permitido. Escolha outro.' });
          return;
        }

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

        // Todos os jogadores do lobby (criador e amigos) entram no modo de
        // busca: a interface fica bloqueada e só o cancelamento continua ativo
        const queuedPayload = {
          type: 'dupla_queued',
          size: players.length
        };
        sendToUser(lobby.hostId, queuedPayload);
        lobby.members.forEach(member => {
          if (member.id !== lobby.hostId) sendToUser(member.id, queuedPayload);
        });

        await tryDuplaMatchmaking();
        return;
      }

      if (data.type === 'dupla_leave_queue') {
        const uid = conn.userId;

        // Cancelar a busca encerra a fila do lobby inteiro e avisa
        // todos os jogadores presentes para liberarem a interface
        const lobby = findDuplaLobbyForUser(uid);
        let canceled = false;
        if (lobby) {
          const index = duplaQueue.findIndex(entry => entry.uid === lobby.hostId);
          if (index !== -1) {
            duplaQueue.splice(index, 1);
            canceled = true;
          }
        }
        removeFromDuplaQueue(ws);
        if (canceled) notifyDuplaQueueCanceled(lobby);
        return;
      }

      /* --- LOBBIES ONLINE (arena e partida normal) ---------------------- */
      if (data.type === 'lobby_request') {
        await sendLobbyToUser(conn.userId, normalizeLobbyKind(data.kind));
        return;
      }

      if (data.type === 'lobby_invite') {
        const kind = normalizeLobbyKind(data.kind);
        const config = lobbyKindConfig(kind);
        const hostUid = conn.userId;
        const targetId = String(data.targetId || '').trim();

        if (!hostUid) {
          sendTo(ws, { type: 'lobby_invite_result', kind, status: 'error', message: 'Entre na sua conta para convidar amigos.' });
          return;
        }
        if (!targetId || targetId === hostUid) {
          sendTo(ws, { type: 'lobby_invite_result', kind, status: 'error', message: 'Convite inválido.' });
          return;
        }

        // O convidado precisa estar online para receber o convite
        if (!getUserSockets(targetId).length) {
          sendTo(ws, {
            type: 'lobby_invite_result',
            kind,
            status: 'offline',
            targetId,
            message: 'Não foi possível enviar convite: o amigo está offline.'
          });
          return;
        }

        // Só amigos podem ser convidados para o lobby
        const relation = await db.getRelation(hostUid, targetId);
        if (relation !== 'friend') {
          sendTo(ws, {
            type: 'lobby_invite_result',
            kind,
            status: 'error',
            targetId,
            message: 'Você só pode convidar amigos.'
          });
          return;
        }

        // O lobby aceita no máximo maxMembers jogadores
        const lobby = findLobbyForUser(hostUid, kind);
        if (lobby && lobby.members.length >= config.maxMembers) {
          sendTo(ws, {
            type: 'lobby_invite_result',
            kind,
            status: 'error',
            targetId,
            message: `O lobby já está completo (${config.maxMembers}/${config.maxMembers}).`
          });
          return;
        }

        const inviteId = crypto.randomUUID();
        lobbyPendingInvites.set(inviteId, {
          id: inviteId,
          fromUid: hostUid,
          toUid: targetId,
          kind,
          createdAt: Date.now()
        });

        const hostProfile = await getLobbyMemberProfile(hostUid, conn.name);
        sendToUser(targetId, {
          type: 'lobby_invite',
          kind,
          inviteId,
          fromId: hostUid,
          fromName: hostProfile.name,
          fromPicture: hostProfile.picture,
          matchType: kind,
          matchTypeLabel: config.matchTypeLabel
        });

        sendTo(ws, {
          type: 'lobby_invite_result',
          kind,
          status: 'sent',
          targetId,
          inviteId,
          message: 'Convite enviado! Aguardando resposta...'
        });
        return;
      }

      if (data.type === 'lobby_invite_response') {
        const inviteId = String(data.inviteId || '');
        const invite = lobbyPendingInvites.get(inviteId);
        if (!invite || invite.toUid !== conn.userId) {
          sendTo(ws, { type: 'lobby_invite_result', kind: normalizeLobbyKind(data.kind), status: 'error', message: 'Convite inválido ou expirado.' });
          return;
        }
        lobbyPendingInvites.delete(inviteId);

        const kind = invite.kind;
        const config = lobbyKindConfig(kind);

        if (!data.accept) {
          sendToUser(invite.fromUid, {
            type: 'lobby_invite_result',
            kind,
            status: 'declined',
            targetId: invite.toUid,
            message: 'O convite foi recusado.'
          });
          return;
        }

        const lobby = await ensureLobby(kind, invite.fromUid, findUserSocket(invite.fromUid));
        if (!lobby.members.some(member => member.id === invite.toUid) && lobby.members.length >= config.maxMembers) {
          sendTo(ws, {
            type: 'lobby_invite_result',
            kind,
            status: 'error',
            message: `O lobby já está completo (${config.maxMembers}/${config.maxMembers}).`
          });
          return;
        }

        const member = await getLobbyMemberWithSocket(invite.toUid, conn.name, ws);
        if (!lobby.members.some(entry => entry.id === invite.toUid)) {
          lobby.members.push(member);
        } else {
          // Atualiza a aba em que o convidado está
          const existing = lobby.members.find(entry => entry.id === invite.toUid);
          if (existing) existing.ws = ws;
        }

        await broadcastLobby(lobby);
        // Avisa quem convidou que o convite foi aceito
        sendToUser(invite.fromUid, {
          type: 'lobby_invite_result',
          kind,
          status: 'accepted',
          targetId: invite.toUid,
          message: 'Convite aceito! O amigo entrou no lobby.'
        });
        sendTo(ws, {
          type: 'lobby_invite_result',
          kind,
          status: 'joined',
          message: `Você entrou no lobby de ${config.label}.`
        });
        return;
      }

      if (data.type === 'lobby_remove') {
        const kind = normalizeLobbyKind(data.kind);
        const lobby = findLobbyForUser(conn.userId, kind);
        if (!lobby || lobby.hostId !== conn.userId) return;
        const memberId = String(data.memberId || '');
        if (memberId === lobby.hostId) return;
        lobby.members = lobby.members.filter(member => member.id !== memberId);
        // O jogador removido também sai da fila de busca
        removeLobbyQueueForUser(kind, memberId);
        await broadcastLobby(lobby);
        sendToUser(memberId, {
          type: 'lobby_left',
          kind,
          message: `Você foi removido do lobby de ${lobbyKindConfig(kind).label}.`
        });
        return;
      }

      if (data.type === 'lobby_leave') {
        const kind = normalizeLobbyKind(data.kind);
        const uid = conn.userId;
        const lobby = findLobbyForUser(uid, kind);
        if (!lobby) return;
        // Sai da fila de busca
        removeLobbyQueueForUser(kind, uid);
        if (lobby.hostId === uid) {
          // O criador saiu: o lobby é encerrado
          onlineLobbies.delete(lobbyMapKey(kind, uid));
          clearLobbyCleanup(kind, uid);
          lobby.members.forEach(member => {
            if (member.id !== uid) {
              sendToUser(member.id, {
                type: 'lobby_left',
                kind,
                message: 'O criador do lobby saiu. O lobby foi encerrado.'
              });
            }
          });
          return;
        }
        // O convidado saiu: o lobby continua com o criador
        lobby.members = lobby.members.filter(member => member.id !== uid);
        await broadcastLobby(lobby);
        sendToUser(uid, {
          type: 'lobby_left',
          kind,
          message: `Você saiu do lobby de ${lobbyKindConfig(kind).label}.`
        });
        return;
      }

      if (data.type === 'lobby_queue') {
        const kind = normalizeLobbyKind(data.kind);
        const uid = conn.userId;
        if (!uid) {
          sendTo(ws, { type: 'lobby_queue_error', kind, error: 'Entre na sua conta para buscar partida.' });
          return;
        }

        // Somente o criador do lobby pode colocar o lobby na fila
        const existingLobby = findLobbyForUser(uid, kind);
        if (existingLobby && existingLobby.hostId !== uid) {
          sendTo(ws, { type: 'lobby_queue_error', kind, error: 'Apenas o criador do lobby pode buscar partida.' });
          return;
        }

        const lobby = existingLobby || await ensureLobby(kind, uid, ws);
        const players = resolveLobbyPlayers(lobby.members, uid, ws);
        if (!players.length) {
          sendTo(ws, { type: 'lobby_queue_error', kind, error: 'Não foi possível entrar na fila.' });
          return;
        }

        // Bloqueia nomes indevidos (nicknames ofensivos) de qualquer jogador
        // do lobby antes de entrar na fila de busca (arena ou partida normal).
        for (const player of players) {
          if (player.name && !namePolicy.isNameAllowed(player.name)) {
            sendTo(ws, {
              type: 'lobby_queue_error',
              kind,
              error: 'Um jogador do lobby utiliza um nome indevido. Altere o nickname antes de buscar partida.'
            });
            return;
          }
        }

        // Cada jogador do lobby entra na fila por si
        const queue = lobbyQueues[kind];
        // BLITZ (partida rápida): só o lobby SOLO usa. A partida é blitz
        // quando os dois jogadores escolheram BLITZ.
        const blitz = kind === 'normal' && data.blitz === true;
        removeLobbyQueueForUser(kind, uid);
        players.forEach(player => {
          queue.push({
            ws: player.ws,
            uid: player.id,
            name: player.name,
            picture: player.picture || '',
            blitz
          });
        });

        // Todos os jogadores do lobby (criador e amigos) entram no modo de
        // busca: a interface fica bloqueada e só o cancelamento continua ativo
        const queuedPayload = {
          type: 'lobby_queued',
          kind,
          size: players.length
        };
        sendToUser(lobby.hostId, queuedPayload);
        lobby.members.forEach(member => {
          if (member.id !== lobby.hostId) sendToUser(member.id, queuedPayload);
        });

        await tryLobbyMatchmaking(kind);
        return;
      }

      if (data.type === 'lobby_leave_queue') {
        const kind = normalizeLobbyKind(data.kind);
        const uid = conn.userId;

        // Cancelar a busca encerra a fila do lobby inteiro e avisa
        // todos os jogadores presentes para liberarem a interface
        const lobby = findLobbyForUser(uid, kind);
        const queue = lobbyQueues[kind] || [];
        let canceled = false;
        if (lobby) {
          const ids = new Set(lobby.members.map(member => member.id));
          for (let i = queue.length - 1; i >= 0; i--) {
            if (ids.has(queue[i].uid)) {
              queue.splice(i, 1);
              canceled = true;
            }
          }
        }
        removeLobbyQueueForUser(kind, uid);
        if (canceled) notifyLobbyQueueCanceled(lobby);
        return;
      }

      if (conn.roomCode === null || conn.playerIdx === null) return;

      const room = rooms.get(conn.roomCode);
      if (!room) return;

      /* --- PARTIDA AUTORITATIVA: pedidas do cliente ------------------- */
      if (data.type === 'leave_match') {
        // Desistência deliberada: diferente de uma queda de conexão,
        // o jogador está saindo de propósito — a vaga é liberada na
        // hora (sem janela de reconexão) e o abandono é definitivo.
        const playerIdx = Number(conn.playerIdx);
        const roomCode = conn.roomCode;
        const leftName = room.names[playerIdx] || conn.name || null;
        let botTookOver = false;

        if (room.game && room.game.started && !room.game.over) {
          if (modeSupportsBotTakeover(room)) {
            // Arena/dupla: um bot assume o slot e a partida continua
            installBotForSlot(room, playerIdx, leftName);
            botTookOver = true;
          } else if (room.mode === 'liga') {
            applyLeagueAbandonResult(room, playerIdx);
          } else if (room.mode === 'tournament') {
            applyTournamentAbandonResult(room, playerIdx);
          } else if (room.mode === 'solo' || room.mode === 'quick') {
            room.game.over = true;
            room.game.winner = otherPlayerIndex(playerIdx);
            clearRoomTurnTimer(room);
            broadcastRoomGame(room, {
              type: 'match_finished',
              over: true,
              winner: room.game.winner,
              scores: room.game.scores,
              reason: 'abandon',
              playerIdx
            });
          }
        }

        // Libera o slot imediatamente
        const absenceKey = `${roomCode}:${playerIdx}`;
        const absence = absentPlayers.get(absenceKey);
        if (absence) {
          clearTimeout(absence.timer);
          absentPlayers.delete(absenceKey);
        }
        room.userIds[playerIdx] = null;
        room.players[playerIdx] = null;
        if (!Array.isArray(room.botSourceNames)) room.botSourceNames = [];
        room.botSourceNames[playerIdx] = leftName;
        room.names[playerIdx] = null;
        room.ready[playerIdx] = false;
        if (conn.userId) userRoom.delete(conn.userId);
        conn.roomCode = null;
        conn.playerIdx = null;

        // Avisa os que ficaram na sala
        if (!botTookOver) {
          broadcastRoom(roomCode, { type: 'opponent_left', playerIdx, reason: 'abandon' }, ws);
        } else {
          startRoomTurnTimer(room);
        }
        return;
      }

      if (data.type === 'game_start') {
        handleGameStart(ws, conn, room);
        return;
      }

      if (data.type === 'roll_request') {
        handleRollRequest(ws, conn, room);
        return;
      }

      if (data.type === 'move_request') {
        handleMoveRequest(ws, conn, room, data);
        return;
      }

      // REVANCHE (roadmap #13): pedir e responder a revanche
      if (data.type === 'rematch_request') {
        await handleRematchRequest(ws, conn, room);
        return;
      }

      if (data.type === 'rematch_response') {
        await handleRematchResponse(ws, conn, room, data);
        return;
      }

      // MENSAGENS RÁPIDAS (roadmap #14)
      if (data.type === 'quick_chat') {
        handleQuickChat(ws, conn, room, data);
        return;
      }

      // O dado, o movimento e a passagem de vez não podem mais vir do
      // cliente: qualquer tentativa é ignorada e registrada.
      if (FORBIDDEN_CLIENT_MESSAGES.has(data.type)) {
        rejectClientMessage(ws, conn, data.type, 'Mensagem controlada pelo cliente não é aceita.', room);
        return;
      }

      // Relay apenas das mensagens permitidas (1 vs 1 envia para o oponente;
      // 2 vs 2 envia para todos os demais)
      if (!RELAYABLE_ROOM_MESSAGES.has(data.type)) {
        rejectClientMessage(ws, conn, data.type, 'Mensagem não permitida dentro da partida.', room);
        return;
      }

      const forward = {
        ...data,
        // type e from por último: o cliente não pode forjar a autoria
        // (o spread antes deixaria data.from sobrescrever conn.playerIdx)
        type: data.type,
        from: conn.playerIdx
      };

      // Guarda a cor escolhida pelo jogador na sala: quem reconectar
      // recebe essa cor no snapshot e o tabuleiro continua igual
      if (data.type === 'color_info' && Number.isInteger(Number(conn.playerIdx))) {
        const rawColor = data.color || {};
        const hex = typeof rawColor.hex === 'string' && /^#[0-9a-f]{6}$/i.test(rawColor.hex.trim())
          ? rawColor.hex.trim().toLowerCase()
          : null;
        if (!Array.isArray(room.slotColorInfo)) room.slotColorInfo = [];
        room.slotColorInfo[conn.playerIdx] = {
          hex,
          name: String(rawColor.name || '').slice(0, 24),
          custom: Boolean(rawColor.custom)
        };
      }

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
      Object.keys(lobbyQueues).forEach(kind => removeFromLobbyQueue(kind, ws));
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

        // Mesmo tratamento para os lobbies online (arena e partida normal)
        for (const lobby of onlineLobbies.values()) {
          const host = lobby.members.find(member => member.id === userId);
          if (host && lobby.hostId === userId) {
            host.ws = null;
            lobby.members.forEach(member => {
              if (member.id !== userId) {
                sendToUser(member.id, {
                  type: 'lobby_left',
                  kind: lobby.kind,
                  message: 'O criador do lobby está offline. O lobby será encerrado se ele não voltar.'
                });
              }
            });
            scheduleLobbyCleanup(lobby.kind, userId);
          }
        }
        onlineLobbies.forEach(lobby => {
          const member = lobby.members.find(entry => entry.id === userId);
          if (!member) return;
          member.ws = null;
          broadcastLobby(lobby).catch(() => {});
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

  // TORNEIOS (roadmap #10): o agendador inicia as edições no horário
  // marcado e cria as salas do chaveamento quando os dois jogadores
  // da partida estão online.
  setInterval(() => {
    runTournamentScheduler();
  }, TOURNAMENT_TICK_MS);
  runTournamentScheduler();

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

