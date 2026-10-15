// Multiplayer bingo tables — Cloudflare Worker API + static asset host.
//
// Roles: the host is an ADMINISTRATOR, not a player. It holds a host seat for
// authentication but is dealt no card and cannot win. Players join separately.
//
// Scale notes (targets 4 to 500 players at one table):
//   * Cards are DERIVED, never stored (see public/game.js), so dealing a round
//     costs the same for 4 players or 500 — no per-player writes at all.
//   * GET /state is O(1) in player count: one room read, one seat read, and no
//     roster scan. Numbers the client already has are not resent.
//   * The call clock is advanced by pollers, writes only when a draw is due,
//     and uses a compare-and-swap so racing pollers cannot draw twice.
//   * Automatic winner call-out evaluates only when the called set changes,
//     which is why it stays cheap: it never scans players per dab.
//   * Roster, leaderboard, item pool, chat and reactions are separate
//     endpoints, each with its own cursor and throttling.

import {
  AVATAR_CHOICES,
  REACTION_EMOJIS,
  bestProgress,
  cardCells,
  cardIndexSet,
  columnLabels,
  completedPatterns,
  defaultConfig,
  deriveCard,
  fieldVisibility,
  generateDrawOrder,
  missedCount,
  normalizeConfig,
  randomAvatar,
  recommendBoard,
  winnerLimit,
} from '../public/game.js';

const SCHEMA_VERSION = 3;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous characters
const CODE_LENGTH = 5;

const MAX_PLAYERS = 500;
const MAX_NAME_LENGTH = 18;
const ONLINE_WINDOW_MS = 25000;
const LAST_SEEN_WRITE_MS = 15000;

const MAX_CATCHUP_DRAWS = 50;
const LEADERBOARD_TTL_MS = 2000;
const LEADERBOARD_MAX_ROWS = 200;
const LEADERBOARD_PAGE = 50;

const CHAT_MAX_WORDS = 20;
const CHAT_MAX_CHARS = 200;
const CHAT_PAGE = 60;
const CHAT_RETENTION_MS = 10 * 60 * 1000;
const REACTION_PAGE = 40;
const PRUNE_CHANCE = 0.1;

