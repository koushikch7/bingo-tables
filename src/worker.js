
  // Everything locks once the round starts — no live tinkering with the rules.
  if (room.status !== 'lobby') return json({ error: 'settings_locked', message: 'Settings are locked once the game starts.' }, 409);

  const current = roomConfig(room);
  const requested = body.config && typeof body.config === 'object' ? body.config : body;
  const wantedContent = requested.content !== undefined ? requested.content : current.content;

  // The item pool lives in the room row. If the host did not resend it, reuse
  // what is already stored — but only when the content type still matches, so
  // switching numbers → images can never inherit the old numbers pool.
  const stored = await env.DB.prepare('SELECT items, content FROM rooms WHERE id = ?').bind(room.id).first();
  const storedItems = (stored && stored.items) || '[]';
  if (requested.customItems === undefined && wantedContent !== 'numbers' && stored && stored.content === wantedContent) {
    let saved = [];
    try {
      saved = JSON.parse(storedItems);
    } catch {
      saved = [];
    }
    requested.customItems = Array.isArray(saved) ? saved : [];
  }