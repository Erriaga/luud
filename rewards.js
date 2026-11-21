/* ------------------------------------------------------------------
   RECOMPENSAS — baú diário com streak + missões diárias/semanais
   (roadmap #6 e #7)

   Módulo de regras puras (sem I/O), no mesmo estilo do league.js:
   - o servidor valida, aplica e persiste;
   - o cliente apenas exibe o que o servidor devolveu.

   Nada aqui confia em valores vindos do navegador: moedas, XP, metas
   e ciclos (dia/semana) são calculados aqui.
------------------------------------------------------------------ */

'use strict';

const shop = require('./shop');

/* ------------------------------------------------------------------
   ECONOMIA DAS PARTIDAS (aba "Economia — Fontes e Gastos")
   O roadmap define o valor de cada resultado: vitória rende mais,
   derrota rende pouco e o empate fica no meio. A partida da Liga
   paga o valor da vitória da Liga (sem somar o da partida rápida).
------------------------------------------------------------------ */
const MATCH_REWARDS = {
  win: 30,     // vitória em partida rápida
  draw: 15,    // empate em partida rápida
  loss: 10,    // derrota em partida rápida
  leagueWin: 50, // vitória em partida da Liga
  leagueLoss: 10  // derrota em partida da Liga
};

/* ------------------------------------------------------------------
   BAÚ DIÁRIO (roadmap #6)

   O baú é um CALENDÁRIO SEMANAL: cada dia da semana (segunda a
   domingo) tem a sua recompensa, e o ciclo recomeça toda segunda.
   Se o jogador deixar um dia passar sem resgatar, aquele dia fica
   INDISPONÍVEL (a sequência NÃO reinicia) e só volta a ser resgatável
   com um COMPENSADOR conquistado no passe.
------------------------------------------------------------------ */
const DAILY_CHEST = [
  { day: 1, coins: 5, xp: 10 },   // segunda-feira
  { day: 2, coins: 8, xp: 15 },   // terça-feira
  { day: 3, coins: 12, xp: 20 },  // quarta-feira
  { day: 4, coins: 16, xp: 30 },  // quinta-feira
  { day: 5, coins: 22, xp: 40 },  // sexta-feira
  { day: 6, coins: 30, xp: 55 },  // sábado
  { day: 7, coins: 50, xp: 80 }   // domingo
];

/* Nome do dia da semana de cada posição do baú (0 = segunda) */
const WEEKDAY_NAMES = [
  'SEGUNDA-FEIRA',
  'TERÇA-FEIRA',
  'QUARTA-FEIRA',
  'QUINTA-FEIRA',
  'SEXTA-FEIRA',
  'SÁBADO',
  'DOMINGO'
];

/* ------------------------------------------------------------------
   MISSÕES (roadmap #7)
   cycle: 'daily' (renova todo dia) ou 'weekly' (renova toda semana)
   metric: 'matches' | 'wins' | 'captures' | 'pieces' | 'dupla'
------------------------------------------------------------------ */
const MISSION_DEFINITIONS = [
  {
    id: 'daily_matches_2',
    cycle: 'daily',
    metric: 'matches',
    target: 2,
    coins: 40,
    xp: 20,
    title: 'Jogue 2 partidas',
    description: 'Jogue 2 partidas hoje — contra a CPU ou online.'
  },
  {
    id: 'daily_win_1',
    cycle: 'daily',
    metric: 'wins',
    target: 1,
    coins: 40,
    xp: 25,
    title: 'Vença 1 partida',
    description: 'Vença uma partida hoje.'
  },
  {
    id: 'daily_captures_3',
    cycle: 'daily',
    metric: 'captures',
    target: 3,
    coins: 40,
    xp: 25,
    title: 'Capture 3 peças',
    description: 'Capture 3 peças adversárias hoje.'
  },
  {
    // 4ª missão diária: só aparece para quem tem o SLOT EXTRA
    // (item CON-003 da loja ou nível 35 do passe free)
    id: 'daily_pieces_2',
    cycle: 'daily',
    metric: 'pieces',
    target: 2,
    coins: 40,
    xp: 20,
    extraSlot: true,
    title: 'Salve 2 peças',
    description: 'Leve 2 peças até a casa final hoje.'
  },
  {
    id: 'weekly_matches_5',
    cycle: 'weekly',
    metric: 'matches',
    target: 5,
    coins: 250,
    xp: 80,
    title: 'Jogue 5 partidas',
    description: 'Jogue 5 partidas nesta semana.'
  },
  {
    id: 'weekly_wins_3',
    cycle: 'weekly',
    metric: 'wins',
    target: 3,
    coins: 250,
    xp: 90,
    title: 'Vença 3 partidas',
    description: 'Vença 3 partidas nesta semana.'
  },
  {
    id: 'weekly_captures_10',
    cycle: 'weekly',
    metric: 'captures',
    target: 10,
    coins: 250,
    xp: 85,
    title: 'Capture 10 peças',
    description: 'Capture 10 peças adversárias nesta semana.'
  },
  {
    id: 'weekly_dupla_1',
    cycle: 'weekly',
    metric: 'dupla',
    target: 1,
    coins: 250,
    xp: 50,
    title: 'Jogue 1 de dupla',
    description: 'Jogue uma partida de dupla (2x2) nesta semana.'
  }
];