/** Hot-path column list — deliberately excludes `items` (the biggest column). */
const ROOM_COLUMNS = `id, code, host_player_id, host_name, status, round, seed, rows, cols, content,
  per_column, pool_size, pool_version, free_centre, call_mode, call_interval_ms, mark_mode,
  winner_mode, max_winners, win_patterns, winner_call, leaderboard, chat, reactions,
  expected_players, draw_order, called, called_count, last_call_at, player_count, winner_count,
  roster_version, ended_reason, created_at, updated_at`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }
      return await env.ASSETS.fetch(request);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return json({ error: 'server_error', message }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;

  // Pre-launch safety: an older development database has a different shape and
  // CREATE TABLE IF NOT EXISTS would leave it half-migrated. There is no data
  // to preserve yet, so rebuild it. Replace with a real migration before the
  // app holds live data.
  const roomsTable = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'"
  ).first();
  if (roomsTable) {
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info('rooms')").all();
    const names = new Set((info.results || []).map((row) => row.name));
    const current =
      names.has('content') &&
      names.has('items') &&
      names.has('winner_call') &&
      names.has('pool_version') &&
      names.has('player_count') &&
      names.has('winner_count');
    const playersInfo = await env.DB.prepare("SELECT name FROM pragma_table_info('players')").all();
    const playerHasRole = (playersInfo.results || []).some((row) => row.name === 'role');
    if (!current || !playerHasRole) {
      await env.DB.batch([
        env.DB.prepare('DROP TABLE IF EXISTS reactions'),
        env.DB.prepare('DROP TABLE IF EXISTS messages'),
        env.DB.prepare('DROP TABLE IF EXISTS winners'),
        env.DB.prepare('DROP TABLE IF EXISTS players'),
        env.DB.prepare('DROP TABLE IF EXISTS rooms'),
      ]);
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS rooms (
         id TEXT PRIMARY KEY,
         code TEXT UNIQUE NOT NULL,
         host_player_id TEXT,
         host_name TEXT NOT NULL DEFAULT 'Host',
         status TEXT NOT NULL DEFAULT 'lobby',
         round INTEGER NOT NULL DEFAULT 0,
         seed TEXT NOT NULL,
         rows INTEGER NOT NULL DEFAULT 5,
         cols INTEGER NOT NULL DEFAULT 5,
         content TEXT NOT NULL DEFAULT 'numbers',
         items TEXT NOT NULL DEFAULT '[]',
         per_column INTEGER NOT NULL DEFAULT 15,
         pool_size INTEGER NOT NULL DEFAULT 75,
         pool_version INTEGER NOT NULL DEFAULT 1,
         free_centre INTEGER NOT NULL DEFAULT 1,
         call_mode TEXT NOT NULL DEFAULT 'auto',
         call_interval_ms INTEGER NOT NULL DEFAULT 5000,
         mark_mode TEXT NOT NULL DEFAULT 'manual',
         winner_mode TEXT NOT NULL DEFAULT 'single',
         max_winners INTEGER NOT NULL DEFAULT 1,
         win_patterns TEXT NOT NULL,
         winner_call TEXT NOT NULL DEFAULT 'manual',
         leaderboard INTEGER NOT NULL DEFAULT 1,
         chat INTEGER NOT NULL DEFAULT 1,
         reactions INTEGER NOT NULL DEFAULT 1,
         expected_players INTEGER NOT NULL DEFAULT 0,
         draw_order TEXT NOT NULL,
         called TEXT NOT NULL DEFAULT '[]',
         called_count INTEGER NOT NULL DEFAULT 0,
         last_call_at INTEGER,
         player_count INTEGER NOT NULL DEFAULT 0,
         winner_count INTEGER NOT NULL DEFAULT 0,
         roster_version INTEGER NOT NULL DEFAULT 0,
         ended_reason TEXT,
         created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS players (
         id TEXT PRIMARY KEY,
         room_id TEXT NOT NULL,
         role TEXT NOT NULL DEFAULT 'player',
         name TEXT NOT NULL,
         avatar TEXT NOT NULL DEFAULT '',
         token TEXT UNIQUE NOT NULL,
         marked TEXT NOT NULL DEFAULT '[]',
         marked_round INTEGER NOT NULL DEFAULT -1,
         joined_at INTEGER NOT NULL,
         last_seen INTEGER NOT NULL
       )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS winners (
         id TEXT PRIMARY KEY,
         room_id TEXT NOT NULL,
         round INTEGER NOT NULL,
         player_id TEXT NOT NULL,
         name TEXT NOT NULL,
         pattern TEXT,
         called_count INTEGER NOT NULL,
         at INTEGER NOT NULL
       )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS messages (
         id TEXT PRIMARY KEY,
         room_id TEXT NOT NULL,
         player_id TEXT NOT NULL,
         name TEXT NOT NULL,
         avatar TEXT NOT NULL DEFAULT '',
         body TEXT NOT NULL,
         at INTEGER NOT NULL
       )`
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS reactions (
         id TEXT PRIMARY KEY,
         room_id TEXT NOT NULL,
         from_id TEXT NOT NULL,
         from_name TEXT NOT NULL,
         to_id TEXT NOT NULL,
         to_name TEXT NOT NULL,
         emoji TEXT NOT NULL,
         at INTEGER NOT NULL
       )`
    ),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_players_room ON players(room_id, role, joined_at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_winners_room_round ON winners(room_id, round, at)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_reactions_room ON reactions(room_id)'),
  ]);

  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleApi(request, env, url) {
  await ensureSchema(env);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (parts[1] === 'health') return json({ ok: true, service: 'bingo-tables', schema: SCHEMA_VERSION });
  if (parts[1] !== 'room') return json({ error: 'not_found' }, 404);

  const token = request.headers.get('x-player-token') || url.searchParams.get('token');

  if (parts.length === 2) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return createRoom(request, env);
  }

  const code = normalizeCode(parts[2]);
  if (!code) return json({ error: 'invalid_code' }, 400);
  if (parts.length !== 4) return json({ error: 'not_found' }, 404);

  const action = parts[3];

  if (request.method === 'GET') {
    switch (action) {
      case 'state': {
        const room = await getRoom(env, code);
        if (!room) return json({ error: 'room_not_found' }, 404);
        return json(await buildState(env, code, token, url.searchParams.get('since')));
      }
      case 'players':
        return listPlayers(env, code, url.searchParams.get('since'));
      case 'leaderboard':
        return getLeaderboard(env, code, token, url.searchParams.get('limit'), url.searchParams.get('offset'));
      case 'pool':
        return getPool(env, code, url.searchParams.get('since'));
      case 'chat':
        return getChat(env, code, url.searchParams.get('since'));
      case 'reactions':
        return getReactions(env, code, url.searchParams.get('since'));
      default:
        return json({ error: 'not_found' }, 404);
    }
  }

  if (request.method !== 'POST') return json({ error: 'not_found' }, 404);

  switch (action) {
    case 'join':
      return joinRoom(request, env, code, token);
    case 'config':
      return updateConfig(request, env, code, token);
    case 'start':
      return startRound(request, env, code, token);
    case 'call':
      return callItem(request, env, code, token);
    case 'mark':
      return markItem(request, env, code, token);
    case 'bingo':
      return claimBingo(request, env, code, token);
    case 'end':
      return endRound(request, env, code, token);
    case 'leave':
      return leaveRoom(request, env, code, token);
    case 'chat':
      return postChat(request, env, code, token);
    case 'react':
      return postReaction(request, env, code, token);
    default:
      return json({ error: 'not_found' }, 404);
  }
}

// ---------------------------------------------------------------------------
// Room config
// ---------------------------------------------------------------------------

function roomConfig(row) {
  return {
    rows: row.rows,
    cols: row.cols,
    content: row.content,
    freeCentre: row.free_centre === 1,
    callMode: row.call_mode,
    callIntervalMs: row.call_interval_ms,
    markMode: row.mark_mode,
    winnerMode: row.winner_mode,
    maxWinners: row.max_winners,
    winPatterns: JSON.parse(row.win_patterns),
    winnerCall: row.winner_call,
    leaderboard: row.leaderboard === 1,
    chat: row.chat === 1,
    reactions: row.reactions === 1,
    expectedPlayers: row.expected_players,
    perColumn: row.per_column,
    poolSize: row.pool_size,
  };
}

