function usableItemCount(items) {
  if (!Array.isArray(items)) return 0;
  let c = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it && typeof it === 'object') {
      if (it.type === 'image' && (it.image || it.dataUrl)) { c++; continue; }
      if (it.type === 'emoji' && (it.emoji || it.label)) { c++; continue; }
      if (it.label && String(it.label).trim() !== '') { c++; continue; }
      if (it.value !== undefined && String(it.value) !== '') { c++; continue; }
    } else if (it !== undefined && it !== null) {
      c++;
    }
  }
  return c;
}