/* Fuso do Brasil (UTC-3): o "dia" do baú e da missão diária é o dia
   do jogador, não o dia do servidor (que costuma rodar em UTC). */
const BRAZIL_UTC_OFFSET_MINUTES = -180;

function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Data local do jogador no formato YYYY-MM-DD
function dayKey(now) {
  const shifted = new Date(toDate(now).getTime() + BRAZIL_UTC_OFFSET_MINUTES * 60000);
  return shifted.toISOString().slice(0, 10);
}

// Move um YYYY-MM-DD em N dias
function shiftDayKey(key, days) {
  const base = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

// Chave da semana (segunda-feira da semana do jogador)
function weekKey(now) {
  const today = dayKey(now);
  const base = new Date(`${today}T00:00:00.000Z`);
  const weekday = (base.getUTCDay() + 6) % 7; // 0 = segunda-feira
  return shiftDayKey(today, -weekday);
}

function clampCount(value, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(max, number);
}

function chestDayForStreak(streak) {
  const value = Math.max(1, Math.floor(Number(streak) || 1));
  return ((value - 1) % DAILY_CHEST.length) + 1;
}

// Índice do dia da semana de uma data YYYY-MM-DD (0 = segunda ... 6 = domingo)
function weekdayIndex(day) {
  const base = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) return -1;
  return (base.getUTCDay() + 6) % 7;
}

// Quantos resgates happened dentro da semana informada (YYYY-MM-DD da segunda)
function claimsInWeek(claims, week) {
  if (!claims) return 0;
  const last = shiftDayKey(week, DAILY_CHEST.length - 1);
  return Object.keys(claims).filter(key => key >= week && key <= last).length;
}

// Garante que o objeto de progresso tenha todos os campos esperados
function ensureProgressShape(progress) {
  if (!progress || typeof progress !== 'object') return {};
  if (!progress.coins || Number(progress.coins) < 0) progress.coins = 0;
  if (!progress.xp || Number(progress.xp) < 0) progress.xp = 0;
  // Cristais: moeda premium da loja (só entra via Pix)
  if (!Number.isFinite(Number(progress.crystals)) || Number(progress.crystals) < 0) {
    progress.crystals = 0;
  }
  if (!Number.isFinite(Number(progress.dailyStreak)) || Number(progress.dailyStreak) < 0) {
    progress.dailyStreak = 0;
  }
  if (!progress.matchesPlayed || Number(progress.matchesPlayed) < 0) progress.matchesPlayed = 0;
  if (!progress.wins || Number(progress.wins) < 0) progress.wins = 0;
  if (!progress.dailyClaims || typeof progress.dailyClaims !== 'object') progress.dailyClaims = {};
  if (!progress.missionState || typeof progress.missionState !== 'object') progress.missionState = {};
  if (!Array.isArray(progress.processedMatchIds)) progress.processedMatchIds = [];
  // Compensadores do passe: trocam um dia perdido do baú por um resgate
  if (!Number.isFinite(Number(progress.compensationTokens)) || Number(progress.compensationTokens) < 0) {
    progress.compensationTokens = 0;
  }
  // Proteções de sequência concedidas pelo passe de temporada (#9)
  // (modelo antigo: o passe agora dá compensadores no lugar delas)
  if (!Number.isFinite(Number(progress.streakFreezes)) || Number(progress.streakFreezes) < 0) {
    progress.streakFreezes = 0;
  }
  return progress;
}

