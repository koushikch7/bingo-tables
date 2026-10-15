import {
  AVATAR_CHOICES,
  MAX_COLS,
  MAX_ROWS,
  MIN_COLS,
  MIN_ROWS,
  REACTION_EMOJIS,
  availablePatterns,
  hasFreeCentre,
  numbersPerColumn,
  patternCells,
  presetPatterns,
  recommendBoard,
  variety,
  winningConditions,
} from '/game.js';

const STORAGE_KEY = 'bingo.session.v2';
const ACTIVE_MS = 1000;
const HIDDEN_MS = 3000;
const ROSTER_STALE_MS = 10000;
const LEADERBOARD_MS = 5000;
const SOCIAL_MS = 2000;
const ROSTER_RENDER_CAP = 150;
const RING_CAP = 48;
const CHAT_WORD_LIMIT = 20;

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

let session = loadSession();
let state = null;
let viewer = null;
let roster = null;
let pool = null;
let leaderboard = null;
let chatLog = [];
let calledList = [];
let lastRound = -1;
let chatCursor = 0;
let reactionCursor = 0;
let poolVersion = null;
let lastRosterAt = 0;
let lastLeaderboardAt = 0;
let lastSocialAt = 0;
let selectedTarget = null;

let busy = false;
let pollTimer = null;
let countdownTimer = null;
let timersTimer = null;
let pollGeneration = 0;
let lastStateAt = 0;
let currentSkeleton = '';
let configDirty = false;
let configSig = '';
const pieceSigs = {};

// --------------------------------------------------------------- session ---

function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.code === 'string' && typeof parsed.token === 'string') return parsed;
  } catch {
    /* ignore corrupt storage */
  }
  return null;
}

function saveSession(next) {
  session = next;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

// ------------------------------------------------------------------ api ----

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const effective = token ?? (session ? session.token : null);
  if (effective) headers['x-player-token'] = effective;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data: data || {} };
}

function messageFor(data, fallback = 'Something went wrong. Try again.') {
  const messages = {
    room_not_found: 'No table with that code. Double-check it with your host.',
    room_full: `That table is full (${data && data.maxPlayers} players max).`,
    invalid_code: 'Table codes are 5 letters/numbers.',
    no_codes_available: 'Could not allocate a table code. Try again in a moment.',
    not_playing: 'The round is not running right now.',
    not_called: 'That item has not been called yet.',
    not_on_card: 'That item is not on your card.',
    auto_mark_enabled: 'This table dabs automatically.',
    auto_call_enabled: 'This table calls items automatically.',
    auto_winner_call: 'This table calls winners automatically.',
    already_called: 'That one has already been called.',
    no_bingo: 'Not a bingo yet — keep going!',
    already_won: 'You already have a bingo this round.',
    winners_full: 'All winner places for this round are taken.',
    leaderboard_disabled: 'The host has the leaderboard switched off.',
    settings_locked: 'Settings are locked once the game starts.',
    host_only: 'Only the host can do that.',
    host_cannot_play: 'The host runs the table but does not play.',
    host_cannot_leave: 'A host cannot leave their own table.',
    invalid_board: data && data.message,
    no_patterns: 'Pick at least one winning pattern.',
    pool_too_small: data && data.message,
    too_many_items: data && data.message,
    too_many_words: data && data.message,
    message_too_long: data && data.message,
    empty_message: 'Type something first.',
    chat_disabled: 'The host switched chat off.',
    reactions_disabled: 'The host switched reactions off.',
    invalid_emoji: 'Pick one of the offered reactions.',
    unknown_player: 'That player has left the table.',
    invalid_rows: data && data.message,
    invalid_cols: data && data.message,
    invalid_max_winners: data && data.message,
    invalid_expected_players: data && data.message,
    server_error: 'Server hiccup. Try again.',
  };
  return messages[data && data.error] || fallback;
}

// -------------------------------------------------------------- utilities --

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2600);
}

const STATUS_LABEL = { lobby: 'Lobby', playing: 'Playing', finished: 'Round over' };
const INTERVALS = [
  [3000, 'Fast · 3s'],
  [4000, 'Brisk · 4s'],
  [5000, 'Normal · 5s'],
  [8000, 'Relaxed · 8s'],
  [12000, 'Slow · 12s'],
  [20000, 'Very slow · 20s'],
];

function itemFor(index) {
  if (state && state.room.config.content === 'numbers') return { label: String(index + 1), media: '' };
  if (pool && Array.isArray(pool.items)) return pool.items[index] || null;
  return null;
}

function itemLabel(index) {
  const item = itemFor(index);
  return item ? item.label : `#${index + 1}`;
}

function isEmojiLabel(label) {
  return typeof label === 'string' && label.length <= 3 && /\p{Extended_Pictographic}/u.test(label);
}

function cellHtml(index) {
  const content = state.room.config.content;
  const item = itemFor(index);
  if (!item) return `<span class="cell-text">${esc(itemLabel(index))}</span>`;
  const label = item.label || '';
  const media = item.media || '';

  if (content === 'mixed' && media) {
    return `${cellMedia(media)}<span class="cell-text tiny">${esc(label)}</span>`;
  }
  if (content === 'images') {
    return cellMedia(label);
  }
  if (isEmojiLabel(label)) {
    return `<span class="cell-media">${esc(label)}</span>`;
  }
  if (media) {
    return `${cellMedia(media)}<span class="cell-text tiny">${esc(label)}</span>`;
  }
  return `<span class="cell-text">${esc(label)}</span>`;
}

/**
 * A pool item may be an emoji, or a real image URL when the host pasted custom
 * items. Both are rendered inline so a 6x8 card stays readable at scale.
 */
function cellMedia(value) {
  if (/^https?:\/\//i.test(value)) {
    return `<img class="cell-image" src="${esc(value)}" alt="" loading="lazy" />`;
  }
  return `<span class="cell-media">${esc(value)}</span>`;
}

// ------------------------------------------------------------------ home ---