// ---------------------------------------------------------------------------
// Handlers: host
// ---------------------------------------------------------------------------

async function createRoom(request, env) {
  const raw = await readJson(request);
  const now = Date.now();

  // "I expect 200 people" is advisory only — it never gates starting a game.
  if (raw.expectedPlayers !== undefined && raw.rows === undefined && raw.cols === undefined) {
    const rec = recommendBoard(Number(raw.expectedPlayers));
    raw.rows = rec.rows;
    raw.cols = rec.cols;
  }

  const base = defaultConfig();
  if (raw.expectedPlayers !== undefined) base.expectedPlayers = Number(raw.expectedPlayers) || 0;
  const built = normalizeConfig(raw, base);
  if (built.error) return json({ error: built.error, message: built.message }, 400);
  const config = built.config;
  const items = built.items;

  let code = null;
  for (let attempt = 0; attempt < 10 && code === null; attempt += 1) {
    const candidate = randomCode();
    const clash = await env.DB.prepare('SELECT id FROM rooms WHERE code = ?').bind(candidate).first();
    if (!clash) code = candidate;
  }
  if (code === null) return json({ error: 'no_codes_available' }, 503);

  const roomId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const hostToken = crypto.randomUUID();
  const hostName = sanitizeName(raw.name, 'Host');

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO rooms
         (id, code, host_player_id, host_name, status, round, seed, rows, cols, content, items,
          per_column, pool_size, pool_version, free_centre, call_mode, call_interval_ms, mark_mode,
          winner_mode, max_winners, win_patterns, winner_call, leaderboard, chat, reactions,
          expected_players, draw_order, called, called_count, last_call_at, player_count, winner_count,
          roster_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'lobby', 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, NULL, 0, 0, 1, ?, ?)`
    ).bind(
      roomId,
      code,
      hostId,
      hostName,
      crypto.randomUUID(),
      config.rows,
      config.cols,
      config.content,
      JSON.stringify(items),
      config.perColumn,
      config.poolSize,
      config.freeCentre ? 1 : 0,
      config.callMode,
      config.callIntervalMs,
      config.markMode,
      config.winnerMode,
      config.maxWinners,
      JSON.stringify(config.winPatterns),
      config.winnerCall,
      config.leaderboard ? 1 : 0,
      config.chat ? 1 : 0,
      config.reactions ? 1 : 0,
      config.expectedPlayers,
      JSON.stringify(generateDrawOrder(config.poolSize)),
      now,
      now
    ),
    // The host is an administrator: a seat for authentication, never a player.
    env.DB.prepare(
      `INSERT INTO players (id, room_id, role, name, avatar, token, marked, marked_round, joined_at, last_seen)
       VALUES (?, ?, 'host', ?, ?, ?, '[]', -1, ?, ?)`
    ).bind(hostId, roomId, hostName, '🎙️', hostToken, now, now),
  ]);

  return json({ ...(await buildState(env, code, hostToken, null)), token: hostToken });
}

async function updateConfig(request, env, code, token) {
  const body = await readJson(request);
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (me.role !== 'host') return json({ error: 'host_only' }, 403);

  // Everything locks once the round starts — no live tinkering with the rules.
  if (room.status !== 'lobby') return json({ error: 'settings_locked', message: 'Settings are locked once the game starts.' }, 409);

  const current = roomConfig(room);
  const requested = body.config && typeof body.config === 'object' ? body.config : body;

  // A custom list is stored in the room's item pool; if the host did not resend
  // it, reuse what is already there.
  if (requested.content === 'custom' && requested.customItems === undefined) {
    const stored = await env.DB.prepare('SELECT items FROM rooms WHERE id = ?').bind(room.id).first();
    requested.customItems = JSON.parse((stored && stored.items) || '[]');
  }

  const built = normalizeConfig(requested, current);
  if (built.error) return json({ error: built.error, message: built.message }, 400);

  const next = built.config;
  const geometryChanged =
    next.rows !== current.rows || next.cols !== current.cols || next.content !== current.content;
  const now = Date.now();

  await env.DB.prepare(
    `UPDATE rooms
        SET rows = ?, cols = ?, content = ?, items = ?, per_column = ?, pool_size = ?, pool_version = pool_version + ?,
            free_centre = ?, call_mode = ?, call_interval_ms = ?, mark_mode = ?, winner_mode = ?, max_winners = ?,
            win_patterns = ?, winner_call = ?, leaderboard = ?, chat = ?, reactions = ?, expected_players = ?,
            draw_order = ?, called = '[]', called_count = 0, updated_at = ?
      WHERE id = ?`
  ).bind(
    next.rows,
    next.cols,
    next.content,
    JSON.stringify(built.items),
    next.perColumn,
    next.poolSize,
    geometryChanged ? 1 : 0,
    next.freeCentre ? 1 : 0,
    next.callMode,
    next.callIntervalMs,
    next.markMode,
    next.winnerMode,
    next.maxWinners,
    JSON.stringify(next.winPatterns),
    next.winnerCall,
    next.leaderboard ? 1 : 0,
    next.chat ? 1 : 0,
    next.reactions ? 1 : 0,
    next.expectedPlayers,
    JSON.stringify(generateDrawOrder(next.poolSize)),
    now,
    room.id
  ).run();

  return json(await buildState(env, code, token, null));
}

async function startRound(request, env, code, token) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (me.role !== 'host') return json({ error: 'host_only' }, 403);

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM winners WHERE room_id = ?').bind(room.id),
    // O(1) regardless of table size: cards are derived, so nothing is dealt.
    // The host may start with any number of players — even none.
    env.DB.prepare(
      `UPDATE rooms
          SET status = 'playing', round = round + 1, called = '[]', called_count = 0, winner_count = 0,
              draw_order = ?, last_call_at = ?, ended_reason = NULL, updated_at = ?
        WHERE id = ?`
    ).bind(JSON.stringify(generateDrawOrder(room.pool_size)), now, now, room.id),
  ]);

  return json(await buildState(env, code, token, null));
}

async function endRound(request, env, code, token) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (me.role !== 'host') return json({ error: 'host_only' }, 403);

  await finishRoom(env, room.id, 'host_ended', Date.now());
  return json(await buildState(env, code, token, null));
}

async function callItem(request, env, code, token) {
  const body = await readJson(request);
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (me.role !== 'host') return json({ error: 'host_only' }, 403);
  if (room.status !== 'playing') return json({ error: 'not_playing' }, 409);
  if (room.call_mode !== 'manual') return json({ error: 'auto_call_enabled' }, 409);

  const called = JSON.parse(room.called);
  const calledSet = new Set(called);
  const now = Date.now();
  let index;

  if (body.index !== undefined && body.index !== null) {
    index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index >= room.pool_size) return json({ error: 'invalid_item' }, 400);
    if (calledSet.has(index)) return json({ error: 'already_called' }, 409);
  } else {
    const drawOrder = JSON.parse(room.draw_order);
    index = drawOrder.find((i) => !calledSet.has(i));
    if (index === undefined) {
      await finishRoom(env, room.id, 'items_exhausted', now);
      return json(await buildState(env, code, token, null));
    }
  }

  const nextCalled = called.concat([index]);
  const result = await env.DB.prepare(
    `UPDATE rooms SET called = ?, called_count = ?, last_call_at = ?, updated_at = ?
      WHERE id = ? AND status = 'playing' AND call_mode = 'manual' AND called_count = ?`
  ).bind(JSON.stringify(nextCalled), nextCalled.length, now, now, room.id, room.called_count).run();

  if (!result.meta || result.meta.changes === 0) return json({ error: 'call_conflict' }, 409);

  let updated = await getRoomById(env, room.id);
  if (updated.called_count >= updated.pool_size) {
    updated = await finishRoom(env, room.id, 'items_exhausted', now);
  } else {
    updated = await autoAward(env, updated, now);
  }
  return json(await buildState(env, code, token, null));
}

// ---------------------------------------------------------------------------
// Handlers: players
// ---------------------------------------------------------------------------

async function joinRoom(request, env, code, token) {
  const body = await readJson(request);
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  if (token) {
    const existing = await env.DB.prepare('SELECT id, role FROM players WHERE token = ? AND room_id = ?')
      .bind(token, room.id)
      .first();
    if (existing) return json({ ...(await buildState(env, code, token, null)), token, role: existing.role });
  }

  if (room.player_count >= MAX_PLAYERS) return json({ error: 'room_full', maxPlayers: MAX_PLAYERS }, 409);

  const now = Date.now();
  const playerId = crypto.randomUUID();
  const newToken = crypto.randomUUID();
  const name = sanitizeName(body.name, 'Player');
  const avatar = AVATAR_CHOICES.includes(body.avatar) ? body.avatar : randomAvatar(`${playerId}${name}`);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO players (id, room_id, role, name, avatar, token, marked, marked_round, joined_at, last_seen)
       VALUES (?, ?, 'player', ?, ?, ?, '[]', -1, ?, ?)`
    ).bind(playerId, room.id, name, avatar, newToken, now, now),
    env.DB.prepare(
      `UPDATE rooms SET player_count = player_count + 1, roster_version = roster_version + 1, updated_at = ?
        WHERE id = ?`
    ).bind(now, room.id),
  ]);

  return json({ ...(await buildState(env, code, newToken, null)), token: newToken, role: 'player' });
}

