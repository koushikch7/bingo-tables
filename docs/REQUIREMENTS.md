# Multiplayer Bingo Tables — Requirements & Implementation

End-to-end specification: what the product must do, how each requirement is
implemented, and how each one is verified.

- **Stack:** Cloudflare Worker (Hono-free, plain `fetch`) + D1 (SQLite) + static assets in `public/`.
- **Entry points:** `src/worker.js` (server), `public/game.js` (shared rules), `public/app.js` (client), `public/styles.css`.
- **Tests:** `test/game.test.js` (unit), `scripts/smoke.mjs` (end-to-end over HTTP).
- **Run:** `npm run dev` → `http://127.0.0.1:3000`.

---

## 1. Product scope

A single live "table" that a host sets up and runs while 4–500 players play
bingo on their own devices. The host is an **administrator, not a player**:
they configure, start, call and end; they never hold a card and can never win.

Three ideas hold the whole design together (documented in `public/game.js`):

1. **Cards are derived, never stored** — a pure function of
   `(room seed, round, player id)`. Dealing costs the same for 4 or 500 players.
2. **A room has a pool of callable items.** A cell stores the item's *index*
   into that pool, so numbers, names, emoji, song titles and host-supplied
   lists all flow through one rule engine.
3. **The rules live in one shared module** (`public/game.js`) imported by both
   the Worker and the browser, so server validation and UI rendering can never
   drift apart.

---

## 2. Roles and lifecycle

### 2.1 Roles

| | Host | Player |
|---|---|---|
| Row in `players` | yes, `role = 'host'` | yes, `role = 'player'` |
| Auth token | yes (`x-player-token`) | yes |
| Card | **none** | one per round |
| Can mark / claim Bingo | **no — 403 `host_cannot_play`** | yes |
| Can configure / start / call / end | **yes — 403 `host_only` otherwise** | no |
| Can be reaction target | **no — 404 `unknown_player`** | yes |
| Leaving | clears local session ("Close table") | `POST /leave` deletes the seat |

### 2.2 Room states

```
lobby ──start──▶ playing ──winners_complete / items_exhausted / host_ended──▶ finished
  ▲                                                                        │
  └───────────────────────── start (new round) ─────────────────────────────┘
```

| Status | Meaning | Settings |
|---|---|---|
| `lobby` | Waiting/configuring | **editable** |
| `playing` | A round is live | **locked** |
| `finished` | Round over, results shown | **locked**; host can start the next round |

`ended_reason` ∈ `winners_complete` · `items_exhausted` · `host_ended`.

---

## 3. Requirements

Each requirement: the rule, its acceptance criteria, where it is implemented,
and the automated check that proves it.

### 3.1 Host as administrator — R-01

> **R-01** The host configures and runs the game but never plays it.

**Acceptance criteria**
- The host holds no seat in the stadium ring and is dealt no card.
- `POST /mark` and `POST /bingo` with a host token → **403 `host_cannot_play`**.
- `POST /config`, `/start`, `/call`, `/end` with a player token → **403 `host_only`**.
- A reaction aimed at the host → **404 `unknown_player`**.
- The host's "Close table" only clears the local session (no server call), so
  the host never trips `host_cannot_leave`.

**Implementation**
`src/worker.js` — `authorize()` returns the seat; handlers branch on
`me.role`. `listPlayers`/leaderboard queries filter `role = 'player'`, so the
host can never appear in the roster. `buildState` returns `you: null` for a
host (only players get a `card`).

**Verified by** smoke: *host cannot mark, host cannot claim, config from a
player is refused, call from a player is refused, reactions at the host are
refused, the host reads the roster and chat.*

---

### 3.2 Configuration happens before the game — R-02

> **R-02** All game settings are chosen by the host **before** the board is
> dealt, from a single settings panel shown only in `lobby`.

**Acceptance criteria**
- The host sees a full settings form in `lobby` (content, geometry, calling,
  dabbing, winners, patterns, social toggles, expected players).
- Players never see the settings form; they see the lobby waiting screen with
  the joined count.
- "Save settings" persists without starting; "Save & start game" persists and
  starts in one action.

**Implementation** `public/app.js` → `renderStudioPanel()` (host-only, gated by
`isHost()`), `readForm()` → `saveConfig()` → `POST /config` then `/start`.

**Verified by** smoke: *config round-trip of every field, host-only access,
player-visible joined count.*