function renderHome(message = '') {
  stopPolling();
  state = null;
  viewer = null;
  resetLocalCaches();
  const savedName = session && session.name ? session.name : '';
  const savedAvatar = pickAvatar(savedName);

  app.innerHTML = `
    <div class="home">
      <div class="home-card">
        <h1 class="brand">Bingo Tables</h1>
        <p class="tagline">Numbers, names, emoji or music. Host a table from 4 seats to 500, with a stadium of players around the board.</p>

        <label class="field">
          <span>Your name</span>
          <input id="name" maxlength="18" placeholder="e.g. Alex" autocomplete="nickname" value="${esc(savedName)}" />
        </label>
        <div class="field">
          <span>Your avatar</span>
          <div class="avatar-picker" id="avatar-picker">
            ${AVATAR_CHOICES.slice(0, 12)
              .map(
                (a) =>
                  `<button type="button" class="avatar-option ${a === savedAvatar ? 'picked' : ''}" data-avatar="${a}">${a}</button>`
              )
              .join('')}
          </div>
        </div>

        <button class="wide" id="create">Host a table</button>
        <p class="hint tiny">As host you run the table and the settings — you don't hold a card.</p>

        <div class="or">or join one</div>

        <label class="field">
          <span>Table code</span>
          <input id="code" maxlength="5" placeholder="ABCDE" autocomplete="off" autocapitalize="characters"
                 spellcheck="false" value="${session && session.code ? esc(session.code) : ''}" />
        </label>
        <button class="wide ghost" id="join">Join a table</button>

        <p class="form-error" id="form-error">${esc(message)}</p>
      </div>
    </div>`;

  const nameEl = document.getElementById('name');
  const codeEl = document.getElementById('code');
  const errorEl = document.getElementById('form-error');
  let avatar = savedAvatar;

  document.getElementById('avatar-picker').addEventListener('click', (event) => {
    const button = event.target.closest('[data-avatar]');
    if (!button) return;
    avatar = button.dataset.avatar;
    document.querySelectorAll('.avatar-option').forEach((el) => el.classList.toggle('picked', el === button));
  });

  codeEl.addEventListener('input', () => {
    codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  document.getElementById('create').addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    errorEl.textContent = '';
    setDisabled('create', true, 'Creating…');
    const { ok, data } = await api('/api/room', { method: 'POST', body: { name: nameEl.value }, token: '' });
    busy = false;
    setDisabled('create', false, 'Host a table');
    if (!ok || !data.room) {
      errorEl.textContent = messageFor(data, 'Could not create a table.');
      return;
    }
    saveSession({ code: data.room.code, token: data.token, role: 'host' });
    applyState(data);
    enterRoom();
  });

  const join = async () => {
    if (busy) return;
    const code = codeEl.value.trim().toUpperCase();
    if (code.length !== 5) {
      errorEl.textContent = 'Enter the 5-character table code.';
      codeEl.focus();
      return;
    }
    busy = true;
    errorEl.textContent = '';
    setDisabled('join', true, 'Joining…');
    const { ok, data } = await api(`/api/room/${code}/join`, {
      method: 'POST',
      body: { name: nameEl.value, avatar },
      token: '',
    });
    busy = false;
    setDisabled('join', false, 'Join a table');
    if (!ok || !data.room) {
      errorEl.textContent = messageFor(data);
      return;
    }
    saveSession({ code: data.room.code, token: data.token, role: 'player' });
    applyState(data);
    enterRoom();
  };

  document.getElementById('join').addEventListener('click', join);
  codeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') join();
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') codeEl.focus();
  });
}

