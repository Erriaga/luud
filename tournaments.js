/* ------------------------------------------------------------------
   TORNEIOS COM HORÁRIO MARCADO (roadmap #10)

   Torneios eliminatórios de 8 ou 16 jogadores em horário fixo
   (ex.: 20h), com premiação em moedas.

   Módulo de regras puras (sem I/O), no mesmo estilo do rewards.js e
   do season.js: o servidor valida, agenda e persiste; o cliente só
   exibe e pede a inscrição.

   Convenções:
   - Os horários são do fuso de Brasília (UTC-3, sem horário de verão
     desde 2019), igual ao baú diário e às missões.
   - Cada edição é identificada por `<id do torneio>-<AAAA-MM-DD>`.
   - O chaveamento é eliminatório simples em partidas 1x1: quem perde
     é eliminado e recebe a colocação correspondente à rodada.
------------------------------------------------------------------ */

'use strict';

const BRAZIL_UTC_OFFSET_MINUTES = -180;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------
   DEFINIÇÃO DOS TORNEIOS
   weekday: 0=domingo ... 6=sábado (null = todos os dias)
------------------------------------------------------------------ */
const TOURNAMENT_DEFINITIONS = [
  {
    id: 'noite',
    name: 'Torneio da Noite',
    description: 'O torneio diário das 20h: 8 jogadores no mata-mata 1x1.',
    slots: 8,
    hour: 20,
    minute: 0,
    weekday: null,
    entryCoins: 0,
    prizes: [
      { fromPlace: 1, toPlace: 1, coins: 200 },
      { fromPlace: 2, toPlace: 2, coins: 120 },
      { fromPlace: 3, toPlace: 4, coins: 60 },
      { fromPlace: 5, toPlace: 8, coins: 30 }
    ]
  },
  {
    id: 'domingo',
    name: 'Torneio de Domingo',
    description: 'Todo domingo às 16h: 16 jogadores e a mayor premiação do dia.',
    slots: 16,
    hour: 16,
    minute: 0,
    weekday: 0,
    entryCoins: 0,
    prizes: [
      { fromPlace: 1, toPlace: 1, coins: 500 },
      { fromPlace: 2, toPlace: 2, coins: 250 },
      { fromPlace: 3, toPlace: 4, coins: 150 },
      { fromPlace: 5, toPlace: 8, coins: 60 },
      { fromPlace: 9, toPlace: 16, coins: 25 }
    ]
  }
];

/* ------------------------------------------------------------------
   DATAS NO FUSO DE BRASÍLIA
------------------------------------------------------------------ */
function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Data local do jogador no formato YYYY-MM-DD (fuso UTC-3)
function dayKey(now) {
  const shifted = new Date(toDate(now).getTime() + BRAZIL_UTC_OFFSET_MINUTES * 60000);
  return shifted.toISOString().slice(0, 10);
}

function shiftDayKey(key, days) {
  const base = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// 0 = domingo ... 6 = sábado
function weekdayOf(key) {
  const base = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  return base.getUTCDay();
}

// Instante do início de um torneio no dia informado (UTC-3)
function startOfDay(key, hour, minute) {
  const base = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  const offsetHours = -BRAZIL_UTC_OFFSET_MINUTES / 60;
  return new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    Number(hour) + offsetHours,
    Number(minute) || 0
  ));
}

function timeLabel(definition) {
  const hour = String(Number(definition.hour) || 0).padStart(2, '0');
  const minute = Number(definition.minute) || 0;
  return minute ? `${hour}h${String(minute).padStart(2, '0')}` : `${hour}h`;
}

function weekdayLabel(definition) {
  if (definition.weekday === null || definition.weekday === undefined) return 'Todo dia';
  const labels = ['Domingos', 'Segundas', 'Terças', 'Quartas', 'Quintas', 'Sextas', 'Sábados'];
  return labels[Number(definition.weekday)] || 'Todo dia';
}

/* ------------------------------------------------------------------
   EDIÇÕES (ocorrências) DE UM TORNEIO
------------------------------------------------------------------ */
function editionId(definition, key) {
  return `${definition.id}-${key}`;
}

