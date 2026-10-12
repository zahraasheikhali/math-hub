/* ═══════════ Zahra's Maths Hub — notification server ═══════════
   A Cloudflare Worker. It does three things and nothing else:
     POST /api/subscribe   a phone registers itself
     POST /api/unsubscribe a phone opts out
     POST /api/notify      the teacher sends a notification (in batches of ~40 phones)
   Everything else falls through to the website's normal files.

   The VAPID private key and the teacher token are SECRETS set in the
   Cloudflare dashboard — they are never in this file or in index.html. */

const enc = new TextEncoder();

/* ---- small helpers ---- */
const b64urlToBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64url = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/* ---- sign a VAPID JWT for one push endpoint ---- */
async function vapidAuth(endpoint, privateKeyB64, publicKeyB64, subject) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject
  })));
  const data = enc.encode(header + '.' + payload);

  const d = b64urlToBytes(privateKeyB64);
  const pub = b64urlToBytes(publicKeyB64);           /* 65 bytes: 0x04 || X || Y */
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: bytesToB64url(d),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  return { jwt: header + '.' + payload + '.' + bytesToB64url(sig), publicKey: publicKeyB64 };
}

/* ---- encrypt the message body (RFC 8291, aes128gcm) ---- */
async function encryptPayload(text, p256dhB64, authB64) {
  const clientPub = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const plaintext = enc.encode(text);

  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const clientKey = await crypto.subtle.importKey('raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const hkdf = async (ikm, salt, info, len) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
  };

  const cat = (...arrs) => {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total); let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };

  const prkInfo = cat(enc.encode('WebPush: info\0'), clientPub, serverPubRaw);
  const ikm = await hkdf(shared, authSecret, prkInfo, 32);
  const cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = cat(plaintext, new Uint8Array([0x02]));      /* final record delimiter */
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([serverPubRaw.length]), serverPubRaw, ct);
}

async function sendOne(sub, text, env) {
  const { jwt, publicKey } = await vapidAuth(sub.endpoint, env.VAPID_PRIVATE, env.VAPID_PUBLIC, env.VAPID_SUBJECT || 'mailto:teacher@example.com');
  const body = await encryptPayload(text, sub.keys.p256dh, sub.keys.auth);
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'TTL': '86400',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Authorization': `vapid t=${jwt}, k=${publicKey}`
    },
    body
  });
}

/* ---- storage ----
   Each phone is stored under 'sub:<hash of endpoint>'. The whole subscription is
   ALSO kept in the key's metadata, so one list() call returns every phone at once.
   Why it matters: Cloudflare's free plan allows only 50 outside calls per request,
   and KV reads count. The old version did a read AND a send per phone, so past
   ~24 phones the rest silently got nothing. */
const subKey = async (endpoint) =>
  'sub:' + bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(endpoint)))).slice(0, 32);

const BUDGET = 45;          /* outside calls we allow ourselves per request (limit is 50) */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/vapid-public') {
      return json({ key: env.VAPID_PUBLIC || '' });
    }

    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      const sub = await request.json().catch(() => null);
      if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({ error: 'bad subscription' }, 400);
      let role = sub.role, userId = sub.userId;
      /* The phone replaced its subscription by itself (service worker): carry the
         person over from the old record, then forget the old one. */
      if (sub.oldEndpoint && sub.oldEndpoint !== sub.endpoint) {
        const oldK = await subKey(sub.oldEndpoint);
        const old = await env.PUSH_SUBS.get(oldK, 'json').catch(() => null);
        if (old) { role = role || old.role; userId = userId || old.userId; }
        await env.PUSH_SUBS.delete(oldK);
      }
      const rec = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        role: String(role || 'student').slice(0, 12),
        userId: String(userId || '').slice(0, 40),
        at: Date.now()
      };
      await env.PUSH_SUBS.put(await subKey(sub.endpoint), JSON.stringify(rec), { metadata: rec });
      return json({ ok: true });
    }

    if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
      const { endpoint } = await request.json().catch(() => ({}));
      if (!endpoint) return json({ error: 'no endpoint' }, 400);
      await env.PUSH_SUBS.delete(await subKey(endpoint));
      return json({ ok: true });
    }

    if (url.pathname === '/api/notify' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!env.TEACHER_TOKEN || body.token !== env.TEACHER_TOKEN) return json({ error: 'not allowed' }, 403);
      const title = String(body.title || 'Maths Hub').slice(0, 80);
      const text = String(body.body || '').slice(0, 300);
      const payload = JSON.stringify({ title, body: text, url: body.url || '/' });

      const role = body.role || null;                    /* 'student' | 'parent' | null = everyone */
      const only = Array.isArray(body.userIds) ? body.userIds.map(String) : null;
      const start = Math.max(0, parseInt(body.offset, 10) || 0);   /* where the previous batch stopped */

      let used = 0;
      const all = [];
      let cursor;
      do {                                               /* 1000 keys per page — one page for a school */
        const page = await env.PUSH_SUBS.list({ prefix: 'sub:', cursor }); used++;
        all.push(...page.keys);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && used < 3);

      let sent = 0, gone = 0, skipped = 0, failed = 0, next = null;
      for (let i = start; i < all.length; i++) {
        if (used >= BUDGET) { next = i; break; }        /* the app calls again from here */
        const k = all[i];
        let sub = k.metadata;
        if (!sub || !sub.endpoint) {                     /* saved by the old version: read it once */
          const raw = await env.PUSH_SUBS.get(k.name); used++;
          if (!raw) continue;
          sub = JSON.parse(raw);
        }
        if (role && sub.role !== role) { skipped++; continue; }
        if (only && !only.includes(String(sub.userId))) { skipped++; continue; }
        if (used + 2 > BUDGET) { next = i; break; }
        try {
          const res = await sendOne(sub, payload, env); used++;
          if (res.status === 404 || res.status === 410) { await env.PUSH_SUBS.delete(k.name); used++; gone++; }
          else if (res.ok) sent++;
          else failed++;
        } catch (e) { failed++; }                         /* one bad phone must not stop the rest */
      }
      return json({ ok: true, sent, removed: gone, skipped, failed, total: all.length, next });
    }

    return env.ASSETS.fetch(request);      /* everything else: the website itself */
  }
};
