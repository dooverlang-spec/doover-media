// Shared by index.html and callback.html.
const API = 'https://asia-northeast3-doover-promo.cloudfunctions.net/tiktok';

function session() {
  try { return sessionStorage.getItem('tt_session'); } catch (e) { return null; }
}

async function api(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      session() ? { Authorization: 'Bearer ' + session() } : {}
    ),
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