function definitionById(id) {
  return TOURNAMENT_DEFINITIONS.find(item => item.id === String(id || '')) || null;
}

// Resolve o-definition e a data a partir do id da edição (o cliente
// nunca escolhe livremente o horário: o servidor confere a definição)
function resolveEditionId(id) {
  const text = String(id || '').trim();
  if (!text) return null;
  for (const definition of TOURNAMENT_DEFINITIONS) {
    const prefix = `${definition.id}-`;
    if (!text.startsWith(prefix)) continue;
    const key = text.slice(prefix.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
    if (definition.weekday !== null && definition.weekday !== undefined
      && weekdayOf(key) !== definition.weekday) return null;
    const startsAt = startOfDay(key, definition.hour, definition.minute);
    if (!startsAt) return null;
    return { definition, dayKey: key, startsAt: startsAt.toISOString(), id: editionId(definition, key) };
  }
  return null;
}

// Próximas ocorrências de um torneio (a partir de agora)
function upcomingOccurrences(definition, now, count = 2) {
  const date = toDate(now);
  const today = dayKey(date);
  const result = [];
  for (let offset = 0; offset < 30 && result.length < count; offset += 1) {
    const key = shiftDayKey(today, offset);
    if (!key) continue;
    if (definition.weekday !== null && definition.weekday !== undefined
      && weekdayOf(key) !== definition.weekday) continue;
    const startsAt = startOfDay(key, definition.hour, definition.minute);
    if (!startsAt || startsAt.getTime() <= date.getTime()) continue;
    result.push({
      id: editionId(definition, key),
      definition,
      dayKey: key,
      startsAt: startsAt.toISOString()
    });
  }
  return result;
}

// Todas as próximas ocorrências de todos os torneios
function upcomingEditions(now, perTournament = 2) {
  const result = [];
  TOURNAMENT_DEFINITIONS.forEach(definition => {
    upcomingOccurrences(definition, now, perTournament).forEach(item => result.push(item));
  });
  return result.sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
}

/* ------------------------------------------------------------------
   ESTADO DA EDIÇÃO
------------------------------------------------------------------ */
function createEdition(definition, startsAt, key) {
  const now = new Date().toISOString();
  return {
    id: editionId(definition, key),
    tournamentId: definition.id,
    name: definition.name,
    dayKey: key,
    startsAt: new Date(startsAt).toISOString(),
    slots: definition.slots,
    status: 'scheduled',
    entrants: [],
    size: 0,
    rounds: [],
    winnerId: null,
    placements: {},
    createdAt: now,
    updatedAt: now
  };
}

/* ------------------------------------------------------------------
   INSCRIÇÃO
------------------------------------------------------------------ */
function registerFor(edition, definition, userId, name, now) {
  if (!edition || !definition) return { ok: false, error: 'Torneio não encontrado.' };
  const date = toDate(now);
  if (edition.status !== 'scheduled') {
    return { ok: false, error: 'As inscrições para este torneio já encerraram.' };
  }
  if (new Date(edition.startsAt).getTime() <= date.getTime()) {
    return { ok: false, error: 'Este torneio já começou.' };
  }
  const id = String(userId || '');
  if (!id) return { ok: false, error: 'Faça login para se inscrever.' };
  if ((edition.entrants || []).some(item => item.userId === id)) {
    return { ok: false, error: 'Você já está inscrito neste torneio.' };
  }
  if ((edition.entrants || []).length >= edition.slots) {
    return { ok: false, error: 'As vagas deste torneio acabaram.' };
  }

  edition.entrants = Array.isArray(edition.entrants) ? edition.entrants : [];
  edition.entrants.push({
    userId: id,
    name: String(name || 'Jogador').slice(0, 24),
    registeredAt: date.toISOString()
  });
  edition.updatedAt = date.toISOString();
  return { ok: true, error: null, edition };
}

function unregisterFrom(edition, userId, now) {
  if (!edition) return { ok: false, error: 'Torneio não encontrado.' };
  const date = toDate(now);
  if (edition.status !== 'scheduled') {
    return { ok: false, error: 'As inscrições para este torneio já encerraram.' };
  }
  if (new Date(edition.startsAt).getTime() <= date.getTime()) {
    return { ok: false, error: 'Este torneio já começou.' };
  }
  const id = String(userId || '');
  const before = (edition.entrants || []).length;
  edition.entrants = (edition.entrants || []).filter(item => item.userId !== id);
  if (edition.entrants.length === before) {
    return { ok: false, error: 'Você não está inscrito neste torneio.' };
  }
  edition.updatedAt = date.toISOString();
  return { ok: true, error: null, edition };
}

/* ------------------------------------------------------------------
   CHAVEAMENTO ELIMINATÓRIO
------------------------------------------------------------------ */
function nextPowerOfTwo(value) {
  let size = 2;
  while (size < value) size *= 2;
  return size;
}

function buildBracket(edition) {
  const entrants = Array.isArray(edition.entrants) ? edition.entrants : [];
  const size = nextPowerOfTwo(Math.max(2, entrants.length));
  const roundCount = Math.round(Math.log2(size));
  const rounds = [];

  for (let round = 0; round < roundCount; round += 1) {
    const matches = [];
    const matchesInRound = size / Math.pow(2, round + 1);
    for (let index = 0; index < matchesInRound; index += 1) {
      matches.push({ index, a: null, b: null, winnerId: null, status: 'pending', roomCode: null });
    }
    rounds.push(matches);
  }

  // Primeira rodada: jogadores pareados em ordem de inscrição.
  // Se sobrar um jogador, ele passa direto (bye).
  entrants.forEach((entrant, index) => {
    const match = rounds[0][Math.floor(index / 2)];
    if (!match) return;
    if (!match.a) match.a = entrant;
    else match.b = entrant;
  });

  edition.size = size;
  edition.rounds = rounds;
  return edition;
}

function playerById(edition, userId) {
  return (edition.entrants || []).find(item => item.userId === String(userId || '')) || null;
}

// Repassa o vencedor (ou a ausência de vencedor) para a próxima rodada
function advanceFromMatch(edition, roundIndex, matchIndex, winner) {
  const round = edition.rounds[roundIndex];
  if (!round) return;
  const match = round[matchIndex];
  if (!match || match.status === 'finished' || match.status === 'empty') return;

  match.winnerId = winner ? winner.userId : null;
  match.status = winner ? 'finished' : 'empty';

  const nextRound = edition.rounds[roundIndex + 1];
  if (!nextRound) {
    if (winner) {
      edition.winnerId = winner.userId;
      edition.status = 'finished';
      edition.finishedAt = new Date().toISOString();
    }
    return;
  }

  const nextMatch = nextRound[Math.floor(matchIndex / 2)];
  if (!nextMatch) return;
  if (matchIndex % 2 === 0) nextMatch.a = winner;
  else nextMatch.b = winner;
  nextMatch.status = 'pending';
}

// Resolve os confrontos que já têm um único jogador (bye) e os
// confrontos vazios, de baixo para cima na chave.
function resolveByes(edition) {
  if (!Array.isArray(edition.rounds)) return;
  for (let round = 0; round < edition.rounds.length; round += 1) {
    if (round > 0) {
      const previous = edition.rounds[round - 1];
      const resolved = previous.every(match => match.status === 'finished' || match.status === 'empty');
      if (!resolved) return;
    }
    for (const match of edition.rounds[round]) {
      if (match.status !== 'pending') continue;
      if (!match.a && !match.b) {
        advanceFromMatch(edition, round, match.index, null);
      } else if (match.a && !match.b) {
        advanceFromMatch(edition, round, match.index, match.a);
      } else if (!match.a && match.b) {
        advanceFromMatch(edition, round, match.index, match.b);
      }
    }
  }
}

// Colocação de quem foi eliminado na rodada informada
function placementRange(size, roundIndex) {
  const total = Math.max(2, Number(size) || 2);
  const remaining = total / Math.pow(2, roundIndex);
  const from = Math.floor(remaining / 2) + 1;
  const to = Math.floor(remaining);
  return { from, to };
}

function prizeForPlace(definition, place) {
  const prizes = (definition && definition.prizes) || [];
  const found = prizes.find(item => place >= item.fromPlace && place <= item.toPlace);
  return found ? Number(found.coins) || 0 : 0;
}

// Recompensa acumulada de uma edição: colocação -> moedas
function prizeTable(definition, edition) {
  const table = {};
  if (!edition || !definition) return table;
  const size = Number(edition.size) || 0;
  if (!size) return table;

  const rounds = Array.isArray(edition.rounds) ? edition.rounds : [];
  rounds.forEach((round, roundIndex) => {
    const range = placementRange(size, roundIndex);
    round.forEach(match => {
      if (!match || match.status !== 'finished' || !match.winnerId) return;
      const loserId = (match.a && match.a.userId !== match.winnerId ? match.a.userId : null)
        || (match.b && match.b.userId !== match.winnerId ? match.b.userId : null);
      if (!loserId) return;
      const coins = prizeForPlace(definition, range.from);
      table[loserId] = (table[loserId] || 0) + coins;
    });
  });

  if (edition.winnerId) {
    const coins = prizeForPlace(definition, 1);
    table[edition.winnerId] = (table[edition.winnerId] || 0) + coins;
  }
  return table;
}

/* ------------------------------------------------------------------
   VISÃO PARA O CLIENTE
------------------------------------------------------------------ */

// Horário oficial da edição (sempre derivado da definição e do dia,
// para que a contagem regressiva mostre o horário do torneio)
function officialStart(definition, edition) {
  if (!definition || !edition || !edition.dayKey) return null;
  const startsAt = startOfDay(edition.dayKey, definition.hour, definition.minute);
  return startsAt ? startsAt.toISOString() : null;
}

function describeEdition(edition, definition, now, options = {}) {
  if (!edition) return null;
  const def = definition || definitionById(edition.tournamentId);
  const date = toDate(now);
  const startIso = officialStart(def, edition) || edition.startsAt;
  const startsAt = new Date(startIso).getTime();
  const entrants = Array.isArray(edition.entrants) ? edition.entrants : [];
  const userId = options.userId ? String(options.userId) : null;
  const registered = userId ? entrants.some(item => item.userId === userId) : false;

  const rounds = (Array.isArray(edition.rounds) ? edition.rounds : []).map(round => round.map(match => ({
    index: match.index,
    a: match.a ? { name: match.a.name, userId: match.a.userId } : null,
    b: match.b ? { name: match.b.name, userId: match.b.userId } : null,
    winnerId: match.winnerId || null,
    status: match.status
  })));

  return {
    id: edition.id,
    tournamentId: edition.tournamentId,
    name: edition.name || (def ? def.name : 'Torneio'),
    description: def ? def.description : '',
    timeLabel: def ? timeLabel(def) : '',
    scheduleLabel: def ? `${weekdayLabel(def)} · ${timeLabel(def)}` : '',
    dayKey: edition.dayKey,
    startsAt: startIso,
    startsInMs: Math.max(0, startsAt - date.getTime()),
    slots: Number(edition.slots) || (def ? def.slots : 0),
    registeredCount: entrants.length,
    capacityLeft: Math.max(0, (Number(edition.slots) || 0) - entrants.length),
    status: edition.status || 'scheduled',
    registered,
    entrants: entrants.map(item => ({ name: item.name, userId: item.userId })),
    prizes: def ? def.prizes.map(item => ({ ...item })) : [],
    size: Number(edition.size) || 0,
    rounds,
    winnerId: edition.winnerId || null
  };
}

module.exports = {
  TOURNAMENT_DEFINITIONS,
  dayKey,
  shiftDayKey,
  weekdayOf,
  startOfDay,
  timeLabel,
  weekdayLabel,
  editionId,
  definitionById,
  resolveEditionId,
  officialStart,
  upcomingOccurrences,
  upcomingEditions,
  createEdition,
  registerFor,
  unregisterFrom,
  buildBracket,
  playerById,
  advanceFromMatch,
  resolveByes,
  placementRange,
  prizeForPlace,
  prizeTable,
  describeEdition
};
