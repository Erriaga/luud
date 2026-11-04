'use strict';

/**
 * POLÍTICA DE NOMES (nicknames, nomes de dupla e nomes exibidos)
 * ------------------------------------------------------------------
 * A lista abaixo reúne termos ofensivos, sexualmente explícitos, de
 * assédio e de ódio em vários idiomas (português, inglês, espanhol,
 * francês, alemão e italiano), inspirada nas políticas de segurança
 * de contas como a do Google.
 *
 * A comparação é tolerante a disfarces comuns em nicknames:
 *  - acentos e maiúsculas são ignorados;
 *  - números e símbolos usados como letras (f0d4, sh1t, @) são trocados;
 *  - letras repetidas são reduzidas (puuuta -> puta);
 *  - separadores (., -, _, espaço) são ignorados em frases;
 *  - enfeites como xX...Xx e números nas pontas são removidos.
 *
 * O objetivo é bloquear nomes claramente indevidos sem rejeitar palavras
 * comuns que apenas contêm uma sequência parecida (ex.: "computador",
 * "disputa", "Assunção", "Dickinson").
 */

const BANNED_WORDS = new Set([
  // Português (Brasil/Portugal)
  'ass', 'asses', 'cu', 'cus', 'puta', 'putas', 'puto', 'putos', 'putaria',
  'putada', 'putinha', 'putinho', 'prostituta', 'prostituto', 'prostitutas',
  'prostitutos', 'vagabunda', 'vagabundas', 'vadia', 'vadias', 'piranha',
  'piranhas', 'piriguete', 'caralho', 'caralhos', 'foder', 'fuder', 'fode',
  'fodeu', 'fodido', 'fodida', 'fudido', 'fudida', 'fodendo', 'fodao', 'foda',
  'fodas', 'fodase', 'fdp', 'fdps', 'arrombado', 'arrombada', 'arrombados',
  'arrombadas', 'corno', 'cornos', 'cornuda', 'cornudo', 'viado', 'viada',
  'viados', 'viadas', 'viadinho', 'viadinhos', 'bicha', 'bichas', 'bichinha',
  'bichinhas', 'boiola', 'boiolas', 'boiolinha', 'traveco', 'travecos',
  'retardado', 'retardada', 'retardados', 'retardadas', 'mongol', 'mongoloide',
  'mongoloides', 'otario', 'otaria', 'otarios', 'otarias', 'imbecil',
  'imbecis', 'idiota', 'idiotas', 'burro', 'burra', 'burros', 'burras',
  'escroto', 'escrota', 'escrotos', 'escrotas', 'cuzudo', 'cuzuda', 'cuzudos',
  'cuzudas', 'cuzao', 'cuzaos', 'cuzinho', 'cuzinhos', 'merda', 'merdas',
  'bosta', 'bostas', 'porra', 'porras', 'cacete', 'cacetes', 'punheta',
  'punhetas', 'bronha', 'bronhas', 'broxa', 'broxas', 'buceta', 'bucetas',
  'xoxota', 'xoxotas', 'pepeca', 'pepecas', 'boquete', 'boquetes', 'penis',
  'vagina', 'vaginas', 'anus', 'sexo', 'sexos', 'porno', 'pornos',
  'pornografia', 'pornografias', 'nude', 'nudes', 'estupro', 'estupros',
  'estuprador', 'estupradores', 'pedofilo', 'pedofila', 'pedofilos',
  'pedofilas', 'pedofilia', 'zoofilia', 'incesto', 'nazi', 'nazis', 'nazista',
  'nazistas', 'nazismo', 'hitler', 'racista', 'racistas', 'machista',
  'machistas', 'homofobico', 'homofobica', 'homofobicos', 'homofobicas',
  'transfobico', 'transfobica', 'xenofobico', 'xenofobica', 'misogino',
  'misogina', 'misoginos', 'misoginas', 'sexista', 'sexistas', 'antisemita',
  'antisemitas', 'islamofobico', 'islamofobica', 'crioulo', 'crioula',
  'crioulos', 'crioulas', 'sapatao', 'sapataos', 'vtnc', 'vsf', 'pqp', 'krl',
  'krlh',

  // Inglês
  'fuck', 'fucks', 'fucked', 'fucking', 'fucker', 'fuckers', 'fuk', 'fuking',
  'motherfucker', 'motherfuckers', 'shit', 'shits', 'shitty', 'bullshit',
  'bitch', 'bitches', 'bitchy', 'cunt', 'cunts', 'asshole', 'assholes',
  'bastard', 'bastards', 'dick', 'dicks', 'dickhead', 'dickheads', 'pussy',
  'pussies', 'whore', 'whores', 'slut', 'sluts', 'fag', 'fags', 'faggot',
  'faggots', 'nigger', 'niggers', 'nigga', 'niggas', 'retard', 'retards',
  'retarded', 'rape', 'rapes', 'raped', 'rapist', 'rapists', 'kkk', 'porn',
  'porns', 'pornstar', 'pornstars', 'pedophile', 'pedophiles', 'paedophile',
  'paedophiles', 'molest', 'molester', 'molesters', 'incest', 'bestiality',
  'zoophile', 'zoophiles', 'kys', 'spic', 'spics', 'chink', 'chinks', 'gook',
  'gooks', 'kike', 'kikes', 'wetback', 'wetbacks', 'beaner', 'beaners',
  'coon', 'coons', 'darkie', 'darkies', 'towelhead', 'towelheads', 'raghead',
  'ragheads', 'redskin', 'redskins', 'tranny', 'trannies', 'shemale',
  'shemales', 'tits', 'titties', 'boob', 'boobs', 'cock', 'cocks', 'cockhead',
  'cum', 'cumming', 'dildo', 'dildos', 'handjob', 'handjobs', 'blowjob',
  'blowjobs', 'orgasm', 'orgasms', 'masturbation', 'piss', 'pissed',

  // Espanhol
  'putita', 'putito', 'mierda', 'mierdas', 'joder', 'jodete', 'jodido',
  'jodida', 'cabron', 'cabrona', 'cabrones', 'pendejo', 'pendeja', 'pendejos',
  'pendejas', 'verga', 'vergas', 'chinga', 'chingar', 'chingada', 'chingon',
  'maricon', 'maricona', 'maricones', 'marica', 'maricas', 'zorra', 'zorras',
  'perra', 'perras', 'cojones', 'gilipollas', 'estupido', 'estupida',
  'violador', 'violadores', 'violacion', 'violaciones', 'polla', 'pollas',
  'culero', 'culera', 'culeros', 'culeras', 'ojete', 'ojetes', 'mamada',
  'mamadas',

  // Francês
  'merde', 'merdes', 'putain', 'putains', 'connard', 'connards', 'connasse',
  'connasses', 'salope', 'salopes', 'encule', 'encules', 'enculer', 'couille',
  'couilles', 'nique', 'niquer', 'tapette', 'tapettes', 'viol', 'viols',
  'violeur', 'violeurs', 'tarlouze', 'tarlouzes',

  // Alemão
  'scheisse', 'scheiss', 'arschloch', 'arschlocher', 'fick', 'ficken',
  'ficker', 'fickers', 'hurensohn', 'hurensohne', 'hure', 'huren', 'wichser',
  'wichsen', 'schwuchtel', 'schwuchteln', 'missgeburt', 'missgeburten',
  'vergewaltigung', 'vergewaltigungen',

  // Italiano
  'cazzo', 'cazzi', 'merda', 'merde', 'puttana', 'puttane', 'stronzo',
  'stronza', 'stronzi', 'stronze', 'vaffanculo', 'fanculo', 'troia', 'troie',
  'culo', 'culi', 'coglione', 'cogliona', 'coglioni', 'stupratore',
  'stupratori', 'stupro', 'stupri',

  // Extremismo/terrorismo e termos de ódio internacionais
  'alqaeda', 'alqaida', 'taliban', 'terrorist', 'terrorists', 'terrorista',
  'terroristas', 'supremacista', 'supremacistas', 'supremacist',
  'supremacists', 'whitesupremacy'
]);

