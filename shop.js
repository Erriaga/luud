/* ------------------------------------------------------------------
   LOJA — catálogo, preços e efeitos (roadmap "loja-luud-economia.xlsx")

   Módulo de regras puras (sem I/O), no mesmo estilo do rewards.js e do
   season.js: o servidor valida, aplica e persiste; o cliente só
   exibe o que o servidor devolveu.

   DUAS MOEDAS (aba "Regras da Economia"):
   - LUDAS   (coins): moeda gratuita, conquistada jogando.
   - CRISTAIS (crystals): moeda premium, comprada via Pix (e no máximo
     10 por temporada na trilha premium do Passe).

   Regras invioláveis desta loja:
   - Ludas NUNCA compram Cristais; Cristais NUNCA viram Ludas.
   - Nenhum item pago dá vantagem competitiva (zero pay-to-win).
   - Todo item cosmético tem caminho grátis (mais lento).
   - O preço e a quantidade são resolvidos AQUI, nunca no cliente.
------------------------------------------------------------------ */

'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------
   RARIDADES E CATEGORIAS
------------------------------------------------------------------ */
const RARITIES = {
  common: { id: 'common', name: 'Comum', tone: 'slate' },
  rare: { id: 'rare', name: 'Raro', tone: 'sky' },
  epic: { id: 'epic', name: 'Épico', tone: 'violet' },
  legendary: { id: 'legendary', name: 'Lendário', tone: 'amber' }
};

const CATEGORIES = [
  { id: 'cosmetic', name: 'COSMÉTICOS', icon: '🎨' },
  { id: 'progress', name: 'PROGRESSÃO', icon: '📈' },
  { id: 'competitive', name: 'COMPETITIVO', icon: '🏆' },
  { id: 'convenience', name: 'CONVENIÊNCIA', icon: '⚡' },
  { id: 'social', name: 'SOCIAL', icon: '👥' },
  { id: 'subscription', name: 'ASSINATURA', icon: '💎' }
];

/* Slots de cosmético equipável */
const EQUIP_SLOTS = [
  { id: 'board', name: 'Tabuleiro' },
  { id: 'tokens', name: 'Peças' },
  { id: 'dice', name: 'Dado' },
  { id: 'theme', name: 'Interface' },
  { id: 'capture', name: 'Captura' },
  { id: 'emotes', name: 'Emotes' },
  { id: 'frame', name: 'Moldura' },
  { id: 'badge', name: 'Badge' },
  { id: 'title', name: 'Título' }
];

/* ------------------------------------------------------------------
   ITENS REPETÍVEIS (consumíveis)
   Baús, boosts, proteções, renomeações e entradas de torneio são
   consumíveis: podem ser comprados de novo depois de usados. Os
   cosméticos (permanentes) ficam no inventário e nunca são
   comprados duas vezes.
------------------------------------------------------------------ */
const REPEATABLE_ITEMS = new Set([
  'PRO-002', // Baú Comum
  'PRO-003', // Baú Raro
  'PRO-004', // Baú Lendário
  'PRO-005', // Boost de XP 24h
  'PRO-006', // Boost de XP 7 dias
  'PRO-007', // Proteção de tier
  'PRO-008', // Renomeação de nick
  'COM-001', // Entrada de torneio diário
  'COM-002', // Entrada de torneio semanal
  'COM-003'  // Entrada de torneio premium
]);

