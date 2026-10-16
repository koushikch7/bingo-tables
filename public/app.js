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
  if (state && state.room && state.room.status === 'lobby' && isHost() && !configDirty) fillItemsFromPool();
}