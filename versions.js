/* ------------------------------------------------------------------
   CALENDÁRIO DE VERSÕES (Servidor de Testes)

   Fonte única de verdade das janelas de versão. O status de cada
   versão (NO AR / PROGRAMADA / ENCERRADA) é calculado aqui e entregue
   ao cliente pela rota /api/version, para que a tela e o servidor
   nunca discordem sobre qual versão está no ar.

   PASSE DE BATALHA
   O Passe acompanha a versão: começa junto com ela, dura 50 dias e
   termina 2 dias antes do fim da versão. Nas versões de 52 dias
   (1.1 em diante) as duas regras batem exatamente: 50 dias de passe
   e 2 dias de folga antes do fim da versão.

   SIMULAÇÃO DE VERSÃO
   O relógio do Servidor de Testes roda adiantado em
   VERSION_SIMULATION_OFFSET_DAYS (61 dias por padrão): assim a
   versão 1.1 já entra NO AR e a 1.0 fica ENCERRADA, simulando a
   virada de versão. Para voltar ao relógio real, configure
   VERSION_SIMULATION_OFFSET_DAYS=0 no ambiente.
------------------------------------------------------------------ */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/* Duração do Passe de Batalha e folga antes do fim da versão */
const PASS_DURATION_DAYS = 50;
const PASS_END_BUFFER_DAYS = 2;

/* Calendário oficial (datas YYYY-MM-DD no fuso de Brasília) */
const VERSION_WINDOWS = [
  { version: '1.0', title: 'Lançamento', start: '2026-11-09', end: '2026-12-31', major: false },
  { version: '1.1', start: '2027-01-01', end: '2027-02-21', major: false },
  { version: '1.2', start: '2027-02-22', end: '2027-04-14' },
  { version: '1.3', start: '2027-04-15', end: '2027-06-05' },
  { version: '1.4', start: '2027-06-06', end: '2027-07-27' },
  { version: '1.5', start: '2027-07-28', end: '2027-09-17' },
  { version: '1.6', start: '2027-09-18', end: '2027-11-08' },
  { version: '2.0', title: 'A Grande Rolagem', start: '2027-11-09', end: '2027-12-31', major: true }
];

/* Relógio adiantado para simular a versão 1.1 no ar */
const SIMULATION_OFFSET_DAYS = (() => {
  const raw = Number(process.env.VERSION_SIMULATION_OFFSET_DAYS);
  return Number.isFinite(raw) ? raw : 61;
})();

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime();
}

/* Relógio do Servidor de Testes (adiantado pela simulação) */
function simulatedNowMs(now) {
  return toMs(now) + SIMULATION_OFFSET_DAYS * DAY_MS;
}

function simulatedNow(now) {
  return new Date(simulatedNowMs(now));
}

/* 00h00 no fuso de Brasília (UTC-3) para uma data YYYY-MM-DD */
function parseVersionDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return Date.UTC(year, month - 1, day, 3);
}

/* Janela da versão em milissegundos (o fim do calendário é inclusivo) */
function versionWindow(entry) {
  return {
    ...entry,
    startMs: parseVersionDate(entry.start),
    endExclusiveMs: parseVersionDate(entry.end) + DAY_MS
  };
}

function allWindows() {
  return VERSION_WINDOWS.map(versionWindow);
}

/* Status derivado da data: encerrada / no ar / programada */
function versionStatus(window, nowMs) {
  if (nowMs < window.startMs) return 'planned';
  if (nowMs >= window.endExclusiveMs) return 'past';
  return 'current';
}

/* Janela do Passe: começa com a versão, dura 50 dias e termina
   2 dias antes do fim da versão (o que vier primeiro). */
function passWindowFor(entry) {
  const window = typeof entry.startMs === 'number' ? entry : versionWindow(entry);
  const byDuration = window.startMs + PASS_DURATION_DAYS * DAY_MS;
  const byVersionEnd = window.endExclusiveMs - PASS_END_BUFFER_DAYS * DAY_MS;
  const endExclusiveMs = Math.min(byDuration, byVersionEnd);
  return {
    startMs: window.startMs,
    endExclusiveMs,
    days: Math.max(1, Math.round((endExclusiveMs - window.startMs) / DAY_MS))
  };
}

/* Versão que está no ar no relógio do Servidor de Testes */
function currentVersion(now) {
  const nowMs = simulatedNowMs(now);
  const windows = allWindows();
  return windows.find(window => versionStatus(window, nowMs) === 'current') || windows[0];
}

/* Visão completa (usada pela API /api/version) */
function describeVersions(now) {
  const nowMs = simulatedNowMs(now);
  const entries = allWindows().map(window => {
    const pass = passWindowFor(window);
    return {
      version: window.version,
      title: window.title || null,
      start: window.start,
      end: window.end,
      major: Boolean(window.major),
      status: versionStatus(window, nowMs),
      passStart: new Date(pass.startMs).toISOString(),
      passEnd: new Date(pass.endExclusiveMs - DAY_MS).toISOString(),
      passDays: pass.days
    };
  });

  const current = entries.find(entry => entry.status === 'current') || entries[0];
  return {
    version: current.version,
    title: current.title,
    start: current.start,
    end: current.end,
    status: current.status,
    simulationOffsetDays: SIMULATION_OFFSET_DAYS,
    simulatedNow: new Date(nowMs).toISOString(),
    passDurationDays: PASS_DURATION_DAYS,
    passEndBufferDays: PASS_END_BUFFER_DAYS,
    entries
  };
}

module.exports = {
  DAY_MS,
  PASS_DURATION_DAYS,
  PASS_END_BUFFER_DAYS,
  VERSION_WINDOWS,
  SIMULATION_OFFSET_DAYS,
  parseVersionDate,
  versionWindow,
  versionStatus,
  passWindowFor,
  simulatedNow,
  simulatedNowMs,
  currentVersion,
  describeVersions
};