async function leaveRoom(request, env, code, token) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);

  if (me.role === 'host') return json({ error: 'host_cannot_leave', message: 'A host cannot leave their own table.' }, 409);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM players WHERE id = ?').bind(me.id),
    env.DB.prepare(
      `UPDATE rooms SET player_count = MAX(0, player_count - 1), roster_version = roster_version + 1,
         updated_at = ? WHERE id = ?`
    ).bind(Date.now(), room.id),
  ]);

  return json({ ok: true });
}

async function markItem(request, env, code, token) {
  const body = await readJson(request);
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (me.role !== 'player') return json({ error: 'host_cannot_play', message: 'The host does not play.' }, 403);
  if (room.status !== 'playing') return json({ error: 'not_playing' }, 409);
  if (room.mark_mode === 'auto') return json({ error: 'auto_mark_enabled' }, 409);

  const index = Number(body.index);
  const config = roomConfig(room);
  const card = playerCard(room, config, me.id);
  if (!cardIndexSet(card).has(index)) return json({ error: 'not_on_card' }, 400);

  const calledSet = new Set(JSON.parse(room.called));
  if (!calledSet.has(index)) return json({ error: 'not_called' }, 409);

  const marked = me.marked_round === room.round ? new Set(JSON.parse(me.marked)) : new Set();
  if (marked.has(index)) marked.delete(index);
  else marked.add(index);

  await env.DB.prepare('UPDATE players SET marked = ?, marked_round = ?, last_seen = ? WHERE id = ?')
    .bind(JSON.stringify([...marked]), room.round, Date.now(), me.id)
    .run();

  return json(await buildState(env, code, token, null));
}