function pickAvatar(seed) {
  if (!seed) return AVATAR_CHOICES[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_CHOICES[hash % AVATAR_CHOICES.length];
}

function renderLoading() {
  app.innerHTML = `
    <div class="home"><div class="home-card">
      <h1 class="brand">Bingo Tables</h1><p class="tagline">Rejoining your table…</p>
    </div></div>`;
}

function setDisabled(id, disabled, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = disabled;
  if (label) el.textContent = label;
}

function resetLocalCaches() {
  roster = null;
  pool = null;
  leaderboard = null;
  chatLog = [];
  calledList = [];
  lastRound = -1;
  chatCursor = 0;
  reactionCursor = 0;
  poolVersion = null;
  lastRosterAt = 0;
  lastLeaderboardAt = 0;
  lastSocialAt = 0;
  selectedTarget = null;
  currentSkeleton = '';
  configDirty = false;
  configSig = '';
  for (const key of Object.keys(pieceSigs)) delete pieceSigs[key];
}

function setPiece(name, signature, html) {
  if (pieceSigs[name] === signature) return false;
  pieceSigs[name] = signature;
  const node = document.getElementById(name);
  if (node) node.innerHTML = html;
  return true;
}

// --------------------------------------------------------------- layout ----

function enterRoom() {
  currentSkeleton = '';
  renderSkeleton();
  startPolling();
}

function isHost() {
  return Boolean(viewer && viewer.isHost);
}

function skeletonKey() {
  const { room, config } = state;
  return [
    room.status,
    isHost() ? 'host' : 'player',
    config.rows,
    config.cols,
    config.content,
    config.markMode,
    config.callMode,
    config.winnerCall,
    config.leaderboard,
    config.chat,
    config.reactions,
  ].join('|');
}

function renderSkeleton() {
  if (!state || !state.room) return;
  const key = skeletonKey();
  if (key === currentSkeleton) {
    if (isHost()) renderStudioPanel();
    return;
  }
  currentSkeleton = key;
  for (const k of Object.keys(pieceSigs)) delete pieceSigs[k];

  const { room } = state;
  const config = room.config;
  const host = isHost();
  const lobby = room.status === 'lobby';

  app.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <section class="stadium-wrap" id="stadium-panel"></section>
    <div class="layout">
      ${host ? '<section class="panel panel-wide" id="studio-panel"></section>' : '<section class="panel" id="card-panel"></section>'}
      <section class="panel" id="board-panel"></section>
      <section class="panel" id="roster-panel"></section>
      ${config.leaderboard && (!host || !lobby) ? '<section class="panel" id="leaderboard-panel"></section>' : ''}
      ${config.reactions || config.chat ? '<section class="panel panel-wide" id="social-panel"></section>' : ''}
    </div>
    <div id="overlay"></div>`;

  if (host) renderStudioPanel();
  updatePieces();
}

// --------------------------------------------------- host studio (config) --

function renderStudioPanel() {
  const panel = document.getElementById('studio-panel');
  if (!panel || !state || !isHost()) return;

  const { room } = state;
  const config = room.config;
  const lobby = room.status === 'lobby';
  const sig = JSON.stringify([config, room.status, room.playerCount, room.expectedPlayers]);
  if (lobby && configDirty) return;
  if (sig === configSig) return;
  configSig = sig;

  if (!lobby) {
    panel.innerHTML = `
      <div class="panel-head">
        <h2>Round ${room.round} in progress</h2>
        <span class="hint">🔒 Settings are locked once the game starts</span>
      </div>
      ${hostControlsHtml()}
      <p class="hint">${configSummary(config)}</p>`;
    attachHostControls();
    return;
  }

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Table settings</h2>
      <span class="hint">${room.playerCount} joined${room.expectedPlayers ? ` · expecting ~${room.expectedPlayers}` : ''} · you can start any time, with any number of players</span>
    </div>
    <form id="config-form" autocomplete="off">
      <div class="setup-row">
        <label class="field">
          <span>Expected players <em>(advice only — never blocks starting)</em></span>
          <input id="cfg-expected" type="number" min="0" max="500" value="${config.expectedPlayers || ''}" placeholder="e.g. 120" />
        </label>
        <button type="button" class="ghost small" id="cfg-recommend">Recommend board</button>
      </div>

      <fieldset>
        <legend>What goes on the card</legend>
        <div class="choice-row" id="content-row">
          ${contentChoices(config.content)}
        </div>
        <div id="custom-block" class="hidden">
          <label class="field">
            <span>Your list <em>(one per line, or “Name | link”)</em></span>
            <textarea id="cfg-custom" rows="5" placeholder="Sunrise&#10;Moonlight&#10;Mount Fuji"></textarea>
          </label>
        </div>
      </fieldset>

      <span id="geometry-block">
        <div class="setup-row">
          <label class="field"><span>Rows</span><select id="cfg-rows">${range(MIN_ROWS, MAX_ROWS).map((n) => `<option value="${n}" ${n === config.rows ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <label class="field"><span>Columns</span><select id="cfg-cols">${range(MIN_COLS, MAX_COLS).map((n) => `<option value="${n}" ${n === config.cols ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        </div>
        <p class="hint" id="cfg-preview"></p>
        <label class="checkbox" id="free-centre-block">
          <input type="checkbox" id="cfg-free" ${config.freeCentre ? 'checked' : ''} /> Free centre space
        </label>
      </span>

      <fieldset>
        <legend>Calling</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="callMode" value="auto" ${config.callMode === 'auto' ? 'checked' : ''} /> Auto — on a timer</label>
          <label class="choice"><input type="radio" name="callMode" value="manual" ${config.callMode === 'manual' ? 'checked' : ''} /> Manual — I call each one</label>
        </div>
        <label class="field" id="interval-block">
          <span>Call speed</span>
          <select id="cfg-interval">${INTERVALS.map(([ms, label]) => `<option value="${ms}" ${ms === config.callIntervalMs ? 'selected' : ''}>${label}</option>`).join('')}</select>
        </label>
      </fieldset>

      <fieldset id="mark-block">
        <legend>Dabbing cards</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="markMode" value="manual" ${config.markMode === 'manual' ? 'checked' : ''} /> Players tap</label>
          <label class="choice"><input type="radio" name="markMode" value="auto" ${config.markMode === 'auto' ? 'checked' : ''} /> Dab automatically</label>
        </div>
        <p class="hint" id="mark-note"></p>
      </fieldset>

      <fieldset>
        <legend>Calling the winner</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="winnerCall" value="manual" ${config.winnerCall === 'manual' ? 'checked' : ''} /> Players shout Bingo</label>
          <label class="choice"><input type="radio" name="winnerCall" value="auto" ${config.winnerCall === 'auto' ? 'checked' : ''} /> The table detects it</label>
        </div>
        <p class="hint" id="winnercall-note"></p>
      </fieldset>

      <fieldset>
        <legend>How many winners</legend>
        <div class="choice-row">
          <label class="choice"><input type="radio" name="winnerMode" value="single" ${config.winnerMode === 'single' ? 'checked' : ''} /> One winner</label>
          <label class="choice"><input type="radio" name="winnerMode" value="multiple" ${config.winnerMode === 'multiple' ? 'checked' : ''} /> Several winners</label>
        </div>
        <label class="field" id="maxwinners-block">
          <span>Winner places <em>(0 = everyone who gets there)</em></span>
          <input id="cfg-maxwinners" type="number" min="0" max="500" value="${config.maxWinners}" />
        </label>
      </fieldset>

      <fieldset>
        <legend>Winning pattern</legend>
        <div id="winning-single">
          <label class="field">
            <span>First to complete</span>
            <select id="cfg-condition">
              ${winningConditions(config.rows, config.cols)
                .map((c) => `<option value="${c.id}" ${matchesCondition(config, c.id) ? 'selected' : ''}>${esc(c.label)}</option>`)
                .join('')}
            </select>
          </label>
        </div>
        <div id="winning-grid" class="hidden">
          <div class="preset-row">
            <button type="button" class="ghost small" data-preset="classic">All lines</button>
            <button type="button" class="ghost small" data-preset="allRows">All rows</button>
            <button type="button" class="ghost small" data-preset="allCols">All columns</button>
            <button type="button" class="ghost small" data-preset="x">Diagonals</button>
            <button type="button" class="ghost small" data-preset="corners">Four corners</button>
            <button type="button" class="ghost small" data-preset="blackout">Blackout</button>
          </div>
          <div class="pattern-list" id="cfg-patterns"></div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Extras</legend>
        <label class="checkbox"><input type="checkbox" id="cfg-leaderboard" ${config.leaderboard ? 'checked' : ''} /> Show the leaderboard</label>
        <label class="checkbox"><input type="checkbox" id="cfg-chat" ${config.chat ? 'checked' : ''} /> Player chat (max ${CHAT_WORD_LIMIT} words)</label>
        <label class="checkbox"><input type="checkbox" id="cfg-reactions" ${config.reactions ? 'checked' : ''} /> Emoji reactions between players</label>
      </fieldset>

      <div class="actions">
        <button type="submit" id="cfg-save">Save settings</button>
        <button type="button" class="ghost" id="cfg-start">Save &amp; start game</button>
      </div>
      <p class="form-error" id="cfg-error"></p>
    </form>`;

  document.getElementById('cfg-custom').value = customToText(config.customItems);
  setContentFields();
  drawPatternList(config.winPatterns);
  applyVisibility();
  updatePreview();

  const form = document.getElementById('config-form');
  form.addEventListener('input', () => {
    configDirty = true;
    document.getElementById('cfg-error').textContent = '';
    applyVisibility();
  });
  form.addEventListener('change', (event) => {
    configDirty = true;
    document.getElementById('cfg-error').textContent = '';
    if (event.target.id === 'cfg-rows' || event.target.id === 'cfg-cols') {
      const next = readForm();
      // Keep the host's chosen winning condition; it stays valid across sizes.
      const conditions = winningConditions(next.rows, next.cols);
      const condition = document.getElementById('cfg-condition');
      const keep = conditions.some((c) => c.id === condition.value) ? condition.value : conditions[0].id;
      condition.innerHTML = conditions
        .map((c) => `<option value="${c.id}" ${c.id === keep ? 'selected' : ''}>${esc(c.label)}</option>`)
        .join('');

      const valid = new Set(availablePatterns(next.rows, next.cols).map((p) => p.id));
      const base =
        next.winnerMode === 'single'
          ? presetPatterns(keep, next.rows, next.cols)
          : next.winPatterns.filter((id) => valid.has(id));
      drawPatternList(base.length ? base : presetPatterns('classic', next.rows, next.cols));
    }
    applyVisibility();
    updatePreview();
  });

  document.getElementById('content-row').addEventListener('click', (event) => {
    const button = event.target.closest('[data-content]');
    if (!button) return;
    document.getElementById('content-row').querySelectorAll('[data-content]').forEach((el) => el.classList.toggle('picked', el === button));
    setContentFields();
    configDirty = true;
    applyVisibility();
    updatePreview();
  });

  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => {
      const next = readForm();
      drawPatternList(presetPatterns(button.dataset.preset, next.rows, next.cols));
      configDirty = true;
      updatePreview();
    });
  });

  document.getElementById('cfg-recommend').addEventListener('click', () => {
    const expected = Number(document.getElementById('cfg-expected').value) || 0;
    const errorEl = document.getElementById('cfg-error');
    if (!expected) {
      errorEl.textContent = 'Enter how many players you expect first.';
      return;
    }
    const rec = recommendBoard(expected);
    document.getElementById('cfg-rows').value = rec.rows;
    document.getElementById('cfg-cols').value = rec.cols;
    drawPatternList(presetPatterns('classic', rec.rows, rec.cols));
    configDirty = true;
    applyVisibility();
    updatePreview();
    errorEl.textContent = `Recommended ${rec.rows} × ${rec.cols} for ~${expected} players (${rec.note}).`;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveConfig(false);
  });
  document.getElementById('cfg-start').addEventListener('click', () => saveConfig(true));
}

function contentChoices(current) {
  const options = [
    ['numbers', '🔢 Numbers'],
    ['names', '👤 Names'],
    ['images', '🖼️ Emoji / images'],
    ['music', '🎵 Music titles'],
    ['mixed', '🎭 Names + images'],
    ['custom', '✏️ My own list'],
  ];
  return options
    .map(([value, label]) => `<button type="button" data-content="${value}" class="ghost small ${value === current ? 'picked' : ''}">${label}</button>`)
    .join('');
}

function setContentFields() {
  const pick = document.querySelector('#content-row [data-content].picked');
  const content = pick ? pick.dataset.content : 'numbers';
  document.getElementById('custom-block').classList.toggle('hidden', content !== 'custom');
}

function matchesCondition(config, id) {
  const target = presetPatterns(id, config.rows, config.cols);
  return target.length === config.winPatterns.length && target.every((p) => config.winPatterns.includes(p));
}

function customToText(items) {
  if (!Array.isArray(items)) return '';
  return items
    .map((i) => (typeof i === 'string' ? i : `${i && i.label ? i.label : ''}${i && i.media ? ` | ${i.media}` : ''}`))
    .join('\n');
}

function parseCustom(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, media] = line.split('|').map((part) => (part || '').trim());
      return media ? { label, media } : label;
    });
}