/* ------------------------------------------------------------------
   ESTADO DE UMA MISSÃO NO CICLO ATUAL
------------------------------------------------------------------ */
function missionEntry(progress, mission, now) {
  const cycle = mission.cycle === 'weekly' ? weekKey(now) : dayKey(now);
  const state = ensureProgressShape(progress).missionState;
  const existing = state[mission.id];
  if (!existing || existing.cycle !== cycle) {
    return { cycle, progress: 0, claimed: false, claimedAt: null };
  }
  return {
    cycle,
    progress: Math.max(0, Number(existing.progress) || 0),
    claimed: Boolean(existing.claimed),
    claimedAt: existing.claimedAt || null
  };
}

/* ------------------------------------------------------------------
   BAÚ DIÁRIO
   O baú mostra a semana atual (segunda a domingo). Cada dia tem um
   estado: resgatado, hoje, indisponível (passou sem resgate) ou
   ainda não chegou.
------------------------------------------------------------------ */
function describeDaily(progress, now) {
  const shape = ensureProgressShape(progress);
  const today = dayKey(now);
  const week = weekKey(now);
  const todayIndex = weekdayIndex(today);
  const claims = shape.dailyClaims || {};
  const tokens = Math.max(0, Number(shape.compensationTokens) || 0);

  const rewards = DAILY_CHEST.map((chest, index) => {
    const date = shiftDayKey(week, index);
    const claim = claims[date] || null;
    const claimed = Boolean(claim);
    const missed = date < today && !claimed;
    return {
      day: chest.day,
      date,
      label: WEEKDAY_NAMES[index],
      coins: chest.coins,
      xp: chest.xp,
      claimed,
      missed,
      today: date === today,
      future: date > today,
      compensated: Boolean(claim && claim.compensated),
      canCompensate: missed && tokens > 0
    };
  });

  const claimedCount = claimsInWeek(claims, week);
  const missedDays = rewards
    .filter(item => item.missed)
    .map(item => ({
      date: item.date,
      day: item.day,
      label: item.label,
      coins: item.coins,
      xp: item.xp
    }));
  const canCompensateAny = missedDays.length > 0 && tokens > 0;

  return {
    // Dias resgatados na semana (a sequência não reinicia ao perder um dia)
    streak: claimedCount,
    weekDays: DAILY_CHEST.length,
    weekKey: week,
    today,
    todayIndex,
    claimedToday: Boolean(claims[today]),
    canClaim: !claims[today],
    currentDay: todayIndex + 1,
    compensationTokens: tokens,
    canCompensateAny,
    missedDays,
    rewards
  };
}

function claimDailyReward(progress, now) {
  const shape = ensureProgressShape(progress);
  const today = dayKey(now);
  const claims = shape.dailyClaims;

  if (claims[today]) {
    return {
      ok: false,
      error: 'Você já resgatou o baú de hoje. Volte amanhã!',
      progress: shape
    };
  }

  const index = weekdayIndex(today);
  const chest = DAILY_CHEST[index];
  const multiplier = xpMultiplier(shape, now);
  const xpGain = Math.round(chest.xp * multiplier);

  shape.coins = (Number(shape.coins) || 0) + chest.coins;
  shape.xp = (Number(shape.xp) || 0) + xpGain;
  shape.lastDailyClaimDate = today;

  claims[today] = {
    day: index + 1,
    coins: chest.coins,
    xp: xpGain,
    claimedAt: new Date().toISOString(),
    compensated: false
  };
  // Guarda só os últimos 14 resgates (o suficiente para o ciclo do baú)
  const keys = Object.keys(claims).sort();
  while (keys.length > 14) {
    delete claims[keys.shift()];
  }
  shape.dailyClaims = claims;

  const week = weekKey(now);
  shape.dailyStreak = claimsInWeek(claims, week);
  shape.dailyWeekKey = week;

  return {
    ok: true,
    error: null,
    reward: {
      day: index + 1,
      label: WEEKDAY_NAMES[index],
      coins: chest.coins,
      xp: xpGain,
      streak: shape.dailyStreak,
      compensated: false
    },
    progress: shape
  };
}

