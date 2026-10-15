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

Rows and columns are not cosmetic — they determine the number pool:

```
numbers per column = min(3 × rows, 99 / cols)
total numbers      = numbers per column × columns
```

So the classic **5 × 5** board is exactly standard 75-ball bingo (15 numbers per
column, B-I-N-G-O). A **6 × 8** board for a big room produces 96 numbers, 12 per
column. Every cell stays two digits so cards stay readable on a phone.

### Choosing a board for your group

More players means more cards, which means someone completes a line sooner — so
bigger groups get bigger cards to keep the round from ending on the third call.
The settings panel has an **Expected players** box that recommends a board:

| Expected players | Board | Numbers |
| --- | --- | --- |
| 4–12 | 4 × 4 | 48 |
| 13–30 | 5 × 5 | 75 |
| 31–80 | 5 × 6 | 90 |
| 81–150 | 5 × 7 | 98 |
| 151–300 | 6 × 6 | 96 |
| 301–500 | 6 × 8 | 96 |

The panel also reports **card variety**. When a column holds barely more numbers
than a card needs, cards repeat and simultaneous winners get common — useful to
know before a 500-player round.

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

Patterns are generated from the board, so "rows 1/2/3" and "columns 1/2/3" are
simply `row:0`–`row:2` and `col:0`–`col:2`. Presets: **Classic lines**, **All
rows**, **All columns**, **Diagonals**, **Four corners**, **Blackout**, or pick
each one by hand.

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
npm test                          # unit tests for the shared rules
npm run dev                       # wrangler dev → http://localhost:8787
node scripts/smoke.mjs            # end-to-end API suite
node scripts/smoke.mjs --scale    # ...plus a 500-player load check
```

`wrangler dev` uses a **local** D1 database (SQLite under `.wrangler/`), so no
cloud account or remote database is needed to develop or test.

> **Upgrading from an earlier build?** The schema changed. `ensureSchema` detects
> a pre-launch database with the old shape and rebuilds it, since there is no
> data worth preserving yet. Replace that guard with a real migration before the
> app holds live data.

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

The hot path is `GET /state`, polled about once a second per player. It is kept
O(1) in table size:

- **Cards are derived, never stored.** A card is a pure function of
  `(room seed, round, player id)`, so dealing a round costs the same for 4 or
  500 players — there is no per-player write, not even a reset between rounds.
- **Auto dabbing stores nothing.** A cell is dabbed exactly when its number has
  been called, so marks are computed on read.
- **The draw clock only writes when a draw is due**, using a compare-and-swap on
  the called count so pollers arriving together cannot call two numbers.
- **Called numbers are sent incrementally** — a client that is caught up
  receives only the new ones.
- **The roster and leaderboard are separate endpoints.** The roster is fetched
  only when it changes; the leaderboard only when enabled and throttled, capped
  and cached per isolate.
- **`last_seen` is written at most once every 15s per player**, not per poll.
- **The client polls more slowly in bigger rooms** (~1s under 40 players, ~2s
  at 500).

Measured on a local `wrangler dev` with **500 seats in one room**:

| Metric | Result |
| --- | --- |
| `GET /state` latency | **p50 9 ms, p95 18 ms** |
| `GET /state` payload | **~1.4 KB — flat, independent of player count** |
| Starting a round | O(1), no per-player writes |
| Leaderboard across 500 players | 36 ms cold, 6 ms warm |
| 499 joins | 12.5 ms each |
| Roster payload | 43 KB for 500 players (fetched only on change) |

## API

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

Player identity is a random token sent in the `x-player-token` header, kept in
`localStorage` so a refresh drops you back into your seat. This is a casual
party game — tokens are seat identifiers, not accounts.

## Deploying

The app targets Workers + a D1 binding named `DB`. Add a real database id to
`wrangler.toml` (or attach the binding through your hosting platform) and run:

```bash
npx wrangler deploy
```

Tables are created on first use, so there is no separate migration step.