/* ------------------------------------------------------------------
   CATÁLOGO (aba "Catálogo de Itens" da planilha)
   Cada item: preço, moeda, raridade, caminho grátis e o efeito que
   ele entrega quando é comprado.
------------------------------------------------------------------ */
const ITEMS = [
  /* ------------------------------- COSMÉTICOS ---------------------- */
  {
    id: 'COS-001', category: 'cosmetic', slot: 'board', icon: '🟩',
    name: 'Skin de tabuleiro: Clássico',
    description: 'Tabuleiro original do LUUD, cores vivas e alta legibilidade no celular.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-002', category: 'cosmetic', slot: 'board', icon: '🟩',
    name: 'Skin de tabuleiro: Neon',
    description: 'Tabuleiro com traços neon que brilham no modo escuro.',
    rarity: 'rare', currency: 'ludas', price: 1200,
    freePath: 'Desbloqueia no nível 15 do passe free',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-003', category: 'cosmetic', slot: 'board', icon: '🟩',
    name: 'Skin de tabuleiro: Madeira Nobre',
    description: 'Tabuleiro em madeira envelhecida, visual sofisticado.',
    rarity: 'rare', currency: 'ludas', price: 1200,
    freePath: 'Baú raro (chance de 8%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-004', category: 'cosmetic', slot: 'board', icon: '🟩',
    name: 'Skin de tabuleiro: Espaço',
    description: 'Tabuleiro galáctico com estrelas animadas.',
    rarity: 'epic', currency: 'ludas', price: 3500,
    freePath: 'Baú lendário (chance de 5%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-005', category: 'cosmetic', slot: 'board', icon: '🟩',
    name: 'Skin de tabuleiro: Praia Tropical',
    description: 'Tabuleiro praiano com ondas animadas.',
    rarity: 'epic', currency: 'ludas', price: 3500,
    freePath: 'Evento de verão (missões especiais)',
    impact: 'Nenhum (cosmético)', availability: 'seasonal'
  },
  {
    id: 'COS-006', category: 'cosmetic', slot: 'board', icon: '🟩',
    name: 'Skin de tabuleiro: Sakura',
    description: 'Tabuleiro com pétalas de cerejeira caindo.',
    rarity: 'legendary', currency: 'crystals', price: 80,
    freePath: 'Recompensa simbólica da Temporada 2 do passe',
    impact: 'Nenhum (cosmético)', availability: 'seasonal'
  },
  {
    id: 'COS-007', category: 'cosmetic', slot: 'tokens', icon: '⬤',
    name: 'Skin de peças: Cores Padrão',
    description: 'Peças nas 4 cores clássicas do Ludo.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-008', category: 'cosmetic', slot: 'tokens', icon: '⬤',
    name: 'Skin de peças: Metálicas',
    description: 'Peças com acabamento metálico cromado.',
    rarity: 'rare', currency: 'ludas', price: 1000,
    freePath: 'Baú raro (chance de 10%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-009', category: 'cosmetic', slot: 'tokens', icon: '⬤',
    name: 'Skin de peças: Pastel',
    description: 'Peças em tons pastel suaves.',
    rarity: 'rare', currency: 'ludas', price: 1000,
    freePath: 'Missão semanal especial (1x/mês)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-010', category: 'cosmetic', slot: 'tokens', icon: '⬤',
    name: 'Skin de peças: Glow',
    description: 'Peças que brilham com rastro de luz ao andar.',
    rarity: 'epic', currency: 'ludas', price: 3000,
    freePath: 'Passe free nível 40',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-011', category: 'cosmetic', slot: 'tokens', icon: '⬤',
    name: 'Skin de peças: Dragão',
    description: 'Peças em forma de mini dragões animados.',
    rarity: 'legendary', currency: 'crystals', price: 60,
    freePath: 'Torneio Premium (1º lugar do mês)',
    impact: 'Nenhum (cosmético)', availability: 'seasonal'
  },
  {
    id: 'COS-012', category: 'cosmetic', slot: 'dice', icon: '🎲',
    name: 'Skin de dado: Clássico',
    description: 'Dado branco tradicional.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-013', category: 'cosmetic', slot: 'dice', icon: '🎲',
    name: 'Skin de dado: Madeira',
    description: 'Dado de madeira entalhada.',
    rarity: 'common', currency: 'ludas', price: 300,
    freePath: 'Baú comum (chance de 15%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-014', category: 'cosmetic', slot: 'dice', icon: '🎲',
    name: 'Skin de dado: Neon',
    description: 'Dado translúcido com pontos neon.',
    rarity: 'rare', currency: 'ludas', price: 600,
    freePath: 'Passe free nível 10',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-015', category: 'cosmetic', slot: 'dice', icon: '🎲',
    name: 'Skin de dado: Cristal',
    description: 'Dado de cristal facetado com reflexos.',
    rarity: 'epic', currency: 'ludas', price: 1800,
    freePath: 'Baú raro (chance de 5%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-016', category: 'cosmetic', slot: 'dice', icon: '🎲',
    name: 'Skin de dado: Dourado',
    description: 'Dado dourado com partículas ao rolar.',
    rarity: 'legendary', currency: 'crystals', price: 50,
    freePath: 'Recompensa simbólica de temporada (5 Cristais/temporada)',
    impact: 'Nenhum (cosmético)', availability: 'seasonal'
  },
  {
    id: 'COS-017', category: 'cosmetic', slot: 'theme', icon: '🎨',
    name: 'Tema de interface: Padrão LUUD',
    description: 'Tema claro oficial do app.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-018', category: 'cosmetic', slot: 'theme', icon: '🎨',
    name: 'Tema de interface: Modo Escuro',
    description: 'Tema escuro para jogar de noite.',
    rarity: 'common', currency: 'ludas', price: 400,
    freePath: 'Grátis para todos após nível 5 de conta',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-019', category: 'cosmetic', slot: 'theme', icon: '🎨',
    name: 'Tema de interface: Oceano',
    description: 'Paleta azul-degradê com ondas no fundo.',
    rarity: 'rare', currency: 'ludas', price: 900,
    freePath: 'Baú comum (chance de 6%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-020', category: 'cosmetic', slot: 'theme', icon: '🎨',
    name: 'Tema de interface: Neon City',
    description: 'Paleta urbana neon com skyline animado.',
    rarity: 'epic', currency: 'ludas', price: 2200,
    freePath: 'Torneio semanal top 8 (1x)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-021', category: 'cosmetic', slot: 'capture', icon: '✨',
    name: 'Efeito de captura: Padrão',
    description: 'Animação padrão ao capturar peça.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-022', category: 'cosmetic', slot: 'capture', icon: '✨',
    name: 'Efeito de captura: Explosão',
    description: 'Explosão de partículas ao capturar.',
    rarity: 'common', currency: 'ludas', price: 350,
    freePath: 'Baú comum (chance de 12%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-023', category: 'cosmetic', slot: 'capture', icon: '✨',
    name: 'Efeito de captura: Relâmpago',
    description: 'Raio cai sobre a peça capturada.',
    rarity: 'rare', currency: 'ludas', price: 700,
    freePath: 'Passe free nível 25',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-024', category: 'cosmetic', slot: 'capture', icon: '✨',
    name: 'Efeito de captura: Fogo de Artifício',
    description: 'Fogos de artifício ao capturar.',
    rarity: 'epic', currency: 'ludas', price: 2000,
    freePath: 'Baú lendário (chance de 10%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-025', category: 'cosmetic', slot: 'emotes', icon: '😆',
    name: 'Emotes: Pacote Básico',
    description: '6 emotes: oi, haha, ops, zzZ, 👏 e 🤝.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-026', category: 'cosmetic', slot: 'emotes', icon: '😆',
    name: 'Emotes: Pacote Zoação',
    description: '8 emotes de provocação leve e memes BR.',
    rarity: 'common', currency: 'ludas', price: 400,
    freePath: 'Missão diária especial (sexta-feira)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-027', category: 'cosmetic', slot: 'emotes', icon: '😆',
    name: 'Emotes: Pacote Festa',
    description: '10 emotes carnavalescos e de gol.',
    rarity: 'rare', currency: 'ludas', price: 900,
    freePath: 'Baú raro (chance de 8%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'COS-028', category: 'cosmetic', slot: 'emotes', icon: '😆',
    name: 'Emotes: Pacote Lendários',
    description: '12 emotes animados exclusivos com voz.',
    rarity: 'epic', currency: 'ludas', price: 2400,
    freePath: 'Passe premium nível 30',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },

  /* ------------------------------- PROGRESSÃO --------------------- */
  {
    id: 'PRO-001', category: 'progress', icon: '🎟️',
    name: 'Passe de Temporada (trilha premium)',
    description: 'Desbloqueia a trilha premium do passe de 30 níveis por 50 dias.',
    rarity: 'epic', currency: 'crystals', price: 200,
    freePath: 'Não há caminho grátis para a trilha premium (a free é aberta a todos)',
    impact: 'Conveniência (recompensas são cosméticas)', availability: 'seasonal'
  },
  {
    id: 'PRO-002', category: 'progress', icon: '🎁',
    name: 'Baú Comum',
    description: 'Baú com Ludas, emote ou skin comum.',
    rarity: 'common', currency: 'ludas', price: 150,
    freePath: 'Baú diário grátis do streak',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'PRO-003', category: 'progress', icon: '🎁',
    name: 'Baú Raro',
    description: 'Baú com chance de skins raras e boosts.',
    rarity: 'rare', currency: 'ludas', price: 450,
    freePath: 'Missões semanais e torneios',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'PRO-004', category: 'progress', icon: '🎁',
    name: 'Baú Lendário',
    description: 'Baú com chance de skins épicas/lendárias.',
    rarity: 'legendary', currency: 'crystals', price: 80,
    freePath: 'Passe free nível 50 (1 por temporada)',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'PRO-005', category: 'progress', icon: '⚡',
    name: 'Boost de XP 24h',
    description: 'Dobra o XP ganho por 24 horas.',
    rarity: 'common', currency: 'ludas', price: 200,
    freePath: 'Baú comum (chance de 10%)',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'PRO-006', category: 'progress', icon: '⚡',
    name: 'Boost de XP 7 dias',
    description: 'Dobra o XP ganho por 7 dias.',
    rarity: 'rare', currency: 'ludas', price: 900,
    freePath: 'Passe free nível 20',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'PRO-007', category: 'progress', icon: '🛡️',
    name: 'Proteção de Tier (3 partidas)',
    description: 'Evita perder pontos de tier nas próximas 3 derrotas.',
    rarity: 'rare', currency: 'ludas', price: 500,
    freePath: 'Baú raro (chance de 8%)',
    impact: 'Conveniência (não altera regras da partida)', availability: 'permanent'
  },
  {
    id: 'PRO-008', category: 'progress', icon: '✏️',
    name: 'Renomeação de nick',
    description: 'Altera o nick do jogador 1 vez.',
    rarity: 'common', currency: 'ludas', price: 600,
    freePath: '1 renomeação grátis no nível 10 de conta',
    impact: 'Conveniência', availability: 'permanent'
  },

  /* ------------------------------- COMPETITIVO -------------------- */
  {
    id: 'COM-001', category: 'competitive', icon: '🎟️',
    name: 'Entrada em Torneio Diário',
    description: 'Inscrição extra no torneio diário de 8 jogadores.',
    rarity: 'common', currency: 'ludas', price: 100,
    freePath: '1 entrada grátis por dia',
    impact: 'Competitivo justo (todos entram com Ludas)', availability: 'permanent'
  },
  {
    id: 'COM-002', category: 'competitive', icon: '🎟️',
    name: 'Entrada em Torneio Semanal',
    description: 'Inscrição extra no torneio de domingo, com premiação maior.',
    rarity: 'rare', currency: 'ludas', price: 300,
    freePath: '1 entrada grátis por semana',
    impact: 'Competitivo justo (todos entram com Ludas)', availability: 'permanent'
  },
  {
    id: 'COM-003', category: 'competitive', icon: '🎟️',
    name: 'Entrada em Torneio Premium',
    description: 'Inscrição extra no torneio premium, com premiação em cosméticos lendários.',
    rarity: 'epic', currency: 'ludas', price: 600,
    freePath: 'Convite via top 100 da Liga',
    impact: 'Competitivo justo (todos entram com Ludas)', availability: 'permanent'
  },
  {
    id: 'COM-004', category: 'competitive', icon: '🏆',
    name: 'Inscrição em Liga Privada',
    description: 'Cria liga classificatória privada com amigos (até 32 jogadores).',
    rarity: 'rare', currency: 'ludas', price: 250,
    freePath: '1 liga grátis a cada 30 dias',
    impact: 'Competitivo justo', availability: 'permanent', comingSoon: true
  },

  /* ------------------------------- CONVENIÊNCIA ------------------- */
  {
    id: 'CON-001', category: 'convenience', icon: '🔁',
    name: 'Revanche Ilimitada 7 dias',
    description: 'Revanches instantâneas sem limite por 7 dias.',
    rarity: 'rare', currency: 'ludas', price: 400,
    freePath: 'Baú raro (chance de 10%)',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'CON-002', category: 'convenience', icon: '📜',
    name: 'Histórico estendido (90 dias)',
    description: 'Histórico de partidas completo com replays por 90 dias.',
    rarity: 'rare', currency: 'ludas', price: 500,
    freePath: 'Histórico padrão de 15 dias é grátis',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'CON-003', category: 'convenience', icon: '📋',
    name: 'Slot extra de missão diária',
    description: 'Libera a 4ª missão diária, com recompensa cheia.',
    rarity: 'epic', currency: 'ludas', price: 1200,
    freePath: 'Passe free nível 35 (1 temporada)',
    impact: 'Conveniência', availability: 'permanent'
  },
  {
    id: 'CON-004', category: 'convenience', icon: '🔍',
    name: 'Filtro de oponentes por tier',
    description: 'Escolhe a faixa de tier dos oponentes na fila.',
    rarity: 'common', currency: 'ludas', price: 300,
    freePath: 'Passe free nível 5',
    impact: 'Conveniência', availability: 'permanent', comingSoon: true
  },
  {
    id: 'CON-005', category: 'convenience', icon: '👀',
    name: 'Modo espectador premium',
    description: 'Assiste partidas de amigos em tempo real com câmera livre.',
    rarity: 'rare', currency: 'crystals', price: 40,
    freePath: 'Modo espectador básico grátis (câmera fixa)',
    impact: 'Conveniência', availability: 'permanent', comingSoon: true
  },

  /* ------------------------------- SOCIAL ------------------------- */
  {
    id: 'SOC-001', category: 'social', slot: 'frame', icon: '🖼️',
    name: 'Moldura de perfil: Básica',
    description: 'Moldura simples de perfil.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-002', category: 'social', slot: 'frame', icon: '🖼️',
    name: 'Moldura de perfil: Bronze',
    description: 'Moldura bronze para o feed de amigos.',
    rarity: 'common', currency: 'ludas', price: 300,
    freePath: 'Baú comum (chance de 10%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-003', category: 'social', slot: 'frame', icon: '🖼️',
    name: 'Moldura de perfil: Prata',
    description: 'Moldura prata com brilho.',
    rarity: 'rare', currency: 'ludas', price: 800,
    freePath: 'Passe free nível 30',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-004', category: 'social', slot: 'frame', icon: '🖼️',
    name: 'Moldura de perfil: Ouro',
    description: 'Moldura dourada animada.',
    rarity: 'epic', currency: 'ludas', price: 2000,
    freePath: 'Torneio diário top 3 (10x)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-005', category: 'social', slot: 'frame', icon: '🖼️',
    name: 'Moldura de perfil: Diamante',
    description: 'Moldura de diamante animada com partículas.',
    rarity: 'legendary', currency: 'crystals', price: 70,
    freePath: 'Passe premium nível 50 (1x/temporada)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-006', category: 'social', slot: 'badge', icon: '🏅',
    name: 'Badge de perfil: Iniciante',
    description: 'Badge de primeiro acesso.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis ao completar o tutorial',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-007', category: 'social', slot: 'badge', icon: '🏅',
    name: 'Badge de perfil: Veteraninho',
    description: 'Badge de 30 dias de conta.',
    rarity: 'common', currency: 'ludas', price: 250,
    freePath: 'Conquista automática (grátis)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-008', category: 'social', slot: 'badge', icon: '🏅',
    name: 'Badge de perfil: Turbinado',
    description: 'Badge de quem jogou 100 partidas.',
    rarity: 'rare', currency: 'ludas', price: 500,
    freePath: 'Conquista automática (grátis)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-009', category: 'social', slot: 'badge', icon: '🏅',
    name: 'Badge de perfil: Lenda da Liga',
    description: 'Badge de campeão de liga.',
    rarity: 'epic', currency: 'ludas', price: 1500,
    freePath: 'Recompensa automática por vencer 1 liga',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-010', category: 'social', slot: 'badge', icon: '🏅',
    name: 'Badge de perfil: Coroa Suprema',
    description: 'Badge animado do topo do ranking nacional.',
    rarity: 'legendary', currency: 'crystals', price: 60,
    freePath: 'Recompensa automática do top 1 nacional (grátis, exclusiva)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-011', category: 'social', slot: 'title', icon: '👑',
    name: 'Título de perfil: Aprendiz',
    description: 'Título exibido sob o nick.',
    rarity: 'common', currency: 'free', price: 0,
    freePath: 'Grátis desde o primeiro login',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-012', category: 'social', slot: 'title', icon: '👑',
    name: 'Título de perfil: Sortudo',
    description: 'Título divertido para o feed.',
    rarity: 'common', currency: 'ludas', price: 200,
    freePath: 'Baú comum (chance de 12%)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-013', category: 'social', slot: 'title', icon: '👑',
    name: 'Título de perfil: Colecionador',
    description: 'Título para quem tem 10+ cosméticos.',
    rarity: 'rare', currency: 'ludas', price: 600,
    freePath: 'Conquista automática (grátis)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-014', category: 'social', slot: 'title', icon: '👑',
    name: 'Título de perfil: Estrategista',
    description: 'Título para 50 vitórias na Liga.',
    rarity: 'epic', currency: 'ludas', price: 1200,
    freePath: 'Conquista automática (grátis)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-015', category: 'social', slot: 'title', icon: '👑',
    name: 'Título de perfil: Imbatível',
    description: 'Título para 90% de vitórias na temporada.',
    rarity: 'legendary', currency: 'crystals', price: 50,
    freePath: 'Conquista automática por desempenho (grátis, exclusiva)',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },
  {
    id: 'SOC-016', category: 'social', icon: '🎉',
    name: 'Destaque de vitória no feed de amigos',
    description: 'Animação especial na sua vitória no feed dos amigos.',
    rarity: 'rare', currency: 'ludas', price: 450,
    freePath: 'Destaque padrão (sem animação) é grátis',
    impact: 'Nenhum (cosmético)', availability: 'permanent'
  },

  /* ------------------------------- ASSINATURA --------------------- */
  {
    id: 'ASS-001', category: 'subscription', icon: '💎',
    name: 'PREMIUM Vitalício',
    description: 'Pagamento único de R$ 19,90 via Pix: sem anúncios, seletor hexadecimal de cores, histórico estendido, 2 entradas grátis de torneio/dia e badge exclusivo.',
    rarity: 'legendary', currency: 'brl', price: 19.9,
    freePath: 'O jogo completo é 100% grátis; PREMIUM é conveniência e personalização',
    impact: 'Conveniência (não dá vantagem competitiva)', availability: 'permanent'
  }
];