/* ------------------------------------------------------------------
   COMPENSADOR
   Resgata um dia que o jogador deixou passar. Custa 1 compensador
   (conquistado no passe de batalha).
------------------------------------------------------------------ */
function claimMissedDailyReward(progress, dateKey, now) {
  const shape = ensureProgressShape(progress);
  const today = dayKey(now);
  const date = String(dateKey || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'Data inválida.', progress: shape };
  }
  if (date >= today) {
    return { ok: false, error: 'A compensação vale apenas para dias que já passaram.', progress: shape };
  }

  const week = weekKey(now);
  const weekStart = shiftDayKey(week, -7);
  if (date < weekStart || date > today) {
    return { ok: false, error: 'A compensação vale apenas para a semana atual.', progress: shape };
  }

  const claims = shape.dailyClaims || {};
  if (claims[date]) {
    return { ok: false, error: 'A recompensa deste dia já foi resgatada.', progress: shape };
  }

  const tokens = Math.max(0, Number(shape.compensationTokens) || 0);
  if (tokens <= 0) {
    return {
      ok: false,
      error: 'Você não tem compensadores. Conquiste mais no Passe de Batalha!',
      progress: shape
    };
  }

  const index = weekdayIndex(date);
  const chest = DAILY_CHEST[index];
  const multiplier = xpMultiplier(shape, now);
  const xpGain = Math.round(chest.xp * multiplier);

  shape.compensationTokens = tokens - 1;
  shape.coins = (Number(shape.coins) || 0) + chest.coins;
  shape.xp = (Number(shape.xp) || 0) + xpGain;

  claims[date] = {
    day: index + 1,
    coins: chest.coins,
    xp: xpGain,
    claimedAt: new Date().toISOString(),
    compensated: true
  };
  const keys = Object.keys(claims).sort();
  while (keys.length > 14) {
    delete claims[keys.shift()];
  }
  shape.dailyClaims = claims;

  shape.dailyStreak = claimsInWeek(claims, weekKey(now));
  shape.dailyWeekKey = weekKey(now);

  return {
    ok: true,
    error: null,
    reward: {
      day: index + 1,
      label: WEEKDAY_NAMES[index],
      coins: chest.coins,
      xp: xpGain,
      compensated: true,
      usedCompensator: true,
      compensationTokens: shape.compensationTokens,
      streak: shape.dailyStreak
    },
    progress: shape
  };
}

/* ------------------------------------------------------------------
   MISSÕES
   A 4ª missão diária é o SLOT EXTRA (item CON-003 da loja): ela só
   aparece (e só pode ser resgatada) para quem tem o slot ativo.
------------------------------------------------------------------ */
function missionUnlocked(mission, shape, now) {
  if (!mission.extraSlot) return true;
  return shop.hasMissionSlot(shape.shopState, now);
}

function describeMissions(progress, now) {
  const shape = ensureProgressShape(progress);
  const daily = [];
  const weekly = [];

  MISSION_DEFINITIONS.forEach(mission => {
    if (!missionUnlocked(mission, shape, now)) return;
    const entry = missionEntry(shape, mission, now);
    const complete = entry.progress >= mission.target;
    const item = {
      id: mission.id,
      title: mission.title,
      description: mission.description,
      metric: mission.metric,
      target: mission.target,
      progress: Math.min(mission.target, entry.progress),
      claimed: entry.claimed,
      complete,
      canClaim: complete && !entry.claimed,
      coins: mission.coins,
      xp: mission.xp,
      cycle: mission.cycle
    };
    if (mission.cycle === 'weekly') weekly.push(item);
    else daily.push(item);
  });

  return { daily, weekly };
}

function claimMissionReward(progress, missionId, now) {
  const shape = ensureProgressShape(progress);
  const mission = MISSION_DEFINITIONS.find(item => item.id === String(missionId || ''));
  if (!mission) {
    return { ok: false, error: 'Missão desconhecida.', progress: shape };
  }
  if (!missionUnlocked(mission, shape, now)) {
    return { ok: false, error: 'Esta missão precisa do slot extra de missão diária.', progress: shape };
  }

  const entry = missionEntry(shape, mission, now);
  if (entry.claimed) {
    return { ok: false, error: 'A recompensa desta missão já foi resgatada.', progress: shape };
  }
  if (entry.progress < mission.target) {
    return { ok: false, error: 'Missão ainda não concluída.', progress: shape };
  }

  const multiplier = xpMultiplier(shape, now);
  const xpGain = Math.round(mission.xp * multiplier);

  shape.coins = (Number(shape.coins) || 0) + mission.coins;
  shape.xp = (Number(shape.xp) || 0) + xpGain;

  const state = shape.missionState;
  state[mission.id] = {
    cycle: entry.cycle,
    progress: entry.progress,
    claimed: true,
    claimedAt: new Date().toISOString()
  };
  shape.missionState = state;

  return {
    ok: true,
    error: null,
    reward: { id: mission.id, coins: mission.coins, xp: xpGain },
    progress: shape
  };
}

/* Multiplicador de XP: o boost comprado na loja (PRO-005/PRO-006)
   DOBRA o XP ganho (o passe tem o boost próprio de 1,5x). */
function xpMultiplier(progress, now) {
  return shop.isXpDoubleActive(progress && progress.shopState, now) ? 2 : 1;
}

