# 🎱 Bingo Tables

A multiplayer bingo game that scales from a kitchen table to a 500-seat hall.
Create a **table**, share the five-character code, and everyone plays the same
live round on their own card, seated around it like a stadium crowd.

Built as a Cloudflare Worker (API) + static frontend, with game state in **D1**.
The **host is an administrator, not a player**: they configure, call and end the
round, but hold no card and can never win.

> 📖 **Full requirements and implementation spec:** [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)
> — every rule, its acceptance criteria, the API surface, the data model and the
> verification matrix.

## How a game works

1. **Create a table** — you get a code like `K7QX2` and become the host.
2. **Friends join** with the code or invite link (up to 500 seats).
3. **The host configures the table** in the lobby, then hits **Start** — with
   any number of players, even none. Joined count is always on screen.
4. **Items are called** — automatically on a timer, or by the host.
5. **Dab your card** — automatically as items are called, or by tapping.
6. **A winner is declared** — automatically by the table, or by a player
   pressing *Bingo* (the server verifies the claim). One winner, a fixed number,
   or everyone who gets there.
7. **Players chat and throw emoji at each other** — a reaction flies across the
   table from the sender to the receiver, visible to everyone.
8. **The host starts a new round** — new cards, new draw order, same table.

## What the host can configure

Everything lives in the lobby settings panel, and **everything locks once a
round starts** — `POST /config` answers `409 settings_locked` until the host
starts the next round. Settings are also **interlinked**: an option that cannot
apply is not shown, and the server enforces the same interlinks, so the two can
ever drift.

| Setting | Options | Interlink |
| --- | --- | --- |
| **Card content** | Numbers, Names, Emoji/images, Music titles, Names+images, or your **own list** | own list only for "my own list" |
| **Board size** | Rows 3–6 × Columns 3–10 — the item pool is derived automatically | drives the pattern list |
| **Free centre** | On/off | only on odd × odd boards |
| **Calling** | **Auto** on a timer (3s–20s) or **Manual**, where the host calls each item | interval hidden when manual |
| **Dabbing** | **Manual** (players tap called items) or **Auto** (dabbed for you) | "you missed some" hint hidden when auto |
| **Winner call-out** | **Automatic** (the table declares) or **manual** (players press *Bingo*) | claim button hidden when automatic |
| **Winners** | **Single**, or **Multiple** with a max count (0 = everyone who gets there) | single ⇒ one condition dropdown; multiple ⇒ pattern grid + cap |
| **Winning patterns** | Any combination of rows, columns, both diagonals, four corners and blackout | generated from rows × columns |
| **Leaderboard / Chat / Reactions** | Show or hide | the whole panel disappears when off |
| **Expected players** | Advice only — recommends a board, **never** blocks starting | — |

### Board geometry drives everything

Rows and columns are not cosmetic — they determine the item pool:

```
numbers per column = min(3 × rows, 99 / cols)
total numbers      = numbers per column × columns
```

So the classic **5 × 5** board is exactly standard 75-ball bingo (15
numbers per column × 5 columns = 75). A **6 × 8** board gives 96 numbers
(16 per column × 6 columns = 96), etc. The column ranges **never overlap**,
so column C always draws from its own slice.

### Choosing a board for your group

| Expected players | Recommended board | Note |
| --- | --- | --- |
| ≤ 12 | 4 × 4 | cosy tables |
| ≤ 30 | 5 × 5 | classic 75-ball |
| ≤ 80 | 5 × 6 | medium rooms |
| ≤ 150 | 5 × 7 | large rooms |
| ≤ 300 | 6 × 6 | halls |
| > 300 | 6 × 8 | very large groups |

The **Recommend board** button in the lobby does this automatically from
`expectedPlayers`.

### What goes on the card

The card does not have to be numbers. The host picks a content type, and every
rule — columns, patterns, winners — works identically across all of them,
because a cell stores an item's *index* into the room's pool:

| Content | Pool |
| --- | --- |
| 🔢 **Numbers** | 1…N, derived from the board (75 at 5×5) |
| 👤 **Names** | 80 built-in first names |
| 🖼️ **Emoji / images** | 90 emoji |
| 🎵 **Music titles** | 65 public-domain / folk pieces |
| 🎭 **Names + images** | name/emoji pairs — "names and images bingo" |
| ✏️ **My own list** | up to 300 lines of `Label`, or `Label \| link` |

A list too small for the chosen board is refused with a message saying how many
items per column it needs — an unsavable, unwinnable table is impossible.
Custom lists are kept on the room, so a later settings save does not wipe them.
The pool is served from its own endpoint (`GET /pool`) with a version cursor, so
a 500-player room does not re-send 90 items on every poll.

### Patterns and winners

A player wins by completing **any** enabled pattern. "Blackout" obviously means
the whole card. With multiple winners the round stays open until the last place
is taken (an atomic slot counter, so simultaneous claims can never overshoot),
and every winner's name is listed on the results screen, ranked.