function range(from, to) {
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(n);
  return out;
}

function drawPatternList(selected) {
  const container = document.getElementById('cfg-patterns');
  if (!container) return;
  const rows = Number(document.getElementById('cfg-rows').value);
  const cols = Number(document.getElementById('cfg-cols').value);
  const set = new Set(selected);
  container.innerHTML = availablePatterns(rows, cols)
    .map((p) => `<label class="pattern"><input type="checkbox" name="pattern" value="${p.id}" ${set.has(p.id) ? 'checked' : ''} /> ${esc(p.label)}</label>`)
    .join('');
}

function readForm() {
  const contentPick = document.querySelector('#content-row [data-content].picked');
  const content = contentPick ? contentPick.dataset.content : 'numbers';
  const rows = Number(document.getElementById('cfg-rows').value);
  const cols = Number(document.getElementById('cfg-cols').value);
  const winnerMode = document.querySelector('input[name="winnerMode"]:checked').value;
  const patterns =
    winnerMode === 'single'
      ? presetPatterns(document.getElementById('cfg-condition').value, rows, cols)
      : [...document.querySelectorAll('input[name="pattern"]:checked')].map((el) => el.value);

  const config = {
    rows,
    cols,
    content,
    freeCentre: document.getElementById('cfg-free').checked,
    callMode: document.querySelector('input[name="callMode"]:checked').value,
    callIntervalMs: Number(document.getElementById('cfg-interval').value),
    markMode: document.querySelector('input[name="markMode"]:checked').value,
    winnerCall: document.querySelector('input[name="winnerCall"]:checked').value,
    winnerMode,
    maxWinners: Number(document.getElementById('cfg-maxwinners').value),
    winPatterns: patterns,
    leaderboard: document.getElementById('cfg-leaderboard').checked,
    chat: document.getElementById('cfg-chat').checked,
    reactions: document.getElementById('cfg-reactions').checked,
    expectedPlayers: Number(document.getElementById('cfg-expected').value) || 0,
  };
  if (content === 'custom') config.customItems = parseCustom(document.getElementById('cfg-custom').value);
  return config;
}

/** Mirrors the server's `fieldVisibility` so the form only shows what matters. */
function applyVisibility() {
  const config = readForm();
  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  };

  const oddBoard = config.rows % 2 === 1 && config.cols % 2 === 1;
  show('free-centre-block', oddBoard);
  show('interval-block', config.callMode === 'auto');
  show('maxwinners-block', config.winnerMode === 'multiple');
  show('winning-single', config.winnerMode === 'single');
  show('winning-grid', config.winnerMode === 'multiple');

  const markNote = document.getElementById('mark-note');
  if (markNote) {
    markNote.textContent =
      config.winnerCall === 'auto'
        ? 'With automatic winner call-out the table watches the called items, so dabbing is just for fun.'
        : 'Players must dab an item before it counts toward their pattern.';
  }

  const winnerNote = document.getElementById('winnercall-note');
  if (winnerNote) {
    winnerNote.textContent =
      config.winnerCall === 'auto'
        ? 'The table declares a winner the moment a card completes the pattern — no shouting needed.'
        : 'Players press Bingo; the table verifies the claim.';
  }
}

function updatePreview() {
  const preview = document.getElementById('cfg-preview');
  if (!preview) return;
  const config = readForm();
  const perColumn = config.content === 'numbers' ? numbersPerColumn(config.rows, config.cols) : null;
  const v = variety(config.rows, config.cols, perColumn || undefined);
  const free = hasFreeCentre(config.rows, config.cols, config.freeCentre);
  const cells = config.rows * config.cols;
  const detail =
    config.content === 'numbers'
      ? `${cells} cells · ${free ? cells - 1 : cells} numbers per card · ${perColumn * config.cols} to call`
      : `${cells} cells · ${free ? cells - 1 : cells} items per card`;
  preview.textContent = `${detail} · card variety: ${config.content === 'numbers' ? v.level : 'depends on your list'}`;
}

async function saveConfig(thenStart) {
  const errorEl = document.getElementById('cfg-error');
  const draft = readForm();
  const patternCount = draft.winnerMode === 'single' ? 1 : draft.winPatterns.length;
  if (patternCount === 0) {
    errorEl.textContent = 'Pick at least one winning pattern.';
    return;
  }

  const saveButton = document.getElementById('cfg-save');
  const startButton = document.getElementById('cfg-start');
  saveButton.disabled = true;
  startButton.disabled = true;

  const { ok, data } = await api(`/api/room/${state.room.code}/config`, { method: 'POST', body: { config: draft } });
  if (!ok) {
    errorEl.textContent = messageFor(data);
    saveButton.disabled = false;
    startButton.disabled = false;
    return;
  }

  configDirty = false;
  applyState(data);
  poolVersion = null;

  if (thenStart) {
    const started = await api(`/api/room/${state.room.code}/start`, { method: 'POST', body: {} });
    if (!started.ok) {
      errorEl.textContent = messageFor(started.data);
      saveButton.disabled = false;
      startButton.disabled = false;
      return;
    }
    applyState(started.data);
  }

  currentSkeleton = '';
  renderSkeleton();
  toast(thenStart ? 'Game on!' : 'Settings saved');
}

function configSummary(config) {
  const patterns = config.winPatterns.length;
  return [
    `${config.content} board ${config.rows}×${config.cols}`,
    config.callMode === 'auto' ? `auto call every ${Math.round(config.callIntervalMs / 1000)}s` : 'manual calling',
    config.markMode === 'auto' ? 'auto dabbing' : 'players dab',
    config.winnerCall === 'auto' ? 'auto winner call-out' : 'players shout bingo',
    config.winnerMode === 'single' ? 'one winner' : `${config.maxWinners || 'unlimited'} winners`,
    `${patterns} winning pattern${patterns === 1 ? '' : 's'}`,
  ].join(' · ');
}