---

### 3.3 Nothing changes once the game starts — R-03

> **R-03** Once the game has started, **no** game setting can be changed.

**Acceptance criteria**
- `POST /config` in `playing` or `finished` → **409 `settings_locked`**.
- Every field is covered — there is no partial-patch escape hatch, because the
  lock is on the whole endpoint, not on individual fields.
- The host's UI swaps the form for a read-only "Round N in progress 🔒"
  summary plus live controls.

**Implementation** `src/worker.js` → `updateConfig()`:
`if (room.status !== 'lobby') return 409 settings_locked`, checked *before* any
validation. `public/app.js` → `renderStudioPanel()` renders the locked panel
when `!lobby`.

**Verified by** smoke: *config refused while playing, refused while finished,
each individual field refused (rows, call mode, patterns, social flags),
accepted again only after returning to the lobby.*

---

### 3.4 Interlinked configuration — R-04

> **R-04** Settings that have no meaning in the current combination must not
> be shown or configurable. The server enforces the same interlinks the UI
> applies, so the two can never drift.

**The interlink matrix** (single source of truth: `fieldVisibility(config)` in
`public/game.js`, mirrored by `applyVisibility()` in `public/app.js`):

| Condition | Hidden / forced |
|---|---|
| `winnerMode = single` | multi-select **pattern grid** hidden → one *winning condition* dropdown shown; `maxWinners` forced to `1` |
| `winnerMode = multiple` | single winning condition hidden; `maxWinners` shown (`0` = unlimited) |
| `callMode = manual` | call **interval** hidden (nothing is on a timer) |
| `winnerCall = auto` | "press Bingo" claim path disabled; dabbing note changes to "just for fun" |
| `winnerCall = manual` | "Players must dab an item before it counts" |
| `markMode = auto` | "you missed some" hint hidden |
| even rows **or** even cols | **free centre** hidden and forced off |
| `content ≠ custom` | custom list textarea hidden |
| `content = numbers` | numeric pool guidance (per-column maths) shown |
| `chat` / `reactions` / `leaderboard` off | the whole panel is hidden, and the API answers **403** |

**Acceptance criteria**
- `normalizeConfig` forces `freeCentre = false` on any even dimension even if
  the client sends `true`.
- `normalizeConfig` forces `maxWinners = 1` when `winnerMode = 'single'`.
- An empty pattern set, or one where every id is invalid for the geometry, →
  **400 `no_patterns`** — an unwinnable table can never be saved. (The client
  prevents this by always sending a valid set.)
- Unknown pattern ids are filtered out; if a geometry change invalidates the
  chosen set, the surviving patterns are kept and the classic preset is used
  when nothing survives.

**Implementation** `public/game.js` → `fieldVisibility()`, `normalizeConfig()`.

**Verified by** unit tests *("field visibility follows the interlinked config",
"normalizeConfig keeps interlinked defaults")* + smoke *(`single winner forces
one place`, `an empty pattern set is refused for multiple winners`, `free
centre is forced off on an even board`)*.

---

### 3.5 Winning patterns are dynamic — R-05

> **R-05** The set of winning patterns is generated from the selected
> **rows × columns**, not hard-coded.

**Acceptance criteria** — `availablePatterns(rows, cols)` yields:

| Pattern id | Produced when |
|---|---|
| `row:0 … row:R-1` | always — so a 6-row board offers Rows 1–6 |
| `col:0 … col:C-1` | always — so a 10-column board offers Columns 1–10 |
| `diag:main`, `diag:anti` | `min(rows, cols) ≥ 2` |
| `corners` | `rows ≥ 2 && cols ≥ 2` |
| `blackout` | always |

- A pattern id not valid for the current geometry is rejected/filtered, so the
  anti-diagonal on a board that cannot have one is impossible to select.
- **Presets** are derived from the same list: `classic` (all lines, minus
  corners/blackout), `allRows`, `allCols`, `x` (both diagonals), `corners`,
  `blackout`, `everything`.
- **Single-winner mode** offers the compact `winningConditions()` list
  ("First to any line", "First to any row", …) instead of a checkbox grid.
- Changing rows/columns **keeps the host's selected condition** and re-derives
  the hidden pattern grid from it.

**Implementation** `public/game.js` → `availablePatterns()`, `presetPatterns()`,
`winningConditions()`; `public/app.js` → `drawPatternList()` and the `change`
handler on `#cfg-rows` / `#cfg-cols`.