const ITEM_BY_ID = ITEMS.reduce((map, item) => {
  map[item.id] = item;
  return map;
}, {});

/* Itens grátis: todo mundo começa com eles. */
const FREE_ITEM_IDS = ITEMS.filter(item => item.currency === 'free').map(item => item.id);

/* ------------------------------------------------------------------
   PACOTES DE CRISTAIS (aba "Preços em Reais")
   Compra única via Pix. O preço e a quantidade são resolvidos no
   servidor; o cliente envia apenas o id do pacote.
------------------------------------------------------------------ */
const CRYSTAL_PACKAGES = [
  { id: 'punhado', name: 'Punhado', crystals: 100, bonus: 0, total: 100, priceBrl: 4.90, audience: 'Quem quer testar o Pix com pouco' },
  { id: 'bolso', name: 'Bolso', crystals: 300, bonus: 0, total: 300, priceBrl: 12.90, audience: 'Comprador eventual' },
  { id: 'punho', name: 'Punho', crystals: 600, bonus: 50, total: 650, priceBrl: 24.90, audience: 'Jogador frequente' },
  { id: 'cofre', name: 'Cofre', crystals: 1200, bonus: 200, total: 1400, priceBrl: 44.90, audience: 'Jogador engajado — bom custo/benefício médio' },
  { id: 'bau-real', name: 'Baú Real', crystals: 2500, bonus: 600, total: 3100, priceBrl: 89.90, audience: 'Fã do jogo / colecionador' },
  { id: 'cofre-lendario', name: 'Cofre Lendário', crystals: 6000, bonus: 2000, total: 8000, priceBrl: 179.90, audience: 'Fã assíduo — melhor custo por cristal' }
];

