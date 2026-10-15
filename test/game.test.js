import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_INTERVALS,
  CONTENT_TYPES,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  availablePatterns,
  bestProgress,
  boardIsValid,
  buildPool,
  cardIndexSet,
  cardCells,
  columnLabels,
  completedPatterns,
  defaultConfig,
  deriveCard,
  fieldVisibility,
  generateDrawOrder,
  hash32,
  hasFreeCentre,
  minimumPoolSize,
  missedCount,
  mulberry32,
  normalizeConfig,
  numbersPerColumn,
  patternCells,
  patternComplete,
  poolFor,
  presetPatterns,
  recommendBoard,
  shuffle,
  variety,
  winnerLimit,
  winningConditions,
} from '../public/game.js';

const BOARD = { seed: 'seed-abc', round: 1, playerId: 'player-1', rows: 5, cols: 5, freeCentre: true, perColumn: 15 };
const seeded = (n) => mulberry32(hash32(`test-${n}`));
const board = (rows, cols) => ({ seed: 's', round: 1, playerId: 'p', rows, cols, freeCentre: true, perColumn: numbersPerColumn(rows, cols) });

// ---------------------------------------------------------------- pools ----

test('numbers pools reproduce classic geometry and stay two digits', () => {
  const five = buildPool({ content: 'numbers', rows: 5, cols: 5 });
  assert.equal(five.perColumn, 15);
  assert.equal(five.poolSize, 75);
  assert.equal(five.items[0].label, '1');
  assert.equal(five.items[74].label, '75');

  for (let rows = MIN_ROWS; rows <= MAX_ROWS; rows += 1) {
    for (let cols = MIN_COLS; cols <= MAX_COLS; cols += 1) {
      const pool = buildPool({ content: 'numbers', rows, cols });
      assert.ok(pool.poolSize >= minimumPoolSize(rows, cols), `${rows}x${cols} pool covers the board`);
      assert.ok(Number(pool.items[pool.poolSize - 1].label) <= 99, `${rows}x${cols} labels stay two digits`);
      assert.equal(pool.items.length, pool.perColumn * cols);
    }
  }
});

test('every content type produces a usable pool for every board size', () => {
  for (const content of CONTENT_TYPES) {
    // 'numbers' is generated from the geometry and 'custom' comes from the host.
    if (content === 'custom' || content === 'numbers') continue;
    const source = poolFor(content);
    assert.ok(source.length > 0, `${content} has a starter pool`);
    for (let rows = MIN_ROWS; rows <= MAX_ROWS; rows += 1) {
      for (let cols = MIN_COLS; cols <= MAX_COLS; cols += 1) {
        const pool = buildPool({ content, rows, cols });
        assert.ok(pool.poolSize >= minimumPoolSize(rows, cols), `${content} ${rows}x${cols} pool is big enough`);
        assert.ok(pool.perColumn >= rows, `${content} ${rows}x${cols} offers a full column`);
      }
    }
  }
});

test('starter pools are big enough for the largest board we recommend', () => {
  const rec = recommendBoard(500);
  for (const content of ['names', 'images', 'music', 'mixed']) {
    const pool = buildPool({ content, rows: rec.rows, cols: rec.cols });
    assert.ok(pool.poolSize >= minimumPoolSize(rec.rows, rec.cols), `${content} covers ${rec.rows}x${rec.cols}`);
  }
});

test('pools trim to a whole number of columns', () => {
  const pool = buildPool({ content: 'names', rows: 5, cols: 6 });
  assert.equal(pool.items.length, pool.perColumn * 6);
  assert.equal(pool.poolSize, pool.perColumn * 6);
});

test('images carry an emoji label and mixed pairs names with images', () => {
  const images = buildPool({ content: 'images', rows: 3, cols: 3 });
  assert.ok(images.items.every((i) => i.label.length > 0));
  const mixed = buildPool({ content: 'mixed', rows: 3, cols: 3 });
  assert.ok(mixed.items.every((i) => i.label.length > 0 && i.media.length > 0), 'each mixed item has a name and an image');
});

