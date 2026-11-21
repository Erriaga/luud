/* ------------------------------------------------------------------
   PASSE DE BATALHA — 50 dias (roadmap #9)

   O Passe acompanha a versão do jogo: começa junto com a versão,
   dura 50 dias e termina 2 dias antes do fim dela. O XP
   conquistado no jogo (partidas, baú diário e missões) libera os
   níveis do passe. A cada virada de versão um novo Passe começa,
   criando um objetivo de longo prazo e o hábito de voltar sempre.

   Módulo de regras puras (sem I/O), no mesmo estilo do rewards.js:
   o servidor valida e persiste; o cliente só exibe.
------------------------------------------------------------------ */

'use strict';

const versions = require('./versions');

/* Duração do Passe (vem do calendário de versões) */
const SEASON_LENGTH_DAYS = versions.PASS_DURATION_DAYS;
const SEASON_LEVELS = 30;
// XP acumulado necessário para desbloquear cada nível
const XP_PER_LEVEL = 80;
// Multiplicador do XP do passe durante um boost
const XP_BOOST_FACTOR = 1.5;
// Multiplicador do XP do passe para contas Premium (roadmap #20):
// a conta Premium ganha o DOBRO de XP em toda partida, baú e missão.
const PREMIUM_XP_MULTIPLIER = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------
   TRILHAS DE RECOMPENSA
   free:    disponível para qualquer jogador
   premium: exige conta Premium (o servidor valida antes de liberar)
   ------------------------------------------------------------------ */
function buildFreeTrack() {
  const track = [];
  for (let level = 1; level <= SEASON_LEVELS; level += 1) {
    const reward = { coins: 5 + level * 3 };
    if (level === 15) reward.compensationTokens = 1;
    if (level === 25) reward.compensationTokens = 1;
    track.push(reward);
  }
  return track;
}

function buildPremiumTrack() {
  const track = [];
  for (let level = 1; level <= SEASON_LEVELS; level += 1) {
    const reward = { coins: 15 + level * 6 };
    if (level === 5) reward.compensationTokens = 1;
    if (level === 10) {
      reward.xpBoostDays = 7;
      // Cristais simbólicos do passe (regra: no máximo 20 por temporada)
      reward.crystals = 2;
    }
    if (level === 15) reward.compensationTokens = 1;
    if (level === 20) {
      reward.xpBoostDays = 7;
      reward.extraCoins = 50;
      reward.crystals = 3;
    }
    if (level === 25) reward.compensationTokens = 1;
    if (level === 30) {
      reward.xpBoostDays = 30;
      reward.extraCoins = 100;
      reward.compensationTokens = 1;
      reward.crystals = 5;
    }
    track.push(reward);
  }
  return track;
}

const FREE_TRACK = buildFreeTrack();
const PREMIUM_TRACK = buildPremiumTrack();