/* ------------------------------------------------------------------
   BAÚS DA LOJA — tabelas de recompensa TRANSPARENTES
   (regra: "Todo baú exibe a chance percentual de cada raridade
   antes da compra")
   Recompensas nunca pagam Cristais: eles só entram via Pix.
------------------------------------------------------------------ */
const CHEST_REWARDS = {
  common: {
    id: 'common', name: 'Baú Comum',
    table: [
      { chance: 60, kind: 'coins', amount: 150, label: '150 Ludas' },
      { chance: 25, kind: 'xp', amount: 120, label: '120 XP' },
      { chance: 10, kind: 'coins', amount: 300, label: '300 Ludas' },
      { chance: 5, kind: 'item', itemId: 'COS-013', label: 'Skin de dado: Madeira' }
    ]
  },
  rare: {
    id: 'rare', name: 'Baú Raro',
    table: [
      { chance: 45, kind: 'coins', amount: 400, label: '400 Ludas' },
      { chance: 20, kind: 'xp', amount: 200, label: '200 XP' },
      { chance: 15, kind: 'item', itemId: 'COS-008', label: 'Skin de peças: Metálicas' },
      { chance: 10, kind: 'boost', days: 1, label: 'Boost de XP 24h' },
      { chance: 10, kind: 'item', itemId: 'SOC-002', label: 'Moldura de perfil: Bronze' }
    ]
  },
  legendary: {
    id: 'legendary', name: 'Baú Lendário',
    table: [
      { chance: 35, kind: 'coins', amount: 800, label: '800 Ludas' },
      { chance: 20, kind: 'xp', amount: 500, label: '500 XP' },
      { chance: 15, kind: 'item', itemId: 'COS-015', label: 'Skin de dado: Cristal' },
      { chance: 15, kind: 'boost', days: 7, label: 'Boost de XP 7 dias' },
      { chance: 10, kind: 'item', itemId: 'SOC-004', label: 'Moldura de perfil: Ouro' },
      { chance: 5, kind: 'item', itemId: 'SOC-013', label: 'Título de perfil: Colecionador' }
    ]
  }
};

