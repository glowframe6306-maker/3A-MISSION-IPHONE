/* 3A Mission cloud sync API (Vercel serverless function).
   A tiny authenticated key/value store on top of Vercel Blob.
   The browser encrypts everything (AES-GCM) before upload, so the blob store only ever holds ciphertext.

   Environment variables (Vercel -> Project -> Settings -> Environment Variables):
     SYNC_KEY               the secret sync key you choose (long random text)
     BLOB_READ_WRITE_TOKEN  added automatically when you create/connect a Blob store to the project
*/
const crypto = require('crypto');
const { put, list, del } = require('@vercel/blob');

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

async function findBlob(pathname) {
  let cursor;
  do {
    const r = await list({ prefix: pathname, cursor, limit: 100 });
    const hit = r.blobs.find((b) => b.pathname === pathname);
    if (hit) return hit;
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const url = new URL(req.url, 'http://x');
    const op = url.searchParams.get('op') || '';
    const name = url.searchParams.get('name') || '';

    if (op === 'ping') {
      res.status(200).json({
        configured: !!process.env.SYNC_KEY && !!process.env.BLOB_READ_WRITE_TOKEN,
        auth: authOk(req),
      });
      return;
    }
    if (!process.env.SYNC_KEY || !process.env.BLOB_READ_WRITE_TOKEN) {
      res.status(503).json({ error: 'Sync is not configured on the server (SYNC_KEY / Blob store missing).' });
      return;
    }
    if (!authOk(req)) { res.status(401).json({ error: 'Wrong sync key.' }); return; }

    if (op === 'get') {
      if (!NAME_RE.test(name)) { res.status(400).json({ error: 'Bad name.' }); return; }
      const b = await findBlob(PREFIX + name);
      if (!b) { res.status(404).json({ error: 'Not found.' }); return; }
      const r = await fetch(b.url + (b.url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) { res.status(502).json({ error: 'Storage read failed (' + r.status + ').' }); return; }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(await r.text());
      return;
    }

    if (op === 'put' && req.method === 'POST') {
      if (!NAME_RE.test(name)) { res.status(400).json({ error: 'Bad name.' }); return; }
      const body = await readBody(req);
      await put(PREFIX + name, body, {
        access: 'public',
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
        const b = await findBlob(PREFIX + n);
        if (b) { await del(b.url); removed++; }
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
