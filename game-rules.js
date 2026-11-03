'use strict';

/**
 * REGRAS DO LUDO NO SERVIDOR
 * ------------------------------------------------------------------
 * O servidor é a fonte da verdade das partidas online:
 *  - sorteia o dado com fonte criptográfica (crypto.randomInt);
 *  - guarda de quem é a vez;
 *  - valida cada jogada (o cliente só informa qual peça escolheu);
 *  - aplica as regras dos 3 seis seguidos e do fim de turno sem movimento;
 *  - calcula capturas, pontos e o vencedor.
 *
 * O cliente apenas pede "rolar" e anima o resultado recebido.
 */

const crypto = require('crypto');

const TRACK_LENGTH = 52;
const FIRST_HOME_POSITION = 51;
const FINAL_POSITION = 56;
const TOKENS_PER_PLAYER = 4;

const COLORS = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
const CLOCKWISE_COLORS = ['BLUE', 'RED', 'GREEN', 'YELLOW'];

// Posição inicial de cada cor no percurso principal
const START_INDEX = { RED: 0, GREEN: 13, YELLOW: 26, BLUE: 39 };

// Percurso principal (mesma geometria do tabuleiro do cliente)
const MAIN_PATH = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
  [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
  [0, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
  [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
  [7, 14],
  [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
  [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
  [14, 7],
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
  [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  [7, 0],
  [6, 0]
];

// Casas seguras (as estrelas do tabuleiro)
const STAR_CELLS = [
  { r: 6, c: 1 }, { r: 2, c: 6 }, { r: 1, c: 8 }, { r: 6, c: 12 },
  { r: 8, c: 13 }, { r: 12, c: 8 }, { r: 13, c: 6 }, { r: 8, c: 2 }
];

/**
 * Sorteio criptográfico do dado (1 a 6). O valor nunca vem do cliente.
 */
function rollDiceValue() {
  return crypto.randomInt(1, 7);
}

/**
 * Cria o estado autoritativo de uma partida.
 * slots: [{ slot, color, team }]
 */
function createGameState(options = {}) {
  const slots = (options.slots || [])
    .map(entry => ({
      slot: Number(entry.slot),
      color: String(entry.color),
      team: entry.team === undefined || entry.team === null ? Number(entry.slot) : Number(entry.team)
    }))
    .filter(entry => COLORS.includes(entry.color))
    .sort((a, b) => a.slot - b.slot);

  const state = {
    mode: options.mode || 'solo',
    target: Number(options.target) || 4,
    slots,
    turn: slots.length ? slots[0].slot : 0,
    dice: null,
    sixes: 0,
    tokens: {},
    scores: {},
    over: false,
    winner: null,
    started: false,
    // Sorteio do dado: por padrão usa a fonte criptográfica, mas pode ser
    // substituída (injeção de dependência) em testes automatizados.
    rollDice: typeof options.rollDice === 'function' ? options.rollDice : rollDiceValue
  };

  COLORS.forEach(color => {
    state.tokens[color] = new Array(TOKENS_PER_PLAYER).fill(-1);
    state.scores[color] = 0;
  });

  return state;
}

function slotEntry(state, slot) {
  return state.slots.find(entry => entry.slot === Number(slot)) || null;
}

function colorOfSlot(state, slot) {
  const entry = slotEntry(state, slot);
  return entry ? entry.color : null;
}

function teamOfColor(state, color) {
  const entry = state.slots.find(item => item.color === color);
  return entry ? entry.team : null;
}

function isSameTeam(state, colorA, colorB) {
  const teamA = teamOfColor(state, colorA);
  const teamB = teamOfColor(state, colorB);
  return teamA !== null && teamA === teamB;
}

// Índice da casa no percurso principal (posição relativa à cor)
function mainPathIndex(color, relativePos) {
  const start = START_INDEX[color];
  return (start + relativePos) % TRACK_LENGTH;
}

// Coordenadas da casa na casa de destino (posição >= 0 e < FIRST_HOME_POSITION)
function cellCoords(color, pos) {
  return MAIN_PATH[mainPathIndex(color, pos)];
}

function isSafeCell(color, pos) {
  if (pos < 0 || pos >= FIRST_HOME_POSITION) return false;
  const [r, c] = cellCoords(color, pos);
  return STAR_CELLS.some(star => star.r === r && star.c === c);
}

/**
 * Peças que podem se mover com o dado informado.
 */
function validTokenIndices(state, slot, roll) {
  const color = colorOfSlot(state, slot);
  if (!color || !Number.isFinite(roll)) return [];
  const tokens = state.tokens[color] || [];
  const valid = [];

  tokens.forEach((pos, idx) => {
    if (pos === -1) {
      // Só sai da base com 6
      if (roll === 6) valid.push(idx);
    } else if (pos < FINAL_POSITION) {
      if (pos + roll <= FINAL_POSITION) valid.push(idx);
    }
  });

  return valid;
}

/**
 * Sorteia o dado para o slot informado e já aplica as regras de turno:
 *  - 3 seis seguidos => o jogador perde a vez;
 *  - sem movimento possível => o jogador perde a vez.
 * Retorna null quando o slot não pode rolar (não é a vez dele, o dado já
 * foi sorteado ou a partida acabou).
 */
function rollForTurn(state, slot) {
  if (!state || state.over) return null;
  if (state.turn !== Number(slot)) return null;
  if (state.dice !== null) return null;

  const value = state.rollDice();
  state.dice = value;

  if (value === 6) {
    state.sixes++;
    if (state.sixes >= 3) {
      // Três seis seguidos: perde a vez
      state.sixes = 0;
      state.dice = null;
      const next = nextSlot(state, slot);
      state.turn = next;
      return {
        value,
        sixes: state.sixes,
        legal: [],
        turnPassed: true,
        reason: 'three_sixes',
        turn: next
      };
    }
  } else {
    state.sixes = 0;
  }

  const legal = validTokenIndices(state, slot, value);

  if (!legal.length) {
    // Sem movimento possível: o turno passa
    state.dice = null;
    const next = nextSlot(state, slot);
    state.turn = next;
    return {
      value,
      sixes: state.sixes,
      legal,
      turnPassed: true,
      reason: 'no_move',
      turn: next
    };
  }

  return {
    value,
    sixes: state.sixes,
    legal,
    turnPassed: false,
    reason: null,
    turn: state.turn
  };
}

/**
 * Aplica a jogada no estado do servidor.
 * Retorna null quando a jogada é ilegal (o cliente é ignorado).
 */
function applyMove(state, slot, tokenIdx) {
  const color = colorOfSlot(state, slot);
  if (!color) return null;

  const roll = state.dice;
  if (!Number.isFinite(roll) || roll < 1 || roll > 6) return null;

  const tokens = state.tokens[color];
  if (!tokens) return null;

  const index = Number(tokenIdx);
  if (!Number.isInteger(index) || index < 0 || index >= tokens.length) return null;
  if (!validTokenIndices(state, slot, roll).includes(index)) return null;

  const from = tokens[index];
  const to = from === -1 ? 0 : from + roll;
  tokens[index] = to;

  const captured = [];
  if (to < FIRST_HOME_POSITION && !isSafeCell(color, to)) {
    const mainIdx = mainPathIndex(color, to);
    state.slots.forEach(other => {
      if (other.color === color) return;
      // Peças do mesmo time não são capturadas
      if (isSameTeam(state, color, other.color)) return;
      const otherTokens = state.tokens[other.color] || [];
      otherTokens.forEach((pos, otherIdx) => {
        if (pos >= 0 && pos < FIRST_HOME_POSITION && mainPathIndex(other.color, pos) === mainIdx) {
          otherTokens[otherIdx] = -1;
          captured.push({ color: other.color, tokenIdx: otherIdx });
        }
      });
    });
  }

  let points = null;
  if (to === FINAL_POSITION) {
    state.scores[color] = (state.scores[color] || 0) + 1;
    points = { color, score: state.scores[color] };
  }

  return { color, tokenIdx: index, from, to, roll, captured, points };
}

/**
 * Próximo slot na ordem do turno.
 */
function nextSlot(state, slot) {
  const ordered = state.slots.map(entry => entry.slot).sort((a, b) => a - b);
  if (!ordered.length) return Number(slot);
  const index = ordered.indexOf(Number(slot));
  if (index === -1) return ordered[0];
  return ordered[(index + 1) % ordered.length];
}

/**
 * Placar por time e vencedor da partida (null se ainda não houver).
 */
function teamStandings(state) {
  const teams = new Map();
  state.slots.forEach(entry => {
    const current = teams.get(entry.team) || { team: entry.team, score: 0, slots: [] };
    current.score += state.scores[entry.color] || 0;
    current.slots.push(entry.slot);
    teams.set(entry.team, current);
  });
  return Array.from(teams.values()).sort((a, b) => a.team - b.team);
}

function checkWinner(state) {
  for (const standing of teamStandings(state)) {
    if (standing.score >= state.target) return standing;
  }
  return null;
}

/**
 * Estado serializado para o cliente (usado na sincronização).
 */
function serializeState(state) {
  return {
    turn: state.turn,
    dice: state.dice,
    sixes: state.sixes,
    tokens: state.tokens,
    scores: state.scores,
    over: state.over,
    winner: state.winner,
    target: state.target
  };
}

module.exports = {
  CLOCKWISE_COLORS,
  COLORS,
  FIRST_HOME_POSITION,
  FINAL_POSITION,
  createGameState,
  rollDiceValue,
  rollForTurn,
  validTokenIndices,
  applyMove,
  nextSlot,
  checkWinner,
  teamStandings,
  serializeState,
  slotEntry,
  colorOfSlot,
  teamOfColor,
  isSameTeam
};
