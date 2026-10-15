#!/usr/bin/env node
// End-to-end smoke test. Everything goes through the same HTTP interface the
// browser uses, including all fixture setup — no direct database access.
//
//   node scripts/smoke.mjs                 # functional coverage
//   node scripts/smoke.mjs --scale         # ...plus a 500-player load check
//
// Run against a live `npm run dev` server.

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const withScale = process.argv.includes('--scale');
const SCALE_PLAYERS = Number(process.env.SCALE_PLAYERS || 500);

let failures = 0;
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  \u2714 ${name}`);
  } else {
    failures += 1;
    console.log(`  \u2716 ${name}${detail ? ` \u2014 ${detail}` : ''}`);
  }
}

const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A crash must never look like a pass: report it, keep the exit code non-zero.
process.on('uncaughtException', (error) => {
  failures += 1;
  console.log(`  \u2716 FATAL \u2014 ${error.message}`);
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  failures += 1;
  console.log(`  \u2716 FATAL \u2014 ${reason && reason.message ? reason.message : reason}`);
  console.log(`\n${passed} passed, ${failures} failed`);
  process.exit(1);
});

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['x-player-token'] = token;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text, size: text.length };
}

// ---------------------------------------------------------------- fixtures ---

const state = (code, token, since) =>
  api(`/api/room/${code}/state${since === undefined ? '' : `?since=${since}`}`, { token });

/** The host never has a card; `you` is only populated for real players. */
const cardOf = async (code, token) => (await state(code, token)).data.you.card;

async function newRoom(name, config = {}) {
  const res = await api('/api/room', { method: 'POST', body: { name, ...config } });
  return { code: res.data?.room?.code, hostToken: res.data?.token, res };
}

async function join(code, name) {
  const res = await api(`/api/room/${code}/join`, { method: 'POST', body: { name } });
  return { token: res.data?.token, card: res.data?.you?.card, res };
}

const startRound = (code, token) => api(`/api/room/${code}/start`, { method: 'POST', body: {}, token });
const claim = (code, token) => api(`/api/room/${code}/bingo`, { method: 'POST', body: {}, token });
const setConfig = (code, token, config) =>
  api(`/api/room/${code}/config`, { method: 'POST', body: { config }, token });
const callNext = (code, token) => api(`/api/room/${code}/call`, { method: 'POST', body: {}, token });
const callIndex = (code, token, index) =>
  api(`/api/room/${code}/call`, { method: 'POST', body: { index }, token });
const dab = (code, token, index) =>
  api(`/api/room/${code}/mark`, { method: 'POST', body: { index }, token });

async function callIndexes(code, token, indexes) {
  for (const index of indexes) await callIndex(code, token, index);
}

const rowIndexes = (card, r) => card[r].filter((n) => n !== null);
const colIndexes = (card, c) => card.map((row) => row[c]).filter((n) => n !== null);
const cardIndexes = (card) => card.flat().filter((n) => n !== null);
const distinct = (list) => [...new Set(list.flat())];

/**
 * Start a round, then read each seat's card *as it is for this round* (cards are
 * derived fresh when a round starts), pick the indexes to call, and call them.
 */
async function playRound(code, hostToken, tokens, pick) {
  await startRound(code, hostToken);
  const cards = [];
  for (const token of tokens) cards.push(await cardOf(code, token));
  const indexes = pick ? pick(cards) : null;
  if (indexes && indexes.length) await callIndexes(code, hostToken, indexes);
  return cards;
}

// ---------------------------------------------------------------- assets ---

section('Static assets');
{
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  check('GET / returns the app shell', home.status === 200 && html.includes('Bingo Tables'), `${home.status}`);
  for (const [path, type] of [
    ['/styles.css', 'text/css'],
    ['/app.js', 'javascript'],
    ['/game.js', 'javascript'],
  ]) {
    const res = await fetch(`${BASE}${path}`);
    check(`GET ${path} served as ${type}`, res.status === 200 && (res.headers.get('content-type') || '').includes(type), `${res.status}`);
  }
  const css = await (await fetch(`${BASE}/styles.css`)).text();
  check('the stylesheet covers the stadium, chat and reactions',
    css.includes('.stadium') && css.includes('.fly-emoji') && css.includes('.chat-log') && css.includes('.cell-image'),
    'stadium/chat/emoji/content rules missing');

  const spa = await fetch(`${BASE}/deep/link`);
  check('unknown paths fall back to the SPA shell', spa.status === 200 && (await spa.text()).includes('Bingo Tables'));
  const health = await api('/api/health');
  check('GET /api/health is handled by the Worker', health.status === 200 && health.data.ok === true, JSON.stringify(health.data));
}

// --------------------------------------------------------------- geometry ---

section('Board geometry (rows x columns drive everything)');
{
  const plain = await newRoom('Host');
  const cfg = plain.res.data.room.config;
  check('default table is classic 5x5 / 75 pool items', cfg.rows === 5 && cfg.poolSize === 75 && cfg.perColumn === 15, JSON.stringify({ rows: cfg.rows, poolSize: cfg.poolSize, perColumn: cfg.perColumn }));
  check('5x5 keeps B-I-N-G-O labels', plain.res.data.room.columnLabels.join() === 'B,I,N,G,O');
  const plainPlayer = await join(plain.code, 'Player');
  check('5x5 card is 5x5 with a free centre', plainPlayer.card.length === 5 && plainPlayer.card[0].length === 5 && plainPlayer.card[2][2] === null);

  const big = await newRoom('Host', { rows: 6, cols: 8 });
  const bigCfg = big.res.data.room.config;
  check('6x8 board derives its own pool', bigCfg.poolSize === 96 && bigCfg.perColumn === 12, JSON.stringify({ poolSize: bigCfg.poolSize, perColumn: bigCfg.perColumn }));
  check('8 columns get numeric labels', big.res.data.room.columnLabels.length === 8 && big.res.data.room.columnLabels[0] === '1');
  check('even x even board drops the free centre', bigCfg.freeCentre === false);
  const bigPlayer = await join(big.code, 'Player');
  check('the card really is 6 rows x 8 columns', bigPlayer.card.length === 6 && bigPlayer.card[0].length === 8);
  check('a 6x8 card holds 48 cells', cardIndexes(bigPlayer.card).length === 48);
  check('column 4 of a 6x8 card stays in its own range', bigPlayer.card.every((row) => row[3] >= 36 && row[3] <= 47), JSON.stringify(bigPlayer.card.map((r) => r[3])));

  const tall = await newRoom('Host', { rows: 3, cols: 10 });
  check('3x10 board works too', tall.res.data.room.config.rows === 3 && tall.res.data.room.config.cols === 10, JSON.stringify(tall.res.data.room.config));
  const tallPlayer = await join(tall.code, 'Player');
  check('a 3x10 card is 30 cells', cardIndexes(tallPlayer.card).length === 30);

  const recommended = await newRoom('Host', { expectedPlayers: 500 });
  check('expectedPlayers recommends a board (6x8)', recommended.res.data.room.config.rows === 6 && recommended.res.data.room.config.cols === 8, JSON.stringify(recommended.res.data.room.config));
  const small = await newRoom('Host', { expectedPlayers: 8 });
  check('small groups get a cosy board (4x4)', small.res.data.room.config.rows === 4 && small.res.data.room.config.cols === 4, JSON.stringify(small.res.data.room.config));
  const odd = await newRoom('Host', { rows: 3, cols: 3 });
  check('odd x odd board keeps the free centre', odd.res.data.room.config.freeCentre === true);

  const badRows = await newRoom('Host', { rows: 2 });
  check('rows below the minimum are rejected', badRows.res.status === 400 && badRows.res.data.error === 'invalid_rows', `${badRows.res.status}`);
  const badCols = await newRoom('Host', { cols: 99 });
  check('columns above the maximum are rejected', badCols.res.status === 400 && badCols.res.data.error === 'invalid_cols', `${badCols.res.status}`);
  const badInterval = await newRoom('Host', { callIntervalMs: 777 });
  check('unsupported call intervals are rejected', badInterval.res.status === 400 && badInterval.res.data.error === 'invalid_interval', `${badInterval.res.status}`);
  const badExpected = await newRoom('Host', { expectedPlayers: 5000 });
  check('an impossible player expectation is rejected', badExpected.res.status === 400 && badExpected.res.data.error === 'invalid_expected_players', `${badExpected.res.status} ${badExpected.res.data?.error}`);
}

// -------------------------------------------------------- dynamic patterns ---

section('Winning patterns are generated from the board size');
{
  const wide = await newRoom('Host', { rows: 6, cols: 6, winPatterns: ['row:5', 'col:5'] });
  check('a 6x6 board accepts Row 6 and Column 6', wide.res.data.room.config.winPatterns.join() === 'row:5,col:5', JSON.stringify(wide.res.data.room.config.winPatterns));

  const small = await newRoom('Host', { rows: 3, cols: 3, winPatterns: ['row:5', 'col:5', 'row:0'] });
  check('patterns that cannot exist on a 3x3 are dropped', small.res.data.room.config.winPatterns.join() === 'row:0', JSON.stringify(small.res.data.room.config.winPatterns));

  const onlyImpossible = await newRoom('Host', { rows: 3, cols: 3, winPatterns: ['row:9', 'col:9'] });
  check('a set that leaves nothing playable is rejected outright', onlyImpossible.res.status === 400 && onlyImpossible.res.data.error === 'no_patterns', `${onlyImpossible.res.status} ${onlyImpossible.res.data?.error}`);

  const empty = await newRoom('Host', { winPatterns: [] });
  check('an empty pattern set is rejected', empty.res.status === 400 && empty.res.data.error === 'no_patterns', `${empty.res.status}`);
  const nonsense = await newRoom('Host', { rows: 3, cols: 3, winPatterns: ['row:99', 'nonsense'] });
  check('a pattern set with nothing usable is rejected', nonsense.res.status === 400 && nonsense.res.data.error === 'no_patterns', `${nonsense.res.status}`);

  const rows3 = await newRoom('Host', { rows: 3, cols: 3, winPatterns: ['row:0', 'row:1', 'row:2', 'col:0', 'col:1', 'col:2'] });
  check('rows 1/2/3 and columns 1/2/3 can be picked individually', rows3.res.data.room.config.winPatterns.length === 6);

  const x = await newRoom('Host', { rows: 5, cols: 5, winPatterns: ['diag:main', 'diag:anti'] });
  check('both diagonals can be the only winning pattern', x.res.data.room.config.winPatterns.join() === 'diag:main,diag:anti');

  // Changing the geometry re-derives the pattern list.
  const morph = await newRoom('Host', { rows: 5, cols: 5, winPatterns: ['row:4'] });
  const grown = await setConfig(morph.code, morph.hostToken, { rows: 6 });
  check('shrinking the board to 6 rows keeps Row 5', grown.data?.room?.config?.winPatterns.includes('row:4'), JSON.stringify(grown.data?.room?.config?.winPatterns));
  const shrunk = await setConfig(morph.code, morph.hostToken, { rows: 3 });
  check('shrinking to 3 rows re-derives patterns that still exist', shrunk.data?.room?.config?.winPatterns.length > 0 && !shrunk.data.room.config.winPatterns.includes('row:4'), JSON.stringify(shrunk.data?.room?.config?.winPatterns));
}

// -------------------------------------------------- interlinked config -----

section('Interlinked configuration');
{
  const single = await newRoom('Host', { winnerMode: 'single', maxWinners: 9 });
  const singleState = single.res.data.room;
  check('single winner mode forces exactly one slot', singleState.config.winnerMode === 'single' && singleState.config.maxWinners === 1 && singleState.winnerSlots === 1, JSON.stringify({ maxWinners: singleState.config.maxWinners, winnerSlots: singleState.winnerSlots }));
  check('single mode offers the compact winning condition, not the pattern grid',
    singleState.visibility.winningCondition === true && singleState.visibility.patternGrid === false && singleState.visibility.maxWinners === false,
    JSON.stringify(singleState.visibility));

  const multi = await newRoom('Host', { winnerMode: 'multiple', maxWinners: 3 });
  check('multiple mode keeps the configured slots', multi.res.data.room.winnerSlots === 3, String(multi.res.data.room.winnerSlots));
  check('multiple mode exposes the pattern grid instead',
    multi.res.data.room.visibility.patternGrid === true && multi.res.data.room.visibility.winningCondition === false && multi.res.data.room.visibility.maxWinners === true,
    JSON.stringify(multi.res.data.room.visibility));

  const unlimited = await newRoom('Host', { winnerMode: 'multiple', maxWinners: 0 });
  check('maxWinners 0 means unlimited', unlimited.res.data.room.winnerSlots === 0);

  const manualCall = await newRoom('Host', { callMode: 'manual' });
  check('a manual caller has no interval to configure', manualCall.res.data.room.visibility.callIntervalMs === false);
  const autoCall = await newRoom('Host', { callMode: 'auto' });
  check('an automatic caller exposes the interval', autoCall.res.data.room.visibility.callIntervalMs === true);

  const evenBoard = await newRoom('Host', { rows: 4, cols: 4 });
  check('an even board hides the free-centre option', evenBoard.res.data.room.visibility.freeCentre === false && evenBoard.res.data.room.config.freeCentre === false, JSON.stringify(evenBoard.res.data.room.visibility));
  const oddBoard = await newRoom('Host', { rows: 5, cols: 5 });
  check('an odd board offers a free centre', oddBoard.res.data.room.visibility.freeCentre === true);

  const custom = await newRoom('Host', { content: 'custom', rows: 3, cols: 4, customItems: Array.from({ length: 24 }, (_, i) => `Item ${i + 1}`) });
  check('custom content exposes the item list', custom.res.data.room?.visibility.customItems === true, `${custom.res.status} ${custom.res.data?.error}`);
  const numbers = await newRoom('Host', { content: 'numbers' });
  check('built-in numbers hide the item list', numbers.res.data.room.visibility.customItems === false);

  const manualDab = await newRoom('Host', { markMode: 'manual' });
  check('manual dabbing exposes the "you missed some" hint', manualDab.res.data.room.visibility.missedHint === true);
  const autoDab = await newRoom('Host', { markMode: 'auto' });
  check('auto dabbing hides it', autoDab.res.data.room.visibility.missedHint === false);

  const manualWinner = await newRoom('Host', { winnerCall: 'manual' });
  check('manual call-out shows the Bingo button', manualWinner.res.data.room.visibility.claimButton === true);
  const autoWinner = await newRoom('Host', { winnerCall: 'auto' });
  check('automatic call-out hides it', autoWinner.res.data.room.visibility.claimButton === false);
}

// ----------------------------------------------------- the host is admin ---

section('The host configures the game but never plays it');
{
  const room = await newRoom('Host', { callMode: 'manual' });
  const hostState = (await state(room.code, room.hostToken)).data;

  check('the host has no card', hostState.you === null, JSON.stringify(hostState.you));
  check('the host viewer is flagged as the admin', hostState.viewer.role === 'host' && hostState.viewer.isHost === true, JSON.stringify(hostState.viewer));

  const hostRoster = await api(`/api/room/${room.code}/players`);
  check('an empty table reports 0 joined players', hostRoster.data.total === 0 && hostRoster.data.players.length === 0, JSON.stringify(hostRoster.data));
  check('the host is not counted among the players', hostState.room.playerCount === 0, String(hostState.room.playerCount));

  const player = await join(room.code, 'Alice');
  const afterJoin = (await state(room.code, room.hostToken)).data;
  check('joining a player updates the live count', afterJoin.room.playerCount === 1 && afterJoin.you === null, String(afterJoin.room.playerCount));
  const rosterAfter = await api(`/api/room/${room.code}/players`);
  check('the roster lists only the player, never the host', rosterAfter.data.total === 1 && rosterAfter.data.players[0].name === 'Alice' && rosterAfter.data.players[0].isHost === undefined, JSON.stringify(rosterAfter.data.players));

  await startRound(room.code, room.hostToken);
  const hostMark = await dab(room.code, room.hostToken, 1);
  check('the host cannot dab', hostMark.status === 403 && hostMark.data.error === 'host_cannot_play', `${hostMark.status} ${hostMark.data?.error}`);
  const hostClaim = await claim(room.code, room.hostToken);
  check('the host cannot call Bingo', hostClaim.status === 403 && hostClaim.data.error === 'host_cannot_play', `${hostClaim.status} ${hostClaim.data?.error}`);

  const hostCall = await callNext(room.code, room.hostToken);
  check('the host can still call numbers', hostCall.status === 200 && hostCall.data.room.calledCount === 1, `${hostCall.status}`);
}

// ------------------------------------------------------- settings lock -----

section('Settings lock once the game starts');
{
  const room = await newRoom('Host', { rows: 5, cols: 5, callMode: 'manual' });

  const before = await setConfig(room.code, room.hostToken, { rows: 4, callIntervalMs: 12000, leaderboard: false });
  check('the host can configure the table in the lobby', before.status === 200 && before.data.room.config.rows === 4 && before.data.room.config.callIntervalMs === 12000 && before.data.room.config.leaderboard === false, `${before.status} ${JSON.stringify(before.data?.room?.config)}`);

  await startRound(room.code, room.hostToken);
  const after = await setConfig(room.code, room.hostToken, { rows: 6, cols: 6, callIntervalMs: 3000, leaderboard: true, content: 'names' });
  check('every setting is refused once the round has started', after.status === 409 && after.data.error === 'settings_locked', `${after.status} ${after.data?.error}`);
  const stillLocked = (await state(room.code, room.hostToken)).data;
  check('the configuration is untouched after the refused change', stillLocked.room.config.rows === 4 && stillLocked.room.config.leaderboard === false, JSON.stringify({ rows: stillLocked.room.config.rows, leaderboard: stillLocked.room.config.leaderboard }));

  const player = await join(room.code, 'Eve');
  const forbidden = await setConfig(room.code, player.token, { callIntervalMs: 3000 });
  check('a player can never change settings', forbidden.status === 403 && forbidden.data.error === 'host_only', `${forbidden.status}`);
}

// ------------------------------------------------------------- calling -----

section('Automatic calling');
{
  const room = await newRoom('Host', { callIntervalMs: 3000, markMode: 'auto' });
  const player = await join(room.code, 'Player');
  await startRound(room.code, room.hostToken);

  const first = await state(room.code, room.hostToken);
  check('a fresh round starts with an empty board', first.data.room.calledCount === 0 && first.data.room.called.length === 0);

  let live = null;
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const poll = await state(room.code, room.hostToken);
    if (poll.data.room.calledCount >= 2) {
      live = poll.data;
      break;
    }
  }
  check('numbers are called on the timer', live !== null, 'nothing called within 20s');

  if (live) {
    const called = live.room.called;
    const calledSet = new Set(called);
    check('called indexes are unique and in range', calledSet.size === called.length && called.every((n) => n >= 0 && n < 75), JSON.stringify(called));
    check('the countdown to the next call is exposed', typeof live.room.nextCallInMs === 'number' && live.room.nextCallInMs >= 0, String(live.room.nextCallInMs));

    const playerState = (await state(room.code, player.token)).data;
    check('auto dabbing marks every called card cell', playerState.you.markedCount === cardIndexes(playerState.you.card).filter((n) => calledSet.has(n)).length, `${playerState.you.markedCount}`);
    check('state never returns the roster (O(1) hot path)', live.players === undefined && live.room.players === undefined);
    check('the player count is tracked without a roster scan', live.room.playerCount === 1, String(live.room.playerCount));
  }
}

section('Manual calling');
{
  const room = await newRoom('Host', { callMode: 'manual', markMode: 'auto' });
  await startRound(room.code, room.hostToken);

  await sleep(3500);
  const idle = await state(room.code, room.hostToken);
  check('nothing is called while the host waits', idle.data.room.calledCount === 0, String(idle.data.room.calledCount));

  const next = await callNext(room.code, room.hostToken);
  check('the host can call the next item', next.status === 200 && next.data.room.calledCount === 1, `${next.status}`);

  const specific = await callIndex(room.code, room.hostToken, 42);
  check('the host can call a specific item', specific.status === 200 && specific.data.room.called.includes(42), `${specific.status}`);

  const repeat = await callIndex(room.code, room.hostToken, 42);
  check('calling the same item twice is rejected', repeat.status === 409 && repeat.data.error === 'already_called', `${repeat.status} ${repeat.data?.error}`);

  const outOfRange = await callIndex(room.code, room.hostToken, 900);
  check('calling out of range is rejected', outOfRange.status === 400 && outOfRange.data.error === 'invalid_item', `${outOfRange.status}`);

  const other = await join(room.code, 'NotHost');
  const byPlayer = await callNext(room.code, other.token);
  check('players cannot call numbers', byPlayer.status === 403, `${byPlayer.status}`);

  const autoRoom = await newRoom('Host', { callMode: 'auto' });
  await startRound(autoRoom.code, autoRoom.hostToken);
  const onAuto = await callNext(autoRoom.code, autoRoom.hostToken);
  check('manual calling is refused on an auto table', onAuto.status === 409 && onAuto.data.error === 'auto_call_enabled', `${onAuto.status} ${onAuto.data?.error}`);
}

section('Exhausting the pool');
{
  const room = await newRoom('Host', { rows: 3, cols: 3, callMode: 'manual', markMode: 'auto' });
  await startRound(room.code, room.hostToken);
  const total = room.res.data.room.config.poolSize;
  await callIndexes(room.code, room.hostToken, Array.from({ length: total }, (_, i) => i));
  const done = await state(room.code, room.hostToken);
  check('calling every item ends the round', done.data.room.status === 'finished' && done.data.room.endedReason === 'items_exhausted', `${done.data.room.status}/${done.data.room.endedReason}`);
  check('all items are recorded as called', done.data.room.calledCount === total, String(done.data.room.calledCount));
}

// ------------------------------------------------------------- marking -----

section('Dabbing (manual and auto)');
{
  const room = await newRoom('Host', { rows: 3, cols: 3, markMode: 'manual', callMode: 'manual' });
  const player = await join(room.code, 'Dabber');
  const card = await playRound(room.code, room.hostToken, [player.token], (cards) => cardIndexes(cards[0]).slice(0, 3));
  const onCard = cardIndexes(card[0]);
  const called = onCard.slice(0, 3);
  const fresh = await state(room.code, player.token);

  check('manual mode dabs nothing by itself', fresh.data.you.markedCount === 0, String(fresh.data.you.markedCount));
  check('called-but-undabbed cells are reported', fresh.data.you.missed === 3, String(fresh.data.you.missed));

  const didDab = await dab(room.code, player.token, called[0]);
  check('a player can dab a called cell', didDab.status === 200 && didDab.data.you.marked.includes(called[0]), `${didDab.status}`);
  const undab = await dab(room.code, player.token, called[0]);
  check('dabbing toggles', undab.status === 200 && undab.data.you.marked.length === 0);

  const notCalled = onCard.find((n) => !called.includes(n));
  const early = await dab(room.code, player.token, notCalled);
  check('dabbing an uncalled cell is rejected', early.status === 409 && early.data.error === 'not_called', `${early.status} ${early.data?.error}`);

  const foreign = Array.from({ length: room.res.data.room.config.poolSize }, (_, i) => i).find((n) => !onCard.includes(n));
  const wrong = await dab(room.code, player.token, foreign);
  check('dabbing something not on your card is rejected', wrong.status === 400 && wrong.data.error === 'not_on_card', `${wrong.status} ${wrong.data?.error}`);

  const autoRoom = await newRoom('Host', { markMode: 'auto', callMode: 'manual' });
  const autoPlayer = await join(autoRoom.code, 'AutoDabber');
  await startRound(autoRoom.code, autoRoom.hostToken);
  const manualOnAuto = await dab(autoRoom.code, autoPlayer.token, 1);
  check('manual dabbing is refused on an auto-dab table', manualOnAuto.status === 409 && manualOnAuto.data.error === 'auto_mark_enabled', `${manualOnAuto.status} ${manualOnAuto.data?.error}`);
  const autoState = await state(autoRoom.code, autoPlayer.token);
  check('the auto-dab table is live for its player', autoState.data.you !== null && autoState.data.room.playerCount === 1, String(autoState.data.room.playerCount));
}

// ------------------------------------------------------------ patterns -----

section('Pattern-based wins (rows / columns / diagonals / blackout)');
{
  const rowRoom = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winPatterns: ['row:0'] });
  const rowPlayer = await join(rowRoom.code, 'Winnr');
  await playRound(rowRoom.code, rowRoom.hostToken, [rowPlayer.token], (cards) => rowIndexes(cards[0], 0));
  const rowWin = await claim(rowRoom.code, rowPlayer.token);
  check('row 1 completes a win when row 1 is the pattern', rowWin.status === 200 && rowWin.data.room.winners.length === 1, `${rowWin.status} ${rowWin.data?.error}`);
  check('the winner name is recorded', rowWin.data?.room?.winners[0]?.name === 'Winnr', JSON.stringify(rowWin.data?.room?.winners?.[0]));
  check('the winning pattern is recorded', rowWin.data?.room?.winners[0]?.pattern === 'row:0', String(rowWin.data?.room?.winners?.[0]?.pattern));

  const missRoom = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winPatterns: ['row:0'] });
  const missPlayer = await join(missRoom.code, 'Missy');
  await playRound(missRoom.code, missRoom.hostToken, [missPlayer.token], (cards) => rowIndexes(cards[0], 1));
  const missWin = await claim(missRoom.code, missPlayer.token);
  check('a completed row that is not the pattern does not win', missWin.status === 409 && missWin.data.error === 'no_bingo', `${missWin.status} ${missWin.data?.error}`);

  const colRoom = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winPatterns: ['col:0', 'col:1'] });
  const colPlayer = await join(colRoom.code, 'Colly');
  await playRound(colRoom.code, colRoom.hostToken, [colPlayer.token], (cards) => colIndexes(cards[0], 1));
  const colWin = await claim(colRoom.code, colPlayer.token);
  check('column 2 completes a win when columns 1/2 are enabled', colWin.status === 200, `${colWin.status} ${colWin.data?.error}`);

  const colMiss = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winPatterns: ['col:0'] });
  const colMissPlayer = await join(colMiss.code, 'Colly');
  await playRound(colMiss.code, colMiss.hostToken, [colMissPlayer.token], (cards) => colIndexes(cards[0], 2));
  const colMissWin = await claim(colMiss.code, colMissPlayer.token);
  check('a completed column outside the enabled set does not win', colMissWin.status === 409 && colMissWin.data.error === 'no_bingo', `${colMissWin.status} ${colMissWin.data?.error}`);

  const diagRoom = await newRoom('Host', { rows: 5, cols: 5, markMode: 'auto', callMode: 'manual', winPatterns: ['diag:main'] });
  const diagPlayer = await join(diagRoom.code, 'Diag');
  await playRound(diagRoom.code, diagRoom.hostToken, [diagPlayer.token], (cards) => [0, 1, 2, 3, 4].map((i) => cards[0][i][i]).filter((n) => n !== null));
  const diagWin = await claim(diagRoom.code, diagPlayer.token);
  check('a completed diagonal wins when it is the pattern', diagWin.status === 200, `${diagWin.status} ${diagWin.data?.error}`);

  const antiRoom = await newRoom('Host', { rows: 5, cols: 5, markMode: 'auto', callMode: 'manual', winPatterns: ['diag:main'] });
  const antiPlayer = await join(antiRoom.code, 'Anti');
  await playRound(antiRoom.code, antiRoom.hostToken, [antiPlayer.token], (cards) => [0, 1, 2, 3, 4].map((i) => cards[0][i][4 - i]).filter((n) => n !== null));
  const antiWin = await claim(antiRoom.code, antiPlayer.token);
  check('the other diagonal does not win when only one is enabled', antiWin.status === 409, `${antiWin.status} ${antiWin.data?.error}`);

  const blackRoom = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winPatterns: ['blackout'] });
  const blackPlayer = await join(blackRoom.code, 'Black');
  const [blackCard] = await playRound(blackRoom.code, blackRoom.hostToken, [blackPlayer.token], (cards) => cardIndexes(cards[0]).slice(0, -1));
  const blackIndexes = cardIndexes(blackCard);
  const partial = await claim(blackRoom.code, blackPlayer.token);
  check('blackout is not won on a partial card', partial.status === 409 && partial.data.error === 'no_bingo', `${partial.status} ${partial.data?.error}`);
  await callIndex(blackRoom.code, blackRoom.hostToken, blackIndexes[blackIndexes.length - 1]);
  const full = await claim(blackRoom.code, blackPlayer.token);
  check('blackout wins once the whole card is called', full.status === 200, `${full.status} ${full.data?.error}`);
}

section('Large-board patterns stay honest');
{
  const room = await newRoom('Host', { rows: 6, cols: 8, markMode: 'auto', callMode: 'manual', winPatterns: ['blackout'] });
  const player = await join(room.code, 'Big');
  check('a 6x8 card has 48 dabbable cells', cardIndexes(player.card).length === 48);
  await playRound(room.code, room.hostToken, [player.token], (cards) => colIndexes(cards[0], 3));
  const after = await state(room.code, player.token);
  check('the only enabled pattern is a 48-cell blackout', after.data.you.best.total === 48, String(after.data.you.best.total));
  const noWin = await claim(room.code, player.token);
  check('filling one column is not a blackout', noWin.status === 409, `${noWin.status}`);
}

// -------------------------------------------------- winner call-out mode ---

section('Winner call-out: manual versus automatic');
{
  // Manual: the table waits for the player to shout Bingo.
  const manual = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winnerCall: 'manual', winPatterns: ['row:0'] });
  const manualPlayer = await join(manual.code, 'Shouter');
  await playRound(manual.code, manual.hostToken, [manualPlayer.token], (cards) => rowIndexes(cards[0], 0));
  const settled = await state(manual.code, manualPlayer.token);
  check('a manual table does not award the win on its own', settled.data.room.winners.length === 0 && settled.data.you.canClaim === true, JSON.stringify({ winners: settled.data.room.winners.length, canClaim: settled.data.you.canClaim }));
  const manualWin = await claim(manual.code, manualPlayer.token);
  check('the manual claim is accepted', manualWin.status === 200, `${manualWin.status} ${manualWin.data?.error}`);

  // Automatic: the table detects it and the claim button is refused.
  const auto = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winnerCall: 'auto', winPatterns: ['row:0'] });
  const autoPlayer = await join(auto.code, 'Watcher');
  await startRound(auto.code, auto.hostToken);

  const earlyClaim = await claim(auto.code, autoPlayer.token);
  check('claiming on an automatic table is refused', earlyClaim.status === 409 && earlyClaim.data.error === 'auto_winner_call', `${earlyClaim.status} ${earlyClaim.data?.error}`);
  const ready = await state(auto.code, autoPlayer.token);
  check('the Bingo button is hidden when the table calls it', ready.data.you.canClaim === false, String(ready.data.you.canClaim));

  const autoCard = ready.data.you.card;
  await callIndexes(auto.code, auto.hostToken, rowIndexes(autoCard, 0));
  const autoState = await state(auto.code, autoPlayer.token);
  check('an automatic table declares the winner without a claim', autoState.data.room.winners.length === 1, JSON.stringify(autoState.data.room.winners));
  check('the declared winner is the player who completed the pattern', autoState.data.room.winners[0]?.name === 'Watcher', JSON.stringify(autoState.data.room.winners[0]));
  check('the automatic table ends the round', autoState.data.room.status === 'finished', autoState.data.room.status);

  const lateClaim = await claim(auto.code, autoPlayer.token);
  check('a late claim on a finished automatic table is refused', lateClaim.status === 409, `${lateClaim.status} ${lateClaim.data?.error}`);
}

// ------------------------------------------------------------- winners -----

section('Single versus multiple winners');
{
  const single = await newRoom('SingleA', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winnerMode: 'single' });
  const a = await join(single.code, 'WinnerA');
  const b = await join(single.code, 'SingleB');
  await playRound(single.code, single.hostToken, [a.token, b.token], (cards) => distinct(cards.map((c) => rowIndexes(c, 0))));

  const firstWin = await claim(single.code, a.token);
  check('single mode accepts the first claim', firstWin.status === 200 && firstWin.data.room.winners.length === 1, `${firstWin.status} ${firstWin.data?.error}`);
  check('single mode ends the round immediately', firstWin.data.room.status === 'finished', firstWin.data.room.status);

  const steal = await claim(single.code, b.token);
  check('a second claimant cannot steal a single-winner round', steal.status === 409, `${steal.status} ${steal.data?.error}`);

  const reClaim = await claim(single.code, a.token);
  check('the same player cannot claim twice', reClaim.status === 409, `${reClaim.status} ${reClaim.data?.error}`);

  const multi = await newRoom('MultiA', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winnerMode: 'multiple', maxWinners: 3 });
  const mA = await join(multi.code, 'MultiOne');
  const mB = await join(multi.code, 'MultiB');
  const mC = await join(multi.code, 'MultiC');
  const mD = await join(multi.code, 'MultiD');
  await playRound(multi.code, multi.hostToken, [mA.token, mB.token, mC.token, mD.token], (cards) =>
    distinct(cards.map((card) => rowIndexes(card, 0)))
  );

  const w1 = await claim(multi.code, mA.token);
  check('multiple mode keeps playing after the first win', w1.status === 200 && w1.data.room.status === 'playing', `${w1.status} ${w1.data?.room?.status}`);
  const w2 = await claim(multi.code, mB.token);
  check('a second player can also win', w2.status === 200 && w2.data.room.winners.length === 2, `${w2.status}`);
  const w3 = await claim(multi.code, mC.token);
  check('the third win fills the round and closes it', w3.status === 200 && w3.data?.room?.winners?.length === 3 && w3.data.room.status === 'finished', `${w3.status} ${JSON.stringify(w3.data?.room?.winners)}`);
  if (w3.status === 200 && w3.data?.room?.winners) {
    check('winners are ranked in order', w3.data.room.winners.map((w) => w.rank).join() === '1,2,3', JSON.stringify(w3.data.room.winners.map((w) => w.rank)));
    check('all winner names are exposed for the results screen', w3.data.room.winners.every((w) => typeof w.name === 'string' && w.name.length > 0) && w3.data.room.winners.length === 3, JSON.stringify(w3.data.room.winners.map((w) => w.name)));
  } else {
    check('winners are ranked in order', false, 'no winners payload');
    check('all winner names are exposed for the results screen', false, 'no winners payload');
  }

  const w4 = await claim(multi.code, mD.token);
  check('a fourth claim is refused once slots are full', w4.status === 409, `${w4.status} ${w4.data?.error}`);

  const unlimited = await newRoom('AnyA', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winnerMode: 'multiple', maxWinners: 0 });
  const uB = await join(unlimited.code, 'AnyB');
  const uC = await join(unlimited.code, 'AnyC');
  await playRound(unlimited.code, unlimited.hostToken, [uB.token, uC.token], (cards) =>
    distinct(cards.map((card) => rowIndexes(card, 0)))
  );
  const uBWin = await claim(unlimited.code, uB.token);
  const uCWin = await claim(unlimited.code, uC.token);
  check('unlimited winners accepts every player who gets there', uBWin.status === 200 && uCWin.status === 200 && uCWin.data.room.winners.length === 2 && uCWin.data.room.status === 'playing', `${uBWin.status}/${uCWin.status} winners=${uCWin.data?.room?.winners?.length} ${uCWin.data?.room?.status}`);
}

section('Round lifecycle');
{
  const room = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual' });
  const player = await join(room.code, 'Guest');
  await startRound(room.code, room.hostToken);
  const r1 = await cardOf(room.code, player.token);

  const ended = await api(`/api/room/${room.code}/end`, { method: 'POST', body: {}, token: room.hostToken });
  check('the host can end a round early', ended.status === 200 && ended.data.room.status === 'finished' && ended.data.room.endedReason === 'host_ended', `${ended.data.room.endedReason}`);

  const restarted = await startRound(room.code, room.hostToken);
  check('a new round resets the board and winners', restarted.status === 200 && restarted.data.room.calledCount === 0 && restarted.data.room.winners.length === 0);
  const r2 = await cardOf(room.code, player.token);
  check('a new round deals a different card', JSON.stringify(r1) !== JSON.stringify(r2));
  check('a new round keeps existing seats', restarted.data.room.playerCount === 1, String(restarted.data.room.playerCount));
}

// --------------------------------------------------------------- roster ---

section('Joined players');
{
  const room = await newRoom('Host');
  const first = await api(`/api/room/${room.code}/players`);
  check('the roster is available to anyone at the table', first.status === 200 && first.data.total === 0, JSON.stringify(first.data));

  const second = await join(room.code, 'Second');
  const again = await api(`/api/room/${room.code}/players?since=${first.data.version}`);
  check('the roster reports a change when players join', again.data.changed === true && again.data.total === 1, JSON.stringify(again.data));
  check('the joined player is listed with their avatar', again.data.players[0].name === 'Second' && typeof again.data.players[0].avatar === 'string', JSON.stringify(again.data.players[0]));
  check('online state is reported', again.data.players[0].online === true, JSON.stringify(again.data.players[0]));

  const unchanged = await api(`/api/room/${room.code}/players?since=${again.data.version}`);
  check('an unchanged roster is a tiny response', unchanged.data.changed === false && unchanged.size < 80, `${unchanged.size} bytes`);

  const third = await join(room.code, 'Third');
  const live = await state(room.code, third.token);
  check('the live player count updates', live.data.room.playerCount === 2, String(live.data.room.playerCount));

  const left = await api(`/api/room/${room.code}/leave`, { method: 'POST', body: {}, token: third.token });
  check('a player can leave', left.status === 200, `${left.status}`);
  const afterLeave = await api(`/api/room/${room.code}/players`);
  check('leaving frees the seat', afterLeave.data.total === 1, String(afterLeave.data.total));

  const stale = await state(room.code, third.token);
  check('a removed seat can no longer read their own state', stale.data.you === null, JSON.stringify(stale.data?.you));
  check('the player who left is no longer counted', (await state(room.code, room.hostToken)).data.room.playerCount === 1, 'count stale');
}

// ---------------------------------------------------------- leaderboard ---

section('Leaderboard (by possible wins)');
{
  const room = await newRoom('TopA', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual' });
  const leader = await join(room.code, 'TopLeader');
  const second = await join(room.code, 'Top2');
  await join(room.code, 'Top3');

  await playRound(room.code, room.hostToken, [leader.token], (cards) => rowIndexes(cards[0], 0));
  const lb = await api(`/api/room/${room.code}/leaderboard`, { token: leader.token });
  check('the leaderboard is served when enabled', lb.status === 200 && lb.data.entries.length === 3, `${lb.status} entries=${lb.data?.entries?.length}`);
  check('entries carry a rank and a possible-wins count', lb.data.entries.every((e) => e.rank >= 1 && typeof e.won === 'number' && typeof e.bestDone === 'number'), JSON.stringify(lb.data.entries[0]));
  check('the requester is flagged on their own row', lb.data.entries.some((e) => e.isYou));
  check('the requester gets their own standing', lb.data.you && lb.data.you.rank >= 1, JSON.stringify(lb.data.you));
  check('the player with a completed line leads', lb.data.entries[0].won >= 1, JSON.stringify(lb.data.entries.map((e) => [e.name, e.won])));

  const total = room.res.data.room.config.poolSize;
  await callIndexes(room.code, room.hostToken, Array.from({ length: total }, (_, i) => i));
  const lb2 = await api(`/api/room/${room.code}/leaderboard`, { token: second.token });
  check('a fully called pool shows everyone at maximum possible wins', lb2.data.entries.every((e) => e.won === lb2.data.patternsTotal), JSON.stringify(lb2.data.entries.map((e) => e.won)));
  check('ranks are a contiguous ordering', lb2.data.entries.map((e) => e.rank).sort((a, b) => a - b).join() === '1,2,3', JSON.stringify(lb2.data.entries.map((e) => e.rank)));

  const offline = await newRoom('Quiet', { leaderboard: false });
  const blocked = await api(`/api/room/${offline.code}/leaderboard`, { token: offline.hostToken });
  check('a disabled leaderboard is refused', blocked.status === 403 && blocked.data.error === 'leaderboard_disabled', `${blocked.status}`);
}

// -------------------------------------------------------- content pools ---

section('Content types: names, images, music, mixed and custom');
{
  const showPool = async (config, label) => {
    const room = await newRoom('Host', config);
    const pool = await api(`/api/room/${room.code}/pool`, { token: room.hostToken });
    return { room, pool, label };
  };

  const names = await showPool({ content: 'names', rows: 5, cols: 5 }, 'names');
  check('names bingo serves a label pool', names.pool.status === 200 && names.pool.data.changed === true && names.pool.data.items.length === names.room.res.data.room.config.poolSize, `${names.pool.status} ${names.pool.data?.items?.length}`);
  check('every name is a plain label', names.pool.data.items.every((i) => typeof i.label === 'string' && i.label.length > 0), JSON.stringify(names.pool.data.items.slice(0, 3)));
  const namesPlayer = await join(names.room.code, 'Readr');
  check('a names table still deals index-based cards', namesPlayer.card.flat().every((n) => n === null || (Number.isInteger(n) && n < names.pool.data.items.length)), JSON.stringify(namesPlayer.card));

  const images = await showPool({ content: 'images', rows: 5, cols: 5 }, 'images');
  check('images bingo serves emoji cells', images.pool.data.items.every((i) => i.label.length > 0 && !/^\d+$/.test(i.label)), JSON.stringify(images.pool.data.items.slice(0, 3)));

  const music = await showPool({ content: 'music', rows: 5, cols: 5 }, 'music');
  check('music bingo serves song titles', music.pool.data.items.some((i) => i.label.includes(' ')), JSON.stringify(music.pool.data.items.slice(0, 3)));

  const mixed = await showPool({ content: 'mixed', rows: 5, cols: 5 }, 'mixed');
  check('mixed bingo pairs a name with an image', mixed.pool.data.items.every((i) => i.label && i.media), JSON.stringify(mixed.pool.data.items.slice(0, 3)));

  const customItems = Array.from({ length: 30 }, (_, i) => ({ label: `Custom ${i + 1}`, media: `https://example.com/${i + 1}.png` }));
  const custom = await showPool({ content: 'custom', rows: 3, cols: 5, customItems }, 'custom');
  check('custom bingo uses the host list verbatim', custom.pool.data.items.every((i) => i.label.startsWith('Custom')), JSON.stringify(custom.pool.data.items.slice(0, 3)));
  check('custom items keep their image links', custom.pool.data.items.every((i) => i.media.startsWith('https://')), JSON.stringify(custom.pool.data.items[0]));
  const customPlayer = await join(custom.room.code, 'Cust');
  check('a custom table can be played', customPlayer.card.length === 3 && customPlayer.card[0].length === 5, JSON.stringify(customPlayer.card));

  const tooSmall = await newRoom('Host', { content: 'custom', rows: 5, cols: 5, customItems: ['One', 'Two'] });
  check('a custom list too small for the board is rejected', tooSmall.res.status === 400 && tooSmall.res.data.error === 'pool_too_small', `${tooSmall.res.status} ${tooSmall.res.data?.error}`);

  // Switching content regenerates the pool and bumps its version.
  const morph = await newRoom('Host', { content: 'numbers', rows: 5, cols: 5 });
  const before = await api(`/api/room/${morph.code}/pool`, { token: morph.hostToken });
  const switched = await setConfig(morph.code, morph.hostToken, { content: 'images' });
  check('switching content is accepted in the lobby', switched.status === 200 && switched.data.room.config.content === 'images', `${switched.status}`);
  const after = await api(`/api/room/${morph.code}/pool?since=${before.data.version}`, { token: morph.hostToken });
  check('the client is told the pool changed', after.data.changed === true && after.data.version !== before.data.version, JSON.stringify({ before: before.data.version, after: after.data.version }));

  const repeat = await api(`/api/room/${morph.code}/pool?since=${after.data.version}`, { token: morph.hostToken });
  check('an unchanged pool is a tiny response', repeat.data.changed === false && repeat.size < 80, `${repeat.size} bytes`);

  const badContent = await newRoom('Host', { content: 'videos' });
  check('an unknown content type is rejected', badContent.res.status === 400 && badContent.res.data.error === 'invalid_content', `${badContent.res.status} ${badContent.res.data?.error}`);

  // A non-numeric table still wins by pattern.
  const nameRoom = await newRoom('Host', { content: 'names', rows: 3, cols: 3, markMode: 'auto', callMode: 'manual', winPatterns: ['row:0'] });
  const namePlayer = await join(nameRoom.code, 'NameFan');
  await playRound(nameRoom.code, nameRoom.hostToken, [namePlayer.token], (cards) => rowIndexes(cards[0], 0));
  const nameWin = await claim(nameRoom.code, namePlayer.token);
  check('a names table wins exactly like a numbers table', nameWin.status === 200 && nameWin.data.room.winners[0]?.pattern === 'row:0', `${nameWin.status} ${nameWin.data?.error}`);
}