async function claimBingo(request, env, code, token) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (me.role !== 'player') return json({ error: 'host_cannot_play', message: 'The host does not play.' }, 403);
  if (room.status !== 'playing') return json({ error: 'not_playing' }, 409);
  if (room.winner_call === 'auto') {
    return json({ error: 'auto_winner_call', message: 'This table calls winners automatically.' }, 409);
  }

  const config = roomConfig(room);
  const called = JSON.parse(room.called);
  const calledSet = new Set(called);
  const card = playerCard(room, config, me.id);
  const markedSet = winningSet(room, config, me, card, calledSet);
  const done = completedPatterns(card, markedSet, calledSet, config.winPatterns);

  if (done.length === 0) {
    return json({ ...(await buildState(env, code, token, null)), error: 'no_bingo' }, 409);
  }

  const already = await env.DB.prepare(
    'SELECT id FROM winners WHERE room_id = ? AND round = ? AND player_id = ?'
  ).bind(room.id, room.round, me.id).first();
  if (already) return json({ ...(await buildState(env, code, token, null)), error: 'already_won' }, 409);

  const limit = winnerLimit(config);
  const now = Date.now();

  // Atomic slot reservation: whoever increments first owns the place, so
  // simultaneous claims can never overshoot the winner limit, and a player who
  // already won cannot take a second place.
  const gate = await env.DB.prepare(
    `UPDATE rooms SET winner_count = winner_count + 1, updated_at = ?
      WHERE id = ? AND status = 'playing' AND winner_count < ?
        AND NOT EXISTS (SELECT 1 FROM winners WHERE room_id = ? AND round = ? AND player_id = ?)`
  ).bind(now, room.id, limit, room.id, room.round, me.id).run();

  if (!gate.meta || gate.meta.changes === 0) {
    return json({ ...(await buildState(env, code, token, null)), error: already ? 'already_won' : 'winners_full' }, 409);
  }

  await env.DB.prepare(
    `INSERT INTO winners (id, room_id, round, player_id, name, pattern, called_count, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), room.id, room.round, me.id, me.name, done[0], called.length, now).run();

  const updated = await getRoomById(env, room.id);
  if (updated.winner_count >= limit) await finishRoom(env, room.id, 'winners_complete', now);

  return json(await buildState(env, code, token, null));
}

// ---------------------------------------------------------------------------
// Social
// ---------------------------------------------------------------------------

async function postChat(request, env, code, token) {
  const body = await readJson(request);
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (room.chat !== 1) return json({ error: 'chat_disabled', message: 'The host switched chat off.' }, 403);

  const text = String(body.body ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return json({ error: 'empty_message' }, 400);
  if (text.length > CHAT_MAX_CHARS) return json({ error: 'message_too_long', message: `Keep messages under ${CHAT_MAX_CHARS} characters.` }, 400);
  const words = text.split(' ').filter(Boolean);
  if (words.length > CHAT_MAX_WORDS) {
    return json({ error: 'too_many_words', message: `Keep messages to ${CHAT_MAX_WORDS} words or fewer.` }, 400);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO messages (id, room_id, player_id, name, avatar, body, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), room.id, me.id, me.name, me.avatar || '', text, now).run();

  if (Math.random() < PRUNE_CHANCE) {
    await env.DB.prepare('DELETE FROM messages WHERE room_id = ? AND at < ?')
      .bind(room.id, now - CHAT_RETENTION_MS)
      .run();
  }

  return json({ ok: true, cursor: await latestCursor(env, 'messages', room.id) });
}

async function postReaction(request, env, code, token) {
  const body = await readJson(request);
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const me = await authorize(env, room, token);
  if (!me) return json({ error: 'unauthorized' }, 401);
  if (room.reactions !== 1) return json({ error: 'reactions_disabled', message: 'The host switched reactions off.' }, 403);

  const emoji = String(body.emoji ?? '');
  if (!REACTION_EMOJIS.includes(emoji)) return json({ error: 'invalid_emoji', message: 'Pick one of the offered reactions.' }, 400);

  const targetId = String(body.to ?? '');
  const target = await env.DB.prepare("SELECT id, name, role FROM players WHERE id = ? AND room_id = ?")
    .bind(targetId, room.id)
    .first();
  if (!target || target.role !== 'player') return json({ error: 'unknown_player' }, 404);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reactions (id, room_id, from_id, from_name, to_id, to_name, emoji, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), room.id, me.id, me.name, target.id, target.name, emoji, now).run();

  if (Math.random() < PRUNE_CHANCE) {
    await env.DB.prepare('DELETE FROM reactions WHERE room_id = ? AND at < ?')
      .bind(room.id, now - CHAT_RETENTION_MS)
      .run();
  }

  return json({ ok: true, cursor: await latestCursor(env, 'reactions', room.id) });
}

async function getChat(env, code, since) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);
  if (room.chat !== 1) return json({ enabled: false, messages: [] });

  const cursor = Number(since) || 0;
  const rows = await env.DB.prepare(
    `SELECT rowid AS seq, player_id, name, avatar, body, at FROM messages
      WHERE room_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`
  ).bind(room.id, cursor, CHAT_PAGE).all();

  const messages = (rows.results || []).map((m) => ({
    seq: m.seq,
    playerId: m.player_id,
    name: m.name,
    avatar: m.avatar,
    body: m.body,
    at: m.at,
  }));
  return json({ enabled: true, cursor: messages.length ? messages[messages.length - 1].seq : cursor, messages });
}

async function getReactions(env, code, since) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);
  if (room.reactions !== 1) return json({ enabled: false, reactions: [] });

  const cursor = Number(since) || 0;
  const rows = await env.DB.prepare(
    `SELECT rowid AS seq, from_id, from_name, to_id, to_name, emoji, at FROM reactions
      WHERE room_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`
  ).bind(room.id, cursor, REACTION_PAGE).all();

  const reactions = (rows.results || []).map((r) => ({
    seq: r.seq,
    fromId: r.from_id,
    fromName: r.from_name,
    toId: r.to_id,
    toName: r.to_name,
    emoji: r.emoji,
    at: r.at,
  }));
  return json({ enabled: true, cursor: reactions.length ? reactions[reactions.length - 1].seq : cursor, reactions });
}

async function latestCursor(env, table, roomId) {
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(rowid), 0) AS seq FROM ${table} WHERE room_id = ?`)
    .bind(roomId)
    .first();
  return row ? row.seq : 0;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