function hostControlsHtml() {
  const { room } = state;
  if (room.status !== 'playing') return '<p class="hint">Start the next round from the results screen.</p>';
  return `
    <div class="actions">
      ${
        room.config.callMode === 'manual'
          ? `<button id="call-next">Call next item</button>
             <input id="call-number" type="number" min="1" max="${room.config.poolSize}" placeholder="${
               room.config.content === 'numbers' ? 'or type a number' : `or item # (1-${room.config.poolSize})`
             }" class="inline-number" />`
          : '<span class="hint" id="host-next">Calling automatically…</span>'
      }
      <button class="ghost small" id="end-round">End round</button>
    </div>`;
}

function attachHostControls() {
  const next = document.getElementById('call-next');
  if (next) next.addEventListener('click', () => hostCall(next));
  const end = document.getElementById('end-round');
  if (end) end.addEventListener('click', () => hostAction('end'));
}

// ------------------------------------------------------------- rendering ---

function applyState(data) {
  const room = data.room;
  if (!room) return;
  if (room.round !== lastRound) {
    calledList = [];
    lastRound = room.round;
    leaderboard = null;
    pieceSigs['leaderboard-panel'] = '';
  }
  if (Array.isArray(room.called)) calledList = room.called.slice();
  else if (Array.isArray(room.calledTail)) {
    calledList = calledList.slice(0, room.calledCount).concat(room.calledTail);
  }
  state = data;
  viewer = data.viewer;
}

function calledSet() {
  return new Set(calledList);
}

function updatePieces() {
  if (!state || !state.room) return;
  updateTopbar();
  updateStadium();
  if (isHost()) renderStudioPanel();
  else updateCard();
  updateBoard();
  updateRoster();
  updateLeaderboard();
  updateSocial();
  updateOverlay();
}

function updateTopbar() {
  const { room } = state;
  const sig = [room.status, room.round, room.playerCount, room.config.callMode, room.hostName, isHost()].join('|');
  const changed = setPiece(
    'topbar',
    sig,
    `<button class="code-chip" id="copy-code" title="Copy invite link">${esc(room.code)} <small>copy</small></button>
     <span class="status-pill ${room.status}">${STATUS_LABEL[room.status] || room.status}${room.status === 'playing' ? ` · round ${room.round}` : ''}</span>
     ${room.status === 'playing' && room.config.callMode === 'auto' ? '<span class="status-pill" id="countdown">next…</span>' : ''}
     <span class="status-pill">👥 ${room.playerCount}/${room.maxPlayers}</span>
     ${room.expectedPlayers ? `<span class="status-pill">expected ~${room.expectedPlayers}</span>` : ''}
     <span class="status-pill">${calledList.length}/${room.config.poolSize} called</span>
     <span class="spacer"></span>
     ${room.status === 'playing' && !isHost() ? '<span class="status-pill">🎙️ host is calling</span>' : ''}
     <span class="status-pill">${isHost() ? '🎙️ Hosting' : esc((viewer && viewer.avatar) || '') + ' ' + esc(viewer ? viewer.name : '')}</span>
     <button class="ghost small" id="leave">${isHost() ? 'Close table' : 'Leave table'}</button>`
  );
  if (changed) attachTopbarHandlers();
}

function attachTopbarHandlers() {
  const copy = document.getElementById('copy-code');
  if (copy) {
    copy.addEventListener('click', async () => {
      const url = `${location.origin}/?table=${state.room.code}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Invite link copied');
      } catch {
        toast(`Table code: ${state.room.code}`);
      }
    });
  }
  const leave = document.getElementById('leave');
  if (leave) {
    leave.addEventListener('click', async () => {
      leave.disabled = true;
      if (isHost()) {
        saveSession(null);
        renderHome();
        return;
      }
      await api(`/api/room/${state.room.code}/leave`, { method: 'POST', body: {} });
      saveSession(null);
      renderHome();
    });
  }
}

// -------------------------------------------------------------- stadium ----

/** Sender/receiver positions for the flying-emoji animation. */
function nodeForId(id) {
  return document.querySelector(`[data-avatar-id="${CSS.escape(id)}"]`);
}

function updateStadium() {
  const { room } = state;
  const players = roster ? roster.players : [];
  const sig = [
    room.status,
    roster ? roster.version : 'none',
    roster ? roster.online : 0,
    calledList.length,
    room.config.content,
    selectedTarget || '',
    isHost() ? 'h' : 'p',
  ].join('|');
  if (pieceSigs['stadium-panel'] === sig) return;
  pieceSigs['stadium-panel'] = sig;

  const panel = document.getElementById('stadium-panel');
  if (!panel) return;

  const ring = players.slice(0, RING_CAP);
  const count = ring.length;
  const avatars = ring
    .map((p, i) => {
      const angle = count > 0 ? (i / count) * Math.PI * 2 - Math.PI / 2 : 0;
      const x = 50 + 44 * Math.cos(angle);
      const y = 50 + 44 * Math.sin(angle);
      return `<button class="seat ${selectedTarget === p.id ? 'selected' : ''} ${p.online ? '' : 'idle'}"
                style="left:${x}%;top:${y}%" data-avatar-id="${p.id}" data-target="${p.id}"
                title="${esc(p.name)}">
                <span class="seat-face">${esc(p.avatar || '🙂')}</span>
                <span class="seat-name">${esc(p.name)}</span>
              </button>`;
    })
    .join('');

  const lastCalled = calledList.length ? calledList[calledList.length - 1] : null;

  panel.innerHTML = `
    <div class="stadium">
      <div class="ring">${avatars}</div>
      <div class="table-centre" data-avatar-id="${esc((viewer && viewer.id) || 'host')}">
        <span class="table-host">🎙️</span>
        <span class="table-name">${esc(room.hostName || 'Host')}</span>
        <span class="table-call">${lastCalled !== null ? esc(itemLabel(lastCalled)) : '·'}</span>
        <span class="table-label">${room.status === 'playing' ? `${calledList.length}/${room.config.poolSize} called` : STATUS_LABEL[room.status]}</span>
      </div>
      <div class="fly-layer" id="fly-layer"></div>
    </div>
    ${
      players.length > RING_CAP
        ? `<p class="hint seats-more">Showing ${RING_CAP} of ${players.length} seats around the table, plus ${players.length - RING_CAP} more in the list below.</p>`
        : ''
    }`;

  panel.querySelectorAll('[data-target]').forEach((node) => {
    node.addEventListener('click', () => {
      selectedTarget = selectedTarget === node.dataset.target ? null : node.dataset.target;
      pieceSigs['stadium-panel'] = '';
      updateStadium();
      updateSocial();
    });
  });
}

function playReactionFlight(reaction) {
  const layer = document.getElementById('fly-layer');
  if (!layer) return;
  const fromNode = nodeForId(reaction.fromId);
  const toNode = nodeForId(reaction.toId);
  if (!fromNode || !toNode) return;

  const layerBox = layer.getBoundingClientRect();
  const fromBox = fromNode.getBoundingClientRect();
  const toBox = toNode.getBoundingClientRect();
  const startX = fromBox.left + fromBox.width / 2 - layerBox.left;
  const startY = fromBox.top + fromBox.height / 2 - layerBox.top;
  const endX = toBox.left + toBox.width / 2 - layerBox.left;
  const endY = toBox.top + toBox.height / 2 - layerBox.top;
  const midX = (startX + endX) / 2 + (startY < endY ? 40 : -40);

  const node = document.createElement('span');
  node.className = 'fly-emoji';
  node.textContent = reaction.emoji;
  node.style.left = `${startX}px`;
  node.style.top = `${startY}px`;
  layer.appendChild(node);

  const animation = node.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0.2 },
      { transform: `translate(${midX - startX}px, ${midYOffset(startY, endY)}px) translate(-50%, -50%) scale(1.5)`, opacity: 1, offset: 0.5 },
      { transform: `translate(${endX - startX}px, ${endY - startY}px) translate(-50%, -50%) scale(1)`, opacity: 0.9 },
    ],
    { duration: 1400, easing: 'cubic-bezier(.3,.7,.4,1)' }
  );
  animation.onfinish = () => node.remove();
  animation.oncancel = () => node.remove();
}

/** Small arc so the emoji lifts between two seats instead of sliding flat. */
function midYOffset(startY, endY) {
  return (endY - startY) / 2 - 46;
}

// ------------------------------------------------------------ card / play --

