function quickreadTrack(event, detail = {}) {
  if (!event || typeof event !== 'string') return;
  fetch('/api/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, detail }),
    keepalive: true,
  }).catch(() => {});
}
