// Pure, dependency-free bingo rules.
//
// This module is the single source of truth for the game: the Worker validates
// claims with it and the browser draws the board with it.
//
// Three ideas hold the design together:
//
//  1. Cards are DERIVED, never stored — a pure function of
//     (room seed, round, player id). Dealing a round costs the same for 4 or
//     500 players, and there is nothing to reset between rounds.
//  2. A room has a POOL of callable items. A cell stores the item's *index*
//     into that pool, so numbers, names, emoji, song titles and host-supplied
//     lists all flow through exactly the same rule engine.
//  3. Board geometry (rows x columns) and the config dependencies live here too,
//     so the server can normalise a config and the UI can render the same rules.

export const MIN_ROWS = 3;
export const MAX_ROWS = 6;
export const MIN_COLS = 3;
export const MAX_COLS = 10;

/** Keeps numeric cells two digits so cards stay readable on phones. */
export const MAX_NUMBER = 99;

export const CONTENT_TYPES = ['numbers', 'names', 'images', 'music', 'mixed', 'custom'];

export const CONTENT_LABELS = {
  numbers: 'Numbers',
  names: 'Names',
  images: 'Images / emoji',
  music: 'Music titles',
  mixed: 'Names + images',
  custom: 'My own list',
};

// ------------------------------------------------------------------ pools ---

// Pools are deliberately public-domain / royalty-free in content. Hosts can
// always supply their own list with the "custom" content type.
const NAME_POOL = [
  'Alex', 'Sam', 'Jordan', 'Taylor', 'Casey', 'Riley', 'Morgan', 'Jamie', 'Avery', 'Quinn',
  'Robin', 'Dakota', 'Skyler', 'Rowan', 'Charlie', 'Emerson', 'Finley', 'Harper', 'Indigo', 'Jules',
  'Kai', 'Lane', 'Marlowe', 'Noel', 'Oakley', 'Parker', 'Reese', 'Sage', 'Toby', 'Wren',
  'Bailey', 'Cameron', 'Devon', 'Elliot', 'Frankie', 'Greer', 'Hollis', 'Ira', 'Juniper', 'Kit',
  'Lennon', 'Micah', 'Nova', 'Owen', 'Piper', 'Remy', 'Sasha', 'Theo', 'Uma', 'Vida',
  'Willa', 'Xander', 'Yara', 'Zane', 'Ada', 'Beau', 'Cleo', 'Drew', 'Esme', 'Flynn',
  'Gus', 'Hana', 'Ivan', 'Jo', 'Kirk', 'Lia', 'Milo', 'Nina', 'Orla', 'Pete',
  'Ravi', 'Sima', 'Tessa', 'Umar', 'Vera', 'Wade', 'Xena', 'Yuri', 'Zoe', 'Alma',
];

const IMAGE_POOL = [
  '🎉', '🎈', '🎁', '🍕', '🍔', '🍟', '🌮', '🍣', '🍩', '🍪',
  '🍫', '🍭', '🍦', '🍎', '🍌', '🍇', '🍓', '🥑', '🌽', '🥕',
  '⚽', '🏀', '🏈', '🎾', '🎱', '🏐', '🥊', '🛹', '🎳', '🏓',
  '🚗', '🚕', '🚌', '🚑', '🚒', '🚓', '🚲', '🛵', '✈️', '🚀',
  '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯',
  '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦄', '🐝',
  '🌸', '🌻', '🌹', '🌵', '🍀', '🌈', '⭐', '🌙', '☀️', '⛅',
  '🎸', '🎹', '🎺', '🥁', '🎻', '🎤', '🎧', '📻', '🎬', '🎮',
  '🔥', '💧', '❄️', '⚡', '🎂', '🎀', '🎩', '👑', '💎', '🔔',
];