// Frases (comparadas sem separadores) que não fazem sentido como palavra
// isolada e por isso ficam em uma lista separada.
const BANNED_PHRASES = [
  'filhodaputa', 'filhadaputa', 'putaquepariu', 'vaisefoder', 'vaitomarnocu',
  'tomarnocu', 'vaiamerda', 'putamadre', 'hijodeputa', 'hijosdeputa',
  'vetealamierda', 'alaverga', 'fuckyou', 'fuckoff', 'sonofabitch',
  'pieceofshit', 'eatshit', 'kissmyass', 'killyourself', 'heilhitler',
  'siegheil', 'whitepower', 'niquetamere', 'vategairefoutre'
];

const ALLOWED_SUFFIXES = new Set([
  '', 's', 'es', 'y', 'ies', 'ing', 'er', 'ers', 'ed', 'd', 'in', 'inha',
  'inhas', 'inho', 'inhos', 'ao', 'aos', 'ona', 'onas', 'ote', 'otes',
  'ty', 'sm'
]);

// Troca os disfarces mais comuns antes de comparar.
function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/9/g, 'g')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function collapseRepeats(word) {
  return String(word || '').replace(/(.)\1+/g, '$1');
}

// Remove enfeites comuns: xX no começo/fim e números nas pontas.
function stripDecorations(word) {
  return String(word || '')
    .replace(/^x+/, '')
    .replace(/x+$/, '')
    .replace(/^[0-9]+/, '')
    .replace(/[0-9]+$/, '');
}