/* ------------------------------------------------------------------
   ESTADO DA LOJA
   Vive em player_progress.shop_state (JSONB).
------------------------------------------------------------------ */
function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function defaultEquipped() {
  const equipped = {};
  EQUIP_SLOTS.forEach(slot => {
    const freeItem = ITEMS.find(item => item.slot === slot.id && item.currency === 'free');
    if (freeItem) equipped[slot.id] = freeItem.id;
  });
  return equipped;
}

function ensureShopState(state) {
  const source = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  const items = Array.isArray(source.items)
    ? source.items.filter(id => typeof id === 'string' && ITEM_BY_ID[id])
    : [];

  // Todo item grátis pertence a todas as contas
  FREE_ITEM_IDS.forEach(id => {
    if (!items.includes(id)) items.push(id);
  });

  const equipped = {};
  const defaults = defaultEquipped();
  EQUIP_SLOTS.forEach(slot => {
    const value = source.equipped && typeof source.equipped === 'object'
      ? source.equipped[slot.id]
      : null;
    if (value && ITEM_BY_ID[value] && ITEM_BY_ID[value].slot === slot.id && items.includes(value)) {
      equipped[slot.id] = value;
    } else {
      equipped[slot.id] = defaults[slot.id];
    }
  });

  const chests = source.chests && typeof source.chests === 'object' ? source.chests : {};
  const tournamentEntries = source.tournamentEntries && typeof source.tournamentEntries === 'object'
    ? source.tournamentEntries
    : {};

  return {
    items,
    equipped,
    chests: {
      common: Math.max(0, Math.floor(Number(chests.common) || 0)),
      rare: Math.max(0, Math.floor(Number(chests.rare) || 0)),
      legendary: Math.max(0, Math.floor(Number(chests.legendary) || 0))
    },
    xpDoubleUntil: normalizeTimestamp(source.xpDoubleUntil),
    tierProtection: Math.max(0, Math.floor(Number(source.tierProtection) || 0)),
    renameTokens: Math.max(0, Math.floor(Number(source.renameTokens) || 0)),
    missionSlotUntil: normalizeTimestamp(source.missionSlotUntil),
    tournamentEntries: {
      daily: Math.max(0, Math.floor(Number(tournamentEntries.daily) || 0)),
      weekly: Math.max(0, Math.floor(Number(tournamentEntries.weekly) || 0)),
      premium: Math.max(0, Math.floor(Number(tournamentEntries.premium) || 0))
    },
    historyUntil: normalizeTimestamp(source.historyUntil),
    rematchUntil: normalizeTimestamp(source.rematchUntil),
    spectatorUntil: normalizeTimestamp(source.spectatorUntil),
    // Temporada em que a trilha premium do passe foi comprada
    passSeasonId: source.passSeasonId || null,
    passSeasons: Array.isArray(source.passSeasons)
      ? source.passSeasons.filter(id => typeof id === 'string')
      : [],
    // Uso das entradas grátis de torneio no dia atual
    entryUsage: source.entryUsage && typeof source.entryUsage === 'object'
      ? {
        date: typeof source.entryUsage.date === 'string' ? source.entryUsage.date : '',
        daily: Math.max(0, Math.floor(Number(source.entryUsage.daily) || 0)),
        weekly: Math.max(0, Math.floor(Number(source.entryUsage.weekly) || 0))
      }
      : { date: '', daily: 0, weekly: 0 },
    // Ids das cobranças já entregues (entrega de Cristais sem duplicar)
    deliveredOrders: Array.isArray(source.deliveredOrders)
      ? source.deliveredOrders.filter(id => typeof id === 'string')
      : []
  };
}

