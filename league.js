'use strict';

/**
 * REGRAS DA LIGA (tiers, pontuação e promoção)
 * ------------------------------------------------------------------
 * A Liga é exclusiva para contas Premium. Os jogadores são divididos
 * em tiers (F, E, D, C, B, A, S e SS). Cada tier tem um intervalo de
 * 100 pontos:
 *
 *  - Ao chegar a 100 pontos no tier atual, o jogador fica "pendente"
 *    de promoção;
 *  - Nos tiers F..A a promoção acontece através de uma melhor de 3
 *    dentro do matchmaking da Liga: vencendo 2 de 3 o jogador sobe
 *    de tier com 0 pontos; perdendo 2 de 3 ele continua no tier com
 *    60 pontos;
 *  - No tier S a promoção para SS depende de 100 pontos E da posição
 *    entre os 100 melhores jogadores do tier S.
 *
 * A pontuação de cada partida da Liga:
 *   vitória por 4 a 0 = +80 | 4 a 1 = +60 | 4 a 2 = +40 | 4 a 3 = +20
 *   derrota          = o valor correspondente do placar, negativo
 */

const TIERS = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS'];
const TIER_COLORS = {
  F: '#76F8F8',
  E: '#9DF89D',
  D: '#BFFF7F',
  C: '#FED4A0',
  B: '#FFBE7C',
  A: '#FFA967',
  S: '#EC6563',
  SS: '#EF5350'
};

const TIER_POINTS = 100;          // pontos para completar o tier
const PROMOTION_WINS = 2;         // vitórias na melhor de 3 para subir
const PROMOTION_LOSSES = 2;       // derrotas na melhor de 3 para ficar
const SERIES_LOSS_POINTS = 60;    // pontos mantidos ao perder a melhor de 3
const SS_RANKING_SIZE = 100;      // posições necessárias para o tier SS
const MATCH_TARGET = 4;           // pontos que encerram a partida

// Normaliza o tier recebido (sempre devolve um tier válido)
function normalizeTier(tier) {
  const value = String(tier || '').trim().toUpperCase();
  return TIERS.indexOf(value) === -1 ? TIERS[0] : value;
}

function isValidTier(tier) {
  return TIERS.indexOf(String(tier || '').trim().toUpperCase()) !== -1;
}

// Posição do tier na ordem de progressão (F = 0 ... SS = 7)
function tierIndex(tier) {
  return TIERS.indexOf(normalizeTier(tier));
}

// Próximo tier (SS é o último: continua no SS)
function nextTier(tier) {
  const index = tierIndex(tier);
  if (index < 0 || index >= TIERS.length - 1) return normalizeTier(tier);
  return TIERS[index + 1];
}

// Tier imediatamente anterior (F é o primeiro: continua no F)
function previousTier(tier) {
  const index = tierIndex(tier);
  if (index <= 0) return normalizeTier(tier);
  return TIERS[index - 1];
}

// Cor oficial de cada tier
function tierColor(tier) {
  return TIER_COLORS[normalizeTier(tier)];
}

/**
 * Pontos ganhos (ou perdidos) em uma partida da Liga.
 * A base vem do placar do perdedor: 4x0 = 80, 4x1 = 60, 4x2 = 40,
 * 4x3 = 20. Na derrota o valor é o mesmo, porém negativo.
 */
function pointsDelta(playerScore, opponentScore) {
  const mine = Number(playerScore) || 0;
  const theirs = Number(opponentScore) || 0;
  if (mine === theirs) return 0;
  const loserScore = Math.min(mine, theirs);
  const base = Math.max(0, 80 - 20 * loserScore);
  return mine > theirs ? base : -base;
}

// Os pontos nunca passam do intervalo do tier (100 pontos)
function clampPoints(points) {
  return Math.min(TIER_POINTS, Math.max(0, Number(points) || 0));
}

// Resultado da melhor de 3: 'promoted', 'demoted' ou null (em andamento)
function seriesDecision(seriesWins, seriesLosses) {
  if (Number(seriesWins) >= PROMOTION_WINS) return 'promoted';
  if (Number(seriesLosses) >= PROMOTION_LOSSES) return 'demoted';
  return null;
}

/**
 * Calcula o novo estado da classificação depois de uma partida.
 * `standing` traz os dados atuais do jogador na Liga.
 */
