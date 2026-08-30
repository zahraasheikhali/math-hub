/* ═══════════ Zahra's Maths Hub — notification server ═══════════
   A Cloudflare Worker. It does three things and nothing else:
     POST /api/subscribe   a phone registers itself
     POST /api/unsubscribe a phone opts out
     POST /api/notify      the teacher sends a notification to everyone
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/vapid-public') {
      return json({ key: env.VAPID_PUBLIC || '' });
    }

    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      const sub = await request.json().catch(() => null);
      if (!sub || !sub.endpoint || !sub.keys) return json({ error: 'bad subscription' }, 400);
      const id = bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(sub.endpoint)))).slice(0, 32);
      await env.PUSH_SUBS.put('sub:' + id, JSON.stringify({
        endpoint: sub.endpoint, keys: sub.keys,
        role: String(sub.role || 'student').slice(0, 12),
        userId: String(sub.userId || '').slice(0, 40),
        at: Date.now()
      }));
      return json({ ok: true });
    }

    if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
      const { endpoint } = await request.json().catch(() => ({}));
      if (!endpoint) return json({ error: 'no endpoint' }, 400);
      const id = bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(endpoint)))).slice(0, 32);
      await env.PUSH_SUBS.delete('sub:' + id);
      return json({ ok: true });
    }

    if (url.pathname === '/api/notify' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      if (!env.TEACHER_TOKEN || body.token !== env.TEACHER_TOKEN) return json({ error: 'not allowed' }, 403);
      const title = String(body.title || 'Maths Hub').slice(0, 80);
      const text = String(body.body || '').slice(0, 300);
      const payload = JSON.stringify({ title, body: text, url: body.url || '/' });

      const role = body.role || null;                    /* 'student' | 'parent' | null = everyone */
      const only = Array.isArray(body.userIds) ? body.userIds : null;
      const list = await env.PUSH_SUBS.list({ prefix: 'sub:' });
      let sent = 0, gone = 0, skipped = 0;
      for (const k of list.keys) {
        const raw = await env.PUSH_SUBS.get(k.name);
        if (!raw) continue;
        const sub = JSON.parse(raw);
        if (role && sub.role !== role) { skipped++; continue; }
        if (only && !only.includes(sub.userId)) { skipped++; continue; }
        try {
          const res = await sendOne(sub, payload, env);
          if (res.status === 404 || res.status === 410) { await env.PUSH_SUBS.delete(k.name); gone++; }
          else if (res.ok || res.status === 201) sent++;
        } catch (e) { /* one bad phone must not stop the rest */ }
      }
      return json({ ok: true, sent, removed: gone, skipped, total: list.keys.length });
    }

    return env.ASSETS.fetch(request);      /* everything else: the website itself */
  }
};