function hasItem(state, itemId) {
  const shape = ensureShopState(state);
  return shape.items.includes(String(itemId || ''));
}

function isActiveUntil(value, now) {
  const until = normalizeTimestamp(value);
  if (!until) return false;
  return toDate(now).getTime() < new Date(until).getTime();
}

/* Boost de XP comprado (dobra o XP) — diferente do boost do passe */
function isXpDoubleActive(state, now) {
  return isActiveUntil(ensureShopState(state).xpDoubleUntil, now);
}

function hasMissionSlot(state, now) {
  return isActiveUntil(ensureShopState(state).missionSlotUntil, now);
}

function hasExtendedHistory(state, now) {
  return isActiveUntil(ensureShopState(state).historyUntil, now);
}

function hasUnlimitedRematch(state, now) {
  return isActiveUntil(ensureShopState(state).rematchUntil, now);
}

function hasPremiumPass(state, seasonId) {
  const shape = ensureShopState(state);
  if (!seasonId) return false;
  return shape.passSeasonId === seasonId || shape.passSeasons.includes(seasonId);
}

/* ------------------------------------------------------------------
   DESCRIÇÃO PARA O CLIENTE
------------------------------------------------------------------ */
function describeItem(item, state, options = {}) {
  const shape = ensureShopState(state);
  const repeatable = REPEATABLE_ITEMS.has(item.id);
  const owned = repeatable ? false : hasItem(shape, item.id);
  const ludas = Math.max(0, Math.floor(Number(options.ludas) || 0));
  const crystals = Math.max(0, Math.floor(Number(options.crystals) || 0));
  const equipped = Boolean(item.slot) && shape.equipped[item.slot] === item.id;
  const afford = item.currency === 'ludas' ? ludas >= item.price
    : item.currency === 'crystals' ? crystals >= item.price
      : true;

  return {
    id: item.id,
    category: item.category,
    slot: item.slot || null,
    icon: item.icon,
    name: item.name,
    description: item.description,
    rarity: item.rarity,
    rarityName: (RARITIES[item.rarity] || RARITIES.common).name,
    currency: item.currency,
    price: item.price,
    freePath: item.freePath,
    impact: item.impact,
    availability: item.availability,
    comingSoon: Boolean(item.comingSoon),
    // Consumíveis podem ser comprados novamente depois de usados
    repeatable,
    owned,
    equipped,
    affordable: afford,
    // O passe premium é comprado a cada temporada
    perSeason: item.id === 'PRO-001'
  };
}

function describeShop(progress, now, options = {}) {
  const shape = ensureShopState(progress && progress.shopState);
  const ludas = Math.max(0, Math.floor(Number(progress && progress.coins) || 0));
  const crystals = Math.max(0, Math.floor(Number(progress && progress.crystals) || 0));
  const seasonId = options.seasonId || null;

  const items = ITEMS.map(item => {
    const view = describeItem(item, shape, { ludas, crystals });
    if (item.id === 'PRO-001') {
      view.owned = hasPremiumPass(shape, seasonId);
      view.equipped = view.owned;
      view.affordable = crystals >= item.price;
    }
    return view;
  });

  return {
    categories: CATEGORIES,
    rarities: RARITIES,
    slots: EQUIP_SLOTS,
    items,
    wallet: {
      ludas,
      crystals,
      // R$ equivalente (somente referência; Ludas não são compráveis)
      ludasBrl: Number((ludas * 0.0049).toFixed(2))
    },
    inventory: {
      items: shape.items.slice(),
      equipped: { ...shape.equipped },
      chests: { ...shape.chests },
      tierProtection: shape.tierProtection,
      renameTokens: shape.renameTokens,
      tournamentEntries: { ...shape.tournamentEntries }
    },
    effects: {
      xpDoubleUntil: shape.xpDoubleUntil,
      xpDoubleActive: isXpDoubleActive(shape, now),
      missionSlotUntil: shape.missionSlotUntil,
      missionSlotActive: hasMissionSlot(shape, now),
      historyUntil: shape.historyUntil,
      historyActive: hasExtendedHistory(shape, now),
      rematchUntil: shape.rematchUntil,
      rematchActive: hasUnlimitedRematch(shape, now),
      tierProtection: shape.tierProtection,
      renameTokens: shape.renameTokens
    },
    chests: Object.keys(CHEST_REWARDS).map(key => ({
      id: key,
      name: CHEST_REWARDS[key].name,
      count: shape.chests[key],
      table: CHEST_REWARDS[key].table.map(entry => ({
        chance: entry.chance,
        kind: entry.kind,
        label: entry.label
      }))
    })),
    packages: CRYSTAL_PACKAGES.map(pkg => ({
      id: pkg.id,
      name: pkg.name,
      crystals: pkg.crystals,
      bonus: pkg.bonus,
      total: pkg.total,
      priceBrl: pkg.priceBrl,
      audience: pkg.audience
    }))
  };
}