/* ------------------------------------------------------------------
   PASSE ATUAL
   A temporada é a versão que está no ar: o Passe começa com ela,
   dura 50 dias e fecha 2 dias antes do fim da versão.
------------------------------------------------------------------ */
function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Data YYYY-MM-DD no fuso de Brasília (UTC-3), para o cliente exibir
// sem erro de fuso (new Date('2027-02-21') seria 20/02 no Brasil)
function formatBrDate(ms) {
  const shifted = new Date(ms + 3 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Versão em curso, janela do Passe e dias restantes
function currentSeason(now) {
  const version = versions.currentVersion(now);
  const pass = versions.passWindowFor(version);
  const date = versions.simulatedNow(now);
  const start = pass.startMs;
  const end = pass.endExclusiveMs;
  const lastDayMs = end - DAY_MS;
  const remainingMs = Math.max(0, lastDayMs - date.getTime());
  return {
    id: `v${version.version}`,
    number: version.version,
    version: version.version,
    versionTitle: version.title || null,
    versionStart: version.start,
    versionEnd: version.end,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    passEnd: new Date(lastDayMs).toISOString(),
    passEndDate: formatBrDate(lastDayMs),
    lengthDays: pass.days,
    daysRemaining: Math.max(1, Math.ceil(remainingMs / DAY_MS)),
    dayOfSeason: Math.min(pass.days, Math.max(1, Math.floor((date.getTime() - start) / DAY_MS) + 1))
  };
}

// XP acumulado necessário para alcançar o nível informado
function levelThreshold(level) {
  const value = Math.max(1, Math.min(SEASON_LEVELS, Math.floor(Number(level) || 1)));
  return value * XP_PER_LEVEL;
}

// Nível alcançado com o XP acumulado do passe
function levelForXp(seasonXp) {
  const xp = Math.max(0, Number(seasonXp) || 0);
  let level = 0;
  for (let candidate = 1; candidate <= SEASON_LEVELS; candidate += 1) {
    if (xp >= levelThreshold(candidate)) level = candidate;
    else break;
  }
  return level;
}

// Descrição de uma recompensa (para o cliente)
// Nota: o emoji de moeda é o U+1F4B0 (saco de dinheiro) e não o
// U+1FA99 (moeda): o segundo não existe em fontes de emoji mais
// antigas e aparecia como quadradinho vazio (tofu) em vários sistemas.
function describeReward(reward) {
  if (!reward) return { coins: 0, crystals: 0, label: '' };
  const parts = [];
  if (reward.coins) parts.push(`💰 ${reward.coins}`);
  if (reward.extraCoins) parts.push(`💰 +${reward.extraCoins}`);
  if (reward.crystals) parts.push(`💎 ${reward.crystals}`);
  if (reward.xpBoostDays) parts.push(`⭐ XP +${Math.round((XP_BOOST_FACTOR - 1) * 100)}% por ${reward.xpBoostDays} dias`);
  if (reward.compensationTokens) parts.push(`🎁 ${reward.compensationTokens} compensador(es)`);
  return {
    coins: (reward.coins || 0) + (reward.extraCoins || 0),
    crystals: reward.crystals || 0,
    xpBoostDays: reward.xpBoostDays || 0,
    compensationTokens: reward.compensationTokens || 0,
    label: parts.join(' · ')
  };
}

function ensureSeasonShape(progress) {
  if (!progress || typeof progress !== 'object') return {};
  if (!progress.seasonXp || Number(progress.seasonXp) < 0) progress.seasonXp = 0;
  if (!Array.isArray(progress.seasonClaims)) progress.seasonClaims = [];
  // Compensadores: trocam um dia perdido do baú diário por um resgate
  if (!Number.isFinite(Number(progress.compensationTokens)) || Number(progress.compensationTokens) < 0) {
    progress.compensationTokens = 0;
  }
  return progress;
}

function claimKey(level, track) {
  return `${track === 'premium' ? 'premium' : 'free'}:${Number(level) || 0}`;
}

/* ------------------------------------------------------------------
   XP DA TEMPORADA
   Todo XP conquistado no jogo (partida, baú diário, missão) alimenta
   o passe. O boost Premium multiplica apenas o XP do passe.

   Contas Premium ganham o DOBRO de XP (roadmap #20): o multiplicador
   do Premium é sempre ativo e soma com o boost por tempo limitado.
------------------------------------------------------------------ */
function applySeasonXp(progress, xpEarned, now, options = {}) {
  const shape = ensureSeasonShape(progress);
  const season = currentSeason(now);
  const gain = Math.max(0, Math.floor(Number(xpEarned) || 0));
  if (!gain) return { ok: false, reason: 'sem_xp', season, seasonXp: shape.seasonXp };

  // Temporada nova: zera a trilha e as resgates da temporada anterior
  let renewed = false;
  if (shape.seasonId !== season.id) {
    shape.seasonId = season.id;
    shape.seasonXp = 0;
    shape.seasonClaims = [];
    renewed = true;
  }

  const premium = Boolean(options.isPremium);
  const boosted = isXpBoostActive(shape, now);
  // Premium: XP em dobro (roadmap #20). O boost por tempo limitado soma
  // em cima do multiplicador do Premium.
  const multiplier = (premium ? PREMIUM_XP_MULTIPLIER : 1) * (boosted ? XP_BOOST_FACTOR : 1);
  const applied = Math.round(gain * multiplier);
  shape.seasonXp = (Number(shape.seasonXp) || 0) + applied;

  return { ok: true, season, seasonXp: shape.seasonXp, gained: applied, boosted, premium, renewed, progress: shape };
}

function isXpBoostActive(progress, now) {
  const shape = ensureSeasonShape(progress);
  if (!shape.xpBoostUntil) return false;
  const until = new Date(shape.xpBoostUntil).getTime();
  if (!Number.isFinite(until)) return false;
  return toDate(now).getTime() < until;
}

/* ------------------------------------------------------------------
   RESGATE DE UM NÍVEL
------------------------------------------------------------------ */
function claimLevelReward(progress, level, track, options = {}) {
  const shape = ensureSeasonShape(progress);
  const season = currentSeason(options.now);
  const wantedLevel = Math.floor(Number(level) || 0);
  const wantedTrack = track === 'premium' ? 'premium' : 'free';

  if (wantedLevel < 1 || wantedLevel > SEASON_LEVELS) {
    return { ok: false, error: 'Nível inválido.', progress: shape };
  }
  if (wantedTrack === 'premium' && !options.isPremium && !options.hasPremiumPass) {
    return { ok: false, error: 'A trilha Premium exige uma conta Premium ou a trilha comprada na loja.', progress: shape };
  }

  // Temporada nova: a lista de resgates é zerada
  if (shape.seasonId !== season.id) {
    shape.seasonId = season.id;
    shape.seasonXp = 0;
    shape.seasonClaims = [];
  }

  const key = claimKey(wantedLevel, wantedTrack);
  if (shape.seasonClaims.includes(key)) {
    return { ok: false, error: 'Recompensa já resgatada.', progress: shape };
  }

  const seasonXp = Number(shape.seasonXp) || 0;
  const required = levelThreshold(wantedLevel);
  if (seasonXp < required) {
    return { ok: false, error: 'Você ainda não tem XP suficiente para este nível.', progress: shape };
  }

  const reward = (wantedTrack === 'premium' ? PREMIUM_TRACK : FREE_TRACK)[wantedLevel - 1];
  const described = describeReward(reward);

  shape.coins = (Number(shape.coins) || 0) + described.coins;
  if (described.crystals) {
    shape.crystals = (Number(shape.crystals) || 0) + described.crystals;
  }
  if (described.compensationTokens) {
    shape.compensationTokens = (Number(shape.compensationTokens) || 0) + described.compensationTokens;
  }
  if (reward.xpBoostDays) {
    const now = toDate(options.now);
    const base = isXpBoostActive(shape, now)
      ? new Date(shape.xpBoostUntil).getTime()
      : now.getTime();
    shape.xpBoostUntil = new Date(base + reward.xpBoostDays * DAY_MS).toISOString();
  }

  shape.seasonClaims.push(key);
  shape.seasonClaims = shape.seasonClaims.slice(-120);

  return {
    ok: true,
    error: null,
    reward: { level: wantedLevel, track: wantedTrack, ...described },
    season,
    progress: shape
  };
}

/* ------------------------------------------------------------------
   RESGATE UNIFICADO DE UM NÍVEL
   O passe tem UM botão por nível: a conta gratuita resgata a trilha
   FREE e a conta Premium resgata a FREE + a PREMIUM de uma vez (o
   botão mostra as duas recompensas lado a lado).
------------------------------------------------------------------ */
function claimLevelRewards(progress, level, options = {}) {
  const free = claimLevelReward(progress, level, 'free', options);
  const hasPremium = Boolean(options.isPremium || options.hasPremiumPass);
  if (!hasPremium) return free;

  const premium = claimLevelReward(progress, level, 'premium', options);
  const rewards = [];
  if (free.ok && free.reward) rewards.push(free.reward);
  if (premium.ok && premium.reward) rewards.push(premium.reward);
  const ok = rewards.length > 0;
  return {
    ok,
    error: ok ? null : (free.error || premium.error),
    reward: rewards[0] || null,
    rewards,
    season: free.season || premium.season,
    progress
  };
}

/* ------------------------------------------------------------------
   VISÃO COMPLETA (usada pela API)
------------------------------------------------------------------ */
function describeSeason(progress, now, options = {}) {
  const shape = ensureSeasonShape(progress);
  const season = currentSeason(now);
  const isCurrent = shape.seasonId === season.id;
  const seasonXp = isCurrent ? Math.max(0, Number(shape.seasonXp) || 0) : 0;
  const claims = isCurrent ? shape.seasonClaims : [];
  const level = levelForXp(seasonXp);
  const nextLevel = level < SEASON_LEVELS ? level + 1 : SEASON_LEVELS;
  const nextThreshold = levelThreshold(nextLevel);
  // Nível 0 = nenhum nível liberado ainda: o progresso do nível 1
  // começa em 0 XP (e não no limite do nível 1).
  const currentThreshold = level > 0 ? levelThreshold(level) : 0;
  const progressToNext = level >= SEASON_LEVELS
    ? 100
    : Math.max(0, Math.min(100, Math.round(((seasonXp - currentThreshold) / Math.max(1, nextThreshold - currentThreshold)) * 100)));
  const isPremium = Boolean(options.isPremium);
  const hasPremiumPass = Boolean(options.hasPremiumPass);
  // Quem tem a trilha premium comprada (item PRO-001 da loja) ou conta
  // Premium resgata as duas trilhas de uma vez.
  const premiumTrackOpen = isPremium || hasPremiumPass;

  const buildTrack = (trackName, rewards) => rewards.map((reward, index) => {
    const itemLevel = index + 1;
    const key = claimKey(itemLevel, trackName);
    const unlocked = seasonXp >= levelThreshold(itemLevel);
    return {
      level: itemLevel,
      track: trackName,
      requiredXp: levelThreshold(itemLevel),
      unlocked,
      claimed: claims.includes(key),
      canClaim: unlocked && !claims.includes(key),
      ...describeReward(reward)
    };
  });

  const free = buildTrack('free', FREE_TRACK);
  const premium = buildTrack('premium', PREMIUM_TRACK);

  // Níveis unificados: cada nível mostra a recompensa gratuita e a
  // premium (a conta Premium resgata as duas de uma vez).
  const levels = free.map(item => {
    const premiumItem = premium.find(entry => entry.level === item.level) || {};
    const claimed = premiumTrackOpen
      ? Boolean(item.claimed && premiumItem.claimed)
      : item.claimed;
    const canClaim = premiumTrackOpen
      ? Boolean(item.canClaim || premiumItem.canClaim)
      : item.canClaim;
    return {
      level: item.level,
      requiredXp: item.requiredXp,
      unlocked: item.unlocked,
      claimed,
      canClaim,
      free: {
        coins: item.coins || 0,
        crystals: item.crystals || 0,
        xpBoostDays: item.xpBoostDays || 0,
        compensationTokens: item.compensationTokens || 0,
        label: item.label || ''
      },
      premium: {
        coins: premiumItem.coins || 0,
        crystals: premiumItem.crystals || 0,
        xpBoostDays: premiumItem.xpBoostDays || 0,
        compensationTokens: premiumItem.compensationTokens || 0,
        label: premiumItem.label || ''
      }
    };
  });

  // Quantos níveis estão esperando resgate (um por nível, não por trilha)
  const claimable = levels.filter(item => item.canClaim).length;

  return {
    seasonId: season.id,
    seasonNumber: season.number,
    seasonLengthDays: season.lengthDays,
    version: season.version,
    versionTitle: season.versionTitle,
    versionStart: season.versionStart,
    versionEnd: season.versionEnd,
    passEnd: season.passEnd,
    passEndDate: season.passEndDate,
    passEndBufferDays: versions.PASS_END_BUFFER_DAYS,
    start: season.start,
    end: season.end,
    daysRemaining: season.daysRemaining,
    dayOfSeason: season.dayOfSeason,
    seasonXp,
    level,
    nextLevel,
    nextRequiredXp: nextThreshold,
    currentRequiredXp: currentThreshold,
    levelXp: Math.max(0, seasonXp - currentThreshold),
    levelXpTotal: Math.max(1, nextThreshold - currentThreshold),
    progressToNext,
    xpBoostActive: isXpBoostActive(shape, now),
    xpBoostUntil: shape.xpBoostUntil || null,
    // Compensadores disponíveis para resgatar um dia perdido do baú
    compensationTokens: Math.max(0, Number(shape.compensationTokens) || 0),
    free,
    premium,
    levels,
    claimable,
    hasClaimable: claimable > 0,
    isPremium,
    hasPremiumPass
  };
}

module.exports = {
  SEASON_LENGTH_DAYS,
  SEASON_LEVELS,
  XP_PER_LEVEL,
  XP_BOOST_FACTOR,
  PREMIUM_XP_MULTIPLIER,
  FREE_TRACK,
  PREMIUM_TRACK,
  PASS_END_BUFFER_DAYS: versions.PASS_END_BUFFER_DAYS,
  currentSeason,
  levelThreshold,
  levelForXp,
  describeReward,
  ensureSeasonShape,
  applySeasonXp,
  isXpBoostActive,
  claimLevelReward,
  claimLevelRewards,
  describeSeason
};