async function buildState(env, code, token, since) {
  const now = Date.now();
  let room = await getRoom(env, code);
  if (!room) return null;
  room = await advanceClock(env, room, now);

  const config = roomConfig(room);
  const called = JSON.parse(room.called);
  const calledCount = room.called_count;

  let me = null;
  if (token) {
    me = await env.DB.prepare(
      'SELECT id, room_id, role, name, avatar, marked, marked_round, last_seen FROM players WHERE token = ?'
    ).bind(token).first();
    if (me && me.room_id !== room.id) me = null;
    if (me && now - me.last_seen > LAST_SEEN_WRITE_MS) {
      await env.DB.prepare('UPDATE players SET last_seen = ? WHERE id = ?').bind(now, me.id).run();
    }
  }

  const winnerRows = await env.DB.prepare(
    'SELECT player_id, name, pattern, called_count FROM winners WHERE room_id = ? AND round = ? ORDER BY at ASC, id ASC'
  ).bind(room.id, room.round).all();
  const winners = (winnerRows.results || []).map((w, index) => ({
    playerId: w.player_id,
    name: w.name,
    rank: index + 1,
    pattern: w.pattern,
    calledCount: w.called_count,
  }));

  const sinceNum = since !== null && since !== undefined && String(since).trim() !== '' ? Number(since) : NaN;
  const useTail = Number.isInteger(sinceNum) && sinceNum >= 0 && sinceNum <= calledCount;

  // Only real players hold cards. The host watches.
  let you = null;
  if (me && me.role === 'player') {
    const card = playerCard(room, config, me.id);
    const calledSet = new Set(called);
    const marked = storedMarked(room, config, me, card, calledSet);
    const markedSet = new Set(marked);
    const win = winningSet(room, config, me, card, calledSet);
    const done = completedPatterns(card, win, calledSet, config.winPatterns);
    you = {
      card,
      marked,
      markedCount: marked.length,
      patterns: done,
      best: bestProgress(card, win, calledSet, config.winPatterns),
      missed: missedCount(card, markedSet, calledSet),
      won: winners.some((w) => w.playerId === me.id),
      canClaim: room.status === 'playing' && done.length > 0 && room.winner_call === 'manual',
    };
  }

  return {
    room: {
      code: room.code,
      status: room.status,
      round: room.round,
      config,
      visibility: fieldVisibility(config),
      columnLabels: columnLabels(config.cols),
      calledCount,
      called: useTail ? null : called,
      calledTail: useTail ? called.slice(sinceNum) : null,
      remaining: config.poolSize - calledCount,
      nextCallInMs:
        config.callMode === 'auto' && room.status === 'playing' && room.last_call_at
          ? Math.max(0, room.last_call_at + config.callIntervalMs - now)
          : null,
      playerCount: room.player_count,
      maxPlayers: MAX_PLAYERS,
      rosterVersion: room.roster_version,
      poolVersion: room.pool_version,
      hostName: room.host_name,
      winners,
      winnerSlots: config.winnerMode === 'single' ? 1 : config.maxWinners,
      endedReason: room.ended_reason || null,
    },
    viewer: me ? { role: me.role, id: me.id, name: me.name, avatar: me.avatar || '', isHost: me.role === 'host' } : null,
    you,
    serverTime: now,
  };
}