// Traditional, folk and public-domain pieces — safe to ship as a starter list.
const MUSIC_POOL = [
  'Jingle Bells', 'Silent Night', 'Deck the Halls', 'O Christmas Tree', 'Joy to the World',
  'Ode to Joy', 'Für Elise', 'Moonlight Sonata', 'Canon in D', 'Greensleeves',
  'Scarborough Fair', 'Danny Boy', 'Amazing Grace', 'Auld Lang Syne', 'When the Saints Go Marching In',
  'Swing Low Sweet Chariot', 'Camptown Races', 'Oh Susanna', 'Yankee Doodle', 'Frère Jacques',
  'London Bridge', 'Twinkle Twinkle Little Star', 'Mary Had a Little Lamb', 'Row Row Row Your Boat',
  'Old MacDonald Had a Farm', 'The Wheels on the Bus', 'Itsy Bitsy Spider', 'Baa Baa Black Sheep',
  'Hickory Dickory Dock', 'Home on the Range', 'Red River Valley', 'Down by the Riverside',
  'This Little Light of Mine', 'Kumbaya', 'Michael Row the Boat Ashore', 'Skip to My Lou',
  'She’ll Be Coming Round the Mountain', 'The Blue Danube', 'William Tell Overture',
  'Ride of the Valkyries', 'In the Hall of the Mountain King', 'The Entertainer', 'Maple Leaf Rag',
  'Pomp and Circumstance', 'Swan Lake', 'Dance of the Sugar Plum Fairy', 'Boléro', 'Clair de Lune',
  'Air on the G String', 'Träumerei', 'Ave Maria', 'Hallelujah Chorus', 'Bridal Chorus',
  'Wedding March', 'Radetzky March', 'Turkey in the Straw', 'Arkansas Traveler',
  'Oh My Darling Clementine', 'I’ve Been Working on the Railroad', 'Alouette',
  'Waltzing Matilda', 'For He’s a Jolly Good Fellow', 'La Cucaracha', 'Red Wing',
  'Take Me Out to the Ball Game',
];

const ITEM_POOLS = {
  names: NAME_POOL,
  images: IMAGE_POOL,
  music: MUSIC_POOL,
};

/** Emoji a player may throw at another player. */
export const REACTION_EMOJIS = [
  '❤️', '😂', '🔥', '👏', '🎉', '😮', '😍', '🤯', '🙌', '💪',
  '😎', '🤝', '🍀', '⭐', '💯', '👀', '🫶', '🎯', '🚀', '😅',
];

/** Avatars a player can pick when joining (no uploads needed). */
export const AVATAR_CHOICES = [
  '🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🐵', '🐧', '🦉', '🦄',
  '🐝', '🐙', '🦖', '🐬', '🦋', '🐢', '🦜', '🐳', '🦩', '🐿️',
  '👑', '🎩', '🎓', '🕶️', '🎧', '🚀', '⚽', '🎸', '🌮', '🍕',
];

export function randomAvatar(seedText) {
  return AVATAR_CHOICES[hash32(seedText) % AVATAR_CHOICES.length];
}

export function poolFor(content) {
  if (content === 'names') return NAME_POOL.slice();
  if (content === 'images') return IMAGE_POOL.slice();
  if (content === 'music') return MUSIC_POOL.map((title) => ({ label: title, media: '' }));
  if (content === 'mixed') return NAME_POOL.map((name, i) => ({ label: name, media: IMAGE_POOL[i % IMAGE_POOL.length] }));
  return [];
}

/** How many numbers each column holds for a numeric board. */
export function numbersPerColumn(rows, cols) {
  return Math.min(3 * rows, Math.floor(MAX_NUMBER / cols));
}

/**
 * Turn a config into the room's callable pool.
 * Items are `{ label, media }`; `media` is an optional link (used by music or
 * host-supplied image URLs). Cells store an item's index into this array.
 */
export function buildPool({ content, rows, cols, customItems }) {
  if (content === 'numbers') {
    const perColumn = numbersPerColumn(rows, cols);
    const size = perColumn * cols;
    return {
      items: Array.from({ length: size }, (_, i) => ({ label: String(i + 1), media: '' })),
      perColumn,
      poolSize: size,
    };
  }

  let source = [];
  if (content === 'custom') {
    source = (Array.isArray(customItems) ? customItems : []).map(normaliseItem).filter(Boolean);
  } else {
    source = poolFor(content).map(normaliseItem).filter(Boolean);
  }

  const perColumn = Math.floor(source.length / cols);
  const size = perColumn * cols;
  return { items: source.slice(0, size), perColumn, poolSize: size };
}