function updateCard() {
  const { room, you } = state;
  if (!you) return;
  const config = room.config;
  const marked = new Set(you.marked);
  const called = calledSet();
  const highlight = new Set();
  for (const id of you.patterns) {
    const cells = patternCells(id, config.rows, config.cols);
    if (cells) for (const [r, c] of cells) highlight.add(`${r},${c}`);
  }

  const sig = [room.round, config.rows, config.cols, config.markMode, calledList.length, you.markedCount, you.patterns.length, room.status, config.content, poolVersion].join('|');
  if (pieceSigs['card-panel'] === sig) return;
  pieceSigs['card-panel'] = sig;

  const panel = document.getElementById('card-panel');
  if (!panel) return;

  const canDab = room.status === 'playing' && config.markMode === 'manual' && config.winnerCall === 'manual';
  const cardHtml = you.card
    .map((row, r) =>
      row
        .map((index, c) => {
          if (index === null) return '<button class="free" disabled>FREE</button>';
          const classes = ['cell'];
          const isMarked = marked.has(index);
          const isCalled = called.has(index);
          if (isMarked || (config.markMode === 'auto' && isCalled)) classes.push('marked');
          else if (isCalled) classes.push('called');
          if (highlight.has(`${r},${c}`)) classes.push('in-pattern');
          const disabled = !canDab || !isCalled;
          return `<button class="${classes.join(' ')}" data-index="${index}" ${disabled ? 'disabled' : ''}>${cellHtml(index)}</button>`;
        })
        .join('')
    )
    .join('');

  const claimable = you.canClaim && !you.won;
  const slots = room.winnerSlots === 0 ? null : room.winnerSlots - room.winners.length;

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Your card</h2>
      <span class="hint">${
        you.patterns.length > 0
          ? `${you.patterns.length}/${config.winPatterns.length} complete!`
          : config.markMode === 'auto' || config.winnerCall === 'auto'
            ? 'Dabbing happens for you'
            : 'Tap a called item to dab it'
      }</span>
    </div>
    <div class="column-labels" style="--cols:${config.cols}">${room.columnLabels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>
    <div class="card-grid" id="card" style="--cols:${config.cols}" data-content="${config.content}">${cardHtml}</div>

    ${
      config.winnerCall === 'manual'
        ? `<div class="actions"><button class="bingo-btn" id="bingo" ${claimable ? '' : 'disabled'}>${you.won ? 'Bingo — you won!' : 'Bingo!'}</button></div>`
        : `<p class="hint">This table declares the winner automatically — just enjoy the game.</p>`
    }
    <p class="hint">${
      you.won
        ? 'You are on the winners list. 🎉'
        : config.winnerCall === 'auto'
          ? `Closest pattern: ${you.best.done}/${you.best.total}`
          : config.markMode === 'manual' && you.missed > 0
            ? `⚠️ ${you.missed} called item${you.missed > 1 ? 's' : ''} not dabbed yet`
            : `Closest pattern: ${you.best.done}/${you.best.total}`
    }</p>
    <p class="hint">Winning: ${esc(
      config.winPatterns.map((id) => patternLabel(id, config.rows, config.cols)).join(', ')
    )}${slots === null ? ' · unlimited winners' : ` · ${Math.max(0, slots)} place${slots === 1 ? '' : 's'} left`}</p>`;

  const card = document.getElementById('card');
  if (card) {
    card.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-index]');
      if (!button || button.disabled) return;
      markItem(Number(button.dataset.index));
    });
  }
  const bingo = document.getElementById('bingo');
  if (bingo) bingo.addEventListener('click', () => claimBingo(bingo));
}

function patternLabel(id, rows, cols) {
  const found = availablePatterns(rows, cols).find((p) => p.id === id);
  return found ? found.label : id;
}

function updateBoard() {
  const { room } = state;
  const config = room.config;
  const called = calledSet();
  const lastCalled = calledList.length ? calledList[calledList.length - 1] : null;
  const sig = [room.round, config.cols, config.perColumn, calledList.length, room.status, config.callMode, poolVersion].join('|');
  if (pieceSigs['board-panel'] === sig) return;
  pieceSigs['board-panel'] = sig;

  const panel = document.getElementById('board-panel');
  if (!panel) return;

  const boardHtml = room.columnLabels
    .map((label, c) => {
      const cells = [];
      for (let i = 0; i < config.perColumn; i += 1) {
        const index = c * config.perColumn + i;
        const cls = ['board-cell'];
        if (called.has(index)) cls.push('called');
        if (index === lastCalled) cls.push('latest');
        cells.push(`<div class="${cls.join(' ')}" title="${esc(itemLabel(index))}">${cellHtml(index)}</div>`);
      }
      return `<div class="board-col">${cells.join('')}</div>`;
    })
    .join('');

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Called items</h2>
      <span class="hint">${calledList.length}/${config.poolSize}</span>
    </div>
    <div class="latest-call">
      <div class="big">${lastCalled !== null ? cellHtml(lastCalled) : '–'}<small>last call</small></div>
      <div class="meta">${
        room.status === 'playing'
          ? config.callMode === 'auto'
            ? `${room.remaining} left · every ${Math.round(config.callIntervalMs / 1000)}s`
            : `${room.remaining} left · the host calls each one`
          : room.status === 'lobby'
            ? 'The game starts when the host is ready.'
            : 'Round finished.'
      }</div>
    </div>
    <div class="column-labels" style="--cols:${config.cols}">${room.columnLabels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>
    <div class="board" style="--cols:${config.cols}" data-content="${config.content}">${boardHtml}</div>`;
}

function updateRoster() {
  const players = roster ? roster.players : [];
  const sig = [roster ? roster.version : 'none', roster ? roster.online : 0, roster ? roster.total : 0, roster ? roster.expected : 0, state.room.status].join('|');
  if (pieceSigs['roster-panel'] === sig) return;
  pieceSigs['roster-panel'] = sig;

  const panel = document.getElementById('roster-panel');
  if (!panel) return;

  if (!roster) {
    panel.innerHTML = `<div class="panel-head"><h2>Players</h2></div><p class="hint">Loading…</p>`;
    return;
  }

  const shown = players.slice(0, ROSTER_RENDER_CAP);
  panel.innerHTML = `
    <div class="panel-head">
      <h2>Players</h2>
      <span class="hint">${roster.total} joined${roster.expected ? ` · ~${roster.expected} expected` : ''} · ${roster.online} online</span>
    </div>
    <ul class="players">
      ${shown
        .map(
          (p) => `<li class="player ${selectedTarget === p.id ? 'you' : ''}">
            <span class="avatar-mini">${esc(p.avatar || '🙂')}</span>
            <span class="name">${esc(p.name)}</span>
            <span class="badges">${p.online ? '' : '<span class="badge">idle</span>'}</span>
          </li>`
        )
        .join('')}
    </ul>
    ${roster.total > shown.length ? `<p class="hint">…and ${roster.total - shown.length} more.</p>` : ''}
    <p class="hint">The host can start with any number of players — no minimum.</p>`;
}

function updateLeaderboard() {
  const { room } = state;
  const panel = document.getElementById('leaderboard-panel');
  if (!room.config.leaderboard) return;
  if (!panel) return;

  if (!leaderboard) {
    if (pieceSigs['leaderboard-panel'] !== 'pending') {
      pieceSigs['leaderboard-panel'] = 'pending';
      panel.innerHTML = `<div class="panel-head"><h2>Leaderboard</h2></div><p class="hint">Loading…</p>`;
    }
    return;
  }
  if (leaderboard.error) {
    if (pieceSigs['leaderboard-panel'] !== leaderboard.error) {
      pieceSigs['leaderboard-panel'] = leaderboard.error;
      panel.innerHTML = `<div class="panel-head"><h2>Leaderboard</h2></div><p class="hint">Switched off.</p>`;
    }
    return;
  }

  const sig = JSON.stringify([leaderboard.calledCount, leaderboard.total, leaderboard.entries.map((e) => [e.id, e.won, e.bestDone, e.rank])]);
  if (pieceSigs['leaderboard-panel'] === sig) return;
  pieceSigs['leaderboard-panel'] = sig;

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Leaderboard</h2>
      <span class="hint">by possible wins · ${leaderboard.total} players</span>
    </div>
    <ol class="players leaderboard">
      ${leaderboard.entries
        .map((e) => {
          const pct = e.bestTotal ? Math.round((e.bestDone / e.bestTotal) * 100) : 0;
          return `<li class="player ${e.isYou ? 'you' : ''}">
            <span class="rank">#${e.rank}</span>
            <span class="avatar-mini">${esc(e.avatar || '🙂')}</span>
            <span class="name">${esc(e.name)}${e.isYou ? ' (you)' : ''}</span>
            <span class="badges">
              <span class="badge ${e.won > 0 ? 'win' : ''}">${e.won}/${leaderboard.patternsTotal} won</span>
              <span class="badge">${pct}%</span>
            </span>
          </li>`;
        })
        .join('')}
    </ol>`;
}

// --------------------------------------------------------------- social ---

function updateSocial() {
  const { room } = state;
  const panel = document.getElementById('social-panel');
  if (!panel) return;
  const sig = JSON.stringify([room.config.chat, room.config.reactions, chatLog.length, chatCursor, selectedTarget, room.status]);
  if (pieceSigs['social-panel'] === sig) return;
  pieceSigs['social-panel'] = sig;

  const target = roster && selectedTarget ? roster.players.find((p) => p.id === selectedTarget) : null;

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Table talk</h2>
      <span class="hint">${room.config.chat ? `${CHAT_WORD_LIMIT} words max` : 'chat off'}${room.config.reactions ? ' · tap a seat to react' : ''}</span>
    </div>
    <div class="social-grid">
      ${
        room.config.chat
          ? `<div class="chat">
              <div class="chat-log" id="chat-log">
                ${chatLog
                  .slice(-40)
                  .map(
                    (m) => `<p class="chat-line ${viewer && m.playerId === viewer.id ? 'mine' : ''}">
                      <span class="chat-avatar">${esc(m.avatar || '🙂')}</span>
                      <span class="chat-name">${esc(m.name)}</span>
                      <span class="chat-body">${esc(m.body)}</span>
                    </p>`
                  )
                  .join('')}
              </div>
              <form class="chat-form" id="chat-form">
                <input id="chat-input" maxlength="200" placeholder="Say something (max ${CHAT_WORD_LIMIT} words)" autocomplete="off" />
                <button type="submit" id="chat-send">Send</button>
              </form>
              <p class="hint tiny" id="chat-count"></p>
            </div>`
          : ''
      }
      ${
        room.config.reactions
          ? `<div class="reactions">
              <p class="hint">${target ? `Send to <strong>${esc(target.name)}</strong>` : 'Tap a seat in the stadium to pick someone'}</p>
              <div class="emoji-row">
                ${REACTION_EMOJIS.map((e) => `<button type="button" class="emoji-btn" data-emoji="${e}" ${target ? '' : 'disabled'}>${e}</button>`).join('')}
              </div>
            </div>`
          : ''
      }
    </div>`;

  const log = document.getElementById('chat-log');
  if (log) log.scrollTop = log.scrollHeight;

  panel.querySelectorAll('[data-emoji]').forEach((button) => {
    button.addEventListener('click', () => sendReaction(button.dataset.emoji));
  });

  const form = document.getElementById('chat-form');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      sendChat();
    });
    const input = document.getElementById('chat-input');
    const count = document.getElementById('chat-count');
    const update = () => {
      const words = input.value.trim().split(/\s+/).filter(Boolean).length;
      count.textContent = `${words}/${CHAT_WORD_LIMIT} words`;
      count.classList.toggle('over', words > CHAT_WORD_LIMIT);
      document.getElementById('chat-send').disabled = words === 0 || words > CHAT_WORD_LIMIT;
    };
    input.addEventListener('input', update);
    update();
  }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const body = input.value.trim();
  if (!body) return;
  const { ok, data } = await api(`/api/room/${state.room.code}/chat`, { method: 'POST', body: { body } });
  if (!ok) {
    toast(messageFor(data));
    return;
  }
  input.value = '';
  const count = document.getElementById('chat-count');
  if (count) {
    count.textContent = `0/${CHAT_WORD_LIMIT} words`;
    count.classList.remove('over');
  }
  await refreshSocial();
}