/* ------------------------------------------------------------------
   PARTIDA CONTABILIZADA NAS MISSÕES
------------------------------------------------------------------ */
function applyMatchProgress(progress, match, now) {
  const shape = ensureProgressShape(progress);
  const info = match || {};
  const id = info.id ? String(info.id).slice(0, 64) : null;

  // A mesma partida não pode ser contabilizada duas vezes
  if (id && shape.processedMatchIds.includes(id)) {
    return { ok: false, duplicate: true, error: 'Partida já contabilizada.', progress: shape };
  }

  const captures = clampCount(info.captures, 40);
  const pieces = clampCount(info.pieces, 8);
  const won = info.result === 'win';
  const draw = info.result === 'draw';
  const mode = String(info.mode || 'local');
  const isLeague = mode === 'liga';

  shape.matchesPlayed = (Number(shape.matchesPlayed) || 0) + 1;
  if (won) shape.wins = (Number(shape.wins) || 0) + 1;

  // Ludas por partida (roadmap "Economia — Fontes e Gastos")
  const coinsGain = isLeague
    ? (won ? MATCH_REWARDS.leagueWin : MATCH_REWARDS.leagueLoss)
    : (won ? MATCH_REWARDS.win : draw ? MATCH_REWARDS.draw : MATCH_REWARDS.loss);
  shape.coins = (Number(shape.coins) || 0) + coinsGain;

  // XP por partida: mesmo perdendo, o jogador continua progredindo
  const multiplier = xpMultiplier(shape, now);
  const xpGain = Math.round((won ? 15 : 8) * multiplier);
  shape.xp = (Number(shape.xp) || 0) + xpGain;

  const gains = {
    matches: 1,
    wins: won ? 1 : 0,
    captures,
    pieces,
    dupla: mode === 'dupla' ? 1 : 0,
    xp: xpGain,
    coins: coinsGain
  };

  const dailyCycle = dayKey(now);
  const weeklyCycle = weekKey(now);
  const state = shape.missionState;

  MISSION_DEFINITIONS.forEach(mission => {
    const cycle = mission.cycle === 'weekly' ? weeklyCycle : dailyCycle;
    const existing = state[mission.id];
    const entry = (existing && existing.cycle === cycle)
      ? {
        cycle,
        progress: Math.max(0, Number(existing.progress) || 0),
        claimed: Boolean(existing.claimed),
        claimedAt: existing.claimedAt || null
      }
      : { cycle, progress: 0, claimed: false, claimedAt: null };

    const gain = gains[mission.metric] || 0;
    if (gain > 0) entry.progress = Math.min(mission.target, entry.progress + gain);
    state[mission.id] = entry;
  });

  shape.missionState = state;
  if (id) {
    shape.processedMatchIds.push(id);
    shape.processedMatchIds = shape.processedMatchIds.slice(-50);
  }
  shape.updatedAt = new Date().toISOString();

  return { ok: true, duplicate: false, progress: shape, gains };
}

/* ------------------------------------------------------------------
   VISÃO COMPLETA (usada pela API)
------------------------------------------------------------------ */
function describeProgress(progress, now) {
  const shape = ensureProgressShape(progress);
  const daily = describeDaily(shape, now);
  const missions = describeMissions(shape, now);
  const all = missions.daily.concat(missions.weekly);
  const xp = Math.max(0, Number(shape.xp) || 0);

  return {
    coins: Math.max(0, Number(shape.coins) || 0),
    crystals: Math.max(0, Number(shape.crystals) || 0),
    xp,
    level: 1 + Math.floor(xp / 200),
    matchesPlayed: Math.max(0, Number(shape.matchesPlayed) || 0),
    wins: Math.max(0, Number(shape.wins) || 0),
    daily,
    missions,
    claimableMissions: all.filter(item => item.canClaim).length,
    compensationTokens: daily.compensationTokens,
    hasRewards: daily.canClaim
      || all.some(item => item.canClaim)
      || Boolean(daily.canCompensateAny),
    dayKey: dayKey(now),
    weekKey: weekKey(now)
  };
}

module.exports = {
  DAILY_CHEST,
  WEEKDAY_NAMES,
  MISSION_DEFINITIONS,
  MATCH_REWARDS,
  dayKey,
  weekKey,
  shiftDayKey,
  weekdayIndex,
  ensureProgressShape,
  describeDaily,
  claimDailyReward,
  claimMissedDailyReward,
  describeMissions,
  claimMissionReward,
  applyMatchProgress,
  describeProgress
};
