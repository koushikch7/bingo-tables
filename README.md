# Bingo Tables

Multiplayer bingo tables — join a room, play live with friends. Cloudflare Workers + D1.

## Features

- Real-time play with automatic calling (configurable interval)
- Six board types: numbers, names, emoji/images, music, names+images, custom
- **Custom content**: upload your own images and names, or use the built-in pool
- Photo avatars for players (upload from home screen)
- Stadium view with photos, emoji reactions (1 per player per minute), chat (≤20 words)
- Bingo, Four Corners, Full Line, Diagonal, X, Blackout; free centre when enabled
- Host controls: call, start/end, settings locked once round starts
- D1-backed rooms/players/cards/winners/messages/reactions

## Development

```bash
npm install
npm run dev
```

Tests:

```bash
npm test
node scripts/smoke.mjs        # 217 API checks
node scripts/smoke.mjs --scale # 226 checks incl load
```

## Deploy

```bash
npm run deploy
```