async function sendReaction(emoji) {
  if (!selectedTarget) {
    toast('Tap a seat first to choose who gets the emoji.');
    return;
  }
  const { ok, data } = await api(`/api/room/${state.room.code}/react`, {
    method: 'POST',
    body: { to: selectedTarget, emoji },
  });
  if (!ok) {
    toast(messageFor(data));
    return;
  }
  selectedTarget = null;
  pieceSigs['stadium-panel'] = '';
  updateStadium();
  await refreshSocial();
  updateSocial();
}

async function refreshSocial() {
  if (!session || !state || !state.room) return;
  const { chat, reactions } = state.room.config;

  if (chat) {
    const { ok, data } = await api(`/api/room/${session.code}/chat?since=${chatCursor}`);
    if (ok && data.enabled !== false && Array.isArray(data.messages)) {
      if (data.messages.length) {
        chatLog = chatLog.concat(data.messages);
        if (chatLog.length > 200) chatLog = chatLog.slice(-200);
        chatCursor = data.cursor || chatCursor;
        updateSocial();
      }
    }
  }

  if (reactions) {
    const { ok, data } = await api(`/api/room/${session.code}/reactions?since=${reactionCursor}`);
    if (ok && data.enabled !== false && Array.isArray(data.reactions)) {
      if (data.reactions.length) {
        reactionCursor = data.cursor || reactionCursor;
        for (const reaction of data.reactions) playReactionFlight(reaction);
        const last = data.reactions[data.reactions.length - 1];
        toast(`${last.fromName} → ${last.toName} ${last.emoji}`);
      }
    }
  }
}

// -------------------------------------------------------------- overlay ----