**Verified by** unit tests *("every board size exposes the right rows and
columns", "presets only contain patterns the board can offer")* + smoke
*(row 1 wins / wrong row does not, columns win / an unselected column does not,
main diagonal wins while the anti-diagonal correctly does not, corners and
blackout partial-vs-full)*.

---

### 3.6 Manual **or** automatic winner call-out — R-06

> **R-06** The host chooses how a winner is declared: the table declares it,
> or the player shouts Bingo.

| `winnerCall` | Behaviour |
|---|---|
| `auto` | The Worker evaluates every player's card when the called set changes and records the winner itself. `POST /bingo` → **409 `auto_winner_call`**. |
| `manual` | `POST /bingo` verifies the claim against the player's own card: **409 `no_bingo`** if nothing is complete, **409 `already_won`** for a second claim. `you.canClaim` is only `true` when a pattern is actually complete. |

**Acceptance criteria**
- Automatic call-out works in **both** dabbing modes: with `markMode = auto`
  it counts dabbed cells; with `markMode = manual` it counts *called* cells, so
  a manual-dab table still declares winners.
- Automatic evaluation runs only when the called set changes — it never scans
  500 players per dab.
- In manual mode a false claim is rejected and the player can retry.

**Implementation** `src/worker.js` → `winningSet()` (mode-aware),
`evaluateAutomaticWinners()` on draw, `claimBingo()` for manual verification.

**Verified by** smoke: *auto call-out records a winner without a claim, a claim
in auto mode is refused, a correct manual claim wins, a false claim is refused,
a repeat claim is refused.*

---

### 3.7 One winner or many — R-07

> **R-07** The host picks single-winner or multiple-winner play, with an
> optional maximum; all winner names are shown, ranked.

**Acceptance criteria**
- `winnerMode = single` → exactly one place; the round ends at the first valid
  claim (`ended_reason = winners_complete`).
- `winnerMode = multiple` + `maxWinners = N` → N places; play continues until
  N distinct players have won, then the round ends.
- `maxWinners = 0` → **unlimited**: every player who gets there is recorded and
  play continues until the pool is exhausted or the host ends the round.
- Simultaneous claims can never overshoot: the slot is reserved with an atomic
  `UPDATE rooms SET winner_count = winner_count + 1` compare-and-swap.
- The results screen lists every winner with `rank`, `name`, `pattern` and
  `calledCount`.

**Implementation** `public/game.js` → `winnerLimit()`; `src/worker.js` →
`claimBingo()` slot gate, `evaluateAutomaticWinners()`, `buildState().winners`.

**Verified by** smoke: *single locks after one claim; multiple accepts a second
and a third then refuses the fourth; unlimited accepts all; the third claim
closes the room; rankings are ordered.* Unit: *"winnerLimit covers single,
capped and unlimited rounds".*

---

### 3.8 Content types (what goes on the card) — R-08

> **R-08** The host chooses what the bingo card is made of, and can add their
> own combinations.

| `content` | Pool | Notes |
|---|---|---|
| `numbers` | 1 … `perColumn × cols` | classic 75-ball at 5×5; always 2-digit max (`MAX_NUMBER = 99`) |
| `names` | 80 built-in names | |
| `images` | 90 emoji | each cell is an emoji glyph |
| `music` | 65 public-domain / folk titles | `media` field reserved for a link |
| `mixed` | name + image pairs | "names and images bingo" |
| `custom` | host's own list | one item per line, or `Label \| link`; ≤ 300 items; label ≤ 40 chars, media ≤ 300 chars |

**Acceptance criteria**
- All six types flow through the same card/pattern/win engine — cells store
  pool **indices**, so nothing else changes.
- A pool too small for the chosen geometry is refused:
  **400 `pool_too_small`**, with a message telling the host how many items per
  column are needed (`minimumPoolSize = rows × cols`).
- The pool is sent to clients from a **separate** `GET /pool` endpoint with its
  own version cursor, so a 500-player room does not re-send 90 items on every
  poll.
- Custom lists persist: re-saving config without resending `customItems` keeps
  what the host already typed.

**Implementation** `public/game.js` → `CONTENT_TYPES`, `poolFor()`,
`buildPool()`, `normaliseItem()`, `minimumPoolSize()`; `src/worker.js` →
`getPool()`, `updateConfig()` item persistence.

**Verified by** unit tests *("every content type builds a pool sized to the
board", "custom lists are normalised and truncated", "a pool smaller than the
board is refused")* + smoke: *all six content types configured and started,
custom list accepted, too-small custom list refused, pool endpoint serves and
caches by version.*

---

### 3.9 Board geometry — R-09

> **R-09** Rows and columns are configurable, and more columns are recommended
> for more players.

**Acceptance criteria**
- `rows` ∈ 3–6, `cols` ∈ 3–10; anything else → **400 `invalid_rows` /
  `invalid_cols` / `invalid_board`**.
- Numbers per column = `min(3 × rows, floor(99 / cols))`; total =
  `perColumn × cols`. 5×5 ⇒ exactly 75; 6×8 ⇒ 96; 3×10 ⇒ 90.
- Column draw ranges never overlap, so a cell in column `c` can only ever hold
  an index in `[c·perColumn, (c+1)·perColumn)`.
- `recommendBoard(expectedPlayers)` maps 4→`4×4`, 12→`4×4`, 30→`5×5`
  (classic), 80→`5×6`, 150→`5×7`, 300→`6×6`, 500→`6×8`.
- `variety()` reports card variety (`high`/`medium`/`low`) so the host is warned
  when a board would deal near-identical cards.

**Implementation** `public/game.js` → constants, `numbersPerColumn()`,
`boardIsValid()`, `recommendBoard()`, `variety()`.

**Verified by** unit tests *("numbers per column stays two digits at every
size", "column ranges never overlap", "recommended boards are valid",
"variety grades boards")* + smoke: *out-of-range rows and columns rejected,
5×5 = 75 numbers, 6×8 = 96 numbers with 48-cell cards, 3×10 accepted.*

---

### 3.10 Expected players never block the game — R-10

> **R-10** The expected number of players is advice only. The host can start
> with any number of players — including none — and the **joined count is
> always visible**.

**Acceptance criteria**
- `POST /start` has **no minimum-player check** of any kind.
- `expectedPlayers` (0–500) is stored and broadcast in `room.config`.
- The top bar shows `👥 joined/max` and, when set, `expected ~N` to everyone.
- The host's settings header shows "N joined · you can start any time, with
  any number of players".
- "Recommend board" uses `expectedPlayers` and, if it is empty, asks for it
  instead of guessing.

**Implementation** `src/worker.js` → `startRound()` (no gate),
`buildState().room.playerCount` / `expectedPlayers`; `public/app.js` →
topbar pills, `renderStudioPanel()` header, `#cfg-recommend`.

**Verified by** smoke: *the expectation is stored, the host can start alone
with nobody joined, an empty table still shows the expectation, joined count
and expectation are both exposed, starting with far fewer players than
expected is allowed.*

---

### 3.11 Joined users are listed — R-11

> **R-11** Everyone can see who has joined, with presence, from a roster panel.

**Acceptance criteria**
- `GET /players` returns every player with `id`, `name`, `avatar` and `online`,
  plus `total`, the `online` count, `expected` and `hostName`. (The host is
  not in the list — they are not a player.)
- Presence: `online = last_seen within 25 s`; `last_seen` is written at most
  once per 15 s per player (never per poll).
- Leaving frees the seat immediately and bumps `roster_version`.
- Incremental reads: `?since=<rosterVersion>` returns `{ changed: false }` when
  nothing moved.

**Implementation** `src/worker.js` → `listPlayers()`, `leaveRoom()`,
`ONLINE_WINDOW_MS`, `LAST_SEEN_WRITE_MS`.

**Verified by** smoke: *roster lists names and host flag, online state flips,
count updates on join and leave, the roster cursor short-circuits unchanged
reads.*

---

### 3.12 Chat, max 20 words — R-12

> **R-12** Players can hold a simple conversation, capped at **20 words per
> message**, and the host can switch it off.

**Acceptance criteria**
- `POST /chat` with 20 words → **200**; with 21 → **400 `too_many_words`**;
  empty → **400 `empty_message`**; > 200 characters → **400
  `message_too_long`**.
- Whitespace is normalised first, so the client's word counter and the
  server's agree exactly.
- The client shows a live `12/20 words` counter, turns red over the limit and
  disables Send at 0 or > 20.
- Messages carry `name` and `avatar` so the log is readable without a lookup.
- `chat = false` → **403 `chat_disabled`** on write, and `GET /chat` reports
  `enabled: false`.
- History is paginated (60 per page) behind a `since` cursor and pruned to a
  10-minute retention window (sampled 10 % of writes), so the table never
  accumulates unbounded text.
- The host can send and read too.

**Implementation** `src/worker.js` → `CHAT_MAX_WORDS`, `CHAT_MAX_CHARS`,
`CHAT_PAGE`, `CHAT_RETENTION_MS`, `postChat()`, `getChat()`;
`public/app.js` → `sendChat()`, the counter in `updateSocial()`.

**Verified by** smoke: *a short message is accepted, exactly 20 words is
accepted, 21 words is rejected, empty is rejected, another player sees it,
messages carry sender name and avatar, the host reads and talks, a caught-up
reader gets nothing new, a chat-less table refuses writes and reports itself
disabled.*

---

### 3.13 Reactions / emoji aimed at a specific player — R-13

> **R-13** Any player can throw an emoji at any other player. Everyone sees
> it, and it **flies from the sender to the receiver**.

**Acceptance criteria**
- A fixed palette of 20 emoji (`REACTION_EMOJIS`); anything else → **400
  `invalid_emoji`**.
- A target is required; an unknown target or the host → **404
  `unknown_player`**.
- The stored reaction carries `fromId`, `fromName`, `toId`, `toName`, `emoji`
  — both ids, so the client can animate the flight without extra lookups.
- Everyone polling `GET /reactions?since=` receives it and animates it.
- `reactions = false` → **403 `reactions_disabled`** and `enabled: false`.
- Cursor-based reads (40 per page) with a 10-minute retention window.

**The flight animation** (`playReactionFlight` in `public/app.js`):
1. Resolve both seats via `data-avatar-id`.
2. Compute centres relative to the `#fly-layer` overlay.
3. Animate a 1.4 s arc with a lifted midpoint (`midYOffset`) using the Web
   Animations API, scaling 0.6 → 1.5 → 1 and fading in/out.
4. Remove the node on finish/cancel.
5. A toast names the pair: `Alex → Sam 🎉`.

Because the host has no seat, a reaction can never be aimed at them; if the
receiver is off the ring cap the flight degrades to the toast only.

**Implementation** `src/worker.js` → `postReaction()`, `getReactions()`;
`public/app.js` → `sendReaction()`, `refreshSocial()`, `playReactionFlight()`;
`public/styles.css` → `.fly-emoji`, `.fly-layer`.

**Verified by** smoke: *a reaction needs a target, the host cannot be targeted,
only offered emoji are accepted, a reaction to another player is accepted,
everyone can see it, it says who sent it to whom, it carries both ids for the
flight, a caught-up reader gets no repeats, reactions can be switched off.*

---

### 3.14 Stadium seating — R-14

> **R-14** The joined players are arranged around the game like an audience in
> a stadium, with the bingo table at the centre.

**Acceptance criteria**
- Seats are placed on an ellipse around the table:
  `x = 50 + 44·cos(θ)`, `y = 50 + 44·sin(θ)`, `θ = i/n·2π − π/2`.
- Each seat shows the player's avatar, name, and an `idle` state when offline.
- The centre holds the 🎙️ host name, the **latest called item** and the
  `called/pool` progress (or the status when not playing).
- Clicking a seat selects it as the reaction target (click again to clear);
  the social panel switches to "Send to *name*".
- `RING_CAP = 48` seats are drawn on the ring; beyond that the remaining
  players are still listed in the roster panel, with a note saying how many
  are off-ring.

**Implementation** `public/app.js` → `updateStadium()`, `nodeForId()`;
`public/styles.css` → `.stadium`, `.ring`, `.seat`, `.table-centre`.

**Verified by** only indirectly — the roster and reaction-target checks (§3.11,
§3.13) exercise the seat identity the animation depends on. The visual layout
itself is **not** automated (see §7).

---

### 3.15 Leaderboard by possible wins — R-15

> **R-15** The host can show a leaderboard ranked by *possible* wins, useful
> from the first call rather than only after someone wins.

**Acceptance criteria**
- `leaderboard = false` → **403 `leaderboard_disabled`**.
- Ranking: most patterns completed → closest to completing the nearest
  pattern (`bestDone / bestTotal`) → earliest join.
- Paginated (50 per page, ≤ 200 rows cached) and memoised for 2 s keyed by
  `(room, round, calledCount, rosterVersion)`, so a 500-player table is not
  recomputed on every request.
- Each entry exposes `won`, `bestDone`, `bestTotal`, `markedCount`, `online`.

**Implementation** `src/worker.js` → `getLeaderboard()`,
`computeLeaderboard()`, `leaderboardCache`; `public/game.js` →
`completedPatterns()`, `bestProgress()`.

**Verified by** smoke: *the leaderboard is computed across 500 players,
paginated, and 403 when disabled*; measured **36 ms cold / 6 ms warm** at 500.

---

### 3.16 Dabbing — R-16

> **R-16** Players dab by hand or the table dabs for them.

| `markMode` | Behaviour |
|---|---|
| `manual` | `POST /mark` toggles a cell; **409 `not_called`** if the item has not been called, **400 `not_on_card`** if it is not on that player's card, **409 `auto_mark_enabled`** when auto is on |
| `auto` | Marks are derived from the called set on every read — nothing to press, nothing to store |

`missedCount()` reports called-but-undabbed cells so the client can nudge.

**Verified by** smoke: *manual dabs nothing by itself, auto dabs every called
cell, each mode refuses the other's endpoint, off-card and uncalled marks are
refused.*

---

### 3.17 Calling: automatic or manual — R-17

> **R-17** Items are called on a timer or by the host, one at a time.

| `callMode` | Behaviour |
|---|---|
| `auto` | The clock is advanced by whoever polls, using a compare-and-swap so racing pollers cannot draw twice; interval ∈ {3, 4, 5, 8, 12, 20}s; up to 50 catch-up draws per request |
| `manual` | The host presses **Call next item** or types a specific item (1-based, matching what is shown); a duplicate → **409 `already_called`**, out of range → **400 `invalid_item`** |

When the pool is exhausted the round finishes with `items_exhausted`.

**Implementation** `src/worker.js` → `advanceClock()`, `callItem()`,
`MAX_CATCHUP_DRAWS`.

**Verified by** smoke: *auto calls on the timer, manual next calls, a specific
number is called, duplicates and out-of-range are refused, manual mode is
refused in auto mode and vice versa.*

---

### 3.18 Scale — R-18

> **R-18** A table must stay responsive for 4 to 500 players.

**Design constraints**

| Hot path | Complexity | Why |
|---|---|---|
| `GET /state` | O(1) in players | one room read + one seat read; no roster scan; already-known numbers are not resent (`?since=` tail) |
| Start a round | O(1) | cards are derived — **zero** per-player writes |
| Draw clock | O(1) | CAS update, writes only when a draw is due |
| Auto winner check | O(players × cells) **once per draw**, not per dab | only on called-set change |
| Roster / leaderboard / pool / chat / reactions | separate endpoints | each with its own cursor and throttle |
| `last_seen` | ≤ 1 write / 15 s / player | not per poll |

**Measured** (500 seats, `node scripts/smoke.mjs --scale`):

| Metric | Result |
|---|---|
| `GET /state` latency | **p50 9 ms, p95 18 ms** (assertion: p95 < 300 ms) |
| `GET /state` payload | **1455 B** (assertion: < 2 KB, independent of table size) |
| 499 joins | 6.3 s → 12.5 ms each |
| Roster payload | 42.9 KB |
| Leaderboard over 500 | 36 ms cold / 6 ms warm |
| Claim at 500 seats | 11 ms |

**Verified by** smoke `--scale`: *board is large, 499 players joined, starting
is O(1), a seat still sees its own card, latency and payload assertions,
leaderboard computed and paginated, claim in constant time.*

---

## 4. API reference

All routes are under `/api`. Authentication is the `x-player-token` header
(or `?token=`). Responses are JSON.

### Room

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | liveness + schema version |
| POST | `/api/room` | anyone | create a table → `{ room, viewer: {role:'host'}, token }` (the host is an administrator, never a player) |
| POST | `/api/room/:code/join` | anyone | join → `{ room, you, viewer, token, role: 'player' }`; idempotent for an existing token |
| POST | `/api/room/:code/leave` | player | delete the seat (**409 `host_cannot_leave`** for the host) |

### Reads (all cursor-friendly)

| Method | Path | Purpose | Cursor |
|---|---|---|---|
| GET | `/state?since=N` | room + your card + tail of the call list | called count |
| GET | `/players?since=N` | roster, presence, counts | `rosterVersion` |
| GET | `/leaderboard?limit&offset` | ranked table (**403** when off) | offset |
| GET | `/pool?since=N` | the item pool (**separate from state**) | `poolVersion` |
| GET | `/chat?since=N` | last 60 messages | message id |
| GET | `/reactions?since=N` | last 40 reactions | reaction id |

### Writes

| Method | Path | Who | Notable errors |
|---|---|---|---|
| POST | `/config` | host, **lobby only** | 403 `host_only`, **409 `settings_locked`**, 400 `invalid_*` / `no_patterns` / `pool_too_small` |
| POST | `/start` | host | 403 `host_only` — no player-count gate |
| POST | `/call` | host | 409 `already_called`, 400 `invalid_item` |
| POST | `/mark` | player | 403 `host_cannot_play`, 409 `not_called` / `auto_mark_enabled`, 400 `not_on_card` |
| POST | `/bingo` | player | 403 `host_cannot_play`, 409 `no_bingo` / `already_won` / `auto_winner_call` |
| POST | `/end` | host | 403 `host_only` |
| POST | `/chat` | any | 403 `chat_disabled`, 400 `too_many_words` / `empty_message` / `message_too_long` |
| POST | `/react` | any | 403 `reactions_disabled`, 400 `invalid_emoji`, 404 `unknown_player` |

### `POST /config` body

```jsonc
{
  "config": {
    "rows": 5, "cols": 5,              // 3-6 × 3-10
    "content": "numbers",              // numbers|names|images|music|mixed|custom
    "customItems": ["Sunrise", "Moonlight | https://…"],  // custom only, ≤300
    "freeCentre": true,                // odd×odd only
    "callMode": "auto",                // auto|manual
    "callIntervalMs": 5000,            // 3000|4000|5000|8000|12000|20000
    "markMode": "manual",              // manual|auto
    "winnerCall": "manual",            // manual|auto   ← R-06
    "winnerMode": "single",            // single|multiple
    "maxWinners": 1,                   // 0 = unlimited, forced to 1 when single
    "winPatterns": ["row:0","col:2"],  // ids from availablePatterns()
    "leaderboard": true, "chat": true, "reactions": true,
    "expectedPlayers": 0               // advisory, never a gate
  }
}
```

### `GET /state` payload (shape)

```jsonc
{
  "room": {
    "code": "AB3K7", "status": "playing", "round": 2,
    "config": { /* as above, normalised, plus perColumn + poolSize */ },
    "visibility": { "freeCentre": true, "callIntervalMs": true, "patternGrid": false, … },
    "columnLabels": ["B","I","N","G","O"],
    "calledCount": 12, "called": [/* full */], "calledTail": null,
    "remaining": 63, "nextCallInMs": 3200,
    "playerCount": 148, "maxPlayers": 500, "rosterVersion": 9, "poolVersion": 3,
    "hostName": "Sam",
    "winners": [{ "playerId": "…", "name": "Alex", "rank": 1, "pattern": "row:2", "calledCount": 17 }],
    "winnerSlots": 3, "endedReason": null
  },
  "viewer": { "role": "player", "id": "…", "name": "Alex", "avatar": "🦊", "isHost": false },
  "you": { "card": [[…]], "marked": [], "patterns": [], "best": {"done":2,"total":5},
           "missed": 0, "won": false, "canClaim": false },   // null for the host
  "serverTime": 1770000000000
}
```

---

## 5. Data model (D1)

```
rooms    id, code, status, round, seed,
         rows, cols, content, items(JSON), per_column, pool_size, pool_version,
         free_centre, call_mode, call_interval_ms, mark_mode,
         winner_mode, max_winners, win_patterns(JSON), winner_call,
         leaderboard, chat, reactions, expected_players,
         draw_order(JSON), called(JSON), called_count, last_call_at,
         winner_count, host_name, player_count, roster_version, ended_reason,
         created_at, updated_at

players  id, room_id, role('host'|'player'), name, avatar, token,
         marked(JSON), marked_round, joined_at, last_seen
winners  id, room_id, round, player_id, name, pattern, called_count, rank, at
messages id, room_id, player_id, name, avatar, body, at
reactions id, room_id, from_id, from_name, to_id, to_name, emoji, at
```

Indexes: `players(room_id, role, joined_at)`, `winners(room_id, round, at)`,
`messages(room_id)`, `reactions(room_id)`.

Schema is created idempotently on first request (`SCHEMA_VERSION = 3`). For a
real deployment the `CREATE TABLE` guard should be replaced by a Wrangler
migration before live data exists.

---

## 6. Shared rules module (`public/game.js`)

| Concern | Functions |
|---|---|
| Pools | `poolFor`, `buildPool`, `numbersPerColumn`, `minimumPoolSize`, `normaliseItem` |
| Cards | `deriveCard`, `cardCells`, `cardIndexSet`, `calledItems`, `missedCount` |
| Patterns | `availablePatterns`, `presetPatterns`, `winningConditions`, `completedPatterns`, `bestProgress` |
| Config | `defaultConfig`, `fieldVisibility`, `normalizeConfig`, `winnerLimit`, `recommendBoard`, `variety` |
| Draw | `generateDrawOrder`, `shuffle`, `mulberry32`, `hash32` |
| Choices | `REACTION_EMOJIS`, `AVATAR_CHOICES`, `CONTENT_TYPES`, `CONTENT_LABELS` |

Determinism comes from `mulberry32(hash32(seed))`, so the same room/round/player
always yields the same card on every device without transferring it.

---

## 7. Client architecture (`public/app.js`)

- **Render pieces with signatures.** Every panel (`topbar`, `stadium`,
  `studio`, `card`, `board`, `roster`, `leaderboard`, `social`, `overlay`)
  computes a signature of the data it depends on and re-renders only when it
  changes. Handlers are attached **only on re-render** — never per poll, which
  would stack click handlers and make a button fire N times.
- **Polling** adapts to load: 1 s base, 1.2 s over 40 players, 1.5 s over 100,
  2 s over 250, doubled when the tab is hidden.
- **Polls fan out**: `/state` is polled on its own cadence; roster, leaderboard,
  pool, chat and reactions refresh only when their version/cursor moves.
- **Host vs player**: `isHost()` swaps the main column between the settings
  studio (lobby) / live controls (playing) and the player's card.

### Manual verification checklist (not automated)

I cannot drive a browser from this environment, so the following are **untested
by me** and worth a click-through in the preview:

1. Settings panel: switch content types, change rows/columns and confirm the
   winning condition and pattern grid stay in sync.
2. A full round on a phone-width screen at 6×8 — tap cells, watch the countdown.
3. The flying emoji between two seats (select a seat → reaction → watch the arc).
4. Chat counter behaviour at 19/20/21 words.
5. The multi-winner results screen with names, ranks and patterns.

---

## 8. Verification matrix

| Layer | Command | Result |
|---|---|---|
| Unit (rules, geometry, interlinks, pools, presets) | `npm test` | **33 / 33 pass** |
| End-to-end API (every requirement above) | `node scripts/smoke.mjs` | **185 / 185 pass** |
| + 500-player load run | `node scripts/smoke.mjs --scale` | **194 / 194 pass** |
| Syntax | `node --check` on all four sources | clean |
| Server log | `dev.log` | no errors |

Bugs found and fixed during this work:

1. **Winner gate closed the room unconditionally** — "multiple winners" ended
   after the first claim. Replaced with an atomic slot counter.
2. **`updateTopbar` re-attached handlers on every poll** — "Call next" would
   have fired once per poll. Handlers now attach only when the markup changes.
3. **Geometry change reset the winning condition** — switching rows/columns
   rebuilt the dropdown without preserving the selection, silently reverting
   the host's choice to the first option.
4. **Chat signature used only the message count** — at the 200-message cap a
   new message could leave the count unchanged and never render; the cursor is
   now part of the signature.
5. **Reaction target stayed selected after sending** — now cleared and
   re-rendered immediately instead of on the next poll.

---

## 9. Known limitations

- **No browser automation in this environment** — UI behaviour is verified at
  the HTTP/asset level only (§7 lists what to click).
- **Nothing is committed or deployed.** A real deploy needs a provisioned D1
  `database_id` in `wrangler.toml` and a migration to replace the local schema
  guard.
- Music cells carry a `media` field but no audio playback yet — the field is
  plumbed end to end for it.
- Chat/reaction history is intentionally ephemeral (10-minute retention).
- The stadium ring caps how many seats are drawn around the table; the roster
  list below always shows everyone.