test('custom lists are cleaned, trimmed and must be big enough', () => {
  const items = Array.from({ length: 30 }, (_, i) => `Item ${i + 1}`);
  const pool = buildPool({ content: 'custom', rows: 4, cols: 4, customItems: items });
  assert.equal(pool.perColumn, 7);
  assert.equal(pool.poolSize, 28);
  assert.equal(pool.items[0].label, 'Item 1');

  const messy = buildPool({
    content: 'custom',
    rows: 3,
    cols: 3,
    customItems: ['  Spacey  ', '', null, { label: 'Named', media: 'https://x/y.png' }, 42, 'A', 'B', 'C', 'D'],
  });
  assert.deepEqual(messy.items.map((i) => i.label), ['Spacey', 'Named', 'A', 'B', 'C', 'D']);
  assert.equal(messy.items[1].media, 'https://x/y.png', 'media links survive cleaning');
  assert.equal(messy.perColumn, 2);
});

// ---------------------------------------------------------------- cards ----

test('cards hold pool indices inside their own column', () => {
  for (const [rows, cols] of [[4, 4], [5, 5], [5, 7], [6, 8], [6, 10]]) {
    const b = board(rows, cols);
    const card = deriveCard(b);
    assert.equal(card.length, rows);
    for (const row of card) assert.equal(row.length, cols);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const idx = card[r][c];
        if (idx === null) continue;
        assert.ok(idx >= c * b.perColumn && idx < (c + 1) * b.perColumn, `cell ${r},${c} index ${idx} within column ${c}`);
      }
    }
    const free = hasFreeCentre(rows, cols, true);
    assert.equal(cardIndexSet(card).size, rows * cols - (free ? 1 : 0), `${rows}x${cols} unique indices`);
  }
});

test('cards are stable per player and round, and change otherwise', () => {
  assert.deepEqual(deriveCard(BOARD), deriveCard(BOARD));
  assert.notDeepEqual(deriveCard(BOARD), deriveCard({ ...BOARD, playerId: 'player-2' }));
  assert.notDeepEqual(deriveCard(BOARD), deriveCard({ ...BOARD, round: 2 }));
  assert.notDeepEqual(deriveCard(BOARD), deriveCard({ ...BOARD, seed: 'other' }));
});

test('cards stay distinct across a large room', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) seen.add(JSON.stringify(deriveCard({ ...BOARD, playerId: `p${i}` })));
  assert.ok(seen.size > 380, `expected near-unique cards, got ${seen.size}/400`);
});

test('a free centre only exists on odd boards and is null', () => {
  assert.equal(deriveCard(BOARD)[2][2], null);
  const even = deriveCard({ ...BOARD, rows: 4, cols: 4, perColumn: 12 });
  assert.ok(even.flat().every((n) => n !== null));
  assert.equal(hasFreeCentre(4, 4, true), false);
});

test('cardCells skips the free centre', () => {
  assert.equal(cardCells(deriveCard(BOARD)).length, 24);
});

test('draw order is a permutation of the pool', () => {
  const order = generateDrawOrder(75, seeded(3));
  assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 75 }, (_, i) => i));
});

// ------------------------------------------------------------- patterns ----

test('available patterns are generated from the board geometry', () => {
  const six = availablePatterns(6, 8);
  assert.equal(six.filter((p) => p.id.startsWith('row:')).length, 6);
  assert.equal(six.filter((p) => p.id.startsWith('col:')).length, 8);
  assert.ok(six.some((p) => p.id === 'diag:main') && six.some((p) => p.id === 'blackout'));
  assert.equal(six.find((p) => p.id === 'row:5').label, 'Row 6');
  assert.equal(six.find((p) => p.id === 'col:7').label, 'Column 8');

  const three = availablePatterns(3, 4);
  assert.equal(three.filter((p) => p.id.startsWith('row:')).length, 3);
  assert.equal(three.filter((p) => p.id.startsWith('col:')).length, 4);
});