function updateOverlay() {
  const { room } = state;
  const sig = [room.status, room.round, room.winners.map((w) => `${w.rank}:${w.name}`).join(','), isHost(), room.endedReason].join('|');
  if (pieceSigs['overlay'] === sig) return;
  pieceSigs['overlay'] = sig;

  const node = document.getElementById('overlay');
  if (!node) return;

  if (room.status !== 'finished') {
    node.innerHTML = '';
    return;
  }

  const winners = room.winners;
  const title = winners.length === 0 ? 'Round over' : winners.length === 1 ? 'BINGO!' : `${winners.length} winners!`;
  const reason = { items_exhausted: 'All items were called.', host_ended: 'The host ended the round.', winners_complete: '' }[room.endedReason] || '';

  node.innerHTML = `
    <div class="overlay">
      <div class="winner-card">
        <div class="trophy">${winners.length ? '🎉' : '🤷'}</div>
        <h2>${esc(title)}</h2>
        ${
          winners.length
            ? `<ul class="winner-list">${winners
                .map(
                  (w) => `<li><span class="rank">#${w.rank}</span> <span class="name">${esc(w.name)}</span>
                    <span class="hint">${esc(patternLabel(w.pattern, room.config.rows, room.config.cols))} · after ${w.calledCount} calls</span></li>`
                )
                .join('')}</ul>`
            : `<p>${esc(reason || 'Nobody completed the pattern.')}</p>`
        }
        ${isHost() ? '<button class="wide" id="overlay-again">Start a new round</button>' : '<p class="hint">Waiting for the host…</p>'}
      </div>
    </div>`;

  const again = document.getElementById('overlay-again');
  if (again) {
    again.addEventListener('click', async () => {
      again.disabled = true;
      const { ok, data } = await api(`/api/room/${state.room.code}/start`, { method: 'POST', body: {} });
      if (ok) {
        applyState(data);
        currentSkeleton = '';
        renderSkeleton();
      } else {
        toast(messageFor(data));
        again.disabled = false;
      }
    });
  }
}

// --------------------------------------------------------------- actions ---

async function markItem(index) {
  if (!state || state.room.status !== 'playing') return;
  const { ok, data } = await api(`/api/room/${state.room.code}/mark`, { method: 'POST', body: { index } });
  if (ok && data.room) {
    applyState(data);
    updatePieces();
  } else if (!ok && data.error !== 'not_called') {
    toast(messageFor(data));
  }
}

async function claimBingo(button) {
  button.disabled = true;
  const { ok, data } = await api(`/api/room/${state.room.code}/bingo`, { method: 'POST', body: {} });
  if (ok && data.room) {
    applyState(data);
    currentSkeleton = '';
    renderSkeleton();
  } else {
    toast(messageFor(data));
    button.disabled = false;
    button.classList.add('shake');
    setTimeout(() => button.classList.remove('shake'), 450);
  }
}

async function hostCall(button) {
  button.disabled = true;
  const input = document.getElementById('call-number');
  const typed = input && input.value !== '' ? Number(input.value) : null;
  const body = typed === null ? {} : { index: typed - 1 };
  const { ok, data } = await api(`/api/room/${state.room.code}/call`, { method: 'POST', body });
  button.disabled = false;
  if (ok) {
    applyState(data);
    if (input) input.value = '';
    updatePieces();
  } else {
    toast(messageFor(data));
  }
}

async function hostAction(action) {
  const { ok, data } = await api(`/api/room/${state.room.code}/${action}`, { method: 'POST', body: {} });
  if (ok) {
    applyState(data);
    currentSkeleton = '';
    renderSkeleton();
  } else {
    toast(messageFor(data));
  }
}

// -------------------------------------------------------------- polling ----

function pollDelay() {
  const count = state && state.room ? state.room.playerCount : 0;
  const base = count > 250 ? 2000 : count > 100 ? 1500 : count > 40 ? 1200 : ACTIVE_MS;
  return document.hidden ? Math.max(base * 2, HIDDEN_MS) : base;
}

function startPolling() {
  stopPolling();
  const generation = ++pollGeneration;

  const loop = async () => {
    await refresh();
    if (generation !== pollGeneration) return;
    pollTimer = setTimeout(loop, pollDelay());
  };
  loop();

  countdownTimer = setInterval(updateCountdown, 250);
  timersTimer = setInterval(() => {
    refreshRosterIfStale();
    refreshLeaderboardIfDue();
    refreshSocialIfDue();
  }, 500);
}

function stopPolling() {
  pollGeneration += 1;
  if (pollTimer) clearTimeout(pollTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  if (timersTimer) clearInterval(timersTimer);
  pollTimer = null;
  countdownTimer = null;
  timersTimer = null;
}

async function refresh() {
  if (!session) return;
  const { ok, status, data } = await api(`/api/room/${session.code}/state?since=${calledList.length}`);
  if (!ok) {
    if (status === 404) {
      saveSession(null);
      renderHome('That table is no longer available.');
    }
    return;
  }
  applyState(data);
  lastStateAt = Date.now();

  if (data.viewer === null) {
    saveSession(null);
    renderHome('Your seat at that table expired. Please join again.');
    return;
  }

  ensurePool();
  renderSkeleton();
  updatePieces();
  refreshRosterIfStale();
  refreshLeaderboardIfDue();
  refreshSocialIfDue();
}

async function ensurePool() {
  const { room } = state;
  if (!room) return;
  if (room.config.content === 'numbers') return; // labels are just index + 1
  if (poolVersion === room.poolVersion && pool) return;
  const { ok, data } = await api(`/api/room/${session.code}/pool?since=${poolVersion === null ? -1 : poolVersion}`);
  if (!ok) return;
  if (data.changed === false) return;
  pool = data;
  poolVersion = data.version;
  pieceSigs['card-panel'] = '';
  pieceSigs['board-panel'] = '';
}

async function refreshRosterIfStale() {
  if (!session || !state || !state.room) return;
  const versionChanged = !roster || roster.version !== state.room.rosterVersion;
  const stale = Date.now() - lastRosterAt > ROSTER_STALE_MS;
  if (!versionChanged && !stale) return;
  lastRosterAt = Date.now();
  const { ok, data } = await api(`/api/room/${session.code}/players?since=${roster ? roster.version : -1}`);
  if (!ok || data.changed === false) return;
  roster = data;
  updateStadium();
  updateRoster();
  updateSocial();
}

async function refreshLeaderboardIfDue() {
  if (!session || !state || !state.room) return;
  if (!state.room.config.leaderboard) return;
  if (Date.now() - lastLeaderboardAt < LEADERBOARD_MS) return;
  lastLeaderboardAt = Date.now();
  const { ok, data } = await api(`/api/room/${session.code}/leaderboard?limit=50`);
  leaderboard = ok ? data : { error: data.error || 'unavailable' };
  updateLeaderboard();
}

async function refreshSocialIfDue() {
  if (!state || !state.room) return;
  const { chat, reactions } = state.room.config;
  if (!chat && !reactions) return;
  if (Date.now() - lastSocialAt < SOCIAL_MS) return;
  lastSocialAt = Date.now();
  await refreshSocial();
}

function updateCountdown() {
  if (!state || state.room.status !== 'playing') return;
  const countdown = typeof state.room.nextCallInMs === 'number';
  const remaining = countdown ? Math.max(0, state.room.nextCallInMs - (Date.now() - lastStateAt)) : null;
  const text = !countdown ? 'next soon' : remaining > 0 ? `next in ${(remaining / 1000).toFixed(1)}s` : 'calling…';

  const el = document.getElementById('countdown');
  if (el) el.textContent = text;

  // The host's own panel keeps its live next-call hint too.
  const host = document.getElementById('host-next');
  if (host) host.textContent = `Calling automatically · ${text}`;
}

// ------------------------------------------------------------------ boot ---

function boot() {
  const params = new URLSearchParams(location.search);
  const tableFromUrl = (params.get('table') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (!session || !session.code) {
    renderHome();
    if (tableFromUrl.length === 5) {
      const codeEl = document.getElementById('code');
      if (codeEl) codeEl.value = tableFromUrl;
    }
    return;
  }

  renderLoading();
  startPolling();
}

boot();