/* ------------------------------------------------------------------
   COMPRA DE UM ITEM
   O preço vem do catálogo (nunca do cliente). A moeda é debitada do
   saldo certo: Ludas em `coins`, Cristais em `crystals`.
------------------------------------------------------------------ */
function purchaseItem(progress, itemId, options = {}) {
  const item = ITEM_BY_ID[String(itemId || '')];
  if (!item) {
    return { ok: false, error: 'Item desconhecido.', progress };
  }
  if (item.comingSoon) {
    return { ok: false, error: 'Este item ainda está em desenvolvimento.', progress };
  }
  if (item.currency === 'brl') {
    return { ok: false, error: 'A Conta Premium é assinada na aba ASSINATURA.', progress };
  }

  const state = ensureShopState(progress && progress.shopState);

  if (item.id === 'PRO-001') {
    const seasonId = options.seasonId || null;
    if (!seasonId) return { ok: false, error: 'Passe indisponível no momento.', progress };
    if (hasPremiumPass(state, seasonId)) {
      return { ok: false, error: 'Você já comprou a trilha premium deste passe.', progress };
    }
    const crystals = Math.max(0, Math.floor(Number(progress && progress.crystals) || 0));
    if (crystals < item.price) {
      return { ok: false, error: `Faltam ${item.price - crystals} Cristais para comprar a trilha premium.`, progress };
    }
    const next = { ...progress, crystals: crystals - item.price };
    next.shopState = ensureShopState({
      ...state,
      passSeasonId: seasonId,
      passSeasons: state.passSeasons.concat(seasonId).slice(-20)
    });
    return {
      ok: true,
      error: null,
      spent: { currency: 'crystals', amount: item.price },
      item: describeItem(item, next.shopState, { ludas: next.coins, crystals: next.crystals }),
      progress: next
    };
  }

  if (hasItem(state, item.id) && !REPEATABLE_ITEMS.has(item.id)) {
    return { ok: false, error: 'Você já possui este item.', progress };
  }

  if (item.currency === 'ludas') {
    const ludas = Math.max(0, Math.floor(Number(progress && progress.coins) || 0));
    if (ludas < item.price) {
      return { ok: false, error: `Faltam ${item.price - ludas} Ludas para comprar este item.`, progress };
    }
    const next = { ...progress, coins: ludas - item.price };
    next.shopState = applyItemEffect(state, item, options);
    return {
      ok: true,
      error: null,
      spent: { currency: 'ludas', amount: item.price },
      item: describeItem(item, next.shopState, { ludas: next.coins, crystals: next.crystals }),
      progress: next
    };
  }

  if (item.currency === 'crystals') {
    const crystals = Math.max(0, Math.floor(Number(progress && progress.crystals) || 0));
    if (crystals < item.price) {
      return { ok: false, error: `Faltam ${item.price - crystals} Cristais para comprar este item.`, progress };
    }
    const next = { ...progress, crystals: crystals - item.price };
    next.shopState = applyItemEffect(state, item, options);
    return {
      ok: true,
      error: null,
      spent: { currency: 'crystals', amount: item.price },
      item: describeItem(item, next.shopState, { ludas: next.coins, crystals: next.crystals }),
      progress: next
    };
  }

  // Itens grátis: já fazem parte do inventário
  return { ok: false, error: 'Este item já está liberado.', progress };
}

/* Aplica o efeito do item comprado ao estado da loja. */
function applyItemEffect(state, item, options = {}) {
  const shape = ensureShopState(state);
  const now = toDate(options.now);
  const next = {
    ...shape,
    // Consumíveis (baús, boosts, entradas...) NÃO entram no inventário
    // permanente: podem ser comprados de novo.
    items: REPEATABLE_ITEMS.has(item.id)
      ? shape.items
      : shape.items.concat(item.id)
  };

  switch (item.id) {
    case 'PRO-002':
      next.chests.common += 1;
      break;
    case 'PRO-003':
      next.chests.rare += 1;
      break;
    case 'PRO-004':
      next.chests.legendary += 1;
      break;
    case 'PRO-005':
    case 'PRO-006': {
      const days = item.id === 'PRO-005' ? 1 : 7;
      const base = isActiveUntil(shape.xpDoubleUntil, now)
        ? new Date(shape.xpDoubleUntil).getTime()
        : now.getTime();
      next.xpDoubleUntil = new Date(base + days * DAY_MS).toISOString();
      break;
    }
    case 'PRO-007':
      next.tierProtection += 3;
      break;
    case 'PRO-008':
      next.renameTokens += 1;
      break;
    case 'COM-001':
      next.tournamentEntries.daily += 1;
      break;
    case 'COM-002':
      next.tournamentEntries.weekly += 1;
      break;
    case 'COM-003':
      next.tournamentEntries.premium += 1;
      break;
    case 'CON-001': {
      const base = isActiveUntil(shape.rematchUntil, now)
        ? new Date(shape.rematchUntil).getTime()
        : now.getTime();
      next.rematchUntil = new Date(base + 7 * DAY_MS).toISOString();
      break;
    }
    case 'CON-002': {
      const base = isActiveUntil(shape.historyUntil, now)
        ? new Date(shape.historyUntil).getTime()
        : now.getTime();
      next.historyUntil = new Date(base + 90 * DAY_MS).toISOString();
      break;
    }
    case 'CON-003': {
      const base = isActiveUntil(shape.missionSlotUntil, now)
        ? new Date(shape.missionSlotUntil).getTime()
        : now.getTime();
      next.missionSlotUntil = new Date(base + 30 * DAY_MS).toISOString();
      break;
    }
    default:
      break;
  }

  // Cosmético equipável: já entra equipado (o jogador pode trocar depois)
  if (item.slot) {
    next.equipped = { ...next.equipped, [item.slot]: item.id };
  }

  return next;
}

/* ------------------------------------------------------------------
   EQUIPAR / DESEQUIPAR
------------------------------------------------------------------ */
function equipItem(progress, itemId) {
  const item = ITEM_BY_ID[String(itemId || '')];
  if (!item) return { ok: false, error: 'Item desconhecido.', progress };
  if (!item.slot) return { ok: false, error: 'Este item não pode ser equipado.', progress };

  const state = ensureShopState(progress && progress.shopState);
  if (!hasItem(state, item.id)) {
    return { ok: false, error: 'Você ainda não possui este item.', progress };
  }

  const next = { ...progress };
  next.shopState = {
    ...state,
    equipped: { ...state.equipped, [item.slot]: item.id }
  };
  return { ok: true, error: null, item: describeItem(item, next.shopState, { ludas: next.coins, crystals: next.crystals }), progress: next };
}