async function listPlayers(env, code, since) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const sinceNum = Number(since);
  if (Number.isInteger(sinceNum) && sinceNum === room.roster_version) {
    return json({ version: room.roster_version, changed: false, total: room.player_count });
  }

  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT id, name, avatar, last_seen FROM players
      WHERE room_id = ? AND role = 'player' ORDER BY joined_at ASC LIMIT ?`
  ).bind(room.id, MAX_PLAYERS).all();

  const players = (rows.results || []).map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    online: now - p.last_seen < ONLINE_WINDOW_MS,
  }));

  return json({
    version: room.roster_version,
    changed: true,
    total: players.length,
    online: players.filter((p) => p.online).length,
    expected: room.expected_players,
    hostName: room.host_name,
    players,
  });
}

async function getPool(env, code, since) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);

  const sinceNum = Number(since);
  if (Number.isInteger(sinceNum) && sinceNum === room.pool_version) {
    return json({ version: room.pool_version, changed: false });
  }

  const row = await env.DB.prepare('SELECT items, content, per_column, pool_size, pool_version FROM rooms WHERE id = ?')
    .bind(room.id)
    .first();

  return json({
    version: row.pool_version,
    changed: true,
    content: row.content,
    perColumn: row.per_column,
    poolSize: row.pool_size,
    items: JSON.parse(row.items || '[]'),
  });
}

async function getLeaderboard(env, code, token, limit, offset) {
  const room = await getRoom(env, code);
  if (!room) return json({ error: 'room_not_found' }, 404);
  if (room.leaderboard !== 1) return json({ error: 'leaderboard_disabled' }, 403);

  const config = roomConfig(room);
  const now = Date.now();
  const cacheKey = `${room.id}:${room.round}:${room.called_count}:${room.roster_version}`;

  let cached = leaderboardCache.get(cacheKey);
  if (!cached || now - cached.at > LEADERBOARD_TTL_MS) {
    cached = await computeLeaderboard(env, room, config, now);
    cached.at = now;
    leaderboardCache.set(cacheKey, cached);
    if (leaderboardCache.size > 60) {
      for (const [key, value] of leaderboardCache) {
        if (now - value.at > LEADERBOARD_TTL_MS) leaderboardCache.delete(key);
      }
    }
  }

  let me = null;
  if (token) {
    me = await env.DB.prepare("SELECT id FROM players WHERE token = ? AND room_id = ? AND role = 'player'")
      .bind(token, room.id)
      .first();
  }

  const size = Math.min(Math.max(Number(limit) || LEADERBOARD_PAGE, 1), 100);
  const start = Math.max(Number(offset) || 0, 0);
  const entries = cached.entries.slice(start, start + size).map((entry) => ({
    ...entry,
    isYou: me ? entry.id === me.id : false,
  }));

  return json({
    round: room.round,
    calledCount: room.called_count,
    total: cached.total,
    patternsTotal: config.winPatterns.length,
    entries,
    you: me ? cached.entries.find((e) => e.id === me.id) || null : null,
  });
}

async function computeLeaderboard(env, room, config, now) {
  const called = JSON.parse(room.called);
  const calledSet = new Set(called);

  const rows = await env.DB.prepare(
    `SELECT id, name, avatar, marked, marked_round, joined_at, last_seen FROM players
      WHERE room_id = ? AND role = 'player' ORDER BY joined_at ASC LIMIT ?`
  ).bind(room.id, MAX_PLAYERS).all();

  const entries = (rows.results || []).map((p) => {
    const card = playerCard(room, config, p.id);
    const marked = storedMarked(room, config, p, card, calledSet);
    const win = winningSet(room, config, p, card, calledSet);
    const won = completedPatterns(card, win, calledSet, config.winPatterns).length;
    const best = bestProgress(card, win, calledSet, config.winPatterns);
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      online: now - p.last_seen < ONLINE_WINDOW_MS,
      markedCount: marked.length,
      won,
      bestDone: best.done,
      bestTotal: best.total,
      joinedAt: p.joined_at,
    };
  });

  entries.sort(
    (a, b) =>
      b.won - a.won ||
      (b.bestTotal ? b.bestDone / b.bestTotal : 0) - (a.bestTotal ? a.bestDone / a.bestTotal : 0) ||
      a.joinedAt - b.joinedAt
  );
  entries.forEach((entry, index) => {
    entry.rank = index + 1;
  });

  return { at: now, total: entries.length, entries: entries.slice(0, LEADERBOARD_MAX_ROWS) };
}

const leaderboardCache = new Map();

// ---------------------------------------------------------------------------
// Game clock
// ---------------------------------------------------------------------------

async function advanceClock(env, room, now) {
  if (room.status !== 'playing' || room.call_mode !== 'auto') return room;

  if (room.called_count >= room.pool_size) return finishRoom(env, room.id, 'items_exhausted', now);

  const interval = room.call_interval_ms;
  const last = room.last_call_at || now;
  const due = Math.floor((now - last) / interval);
  if (due <= 0) return room;

  const draws = Math.min(due, room.pool_size - room.called_count, MAX_CATCHUP_DRAWS);
  if (draws <= 0) return room;

  const drawOrder = JSON.parse(room.draw_order);
  const called = JSON.parse(room.called);
  const more = drawOrder.slice(room.called_count, room.called_count + draws);
  if (more.length === 0) return finishRoom(env, room.id, 'items_exhausted', now);

  const result = await env.DB.prepare(
    `UPDATE rooms
        SET called = ?, called_count = ?, last_call_at = last_call_at + ? * ?, updated_at = ?
      WHERE id = ? AND status = 'playing' AND call_mode = 'auto' AND called_count = ?`
  ).bind(
    JSON.stringify(called.concat(more)),
    room.called_count + more.length,
    more.length,
    interval,
    now,
    room.id,
    room.called_count
  ).run();

  if (!result.meta || result.meta.changes === 0) return getRoomById(env, room.id);

  let updated = await getRoomById(env, room.id);
  if (updated.called_count >= updated.pool_size) {
    updated = await finishRoom(env, room.id, 'items_exhausted', now);
  } else {
    updated = await autoAward(env, updated, now);
  }
  return updated;
}

/**
 * Automatic winner call-out. Runs only when the called set changed, so it is
 * O(players) per *call* rather than per dab — which is what keeps it affordable
 * at 500 seats. Ties are broken by who is closest, then by join order.
 */
async function autoAward(env, room, now) {
  if (room.status !== 'playing' || room.winner_call !== 'auto') return room;

  const config = roomConfig(room);
  const limit = winnerLimit(config);
  if (room.winner_count >= limit) return room;

  const called = JSON.parse(room.called);
  const calledSet = new Set(called);

  const rows = await env.DB.prepare(
    `SELECT id, name, marked, marked_round, joined_at FROM players
      WHERE room_id = ? AND role = 'player' ORDER BY joined_at ASC LIMIT ?`
  ).bind(room.id, MAX_PLAYERS).all();

  const hits = [];
  for (const p of rows.results || []) {
    const card = playerCard(room, config, p.id);
    const win = winningSet(room, config, p, card, calledSet);
    const done = completedPatterns(card, win, calledSet, config.winPatterns);
    if (done.length === 0) continue;
    const best = bestProgress(card, win, calledSet, config.winPatterns);
    hits.push({ id: p.id, name: p.name, pattern: done[0], ratio: best.ratio, joinedAt: p.joined_at });
  }
  if (hits.length === 0) return room;

  hits.sort((a, b) => b.ratio - a.ratio || a.joinedAt - b.joinedAt);
  const remaining = limit - room.winner_count;
  const awards = hits.slice(0, remaining);

  for (const award of awards) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO winners (id, room_id, round, player_id, name, pattern, called_count, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(crypto.randomUUID(), room.id, room.round, award.id, award.name, award.pattern, called.length, now),
      env.DB.prepare('UPDATE rooms SET winner_count = winner_count + 1, updated_at = ? WHERE id = ? AND status = ?')
        .bind(now, room.id, 'playing'),
    ]);
  }

  const updated = await getRoomById(env, room.id);
  if (updated.winner_count >= limit) return finishRoom(env, room.id, 'winners_complete', now);
  return updated;
}

async function finishRoom(env, roomId, reason, now) {
  await env.DB.prepare(
    "UPDATE rooms SET status = 'finished', ended_reason = ?, updated_at = ? WHERE id = ? AND status = 'playing'"
  ).bind(reason, now, roomId).run();
  return getRoomById(env, roomId);
}

// ---------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------

function playerCard(room, config, playerId) {
  return deriveCard({
    seed: room.seed,
    round: room.round,
    playerId,
    rows: config.rows,
    cols: config.cols,
    freeCentre: config.freeCentre,
    perColumn: config.perColumn,
  });
}

/** Indexes the player has actually dabbed (empty in auto-dab mode until derived). */
function storedMarked(room, config, playerRow, card, calledSet) {
  if (config.markMode === 'auto') {
    return cardCells(card)
      .filter((cell) => calledSet.has(cell.index))
      .map((cell) => cell.index);
  }
  if (playerRow.marked_round !== room.round) return [];
  return JSON.parse(playerRow.marked);
}

/**
 * The set used to decide a win.
 *
 * In automatic call-out mode the system watches the CALLED set, so a winner is
 * declared the moment their pattern is fully called — that is what makes the
 * check run once per call instead of once per dab, and it is how electronic
 * bingo halls work. In manual call-out mode dabbing still matters.
 */
function winningSet(room, config, playerRow, card, calledSet) {
  if (room.winner_call === 'auto') {
    return new Set(cardCells(card).filter((cell) => calledSet.has(cell.index)).map((cell) => cell.index));
  }
  return new Set(storedMarked(room, config, playerRow, card, calledSet));
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function methodNotAllowed(allowed) {
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: { 'content-type': 'application/json; charset=utf-8', allow: allowed, 'cache-control': 'no-store' },
  });
}

async function readJson(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    return {};
  }
}

function normalizeCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  return [...code].every((ch) => CODE_ALPHABET.includes(ch)) ? code : null;
}

function randomCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function sanitizeName(value, fallback) {
  const raw = typeof value === 'string' ? value : '';
  const clean = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

function getRoom(env, code) {
  return env.DB.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE code = ?`).bind(code).first();
}

function getRoomById(env, id) {
  return env.DB.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms WHERE id = ?`).bind(id).first();
}

function authorize(env, room, token) {
  if (typeof token !== 'string' || !token) return null;
  return env.DB.prepare(
    'SELECT id, room_id, role, name, avatar, marked, marked_round, last_seen FROM players WHERE token = ? AND room_id = ?'
  ).bind(token, room.id).first();
}

