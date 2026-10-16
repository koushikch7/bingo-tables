# Requirements for Bingo Tables

This document states concrete, testable requirements (R-01..R-19). All smoke/API tests and the browser harness verify these.

## 1. Rooms & joining (R-01..R-03)

- R-01: A new room is created with a 6-character alphanumeric code (A–Z, 0–9) when the host clicks "New Table". The code is stored and returned.
- R-02: Players join a room by code; the join requires a display name (1–16 chars). Names are trimmed and deduplicated client-side; server may reject empty/invalid.
- R-03: On join, a player gets a role (host/player), a player id and a token stored in `sessionStorage`.

## 2. Boards & geometry (R-04..R-05)

- R-04: Geometry is rows × cols with `min 3, max 6` for both (so valid table sizes 3×3 up to 6×6). Centre is free when `free_centre` is true.
- R-05: A card has `rows*cols` cells. Numbers content fills 1..N in a random order per player (seeded). Other content types draw from the callable pool (the room's items) without duplicates per card.

## 3. Calling & marking (R-06..R-08)

- R-06: Call mode is `auto` or `manual`. Auto uses `call_interval_ms` in {1500,2000,2500,3000,3500,4000,4500,5000}. Manual only the host may call the next item.
- R-07: Marking mode is `free` (tap any cell) or `called-only` (tap only cells whose values match the last called item). Taps are idempotent.
- R-08: The callable pool comes from **content type**. Numbers use 1..poolSize. Names use a built-in list or a **host-provided list** (My own names). Emoji/images use a built-in pool or **uploaded images with optional names** (My own images). Music uses a built-in list or can be populated by uploads in that type. **Names+images** pairs host names with uploaded images (or falls back to the pool). **Custom** uses the exact host list. When **My own images & names** is selected, the studio requires uploads (names+images needs names and pictures) and enforces `min 9, max 30` items by default in practice but the save gate is "cover every cell" (need `rows*cols` usable items). Pictures are downscaled in-browser to ≤96 px JPEG before upload (data URL) to keep size small.

## 4. Win conditions (R-09..R-10)

- R-09: Winner modes include `bingo` (any full line), `four-corners`, `full-line`, `diagonal`, `x`, `blackout`. `max_winners` 1..5 (or unlimited in UI but capped). `winner_call` `on_call` or `on_mark`.
- R-10: A win is detected on the card; results are broadcast. The room may end when reaching max winners (or host ends).

## 5. Social & roster (R-11..R-12)

- R-11: The joined users list (roster) shows connected players with their names/avatars and updates on join/leave/state changes.
- R-12: Chat is enabled/disabled by host; messages are capped at **20 words** (client+server), trimmed, and retained briefly (pruned by time). Reactions are **one emoji per player per minute** (server enforces 429 with `retryInMs`; client disables the send row and shows a countdown).

## 6. API contracts (R-13..R-15)

- R-13: Endpoints include `POST /api/room/create`, `POST /api/room/:code/join`, `GET /api/room/:code/state`, `POST /api/room/:code/config`, `POST /api/room/:code/start`, `POST /api/room/:code/call`, `POST /api/room/:code/mark`, `POST /api/room/:code/end`, `POST /api/room/:code/chat`, `POST /api/room/:code/react`, `GET /api/room/:code/pool`, `GET /api/room/:code/players`, `GET /api/room/:code/leaderboard`, `GET /api/room/:code/social`. Responses use standard JSON and appropriate status codes.
- R-14: `POST /config` requires host auth and rejects changes once `status !== 'lobby'` (409 `settings_locked`). It validates geometry, content, pool size against table size (`pool_size >= rows*cols` when free_centre false; `pool_size >= rows*cols-1` when free_centre true), items count/types, and caps (see R-08). The server stores `items` (the callable pool) and bumps `pool_version` if geometry/type or the pool content changed.
- R-15: `GET /state` returns the room snapshot (including `called`, `called_count`, `pool_version`, `roster_version`, `chat`, `reactions`, `config`) plus the viewer's card/role/token context as applicable. `GET /pool` returns the callable items and version; clients refetch only when `since < version` or on content change.

## 7. Validation & safety (R-16..R-17)

- R-16: Uploads are **browser-downscaled** to ≤96 px and converted to JPEG data URL (size capped on client and server). Avatars are small data URLs (≤2000). Chat length ≤20 words. Reactions limited to the allowed set and ≤1/min.
- R-17: The count of usable items is always shown and saving is blocked until `usable >= needed` (needed = `rows*cols - (free_centre?1:0)`). The server also rejects a config that would leave too few callable items (`pool_too_small`) or an empty/invalid list (`invalid_items`); it never silently swaps an unusable host list for the built-in pool.

## 8. UI/UX & stadium (R-18)

- R-18: Studio has source choice (Built-in / My own...) per non-numbers type, auto-fill buttons, upload grid with per-picture names and remove. Stadium renders photos for image cells, emoji for emoji cells, and centres the table with seats arranged around it (no overlap) in a ring/table layout; the top bar shows "X of Y items" and a checkmark when complete on every type.

## 9. Performance & correctness (R-19)

- R-19: The smoke suite covers numbers, names (built-in+host), images (built-in+uploads), music, names+images (paired), custom; emoji rendering; photo avatar; reaction cooldown (429); rate limits for chat/react; host list reuse only when content matches; `hidden` panels are actually hidden (CSS present). Unit tests cover normaliseItem, MAX constants, pool bytes/media limits. Browser harness checks all combinations and stadium layout. `node --check` passes on all sources.