// ----------------------------------------------------------------- chat ---

section('Table chat (max 20 words)');
{
  const room = await newRoom('Host');
  const alice = await join(room.code, 'Alice');
  const bob = await join(room.code, 'Bob');

  const short = await api(`/api/room/${room.code}/chat`, { method: 'POST', body: { body: 'Good luck everyone' }, token: alice.token });
  check('a short message is accepted', short.status === 200 && short.data.ok === true, `${short.status} ${short.data?.error}`);

  const twenty = await api(`/api/room/${room.code}/chat`, { method: 'POST', body: { body: Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ') }, token: alice.token });
  check('exactly 20 words is accepted', twenty.status === 200, `${twenty.status} ${twenty.data?.error}`);

  const twentyOne = await api(`/api/room/${room.code}/chat`, { method: 'POST', body: { body: Array.from({ length: 21 }, (_, i) => `w${i}`).join(' ') }, token: alice.token });
  check('21 words is rejected', twentyOne.status === 400 && twentyOne.data.error === 'too_many_words', `${twentyOne.status} ${twentyOne.data?.error}`);

  const empty = await api(`/api/room/${room.code}/chat`, { method: 'POST', body: { body: '   ' }, token: alice.token });
  check('an empty message is rejected', empty.status === 400 && empty.data.error === 'empty_message', `${empty.status}`);

  const fromBob = await api(`/api/room/${room.code}/chat?since=0`, { token: bob.token });
  check('another player sees the messages', fromBob.status === 200 && fromBob.data.messages.some((m) => m.body === 'Good luck everyone'), JSON.stringify(fromBob.data?.messages));
  check('messages carry the sender name and avatar', fromBob.data.messages.every((m) => typeof m.name === 'string' && typeof m.avatar === 'string'), JSON.stringify(fromBob.data.messages[0]));

  const hostRead = await api(`/api/room/${room.code}/chat?since=0`, { token: room.hostToken });
  check('the host reads chat too', hostRead.status === 200 && hostRead.data.messages.length >= 2, String(hostRead.data.messages?.length));

  const scroll = await api(`/api/room/${room.code}/chat?since=${fromBob.data.cursor}`);
  check('a caught-up reader gets nothing new', scroll.data.messages.length === 0, String(scroll.data.messages?.length));

  const off = await newRoom('Host', { chat: false });
  const offPlayer = await join(off.code, 'Quiet');
  const postOff = await api(`/api/room/${off.code}/chat`, { method: 'POST', body: { body: 'hello' }, token: offPlayer.token });
  check('posting to a chat-less table is refused', postOff.status === 403 && postOff.data.error === 'chat_disabled', `${postOff.status} ${postOff.data?.error}`);
  const readOff = await api(`/api/room/${off.code}/chat?since=0`, { token: offPlayer.token });
  check('a disabled chat reports itself as disabled', readOff.data.enabled === false, JSON.stringify(readOff.data));

  const hostPost = await api(`/api/room/${room.code}/chat`, { method: 'POST', body: { body: 'hello from the host' }, token: room.hostToken });
  check('the host can talk to the room', hostPost.status === 200, `${hostPost.status} ${hostPost.data?.error}`);
}

// ------------------------------------------------------------ reactions ---

section('Emoji reactions between players');
{
  const room = await newRoom('Host');
  const alice = await join(room.code, 'Alice');
  const bob = await join(room.code, 'Bob');

  const noTarget = await api(`/api/room/${room.code}/react`, { method: 'POST', body: { emoji: '🎉' }, token: alice.token });
  check('a reaction needs a target', noTarget.status === 404 && noTarget.data.error === 'unknown_player', `${noTarget.status} ${noTarget.data?.error}`);

  const hostTarget = await api(`/api/room/${room.code}/react`, { method: 'POST', body: { to: 'host', emoji: '🎉' }, token: alice.token });
  check('you cannot throw an emoji at the host', hostTarget.status === 404 && hostTarget.data.error === 'unknown_player', `${hostTarget.status} ${hostTarget.data?.error}`);

  const badEmoji = await api(`/api/room/${room.code}/react`, { method: 'POST', body: { to: bob.token, emoji: '💣' }, token: alice.token });
  check('only the offered emoji are accepted', badEmoji.status === 400 && badEmoji.data.error === 'invalid_emoji', `${badEmoji.status} ${badEmoji.data?.error}`);

  // Targets are player ids taken from the roster — a token is never accepted.
  const roster = await api(`/api/room/${room.code}/players`);
  const aliceId = roster.data.players.find((p) => p.name === 'Alice')?.id;
  const bobId = roster.data.players.find((p) => p.name === 'Bob')?.id;
  const ok = await api(`/api/room/${room.code}/react`, { method: 'POST', body: { to: bobId, emoji: '🎉' }, token: alice.token });
  check('a reaction to another player is accepted', ok.status === 200 && ok.data.ok === true, `${ok.status} ${ok.data?.error}`);

  const seenByThird = await api(`/api/room/${room.code}/reactions?since=0`, { token: room.hostToken });
  const hit = seenByThird.data.reactions?.[0];
  check('everyone can see the reaction', seenByThird.status === 200 && seenByThird.data.reactions.length === 1, `${seenByThird.status} ${seenByThird.data?.reactions?.length}`);
  check('the reaction says who sent it to whom', hit && hit.fromName === 'Alice' && hit.toName === 'Bob' && hit.emoji === '🎉', JSON.stringify(hit));
  check('the reaction carries both ids for the flight animation', hit && hit.fromId === aliceId && hit.toId === bobId, JSON.stringify(hit));

  const scroll = await api(`/api/room/${room.code}/reactions?since=${seenByThird.data.cursor}`);
  check('a caught-up reader gets no repeats', scroll.data.reactions.length === 0, String(scroll.data.reactions?.length));

  const off = await newRoom('Host', { reactions: false });
  const quiet = await join(off.code, 'Quiet');
  const offRoster = await api(`/api/room/${off.code}/players`);
  const postOff = await api(`/api/room/${off.code}/react`, { method: 'POST', body: { to: offRoster.data.players[0].id, emoji: '🎉' }, token: quiet.token });
  check('reactions can be switched off by the host', postOff.status === 403 && postOff.data.error === 'reactions_disabled', `${postOff.status} ${postOff.data?.error}`);
}

// ------------------------------------------------ expected vs actual ------

section('Expected players never block the host');
{
  const room = await newRoom('Host', { rows: 5, cols: 5, expectedPlayers: 200, callMode: 'manual' });
  check('the expectation is stored', room.res.data.room.config.expectedPlayers === 200, String(room.res.data.room.config.expectedPlayers));

  const solo = await startRound(room.code, room.hostToken);
  check('the host can start alone, with nobody joined', solo.status === 200 && solo.data.room.status === 'playing' && solo.data.room.playerCount === 0, `${solo.status} ${solo.data.room?.status}/${solo.data.room?.playerCount}`);
  const soloState = await state(room.code, room.hostToken);
  check('an empty table still shows the expectation to the room', soloState.data.room.config.expectedPlayers === 200, String(soloState.data.room.config.expectedPlayers));

  await join(room.code, 'EarlyBird');
  const roster = await api(`/api/room/${room.code}/players`);
  check('joined count and expectation are both exposed', roster.data.total === 1 && roster.data.expected === 200, JSON.stringify({ total: roster.data.total, expected: roster.data.expected }));

  const under = await newRoom('Host', { rows: 3, cols: 3, expectedPlayers: 50, callMode: 'manual' });
  await join(under.code, 'OnlyMe');
  const started = await startRound(under.code, under.hostToken);
  check('starting with far fewer players than expected is allowed', started.status === 200 && started.data.room.playerCount === 1, `${started.status} ${started.data.room?.playerCount}`);
}

// ------------------------------------------------- incremental payload ----

section('Incremental call payload');
{
  const room = await newRoom('Host', { rows: 3, cols: 3, markMode: 'auto', callMode: 'manual' });
  const player = await join(room.code, 'Catcher');
  await startRound(room.code, room.hostToken);
  const card = await cardOf(room.code, player.token);
  const indexes = cardIndexes(card).slice(0, 6);
  await callIndexes(room.code, room.hostToken, indexes);

  const full = await state(room.code, player.token);
  check('a client without a cursor gets the whole call list', Array.isArray(full.data.room.called) && full.data.room.called.length === 6 && full.data.room.calledTail === null, JSON.stringify(full.data.room.called));

  const tail = await state(room.code, player.token, 4);
  check('a caught-up client only receives the new items', tail.data.room.called === null && tail.data.room.calledTail.length === 2 && tail.data.room.calledTail[0] === indexes[4], JSON.stringify(tail.data.room.calledTail));
  check('the incremental payload is smaller than the full one', tail.size < full.size, `${tail.size} vs ${full.size}`);

  const zero = await state(room.code, player.token, 6);
  check('an already-caught-up client gets an empty tail', Array.isArray(zero.data.room.calledTail) && zero.data.room.calledTail.length === 0);

  const ahead = await state(room.code, player.token, 99);
  check('an out-of-range cursor falls back to the full list', Array.isArray(ahead.data.room.called) && ahead.data.room.called.length === 6, JSON.stringify(ahead.data.room.called));
}

// ---------------------------------------------------------------- scale ---

if (withScale) {
  section(`Scale: one table with ${SCALE_PLAYERS} players`);
  const room = await newRoom('ScaleHost', {
    rows: 6,
    cols: 8,
    markMode: 'auto',
    callMode: 'manual',
    leaderboard: true,
    expectedPlayers: SCALE_PLAYERS,
  });
  check('the scale table uses a large board', room.res.data.room.config.rows === 6 && room.res.data.room.config.cols === 8, JSON.stringify(room.res.data.room.config));

  const tokens = [];
  const joinStart = Date.now();
  for (let i = 1; i < SCALE_PLAYERS; i += 1) {
    const res = await api(`/api/room/${room.code}/join`, { method: 'POST', body: { name: `P${i}` } });
    if (res.data && res.data.token) tokens.push(res.data.token);
  }
  const joinMs = Date.now() - joinStart;
  const rosterRes = await api(`/api/room/${room.code}/players`);
  check(`${SCALE_PLAYERS - 1} players joined`, rosterRes.data.total === SCALE_PLAYERS - 1, String(rosterRes.data.total));
  console.log(`    \u00b7 ${SCALE_PLAYERS - 1} joins in ${(joinMs / 1000).toFixed(1)}s (${(joinMs / SCALE_PLAYERS).toFixed(1)}ms each)`);
  console.log(`    \u00b7 roster payload ${(rosterRes.size / 1024).toFixed(1)} KB`);

  const startMs = Date.now();
  await startRound(room.code, room.hostToken);
  check('starting a 500-seat round is O(1)', Date.now() - startMs < 800, `${Date.now() - startMs}ms`);

  for (let i = 0; i < 8; i += 1) await callNext(room.code, room.hostToken);

  const latencies = [];
  let maxPayload = 0;
  for (let i = 0; i < 60; i += 1) {
    const token = tokens[i % tokens.length];
    const t0 = Date.now();
    const res = await state(room.code, token, 8);
    latencies.push(Date.now() - t0);
    maxPayload = Math.max(maxPayload, res.size);
    if (i === 0) check('a seat still sees its own card at scale', Array.isArray(res.data.you.card) && res.data.you.card.length === 6);
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  console.log(`    \u00b7 /state with ${SCALE_PLAYERS} players: p50 ${p50}ms, p95 ${p95}ms, worst payload ${maxPayload} B`);
  check('state latency stays low at scale (p95 < 300ms)', p95 < 300, `p95 ${p95}ms`);
  check('state payload is independent of table size (< 2 KB)', maxPayload < 2048, `${maxPayload} B`);

  const lbStart = Date.now();
  const lb = await api(`/api/room/${room.code}/leaderboard?limit=50`, { token: room.hostToken });
  const lbMs = Date.now() - lbStart;
  check('the leaderboard is computed across the table', lb.status === 200 && lb.data.total === SCALE_PLAYERS - 1, `${lb.status} total=${lb.data?.total}`);
  check('the leaderboard is paginated rather than dumping everyone', lb.data.entries.length === 50, String(lb.data.entries?.length));
  const lbWarm = Date.now();
  await api(`/api/room/${room.code}/leaderboard?limit=50`, { token: tokens[1] });
  console.log(`    \u00b7 leaderboard over ${SCALE_PLAYERS} players: ${lbMs}ms cold, ${Date.now() - lbWarm}ms warm`);

  const claimStart = Date.now();
  const winState = await claim(room.code, tokens[0]);
  console.log(`    \u00b7 claim with ${SCALE_PLAYERS} seats: ${Date.now() - claimStart}ms (status ${winState.status})`);
  check('a claim is handled in constant time at scale', Date.now() - claimStart < 1000, `${Date.now() - claimStart}ms`);
}

console.log(`\n${passed} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