function isBannedWord(word) {
  if (!word) return false;
  if (BANNED_WORDS.has(word)) return true;

  const collapsed = collapseRepeats(word);
  if (BANNED_WORDS.has(collapsed)) return true;

  // Palavras com plural/variação simples: putas, bitches, nazis...
  for (const term of BANNED_WORDS) {
    if (!word.startsWith(term)) continue;
    const suffix = word.slice(term.length);
    if (ALLOWED_SUFFIXES.has(suffix)) return true;
  }

  return false;
}

/**
 * Verifica se um nome é permitido.
 * @param {string} value Nome a validar.
 * @returns {{ allowed: boolean, reason?: string, matched?: string }}
 */
function checkName(value) {
  const normalized = normalizeName(value);
  if (!normalized) return { allowed: true };

  const compact = normalized.replace(/ /g, '');
  for (const phrase of BANNED_PHRASES) {
    if (compact.includes(phrase)) {
      return {
        allowed: false,
        reason: 'Esse nome não é permitido. Escolha outro nome.',
        matched: phrase
      };
    }
  }

  const tokens = normalized.split(' ').filter(Boolean);
  const candidates = new Set(tokens);

  tokens.forEach(token => {
    candidates.add(collapseRepeats(token));
    const stripped = stripDecorations(token);
    if (stripped) {
      candidates.add(stripped);
      candidates.add(collapseRepeats(stripped));
    }
  });

  // "f u c k", "p.u.t.a": sequências de letras soltas viram uma palavra.
  const singles = tokens.filter(token => token.length === 1).join('');
  if (singles) candidates.add(singles);

  for (const candidate of candidates) {
    if (isBannedWord(candidate)) {
      return {
        allowed: false,
        reason: 'Esse nome não é permitido. Escolha outro nome.',
        matched: candidate
      };
    }
  }

  return { allowed: true };
}

function isNameAllowed(value) {
  return checkName(value).allowed;
}

module.exports = {
  checkName,
  isNameAllowed,
  normalizeName
};