/* ------------------------------------------------------------------
   ABRIR UM BAÚ DA LOJA
   A tabela é pública (transparência de probabilidade) e o sorteio
   acontece no servidor.
------------------------------------------------------------------ */
function openChest(progress, chestId, options = {}) {
  const chest = CHEST_REWARDS[String(chestId || '')];
  if (!chest) return { ok: false, error: 'Baú desconhecido.', progress };

  const state = ensureShopState(progress && progress.shopState);
  const count = state.chests[chest.id] || 0;
  if (count <= 0) {
    return { ok: false, error: 'Você não tem este baú.', progress };
  }

  const roll = Math.random() * 100;
  let acc = 0;
  let prize = chest.table[chest.table.length - 1];
  for (const entry of chest.table) {
    acc += entry.chance;
    if (roll < acc) {
      prize = entry;
      break;
    }
  }

  const next = { ...progress };
  const nextState = { ...state, chests: { ...state.chests } };
  nextState.chests[chest.id] = count - 1;

  const result = { kind: prize.kind, label: prize.label, chance: prize.chance };

  if (prize.kind === 'coins') {
    next.coins = (Number(progress.coins) || 0) + prize.amount;
    result.amount = prize.amount;
  } else if (prize.kind === 'xp') {
    next.xp = (Number(progress.xp) || 0) + prize.amount;
    result.amount = prize.amount;
  } else if (prize.kind === 'item') {
    const item = ITEM_BY_ID[prize.itemId];
    if (item && !hasItem(nextState, item.id)) {
      nextState.items = nextState.items.concat(item.id);
      if (item.slot) nextState.equipped = { ...nextState.equipped, [item.slot]: item.id };
      result.itemId = item.id;
      result.itemName = item.name;
    } else {
      // Já tinha: vira Ludas para não desperdiçar o baú
      next.coins = (Number(progress.coins) || 0) + 400;
      result.amount = 400;
      result.label = '400 Ludas (item repetido)';
    }
  } else if (prize.kind === 'boost') {
    const base = isActiveUntil(nextState.xpDoubleUntil, options.now)
      ? new Date(nextState.xpDoubleUntil).getTime()
      : toDate(options.now).getTime();
    nextState.xpDoubleUntil = new Date(base + prize.days * DAY_MS).toISOString();
  }

  next.shopState = nextState;
  return { ok: true, error: null, chest: chest.id, reward: result, progress: next };
}

/* ------------------------------------------------------------------
   ENTRADAS DE TORNEIO
   Cada conta tem 1 entrada grátis por tipo de torneio por dia
   (o torneio de domingo é o semanal). Quando essa entrada grátis já
   foi usada, é preciso uma entrada comprada na loja:
   - COM-001 vale para o torneio diário;
   - COM-002 vale para o torneio semanal;
   - COM-003 (premium) vale para qualquer torneio.
------------------------------------------------------------------ */
const BRAZIL_UTC_OFFSET_MINUTES = -180;

function dayKey(now) {
  const shifted = new Date(toDate(now).getTime() + BRAZIL_UTC_OFFSET_MINUTES * 60000);
  return shifted.toISOString().slice(0, 10);
}

function prepareTournamentEntry(state, type, now) {
  const shape = ensureShopState(state);
  const key = type === 'weekly' ? 'weekly' : 'daily';
  const today = dayKey(now);

  let usage = { ...shape.entryUsage };
  if (usage.date !== today) usage = { date: today, daily: 0, weekly: 0 };

  const entries = { ...shape.tournamentEntries };
  const nextUsage = { ...usage };

  // 1) Entrada grátis do dia
  if (nextUsage[key] < 1) {
    nextUsage[key] += 1;
    return {
      ok: true,
      free: true,
      kind: 'free',
      state: { ...shape, entryUsage: nextUsage, tournamentEntries: entries }
    };
  }

  // 2) Entrada comprada do mesmo tipo
  if (entries[key] > 0) {
    entries[key] -= 1;
    return {
      ok: true,
      free: false,
      kind: key,
      state: { ...shape, entryUsage: nextUsage, tournamentEntries: entries }
    };
  }

  // 3) Entrada premium: serve para qualquer torneio
  if (entries.premium > 0) {
    entries.premium -= 1;
    return {
      ok: true,
      free: false,
      kind: 'premium',
      state: { ...shape, entryUsage: nextUsage, tournamentEntries: entries }
    };
  }

  return {
    ok: false,
    free: false,
    kind: null,
    error: 'Você já usou a entrada grátis deste torneio. Compre uma entrada na LOJA para entrar de novo.',
    state: shape
  };
}

/* Devolve a entrada usada quando o jogador cancela a inscrição:
   a entrada grátis do dia volta a ficar disponível e a entrada
   comprada volta para o inventário. */
function refundTournamentEntry(state, entry, now) {
  const shape = ensureShopState(state);
  if (!entry || !entry.kind) return { ok: false, state: shape };

  const today = dayKey(now);
  const usage = { ...shape.entryUsage };
  const current = usage.date === today
    ? usage
    : { date: today, daily: 0, weekly: 0 };

  if (entry.kind === 'free') {
    const key = entry.tournamentType === 'weekly' ? 'weekly' : 'daily';
    current[key] = Math.max(0, current[key] - 1);
    return {
      ok: true,
      state: { ...shape, entryUsage: { ...current, date: today } }
    };
  }

  const entries = { ...shape.tournamentEntries };
  const key = ['daily', 'weekly', 'premium'].includes(entry.kind) ? entry.kind : 'daily';
  entries[key] = (Number(entries[key]) || 0) + 1;
  return {
    ok: true,
    state: { ...shape, tournamentEntries: entries }
  };
}

module.exports = {
  RARITIES,
  CATEGORIES,
  EQUIP_SLOTS,
  ITEMS,
  ITEM_BY_ID,
  FREE_ITEM_IDS,
  REPEATABLE_ITEMS,
  CRYSTAL_PACKAGES,
  CHEST_REWARDS,
  DAY_MS,
  ensureShopState,
  hasItem,
  hasPremiumPass,
  isXpDoubleActive,
  hasMissionSlot,
  hasExtendedHistory,
  hasUnlimitedRematch,
  describeItem,
  describeShop,
  purchaseItem,
  applyItemEffect,
  equipItem,
  openChest,
  prepareTournamentEntry,
  refundTournamentEntry
};