function normaliseItem(raw) {
  if (typeof raw === 'string') {
    const label = raw.trim().slice(0, 40);
    return label ? { label, media: '' } : null;
  }
  if (raw && typeof raw === 'object') {
    const label = String(raw.label ?? '').trim().slice(0, 40);
    const media = String(raw.media ?? '').trim().slice(0, 300);
    return label ? { label, media } : null;
  }
  return null;
}

/** The fewest pool items a board of this shape needs to deal unique cards. */
export function minimumPoolSize(rows, cols) {
  return rows * cols;
}

export function boardIsValid(rows, cols) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return false;
  if (rows < MIN_ROWS || rows > MAX_ROWS) return false;
  if (cols < MIN_COLS || cols > MAX_COLS) return false;
  return true;
}

export function hasFreeCentre(rows, cols, freeCentre) {
  return Boolean(freeCentre) && rows % 2 === 1 && cols % 2 === 1;
}

export function columnLabels(cols) {
  const classic = ['B', 'I', 'N', 'G', 'O'];
  if (cols <= 5) return classic.slice(0, cols);
  return Array.from({ length: cols }, (_, i) => String(i + 1));
}

// ---------------------------------------------------------------- random ---

export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, rng = Math.random) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The order pool indices will be called in. */
export function generateDrawOrder(poolSize, rng = Math.random) {
  return shuffle(Array.from({ length: poolSize }, (_, i) => i), rng);
}

// ----------------------------------------------------------------- cards ---

/**
 * The card a player holds this round, as pool indices.
 * Column `c` draws from indices `[c*perColumn, (c+1)*perColumn)`.
 */
export function deriveCard({ seed, round, playerId, rows, cols, freeCentre, perColumn }) {
  const rng = mulberry32(hash32(`${seed}|r${round}|${playerId}`));
  const free = hasFreeCentre(rows, cols, freeCentre);
  const freeRow = (rows - 1) / 2;
  const freeCol = (cols - 1) / 2;

  const columns = [];
  for (let c = 0; c < cols; c += 1) {
    const slice = [];
    for (let i = 0; i < perColumn; i += 1) slice.push(c * perColumn + i);
    columns.push(shuffle(slice, rng).slice(0, rows));
  }

  const card = [];
  for (let r = 0; r < rows; r += 1) {
    const row = [];
    for (let c = 0; c < cols; c += 1) {
      const isFree = free && r === freeRow && c === freeCol;
      row.push(isFree ? null : columns[c][r]);
    }
    card.push(row);
  }
  return card;
}

export function cardCells(card) {
  const cells = [];
  for (let r = 0; r < card.length; r += 1) {
    for (let c = 0; c < card[r].length; c += 1) {
      if (card[r][c] !== null) cells.push({ row: r, col: c, index: card[r][c] });
    }
  }
  return cells;
}

export function cardIndexSet(card) {
  const set = new Set();
  for (const cell of cardCells(card)) set.add(cell.index);
  return set;
}

export function calledItems(drawOrder, count) {
  const n = Math.max(0, Math.min(Number(count) || 0, drawOrder.length));
  return drawOrder.slice(0, n);
}

// -------------------------------------------------------------- patterns ---

/**
 * Every pattern this board can offer, generated from its geometry — so a 6x8
 * board automatically exposes Rows 1-6 and Columns 1-8.
 */
export function availablePatterns(rows, cols) {
  const list = [];
  for (let r = 0; r < rows; r += 1) list.push({ id: `row:${r}`, kind: 'row', index: r, label: `Row ${r + 1}` });
  for (let c = 0; c < cols; c += 1) list.push({ id: `col:${c}`, kind: 'col', index: c, label: `Column ${c + 1}` });
  if (Math.min(rows, cols) >= 2) {
    list.push({ id: 'diag:main', kind: 'diag', label: 'Diagonal ↘' });
    list.push({ id: 'diag:anti', kind: 'diag', label: 'Diagonal ↙' });
  }
  if (rows >= 2 && cols >= 2) list.push({ id: 'corners', kind: 'corners', label: 'Four corners' });
  list.push({ id: 'blackout', kind: 'blackout', label: 'Blackout (full card)' });
  return list;
}