**Winner call-out is configurable.** With *automatic* call-out the table watches
the called items and declares the winner the moment a card completes the
pattern. With *manual* call-out players press **Bingo** and the server verifies
the claim against the real called items — a false claim is rejected.

The **leaderboard** ranks players by *possible wins*: patterns completed first,
then how close they are to their nearest one — so it is useful from the very
first call, not only once someone wins.

## The table around you

The room is drawn as a **stadium**: every joined player is a seat on an ellipse
around the table, which shows the host's name, the latest called item and the
progress. Tap a seat to aim at that player.

- **Chat** — short messages, **20 words maximum**, with a live word counter.
  Paginated and pruned to a 10-minute window, so a busy table never bloats.
- **Reactions** — 20 emoji. Any player can throw one at any other player; it is
  visible to **everyone** and animates across the table, **flying from the
  sender's seat to the receiver's**.

Both can be switched off by the host, and the API answers `403` when they are.

## Running it

```bash
npm install
npm run dev   # http://localhost:3000
```

The dev server spins up a local D1 database automatically — no extra setup.

## Architecture

```
public/            static frontend (served as assets)
  index.html
  app.js           lobby, settings studio, stadium, chat, polling
  styles.css
  game.js          shared pure rules — pools, geometry, cards, patterns, config
src/
  worker.js        HTTP API, D1 schema, draw clock, winners, leaderboard
test/
  game.test.js     unit tests for the rules
scripts/
  smoke.mjs        end-to-end suite through the public HTTP API
docs/
  REQUIREMENTS.md  full requirements + implementation spec
```

### How this scales to 500 players

- **Cards are derived, never stored** — a pure function of `(room seed, round,
  player id)`. Dealing a round costs the same for 4 or 500 players: **zero
  per-player writes**.
- **GET `/state` is O(1)** in player count: one room read, one seat read, no
  roster scan. Numbers the client already has are not resent (`?since=` tail).
- **Draw clock** is advanced by pollers, writes only when a draw is due, and
  uses a compare-and-swap so racing pollers cannot draw twice.
- **Automatic winner check** runs only when the called set changes — it never
  scans 500 players per dab.
- **Roster, leaderboard, item pool, chat, reactions** are separate endpoints,
  each with its own cursor and throttle.
- **`last_seen` updates ≤ 1 / 15 s / player** — not per poll.

| Metric | Result |
| --- | --- |
| `GET /state` latency | **p50 9 ms, p95 18 ms** |
| `GET /state` payload | **~1.4 KB — flat, independent of player count** |
| Starting a round | O(1), no per-player writes |
| Leaderboard across 500 players | 36 ms cold, 6 ms warm |
| 499 joins | 12.5 ms each |
| Roster payload | 43 KB for 500 players (fetched only on change) |

All numbers from `node scripts/smoke.mjs --scale` (194 checks, 0 failures).

## API

All routes are under `/api`. Auth is the `x-player-token` header (or `?token=`).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/room` | Create a table. `{ name, ...config }`, `expectedPlayers` auto-picks a board |
| `POST` | `/api/room/:code/join` | Join or rejoin → state + seat `token` |
| `GET` | `/api/room/:code/state?since=N` | Poll table state; `since` returns only new calls |
| `GET` | `/api/room/:code/players?since=V` | Roster, or a tiny "unchanged" reply |
| `GET` | `/api/room/:code/leaderboard?limit=&offset=` | Ranked by possible wins (`403` when off) |
| `GET` | `/api/room/:code/pool?since=V` | The card's item pool (`403` n/a — versioned) |
| `GET` | `/api/room/:code/chat?since=I` | Last 60 messages |
| `GET` | `/api/room/:code/reactions?since=I` | Last 40 reactions, with both player ids |
| `POST` | `/api/room/:code/config` | Host: update settings (**locked** once playing) |
| `POST` | `/api/room/:code/start` | Host: start / restart a round — no player minimum |
| `POST` | `/api/room/:code/call` | Host: call next, or `{ index }` for a specific item |
| `POST` | `/api/room/:code/mark` | Toggle a dab (manual tables only) |
| `POST` | `/api/room/:code/bingo` | Claim a win (verified server-side) |
| `POST` | `/api/room/:code/chat` | Post a message (max 20 words) |
| `POST` | `/api/room/:code/react` | Throw an emoji at `{ to, emoji }` |
| `POST` | `/api/room/:code/end` | Host: end the round |
| `POST` | `/api/room/:code/leave` | Give up your seat (the host cannot) |
| `GET` | `/api/health` | Liveness check |

## Deploying

1. Provision a D1 database: `wrangler d1 create bingo-tables`
2. Put its `database_id` in `wrangler.toml` (replace `local-dev-only`)
3. Run the migration once: `wrangler d1 execute bingo-tables --remote --file=./schema.sql`
   (the schema lives in `src/worker.js` under `ensureSchema()`; extract it)
4. `npm run deploy` → your Worker is live.

> **Note:** The repo includes no production D1 binding — the `database_id` in
> `wrangler.toml` is a placeholder. The local dev server works out of the box.