test('patternCells describes every pattern kind', () => {
  assert.deepEqual(patternCells('row:1', 3, 4), [[1, 0], [1, 1], [1, 2], [1, 3]]);
  assert.deepEqual(patternCells('col:2', 3, 4), [[0, 2], [1, 2], [2, 2]]);
  assert.deepEqual(patternCells('diag:main', 3, 3), [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(patternCells('diag:anti', 3, 3), [[0, 2], [1, 1], [2, 0]]);
  assert.deepEqual(patternCells('corners', 3, 4), [[0, 0], [0, 3], [2, 0], [2, 3]]);
  assert.equal(patternCells('blackout', 3, 4).length, 12);
  assert.deepEqual(patternCells('diag:main', 5, 7), [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]);
  assert.equal(patternCells('row:9', 3, 3), null);
});

test('patterns complete only when called and dabbed', () => {
  const card = deriveCard(BOARD);
  const row = patternCells('row:0', 5, 5);
  const indices = row.map(([r, c]) => card[r][c]);
  const called = new Set(indices);
  assert.equal(patternComplete(card, row, new Set(), called), false);
  assert.equal(patternComplete(card, row, new Set(indices), new Set()), false);
  assert.equal(patternComplete(card, row, new Set(indices), called), true);
});

test('the free centre satisfies a pattern on its own', () => {
  const card = deriveCard(BOARD);
  const middle = patternCells('row:2', 5, 5);
  const real = middle.map(([r, c]) => card[r][c]).filter((n) => n !== null);
  assert.equal(real.length, 4);
  assert.equal(patternComplete(card, middle, new Set(real), new Set(real)), true);
});

test('completedPatterns honours the enabled set', () => {
  const card = deriveCard(BOARD);
  const coords = patternCells('row:0', 5, 5);
  const indices = new Set(coords.map(([r, c]) => card[r][c]));
  assert.deepEqual(completedPatterns(card, indices, indices, ['row:0', 'row:1', 'row:2']), ['row:0']);
  assert.deepEqual(completedPatterns(card, indices, indices, ['col:0', 'col:1', 'col:2']), []);
});

test('bestProgress and missedCount work on indices', () => {
  const card = deriveCard(BOARD);
  const row = patternCells('row:0', 5, 5);
  const indices = row.map(([r, c]) => card[r][c]);
  const best = bestProgress(card, new Set(indices.slice(0, 3)), new Set(indices), ['row:0', 'row:3']);
  assert.equal(best.id, 'row:0');
  assert.equal(best.total, 5);
  assert.equal(best.done, 3);

  const cells = cardCells(card).slice(0, 4).map((c) => c.index);
  assert.equal(missedCount(card, new Set(cells.slice(0, 1)), new Set(cells)), 3);
});

test('presets and winning conditions adapt to the board', () => {
  assert.deepEqual(presetPatterns('allRows', 3, 3), ['row:0', 'row:1', 'row:2']);
  assert.deepEqual(presetPatterns('allCols', 3, 3), ['col:0', 'col:1', 'col:2']);
  assert.deepEqual(presetPatterns('x', 3, 3), ['diag:main', 'diag:anti']);
  assert.equal(presetPatterns('classic', 5, 5).length, 12);
  const conditions = winningConditions(5, 5);
  assert.ok(conditions.length >= 5);
  assert.ok(conditions.every((c) => c.id && c.label));
});

test('recommended boards grow with the group and stay valid', () => {
  let previous = 0;
  for (const players of [4, 12, 30, 80, 150, 300, 500]) {
    const rec = recommendBoard(players);
    assert.ok(boardIsValid(rec.rows, rec.cols), `recommendation for ${players} is valid`);
    assert.ok(rec.rows * rec.cols >= previous, 'recommendation never shrinks');
    previous = rec.rows * rec.cols;
  }
});

test('column labels fall back to numbers past five columns', () => {
  assert.deepEqual(columnLabels(5), ['B', 'I', 'N', 'G', 'O']);
  assert.deepEqual(columnLabels(8), ['1', '2', '3', '4', '5', '6', '7', '8']);
});

test('variety reflects how many items each column offers', () => {
  assert.equal(variety(5, 5, 15).level, 'high', '3 per row needed');
  assert.equal(variety(6, 8, 12).level, 'medium', '2 per row needed');
  assert.equal(variety(6, 10, 9).level, 'medium', '1.5 per row needed');
  assert.equal(variety(6, 10, 6).level, 'low', 'exactly one item per cell — cards repeat');
});

// ------------------------------------------------- interlinked config -----

test('fieldVisibility hides settings that have no meaning', () => {
  const base = defaultConfig();

  // Even board: no free centre can exist.
  assert.equal(fieldVisibility({ ...base, rows: 4, cols: 4 }).freeCentre, false);
  assert.equal(fieldVisibility({ ...base, rows: 5, cols: 5 }).freeCentre, true);

  // Manual calling: no interval to configure.
  assert.equal(fieldVisibility({ ...base, callMode: 'manual' }).callIntervalMs, false);
  assert.equal(fieldVisibility({ ...base, callMode: 'auto' }).callIntervalMs, true);

  // Single winner: one place, so a compact winning condition instead of a grid.
  const single = fieldVisibility({ ...base, winnerMode: 'single' });
  assert.equal(single.patternGrid, false);
  assert.equal(single.winningCondition, true);
  assert.equal(single.maxWinners, false);

  const multi = fieldVisibility({ ...base, winnerMode: 'multiple' });
  assert.equal(multi.patternGrid, true);
  assert.equal(multi.winningCondition, false);
  assert.equal(multi.maxWinners, true);

  // Automatic call-out: no Bingo button needed.
  assert.equal(fieldVisibility({ ...base, winnerCall: 'auto' }).claimButton, false);
  assert.equal(fieldVisibility({ ...base, winnerCall: 'manual' }).claimButton, true);

  // Automatic dabbing: the "you missed some" hint is meaningless.
  assert.equal(fieldVisibility({ ...base, markMode: 'auto' }).missedHint, false);

  // Content dependent.
  assert.equal(fieldVisibility({ ...base, content: 'custom' }).customItems, true);
  assert.equal(fieldVisibility({ ...base, content: 'numbers' }).customItems, false);
  assert.equal(fieldVisibility({ ...base, content: 'music' }).poolDetails, true);

  // Social toggles follow their switches.
  assert.equal(fieldVisibility({ ...base, chat: false }).chat, false);
  assert.equal(fieldVisibility({ ...base, reactions: false }).reactions, false);
});

test('normalizeConfig enforces the single-winner interlink', () => {
  const built = normalizeConfig({ winnerMode: 'single', maxWinners: 9 }, defaultConfig());
  assert.equal(built.config.winnerMode, 'single');
  assert.equal(built.config.maxWinners, 1, 'a single-winner round has exactly one place');
  assert.equal(winnerLimit(built.config), 1);
});

test('normalizeConfig drops a free centre that cannot exist', () => {
  const built = normalizeConfig({ rows: 4, cols: 4, freeCentre: true }, defaultConfig());
  assert.equal(built.config.freeCentre, false);
  assert.equal(built.config.rows, 4);
});

test('normalizeConfig rejects out-of-range and unknown values', () => {
  const base = defaultConfig();
  assert.equal(normalizeConfig({ rows: 2 }, base).error, 'invalid_rows');
  assert.equal(normalizeConfig({ rows: 7 }, base).error, 'invalid_rows');
  assert.equal(normalizeConfig({ cols: 2 }, base).error, 'invalid_cols');
  assert.equal(normalizeConfig({ cols: 99 }, base).error, 'invalid_cols');
  assert.equal(normalizeConfig({ content: 'paintings' }, base).error, 'invalid_content');
  assert.equal(normalizeConfig({ callIntervalMs: 777 }, base).error, 'invalid_interval');
  assert.equal(normalizeConfig({ winnerCall: 'shout' }, base).error, 'invalid_winner_call');
  assert.equal(normalizeConfig({ winnerMode: 'nobody' }, base).error, 'invalid_winner_mode');
  assert.equal(normalizeConfig({ callMode: 'psychic' }, base).error, 'invalid_call_mode');
  assert.equal(normalizeConfig({ markMode: 'psychic' }, base).error, 'invalid_mark_mode');
  assert.equal(normalizeConfig({ maxWinners: 900 }, base).error, 'invalid_max_winners');
  assert.equal(normalizeConfig({ expectedPlayers: 9999 }, base).error, 'invalid_expected_players');
  assert.equal(normalizeConfig({ winPatterns: [] }, base).error, 'no_patterns');
  assert.equal(normalizeConfig({ winPatterns: ['row:99', 'nope'] }, base).error, 'no_patterns');
});

test('normalizeConfig keeps valid patterns and re-derives bad ones', () => {
  const partly = normalizeConfig({ rows: 3, cols: 3, winPatterns: ['row:0', 'row:99', 'nope'] }, defaultConfig());
  assert.deepEqual(partly.config.winPatterns, ['row:0']);

  // Patterns that do not exist on the new geometry fall back to classic.
  const shrunk = normalizeConfig({ rows: 3, cols: 3 }, { ...defaultConfig(), winPatterns: ['row:5', 'col:9'] });
  assert.deepEqual(shrunk.config.winPatterns, presetPatterns('classic', 3, 3));
});

test('normalizeConfig validates custom pools against the board', () => {
  const base = defaultConfig();
  const tooShort = normalizeConfig({ content: 'custom', rows: 6, cols: 10, customItems: ['a', 'b', 'c'] }, base);
  assert.equal(tooShort.error, 'pool_too_small');
  assert.match(tooShort.message, /at least 60 items/);

  const enough = normalizeConfig(
    { content: 'custom', rows: 6, cols: 10, customItems: Array.from({ length: 60 }, (_, i) => `T${i}`) },
    base
  );
  assert.ok(enough.config, 'a 60 item list covers a 6x10 board');
  assert.equal(enough.config.poolSize, 60);
  assert.equal(enough.config.perColumn, 6);

  const tooMany = normalizeConfig({ content: 'custom', customItems: Array.from({ length: 400 }, (_, i) => `T${i}`) }, base);
  assert.equal(tooMany.error, 'too_many_items');
});

test('normalizeConfig ignores unknown keys and reports the derived pool', () => {
  const built = normalizeConfig({ nonsense: true, rows: 6, cols: 8 }, defaultConfig());
  assert.ok(built.config);
  assert.equal(built.config.nonsense, undefined);
  assert.equal(built.config.perColumn, buildPool({ content: 'numbers', rows: 6, cols: 8 }).perColumn);
  assert.equal(built.config.poolSize, buildPool({ content: 'numbers', rows: 6, cols: 8 }).poolSize);
});

test('normalizeConfig keeps social and leaderboard toggles', () => {
  const built = normalizeConfig({ chat: false, reactions: false, leaderboard: false, expectedPlayers: 120 }, defaultConfig());
  assert.equal(built.config.chat, false);
  assert.equal(built.config.reactions, false);
  assert.equal(built.config.leaderboard, false);
  assert.equal(built.config.expectedPlayers, 120);
});

test('winnerLimit covers single, capped and unlimited rounds', () => {
  assert.equal(winnerLimit({ winnerMode: 'single', maxWinners: 1 }), 1);
  assert.equal(winnerLimit({ winnerMode: 'multiple', maxWinners: 3 }), 3);
  assert.equal(winnerLimit({ winnerMode: 'multiple', maxWinners: 0 }), 500);
});

test('allowed intervals and content types stay stable', () => {
  assert.deepEqual(ALLOWED_INTERVALS, [3000, 4000, 5000, 8000, 12000, 20000]);
  assert.deepEqual(CONTENT_TYPES, ['numbers', 'names', 'images', 'music', 'mixed', 'custom']);
});

test('shuffle and the seeded helpers remain deterministic', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = shuffle(input, seeded(9));
  assert.deepEqual([...out].sort((a, b) => a - b), input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
});