export function patternCells(id, rows, cols) {
  if (typeof id !== 'string') return null;
  const [kind, rawIndex] = id.split(':');
  const index = Number(rawIndex);

  if (kind === 'row') {
    if (!Number.isInteger(index) || index < 0 || index >= rows) return null;
    return Array.from({ length: cols }, (_, c) => [index, c]);
  }
  if (kind === 'col') {
    if (!Number.isInteger(index) || index < 0 || index >= cols) return null;
    return Array.from({ length: rows }, (_, r) => [r, index]);
  }
  if (kind === 'diag') {
    if (Math.min(rows, cols) < 2) return null;
    const span = Math.min(rows, cols);
    if (rawIndex === 'main') return Array.from({ length: span }, (_, i) => [i, i]);
    if (rawIndex === 'anti') return Array.from({ length: span }, (_, i) => [i, cols - 1 - i]);
    return null;
  }
  if (kind === 'corners') {
    if (rows < 2 || cols < 2) return null;
    return [[0, 0], [0, cols - 1], [rows - 1, 0], [rows - 1, cols - 1]];
  }
  if (kind === 'blackout') {
    const cells = [];
    for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) cells.push([r, c]);
    return cells;
  }
  return null;
}

export function patternComplete(card, cells, markedSet, calledSet) {
  if (!cells) return false;
  for (const [r, c] of cells) {
    const idx = card[r][c];
    if (idx === null) continue; // free centre counts automatically
    if (!calledSet.has(idx) || !markedSet.has(idx)) return false;
  }
  return true;
}

export function completedPatterns(card, markedSet, calledSet, enabledPatterns) {
  const rows = card.length;
  const cols = card[0] ? card[0].length : 0;
  return enabledPatterns.filter((id) => patternComplete(card, patternCells(id, rows, cols), markedSet, calledSet));
}

/** How close this player is to their nearest enabled pattern. */
export function bestProgress(card, markedSet, calledSet, enabledPatterns) {
  const rows = card.length;
  const cols = card[0] ? card[0].length : 0;
  let best = { id: null, done: 0, total: 0, ratio: 0 };
  for (const id of enabledPatterns) {
    const cells = patternCells(id, rows, cols);
    if (!cells) continue;
    let done = 0;
    for (const [r, c] of cells) {
      const idx = card[r][c];
      if (idx === null) done += 1;
      else if (calledSet.has(idx) && markedSet.has(idx)) done += 1;
    }
    const ratio = cells.length ? done / cells.length : 0;
    if (ratio > best.ratio || (ratio === best.ratio && done > best.done)) {
      best = { id, done, total: cells.length, ratio };
    }
  }
  return best;
}

export function missedCount(card, markedSet, calledSet) {
  let missed = 0;
  for (const { index } of cardCells(card)) {
    if (calledSet.has(index) && !markedSet.has(index)) missed += 1;
  }
  return missed;
}

// --------------------------------------------------------------- presets ---

export function presetPatterns(name, rows, cols) {
  const ids = availablePatterns(rows, cols).map((p) => p.id);
  switch (name) {
    case 'classic':
      return ids.filter((id) => id !== 'corners' && id !== 'blackout');
    case 'allRows':
      return ids.filter((id) => id.startsWith('row:'));
    case 'allCols':
      return ids.filter((id) => id.startsWith('col:'));
    case 'x':
      return ids.filter((id) => id.startsWith('diag:'));
    case 'corners':
      return ['corners'];
    case 'blackout':
      return ['blackout'];
    case 'everything':
      return ids;
    default:
      return presetPatterns('classic', rows, cols);
  }
}

/**
 * The compact "winning condition" choices offered in single-winner mode, where
 * a full pattern grid would be noise — one place to fill means one condition.
 */
export function winningConditions(rows, cols) {
  return [
    { id: 'classic', label: 'First to any line (row, column or diagonal)' },
    { id: 'allRows', label: 'First to any row' },
    { id: 'allCols', label: 'First to any column' },
    { id: 'x', label: 'First to a diagonal' },
    { id: 'corners', label: 'First to four corners' },
    { id: 'blackout', label: 'First to a full card (blackout)' },
  ];
}

