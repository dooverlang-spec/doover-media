// Doover TikTok uploader backend (Cloud Functions gen2, Node 20).
// Holds the TikTok client secret and the account's tokens so the public
// Pages site (dooverlang-spec.github.io/doover-media/tiktok/) never sees them.
const crypto = require('crypto');
const functions = require('@google-cloud/functions-framework');
const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');

const {
  TIKTOK_CLIENT_KEY,
  TIKTOK_CLIENT_SECRET,
  SESSION_SECRET,
  ROUTINE_KEY,
  GOOGLE_CLOUD_PROJECT,
  ALLOWED_ORIGIN = 'https://dooverlang-spec.github.io',
  REDIRECT_URI = 'https://dooverlang-spec.github.io/doover-media/tiktok/callback.html',
  TOKEN_SECRET_ID = 'tiktok-token',
} = process.env;

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = 'user.info.basic,video.upload';
const sm = new SecretManagerServiceClient();
const tokenSecret = () => `projects/${GOOGLE_CLOUD_PROJECT}/secrets/${TOKEN_SECRET_ID}`;

// ---- token storage (one TikTok account) ----

async function loadToken() {
  try {
    const [v] = await sm.accessSecretVersion({ name: `${tokenSecret()}/versions/latest` });
    return JSON.parse(v.payload.data.toString('utf8'));
  } catch (e) {
    return null;
  }
}

async function saveToken(token) {
  const [prev] = await sm.listSecretVersions({ parent: tokenSecret(), filter: 'state:ENABLED' });
  await sm.addSecretVersion({
    parent: tokenSecret(),
    payload: { data: Buffer.from(JSON.stringify(token), 'utf8') },
  });
  // Keep only the newest version so refreshes don't pile up billable versions.
  for (const v of prev) await sm.destroySecretVersion({ name: v.name }).catch(() => {});
}

async function oauth(params) {
  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    ...params,
  });
  const r = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token: ${j.error || r.status} ${j.error_description || ''}`);
  return {
    open_id: j.open_id,
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in - 300) * 1000,
    refresh_expires_at: Date.now() + j.refresh_expires_in * 1000,
  };
}

async function accessToken() {
  let t = await loadToken();
  if (!t) throw new Error('not connected');
  if (Date.now() > t.expires_at) {
    const fresh = await oauth({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    // Login Kit pins one account; never let a refresh swap it.
    if (fresh.open_id && fresh.open_id !== t.open_id) throw new Error('account mismatch');
    t = fresh;
    await saveToken(t);
  }
  return t.access_token;
}

async function tiktok(path, init = {}) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json; charset=UTF-8',
      ...(init.headers || {}),
    },
  });
  const j = await r.json();
  if (j.error && j.error.code !== 'ok') throw new Error(`${path}: ${j.error.code} ${j.error.message}`);
  return j.data;
}

// ---- browser sessions (HMAC-signed, short-lived) ----

function sign(openId) {
  const exp = Date.now() + 2 * 3600 * 1000;
  const body = `${openId}.${exp}`;
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(session) {
  const [openId, exp, mac] = String(session || '').split('.');
  if (!openId || !exp || !mac || Date.now() > Number(exp)) return null;
  const want = crypto.createHmac('sha256', SESSION_SECRET).update(`${openId}.${exp}`).digest('base64url');
  const ok = want.length === mac.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac));
  return ok ? openId : null;
}

async function authorized(req) {
  const key = req.get('x-routine-key');
  if (ROUTINE_KEY && key && key.length === ROUTINE_KEY.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ROUTINE_KEY))) return true;
  const openId = verify((req.get('authorization') || '').replace(/^Bearer /, ''));
  const t = openId && (await loadToken());
  return Boolean(t && t.open_id === openId);
}

// ---- upload ----

async function sendToInbox(videoUrl) {
  if (!/^https:\/\/dooverlang-spec\.github\.io\/doover-media\//.test(videoUrl)) {
    throw new Error('video must be on the doover-media site');
  }
  const vr = await fetch(videoUrl);
  if (!vr.ok) throw new Error(`video fetch ${vr.status}`);
  const video = Buffer.from(await vr.arrayBuffer());
  if (video.length > 64 * 1024 * 1024) throw new Error('video over 64MB');
  const init = await tiktok('/post/publish/inbox/video/init/', {
    method: 'POST',
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: video.length,
        chunk_size: video.length,
        total_chunk_count: 1,
      },
    }),
  });
  const up = await fetch(init.upload_url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(video.length),
      'Content-Range': `bytes 0-${video.length - 1}/${video.length}`,
    },
    body: video,
  });
  if (!up.ok) throw new Error(`upload ${up.status}`);
  return init.publish_id;
}

// ---- routes ----

functions.http('tiktok', async (req, res) => {
  res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    switch (req.path) {
      case '/config':
        return res.json({ client_key: TIKTOK_CLIENT_KEY, redirect_uri: REDIRECT_URI, scope: SCOPES });

      case '/exchange': {
        const t = await oauth({
          grant_type: 'authorization_code',
          code: req.body.code,
          redirect_uri: REDIRECT_URI,
        });
        const current = await loadToken();
        if (current && current.open_id !== t.open_id && Date.now() < current.refresh_expires_at) {
          return res.status(403).json({ error: 'This uploader is already linked to another TikTok account.' });
        }
        await saveToken(t);
        return res.json({ session: sign(t.open_id) });
      }

      case '/me': {
        if (!(await authorized(req))) return res.status(401).json({ error: 'login required' });
        const d = await tiktok('/user/info/?fields=open_id,display_name,avatar_url');
        return res.json(d.user);
      }

      case '/send': {
        if (!(await authorized(req))) return res.status(401).json({ error: 'login required' });
        return res.json({ publish_id: await sendToInbox(req.body.video_url) });
      }

      case '/status': {
        if (!(await authorized(req))) return res.status(401).json({ error: 'login required' });
        const d = await tiktok('/post/publish/status/fetch/', {
          method: 'POST',
          body: JSON.stringify({ publish_id: req.body.publish_id }),
        });
        return res.json(d);
      }

      default:
        return res.status(404).json({ error: 'not found' });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});