function applyMatchResult(standing, playerScore, opponentScore, options = {}) {
  const current = {
    tier: normalizeTier(standing && standing.tier),
    points: Math.max(0, Number(standing && standing.points) || 0),
    wins: Number(standing && standing.wins) || 0,
    losses: Number(standing && standing.losses) || 0,
    seriesWins: Number(standing && standing.seriesWins) || 0,
    seriesLosses: Number(standing && standing.seriesLosses) || 0,
    promotionPending: Boolean(standing && standing.promotionPending)
  };

  const delta = pointsDelta(playerScore, opponentScore);
  const won = (Number(playerScore) || 0) > (Number(opponentScore) || 0);
  const next = { ...current };
  if (won) next.wins += 1; else next.losses += 1;

  // Tier máximo: nada a fazer além da pontuação normal
  if (next.tier === 'SS') {
    next.points = clampPoints(next.points + delta);
    next.promotionPending = false;
    return { ...next, delta, won, promoted: false, seriesFinished: false };
  }

  // Promoção pendente nos tiers F..A: a partida vale como jogo da melhor de 3
  if (next.promotionPending && next.tier !== 'S') {
    if (won) next.seriesWins += 1; else next.seriesLosses += 1;
    const decision = seriesDecision(next.seriesWins, next.seriesLosses);
    if (decision === 'promoted') {
      next.tier = nextTier(next.tier);
      next.points = 0;
      next.promotionPending = false;
      next.seriesWins = 0;
      next.seriesLosses = 0;
      return { ...next, delta, won, promoted: true, seriesFinished: true };
    }
    if (decision === 'demoted') {
      // Perdeu a melhor de 3: continua no tier com 60 pontos
      next.points = SERIES_LOSS_POINTS;
      next.promotionPending = false;
      next.seriesWins = 0;
      next.seriesLosses = 0;
      return { ...next, delta, won, promoted: false, seriesFinished: true };
    }
    // Série em andamento: os pontos do tier ficam congelados
    return { ...next, delta, won, promoted: false, seriesFinished: false };
  }

  // Partida normal: soma (ou subtrai) os pontos do placar
  next.points = clampPoints(next.points + delta);

  // Chegou a 100 pontos: fica pendente de promoção
  if (!next.promotionPending && next.points >= TIER_POINTS) {
    next.promotionPending = true;
  }

  // No tier S a promoção para SS também depende do ranking (top 100):
  // esse ajuste é feito pelo servidor, que tem a lista do tier.
  const promoted = Boolean(options.promoted);
  if (promoted) {
    next.tier = nextTier(next.tier);
    next.points = 0;
    next.promotionPending = false;
  }

  return { ...next, delta, won, promoted, seriesFinished: false };
}

// Resumo da situação do jogador na Liga (usado na interface)
function describeStanding(standing) {
  const tier = normalizeTier(standing && standing.tier);
  const points = clampPoints(standing && standing.points);
  const pending = Boolean(standing && standing.promotionPending);
  const seriesWins = Number(standing && standing.seriesWins) || 0;
  const seriesLosses = Number(standing && standing.seriesLosses) || 0;
  return {
    tier,
    tierColor: tierColor(tier),
    points,
    wins: Number(standing && standing.wins) || 0,
    losses: Number(standing && standing.losses) || 0,
    seriesWins,
    seriesLosses,
    // A melhor de 3 acontece nos tiers F..A quando o jogador chega a 100 pontos
    seriesInProgress: pending && tier !== 'S' && tier !== 'SS',
    seriesTarget: PROMOTION_WINS,
    promotionPending: pending,
    nextTier: nextTier(tier),
    pointsToNextTier: Math.max(0, TIER_POINTS - points)
  };
}

module.exports = {
  TIERS,
  TIER_COLORS,
  TIER_POINTS,
  PROMOTION_WINS,
  PROMOTION_LOSSES,
  SERIES_LOSS_POINTS,
  SS_RANKING_SIZE,
  MATCH_TARGET,
  normalizeTier,
  isValidTier,
  tierIndex,
  nextTier,
  previousTier,
  tierColor,
  pointsDelta,
  clampPoints,
  seriesDecision,
  applyMatchResult,
  describeStanding
};