export function recommendBoard(expectedPlayers) {
  const n = Number(expectedPlayers) || 0;
  if (n <= 12) return { rows: 4, cols: 4, note: 'cosy tables' };
  if (n <= 30) return { rows: 5, cols: 5, note: 'classic 75-ball' };
  if (n <= 80) return { rows: 5, cols: 6, note: 'medium rooms' };
  if (n <= 150) return { rows: 5, cols: 7, note: 'large rooms' };
  if (n <= 300) return { rows: 6, cols: 6, note: 'halls' };
  return { rows: 6, cols: 8, note: 'very large groups' };
}

export function variety(rows, cols, perColumn) {
  const per = perColumn ?? numbersPerColumn(rows, cols);
  const ratio = per / rows;
  if (ratio >= 2.5) return { level: 'high', ratio };
  if (ratio >= 1.5) return { level: 'medium', ratio };
  return { level: 'low', ratio };
}

// ------------------------------------------------------------- the config ---

export const DEFAULT_SECONDS = 5;
export const ALLOWED_INTERVALS = [3000, 4000, 5000, 8000, 12000, 20000];
export const MAX_CUSTOM_ITEMS = 300;

export function defaultConfig() {
  const rows = 5;
  const cols = 5;
  return {
    rows,
    cols,
    content: 'numbers',
    customItems: [],
    freeCentre: true,
    callMode: 'auto',
    callIntervalMs: 5000,
    markMode: 'manual',
    winnerMode: 'single',
    maxWinners: 1,
    winPatterns: presetPatterns('classic', rows, cols),
    winnerCall: 'manual',
    leaderboard: true,
    chat: true,
    reactions: true,
    expectedPlayers: 0,
  };
}

/**
 * Which settings actually apply. This is the "interlinked configuration"
 * contract: the UI hides what has no meaning and the server enforces the same
 * rules, so the two can never drift.
 */
export function fieldVisibility(config) {
  const { rows, cols } = config;
  const odd = rows % 2 === 1 && cols % 2 === 1;
  return {
    // A free centre cannot exist on an even board.
    freeCentre: odd,
    // An interval only matters when the machine is doing the calling.
    callIntervalMs: config.callMode === 'auto',
    // A single winner has one place to fill, so the multi-select pattern grid
    // is replaced by one winning condition.
    patternGrid: config.winnerMode === 'multiple',
    winningCondition: config.winnerMode === 'single',
    // A cap only means something when more than one player can win.
    maxWinners: config.winnerMode === 'multiple',
    // Only needed when the host is supplying the list.
    customItems: config.content === 'custom',
    // Non-numeric content has its own pool guidance.
    poolDetails: config.content !== 'numbers',
    // The "you missed some" hint is pointless when dabbing is automatic.
    missedHint: config.markMode === 'manual',
    // Manual call-out means players press Bingo.
    claimButton: config.winnerCall === 'manual',
    chat: config.chat,
    reactions: config.reactions,
    leaderboard: config.leaderboard,
  };
}

/**
 * Validate and coerce a requested config. Used by the server on every write and
 * unit tested directly, because an incoherent config makes the game unfair.
 */
