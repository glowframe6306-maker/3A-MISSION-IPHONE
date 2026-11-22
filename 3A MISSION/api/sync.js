/* 3A Mission cloud sync API (Vercel serverless function).
   A tiny authenticated key/value store on top of Vercel Blob.
   The browser encrypts everything (AES-GCM) before upload, so the blob store only ever holds ciphertext.

   Environment variables (Vercel -> Project -> Settings -> Environment Variables):
     SYNC_KEY               the secret sync key you choose (long random text)
   A PRIVATE Vercel Blob store connected to the project (Storage -> Create -> Blob -> Private).
   Needs @vercel/blob >= 2.6.1.
*/
const crypto = require('crypto');
const { put, get, list, del } = require('@vercel/blob');

const PREFIX = '3a-sync/';
const MAX_BODY = 4 * 1024 * 1024; /* Vercel functions accept at most ~4.5 MB per request */
const NAME_RE = /^[A-Za-z0-9._\/-]{1,160}$/;

function authOk(req) {
  const want = process.env.SYNC_KEY;
  const got = req.headers['x-sync-key'];
  if (!want || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readText(pathname) {
  const r = await get(pathname, { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return await new Response(r.stream).text();
}

async function removeOne(pathname) {
  try { await del(pathname); return true; } catch (e) { /* fall back to url lookup */ }
  const r = await list({ prefix: pathname, limit: 10 });
  const hit = r.blobs.find((x) => x.pathname === pathname);
  if (hit) { await del(hit.url); return true; }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const op = url.searchParams.get('op') || '';
    const name = url.searchParams.get('name') || '';

    if (op === 'ping') {
      res.status(200).json({
        configured: !!process.env.SYNC_KEY,
        auth: authOk(req),
      });
      return;
    }
    if (!process.env.SYNC_KEY) {
      res.status(503).json({ error: 'Sync is not configured on the server (SYNC_KEY missing).' });
      return;
    }
    if (!authOk(req)) { res.status(401).json({ error: 'Wrong sync key.' }); return; }

    if (op === 'get') {
      if (!NAME_RE.test(name)) { res.status(400).json({ error: 'Bad name.' }); return; }
      const text = await readText(PREFIX + name);
      if (text == null) { res.status(404).json({ error: 'Not found.' }); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(text);
      return;
    }

    if (op === 'put' && req.method === 'POST') {
      if (!NAME_RE.test(name)) { res.status(400).json({ error: 'Bad name.' }); return; }
      const body = await readBody(req);
      await put(PREFIX + name, body, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'text/plain',
        cacheControlMaxAge: 60,
      });
      res.status(200).json({ ok: true, bytes: body.length });
      return;
    }

    if (op === 'del' && req.method === 'POST') {
      const names = JSON.parse((await readBody(req)) || '[]');
      if (!Array.isArray(names) || names.length > 200 || !names.every((n) => NAME_RE.test(n))) {
        res.status(400).json({ error: 'Bad names.' });
        return;
      }
      let removed = 0;
      for (const n of names) {
        if (await removeOne(PREFIX + n)) removed++;
      }
      res.status(200).json({ ok: true, removed });
      return;
    }

    res.status(400).json({ error: 'Unknown operation.' });
  } catch (e) {
    res.status(e && e.status ? e.status : 500).json({ error: String((e && e.message) || e) });
  }
};

module.exports.config = { api: { bodyParser: false } };