export function normalizeConfig(raw, base) {
  const next = { ...base };
  const input = raw && typeof raw === 'object' ? raw : {};

  if (input.rows !== undefined) {
    const rows = Number(input.rows);
    if (!Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) {
      return { error: 'invalid_rows', message: `Rows must be ${MIN_ROWS}-${MAX_ROWS}.` };
    }
    next.rows = rows;
  }
  if (input.cols !== undefined) {
    const cols = Number(input.cols);
    if (!Number.isInteger(cols) || cols < MIN_COLS || cols > MAX_COLS) {
      return { error: 'invalid_cols', message: `Columns must be ${MIN_COLS}-${MAX_COLS}.` };
    }
    next.cols = cols;
  }
  if (!boardIsValid(next.rows, next.cols)) {
    return { error: 'invalid_board', message: `${next.rows} x ${next.cols} is not a supported board.` };
  }

  if (input.content !== undefined) {
    if (!CONTENT_TYPES.includes(input.content)) return { error: 'invalid_content', message: 'Unknown bingo content type.' };
    next.content = input.content;
  }
  if (input.customItems !== undefined) {
    if (!Array.isArray(input.customItems)) return { error: 'invalid_items', message: 'Custom items must be a list.' };
    if (input.customItems.length > MAX_CUSTOM_ITEMS) {
      return { error: 'too_many_items', message: `Keep custom lists to ${MAX_CUSTOM_ITEMS} entries or fewer.` };
    }
    next.customItems = input.customItems;
  }

  const pool = buildPool({ content: next.content, rows: next.rows, cols: next.cols, customItems: next.customItems });
  const needed = minimumPoolSize(next.rows, next.cols);
  if (pool.poolSize < needed) {
    return {
      error: 'pool_too_small',
      message:
        next.content === 'custom'
          ? `You need at least ${needed} items for a ${next.rows}x${next.cols} board (${needed / next.cols} per column), or reduce the columns.`
          : 'That content pool is too small for this board.',
    };
  }

  if (input.freeCentre !== undefined) next.freeCentre = Boolean(input.freeCentre);
  // Interlink: the free centre only exists on an odd x odd board.
  next.freeCentre = hasFreeCentre(next.rows, next.cols, next.freeCentre);

  if (input.callMode !== undefined) {
    if (input.callMode !== 'auto' && input.callMode !== 'manual') return { error: 'invalid_call_mode' };
    next.callMode = input.callMode;
  }
  if (input.callIntervalMs !== undefined) {
    const ms = Number(input.callIntervalMs);
    if (!ALLOWED_INTERVALS.includes(ms)) return { error: 'invalid_interval', message: 'Unsupported call speed.' };
    next.callIntervalMs = ms;
  }
  if (input.markMode !== undefined) {
    if (input.markMode !== 'auto' && input.markMode !== 'manual') return { error: 'invalid_mark_mode' };
    next.markMode = input.markMode;
  }
  if (input.winnerCall !== undefined) {
    if (input.winnerCall !== 'auto' && input.winnerCall !== 'manual') return { error: 'invalid_winner_call' };
    next.winnerCall = input.winnerCall;
  }
  if (input.winnerMode !== undefined) {
    if (input.winnerMode !== 'single' && input.winnerMode !== 'multiple') return { error: 'invalid_winner_mode' };
    next.winnerMode = input.winnerMode;
  }
  if (input.maxWinners !== undefined) {
    const maxWinners = Number(input.maxWinners);
    if (!Number.isInteger(maxWinners) || maxWinners < 0 || maxWinners > 500) {
      return { error: 'invalid_max_winners', message: 'Winner places must be 0-500 (0 = no limit).' };
    }
    next.maxWinners = maxWinners;
  }
  // Interlink: a single winner has exactly one place to fill.
  if (next.winnerMode === 'single') next.maxWinners = 1;

  if (input.expectedPlayers !== undefined) {
    const expected = Number(input.expectedPlayers);
    if (!Number.isInteger(expected) || expected < 0 || expected > 500) {
      return { error: 'invalid_expected_players', message: 'Expected players must be 0-500.' };
    }
    next.expectedPlayers = expected;
  }

  for (const flag of ['leaderboard', 'chat', 'reactions']) {
    if (input[flag] !== undefined) next[flag] = Boolean(input[flag]);
  }

  if (Array.isArray(input.winPatterns)) {
    const valid = new Set(availablePatterns(next.rows, next.cols).map((p) => p.id));
    const list = [...new Set(input.winPatterns.filter((id) => valid.has(id)))];
    if (list.length === 0) return { error: 'no_patterns', message: 'Pick at least one winning pattern.' };
    next.winPatterns = list;
  }

  // Geometry or content changes can invalidate the chosen patterns.
  const validIds = new Set(availablePatterns(next.rows, next.cols).map((p) => p.id));
  next.winPatterns = (next.winPatterns || []).filter((id) => validIds.has(id));
  if (next.winPatterns.length === 0) next.winPatterns = presetPatterns('classic', next.rows, next.cols);

  next.perColumn = pool.perColumn;
  next.poolSize = pool.poolSize;
  return { config: next, items: pool.items };
}

/** How many winners the round will accept (a single winner is one place). */
export function winnerLimit(config) {
  if (config.winnerMode === 'single') return 1;
  return config.maxWinners > 0 ? config.maxWinners : 500;
}
