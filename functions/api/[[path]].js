// DropLink v2 API — Cloudflare Pages Function, files stored in Google Drive
// Binding required (Pages → Settings → Bindings):
//   DB → D1 database
// Environment variables (Pages → Settings → Variables and Secrets):
//   ADMIN_PASSWORD   (required)  password to log in
//   SCRIPT_URL       (required)  Google Apps Script web-app URL (handles Drive access + email)
//   SCRIPT_KEY       (required)  shared secret, same as SECRET_KEY in the Apps Script
//   SENDER_NAME      (optional)  name shown in emails, e.g. "Musfikur Rahman"
//   STORAGE_LIMIT_GB (optional)  extra cap for DropLink files (default: whatever is free in Drive)
//   CLEANUP_KEY      (optional)  lets a daily GitHub Action call /api/cleanup?key=...
//   NOTIFY_EMAIL     (optional)  your email — get notified on downloads and on files received via Request links

const DAY = 86400000;
let schemaReady = false;
let tokenCache = null; // { token, folderId, exp }

const driveBase = (env) => (env.DRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/$/, '');

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY, title TEXT, message TEXT, created_at INTEGER, expires_at INTEGER,
      status TEXT, pass_hash TEXT, pass_salt TEXT, total_size INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0, downloads INTEGER DEFAULT 0, last_download_at INTEGER,
      recipients TEXT DEFAULT '[]')`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, transfer_id TEXT, name TEXT, size INTEGER, type TEXT,
      drive_id TEXT, session_url TEXT, done INTEGER DEFAULT 0, downloads INTEGER DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_files_transfer ON files(transfer_id)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status, expires_at)`),
  ]);
  const ver = await env.DB.prepare(`SELECT v FROM kv WHERE k='schema'`).first();
  if (!ver || Number(ver.v) < 4) {
    for (const col of ['folder_id TEXT', 'notify INTEGER DEFAULT 0', 'notified INTEGER DEFAULT 0', 'request_id TEXT', 'from_name TEXT', 'from_email TEXT', 'from_note TEXT']) {
      try { await env.DB.prepare(`ALTER TABLE transfers ADD COLUMN ${col}`).run(); } catch (e) {}
    }
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, emails TEXT, created_at INTEGER)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, title TEXT, message TEXT, created_at INTEGER, expires_at INTEGER,
        keep_days INTEGER, max_bytes INTEGER, status TEXT, pass_hash TEXT, pass_salt TEXT, uploads INTEGER DEFAULT 0, recipients TEXT DEFAULT '[]')`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transfers_request ON transfers(request_id)`),
      env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, exp) VALUES ('schema', '4', 0)`),
    ]);
  }
  schemaReady = true;
}

// ---------- helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const fail = (msg, status = 400) => json({ error: msg }, status);

const ALPHA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function rid(n = 10) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const x of b) s += ALPHA[x % ALPHA.length];
  return s;
}
const enc = new TextEncoder();
function b64url(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
async function sha256(str) {
  return b64url(await crypto.subtle.digest('SHA-256', enc.encode(str)));
}
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const secretOf = (env) => (env.SESSION_SECRET || '') + '|' + (env.ADMIN_PASSWORD || '') + '|droplink';
function cookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isAdmin(request, env) {
  const v = cookie(request, 'dl_s');
  if (!v || !env.ADMIN_PASSWORD) return false;
  const [exp, sig] = v.split('.');
  if (!exp || Number(exp) < Date.now()) return false;
  return safeEq(sig, await hmac(secretOf(env), 'admin.' + exp));
}
async function unlockToken(env, tid, exp) {
  return exp + '.' + (await hmac(secretOf(env), 'unlock.' + tid + '.' + exp));
}
async function validUnlock(env, tid, token) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || Number(exp) < Date.now()) return false;
  return safeEq(sig, await hmac(secretOf(env), 'unlock.' + tid + '.' + exp));
}
function safeName(name) {
  return String(name || 'file').replace(/[\\]/g, '/').split('/')
    .map(p => p.replace(/[^\p{L}\p{N}\p{M}_.\- ()&+,@#\[\]]/gu, '_')).filter(Boolean).join('/').slice(-200) || 'file';
}
function disposition(type, name) {
  const base = String(name).split('/').pop();
  const ascii = base.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dhaka' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Google Apps Script bridge ----------
async function callScript(env, payload) {
  if (!env.SCRIPT_URL) throw new Error('Google Apps Script is not connected yet (SCRIPT_URL missing in Cloudflare settings)');
  let r;
  try {
    r = await fetch(env.SCRIPT_URL, {
      method: 'POST', redirect: 'follow',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ key: env.SCRIPT_KEY || '', ...payload }),
    });
  } catch (e) { throw new Error('Could not reach Google Apps Script: ' + e.message); }
  const text = await r.text();
  let out;
  try { out = JSON.parse(text); }
  catch (e) { throw new Error('Google Apps Script did not answer correctly. Check the deployment has “Who has access: Anyone”.'); }
  if (!out.ok) throw new Error(out.error || 'Apps Script error');
  return out;
}
// OAuth token for Drive, cached in memory + D1 (~45 min)
async function getDrive(env, force = false) {
  const now = Date.now();
  if (!force && tokenCache && tokenCache.exp > now) return tokenCache;
  if (!force) {
    const row = await env.DB.prepare(`SELECT v, exp FROM kv WHERE k='drive'`).first();
    if (row && row.exp > now) { tokenCache = { ...JSON.parse(row.v), exp: row.exp }; return tokenCache; }
  }
  const out = await callScript(env, { action: 'token' });
  tokenCache = { token: out.token, folderId: out.folderId, exp: now + 45 * 60000 };
  await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, exp) VALUES ('drive', ?, ?)`)
    .bind(JSON.stringify({ token: out.token, folderId: out.folderId }), tokenCache.exp).run();
  return tokenCache;
}
// fetch Google Drive API with auto token refresh on 401
async function gfetch(env, path, init = {}) {
  let d = await getDrive(env);
  const go = (tok) => fetch(driveBase(env) + path, { ...init, headers: { ...(init.headers || {}), authorization: 'Bearer ' + tok } });
  let r = await go(d.token);
  if (r.status === 401) { d = await getDrive(env, true); r = await go(d.token); }
  return r;
}
async function driveQuota(env) {
  try {
    const r = await gfetch(env, '/drive/v3/about?fields=storageQuota');
    if (!r.ok) return null;
    const q = (await r.json()).storageQuota || {};
    return { limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage || 0) };
  } catch (e) { return null; }
}
async function driveDelete(env, id) {
  try { const r = await gfetch(env, '/drive/v3/files/' + encodeURIComponent(id), { method: 'DELETE' }); return r.ok || r.status === 404; }
  catch (e) { return false; }
}

async function usage(env, withDrive = true) {
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(total_size),0) AS used, COUNT(*) AS n FROM transfers WHERE status IN ('ready','uploading')`).first();
  const out = { used: r.used, active: r.n, cap: env.STORAGE_LIMIT_GB ? Number(env.STORAGE_LIMIT_GB) * 1024 ** 3 : null };
  if (withDrive) out.drive = await driveQuota(env);
  // free space for new uploads = smaller of (Drive free) and (DropLink cap left)
  const frees = [];
  if (out.drive && out.drive.limit) frees.push(out.drive.limit - out.drive.usage);
  if (out.cap) frees.push(out.cap - out.used);
  out.free = frees.length ? Math.max(0, Math.min(...frees)) : null;
  return out;
}

// Delete expired / abandoned transfers and their Drive files
async function cleanup(env, max = 10) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT id, status FROM transfers WHERE (status='ready' AND expires_at < ?) OR (status='uploading' AND created_at < ?) LIMIT ?`
  ).bind(now, now - DAY, max).all();
  for (const t of results) await purge(env, t.id, t.status === 'ready' ? 'expired' : 'deleted');
  return results.length;
}
async function purge(env, tid, newStatus) {
  const t = await env.DB.prepare(`SELECT folder_id FROM transfers WHERE id=?`).bind(tid).first();
  if (t && t.folder_id) {
    await driveDelete(env, t.folder_id);   // deleting the folder removes all its files in one step
  } else {
    // older transfers without a folder: delete file by file (max 40 per request)
    const { results: files } = await env.DB.prepare(`SELECT drive_id FROM files WHERE transfer_id=? AND drive_id IS NOT NULL LIMIT 40`).bind(tid).all();
    for (const f of files) await driveDelete(env, f.drive_id);
  }
  await env.DB.batch([
    env.DB.prepare(`UPDATE transfers SET status=? WHERE id=?`).bind(newStatus, tid),
    env.DB.prepare(`UPDATE files SET session_url=NULL WHERE transfer_id=?`).bind(tid),
  ]);
}

// ---------- shared transfer creation (used by you and by Request-files uploads) ----------
async function createTransfer(env, { title, message, files, expires, password, notify = 0, extra = {} }) {
  const now = Date.now();
  files = Array.isArray(files) ? files : [];
  if (!files.length) throw httpError('Add at least one file', 400);
  if (files.length > 1000) throw httpError('Maximum 1000 files per transfer', 400);
  const total = files.reduce((s, f) => s + Math.max(0, Number(f.size) || 0), 0);
  const u = await usage(env);
  if (u.free !== null && total > u.free) throw httpError(`Not enough free space: this upload is ${fmtSize(total)}, but only ${fmtSize(u.free)} is free in Google Drive.`, 413);
  const tid = rid(10);
  let passHash = null, passSalt = null;
  if (password) { passSalt = rid(12); passHash = await sha256(passSalt + '|' + password); }
  title = String(title || '').trim().slice(0, 160) || (files.length === 1 ? String(files[0].name).split('/').pop() : `${files.length} files`);
  const drive = await getDrive(env);
  const fr = await gfetch(env, '/drive/v3/files?fields=id', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${new Date(now).toISOString().slice(0, 10)} · ${title.replace(/[\\/]/g, '-')} (${tid})`, mimeType: 'application/vnd.google-apps.folder', parents: [drive.folderId] }),
  });
  if (!fr.ok) throw httpError('Google Drive error: ' + (await fr.text()).slice(0, 200), 502);
  const folderId = (await fr.json()).id;
  const stmts = [env.DB.prepare(
    `INSERT INTO transfers (id,title,message,created_at,expires_at,status,pass_hash,pass_salt,total_size,file_count,folder_id,notify,request_id,from_name,from_email,from_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(tid, title, String(message || '').slice(0, 3000), now, expires, 'uploading', passHash, passSalt, total, files.length, folderId, notify ? 1 : 0,
    extra.request_id || null, extra.from_name || null, extra.from_email || null, extra.from_note || null)];
  const out = [];
  for (const f of files) {
    const fid = rid(12);
    const name = safeName(f.name);
    const size = Math.max(0, Number(f.size) || 0);
    const type = String(f.type || 'application/octet-stream').slice(0, 100) || 'application/octet-stream';
    stmts.push(env.DB.prepare(`INSERT INTO files (id,transfer_id,name,size,type,done) VALUES (?,?,?,?,?,0)`).bind(fid, tid, name, size, type));
    out.push({ id: fid, name, size, done: false });
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { id: tid, files: out };
}
function httpError(msg, status) { const e = new Error(msg); e.status = status; return e; }
async function canUpload(request, env, tid) {
  if (await isAdmin(request, env)) return true;
  const tok = request.headers.get('x-up');
  return !!tok && safeEq(tok, await hmac(secretOf(env), 'up.' + tid));
}

// ---------- notifications to you ----------
function simpleEmail(heading, lines, button, link) {
  return `<!doctype html><html><body style="margin:0;background:#f3f5fb;font-family:Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#3b5bfd;padding:18px 24px;color:#fff;font-size:18px;font-weight:700">DropLink</td></tr>
<tr><td style="padding:24px"><h2 style="margin:0 0 12px;font-size:20px;color:#111827">${heading}</h2>
${lines.filter(Boolean).map(l => `<p style="margin:0 0 8px;font-size:14px;color:#374151">${l}</p>`).join('')}
${link ? `<a href="${link}" style="display:inline-block;margin-top:12px;background:#3b5bfd;color:#fff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:9px">${button}</a>` : ''}
</td></tr></table><p style="font-size:11px;color:#9ca3af">DropLink · Developed by Musfikur Rahman</p></td></tr></table></body></html>`;
}
async function notifyAdmin(env, subject, html) {
  if (!env.NOTIFY_EMAIL || !env.SCRIPT_URL) return;
  try { await callScript(env, { action: 'mail', to: env.NOTIFY_EMAIL, subject, html, name: 'DropLink' }); } catch (e) {}
}
async function notifyFirstDownload(env, origin, tid, fileName, request) {
  const r = await env.DB.prepare(`UPDATE transfers SET notified=1 WHERE id=? AND notify=1 AND notified=0`).bind(tid).run();
  if (!r.meta || !r.meta.changes) return;
  const t = await env.DB.prepare(`SELECT title, file_count FROM transfers WHERE id=?`).bind(tid).first();
  const cf = request.cf || {};
  const where = [cf.city, cf.country].filter(Boolean).join(', ');
  const when = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  await notifyAdmin(env, `⬇ Downloaded: ${t.title}`, simpleEmail('Your files were downloaded',
    [`<b>${esc(t.title)}</b>`, fileName ? `First file: ${esc(fileName)}` : `Downloaded as ZIP (${t.file_count} files)`, `Time: ${when} (Dhaka)`, where ? `Location: ${esc(where)}` : ''],
    'Open DropLink', `${origin}/#list`));
}
async function emailRequest(env, origin, id, recipients) {
  const q = await env.DB.prepare(`SELECT * FROM requests WHERE id=?`).bind(id).first();
  const sender = env.SENDER_NAME || 'DropLink';
  const html = simpleEmail(`${esc(sender)} is requesting files from you`,
    [`<b>${esc(q.title)}</b>`, q.message ? `<span style="white-space:pre-wrap">${esc(q.message)}</span>` : '',
     `Please upload by <b>${fmtDate(q.expires_at)}</b>. No account needed.`, q.pass_hash ? 'The upload page is password protected — the password will be shared separately.' : ''],
    'Upload files', `${origin}/r/${id}`);
  const results = [];
  for (const to of recipients) {
    try { await callScript(env, { action: 'mail', to, subject: `${sender} requests files: ${q.title}`, html, name: sender }); results.push({ to, ok: true }); }
    catch (e) { results.push({ to, ok: false, error: e.message }); }
  }
  const all = [...new Set([...JSON.parse(q.recipients || '[]'), ...results.filter(r => r.ok).map(r => r.to)])];
  await env.DB.prepare(`UPDATE requests SET recipients=? WHERE id=?`).bind(JSON.stringify(all), id).run();
  return results;
}

// ---------- email ----------
function emailHtml({ sender, title, message, link, files, total, expires, hasPassword }) {
  const list = files.slice(0, 12).map(f =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #eef0f4;font-size:14px;color:#1f2937">${esc(f.name)}</td><td style="padding:6px 0;border-bottom:1px solid #eef0f4;font-size:13px;color:#6b7280;text-align:right;white-space:nowrap">${fmtSize(f.size)}</td></tr>`).join('');
  const more = files.length > 12 ? `<tr><td colspan="2" style="padding:6px 0;font-size:13px;color:#6b7280">+ ${files.length - 12} more file(s)</td></tr>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f3f5fb;font-family:Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5fb;padding:28px 12px"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
<tr><td style="background:#3b5bfd;padding:22px 28px;color:#fff;font-size:20px;font-weight:700">DropLink</td></tr>
<tr><td style="padding:28px">
<p style="margin:0 0 6px;font-size:15px;color:#374151"><b>${esc(sender)}</b> sent you ${files.length} file${files.length > 1 ? 's' : ''} (${fmtSize(total)})</p>
<h2 style="margin:0 0 14px;font-size:22px;color:#111827">${esc(title)}</h2>
${message ? `<div style="margin:0 0 18px;padding:14px 16px;background:#f6f7fb;border-radius:10px;font-size:14px;color:#374151;white-space:pre-wrap">${esc(message)}</div>` : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:22px">${list}${more}</table>
<a href="${link}" style="display:inline-block;background:#3b5bfd;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:13px 28px;border-radius:10px">Download files</a>
<p style="margin:18px 0 0;font-size:13px;color:#6b7280">Available until <b>${fmtDate(expires)}</b>.${hasPassword ? ' This transfer is password protected — the sender will share the password with you separately.' : ''}</p>
<p style="margin:10px 0 0;font-size:12px;color:#9ca3af;word-break:break-all">Link: ${link}</p>
</td></tr></table>
<p style="font-size:11px;color:#9ca3af;margin-top:14px">Sent with DropLink · Developed by Musfikur Rahman</p>
</td></tr></table></body></html>`;
}
async function emailTransfer(env, origin, tid, recipients, note) {
  const t = await env.DB.prepare(`SELECT * FROM transfers WHERE id=?`).bind(tid).first();
  const { results: files } = await env.DB.prepare(`SELECT name, size FROM files WHERE transfer_id=? ORDER BY name`).bind(tid).all();
  const html = emailHtml({
    sender: env.SENDER_NAME || 'DropLink', title: t.title, message: note ?? t.message,
    link: `${origin}/d/${tid}`, files, total: t.total_size, expires: t.expires_at, hasPassword: !!t.pass_hash,
  });
  const subject = `${env.SENDER_NAME || 'DropLink'} sent you files: ${t.title}`;
  const results = [];
  for (const to of recipients) {
    try { await callScript(env, { action: 'mail', to, subject, html, name: env.SENDER_NAME || 'DropLink' }); results.push({ to, ok: true }); }
    catch (e) { results.push({ to, ok: false, error: e.message }); }
  }
  const prev = JSON.parse(t.recipients || '[]');
  const all = [...new Set([...prev, ...results.filter(r => r.ok).map(r => r.to)])];
  await env.DB.prepare(`UPDATE transfers SET recipients=? WHERE id=?`).bind(JSON.stringify(all), tid).run();
  return results;
}
const cleanEmails = (list) => [...new Set((Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
  .map(e => String(e).trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))].slice(0, 40);

// parse "bytes=0-12345" from a Drive 308 reply → next offset
const committed = (r) => { const m = /bytes=0-(\d+)/.exec(r.headers.get('range') || ''); return m ? Number(m[1]) + 1 : 0; };

// ---------- router ----------
export async function onRequest(context) {
  const { env, params } = context;
  try {
    if (!env.DB) return fail('Server not configured: add the DB (D1) binding in Cloudflare Pages settings.', 500);
    await ensureSchema(env);
    return await route(context, (params.path || []), context.request.method);
  } catch (e) {
    return fail(e.message || String(e), e.status || 500);
  }
}

async function route(context, p, method) {
  const { request, env } = context;
  const url = new URL(request.url);
  const origin = url.origin;
  const now = Date.now();
  const [a, b, c] = p;

  if (a === 'ping') return json({ ok: true, time: now });

  // ----- auth -----
  if (a === 'login' && method === 'POST') {
    const { password } = await request.json().catch(() => ({}));
    if (!env.ADMIN_PASSWORD) return fail('ADMIN_PASSWORD is not set in Cloudflare settings', 500);
    if (!safeEq(password, env.ADMIN_PASSWORD)) { await new Promise(r => setTimeout(r, 800)); return fail('Wrong password', 401); }
    const exp = now + 30 * DAY;
    const v = exp + '.' + (await hmac(secretOf(env), 'admin.' + exp));
    return json({ ok: true }, 200, { 'set-cookie': `dl_s=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}` });
  }
  if (a === 'logout') return json({ ok: true }, 200, { 'set-cookie': `dl_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  if (a === 'me') return json({ admin: await isAdmin(request, env), sender: env.SENDER_NAME || '', mail: !!env.SCRIPT_URL, storage: !!env.SCRIPT_URL, notify: !!env.NOTIFY_EMAIL });

  // ----- cron cleanup -----
  if (a === 'cleanup') {
    if (!(await isAdmin(request, env)) && !(env.CLEANUP_KEY && safeEq(url.searchParams.get('key'), env.CLEANUP_KEY))) return fail('Forbidden', 403);
    let total = 0, n;
    do { n = await cleanup(env, 10); total += n; } while (n === 10 && total < 30);
    return json({ ok: true, cleaned: total });
  }

  // ----- public download page data -----
  if (a === 'public' && b && !c && method === 'GET') {
    const t = await env.DB.prepare(`SELECT * FROM transfers WHERE id=?`).bind(b).first();
    if (!t || t.status === 'deleted' || t.status === 'uploading') return fail('This transfer does not exist or was deleted.', 404);
    if (t.status === 'expired' || t.expires_at < now) return json({ expired: true, title: t.title, expires_at: t.expires_at }, 410);
    const out = { id: t.id, title: t.title, message: t.message, created_at: t.created_at, expires_at: t.expires_at,
      total_size: t.total_size, file_count: t.file_count, sender: env.SENDER_NAME || '', locked: !!t.pass_hash };
    if (!t.pass_hash || (await validUnlock(env, t.id, url.searchParams.get('k')))) {
      out.locked = false;
      out.files = (await env.DB.prepare(`SELECT id, name, size, type FROM files WHERE transfer_id=? ORDER BY name`).bind(t.id).all()).results;
    }
    return json(out);
  }
  if (a === 'public' && b && c === 'unlock' && method === 'POST') {
    const t = await env.DB.prepare(`SELECT id, pass_hash, pass_salt FROM transfers WHERE id=? AND status='ready'`).bind(b).first();
    if (!t) return fail('Not found', 404);
    const { password } = await request.json().catch(() => ({}));
    if (!t.pass_hash || safeEq(await sha256(t.pass_salt + '|' + password), t.pass_hash)) {
      return json({ token: await unlockToken(env, t.id, now + DAY) });
    }
    await new Promise(r => setTimeout(r, 700));
    return fail('Wrong password', 401);
  }
  if (a === 'public' && b && c === 'zipped' && method === 'POST') {
    const t = await env.DB.prepare(`SELECT id FROM transfers WHERE id=? AND status='ready'`).bind(b).first();
    if (t && !(await isAdmin(request, env))) {
      await env.DB.prepare(`UPDATE transfers SET downloads=downloads+1, last_download_at=? WHERE id=?`).bind(now, b).run();
      context.waitUntil(notifyFirstDownload(env, origin, b, null, request));
    }
    return json({ ok: true });
  }

  // ----- file download (streams from Google Drive, supports Range / resume) -----
  if (a === 'dl' && b && c && (method === 'GET' || method === 'HEAD')) {
    const row = await env.DB.prepare(
      `SELECT f.*, t.status, t.expires_at, t.pass_hash FROM files f JOIN transfers t ON t.id=f.transfer_id WHERE f.id=? AND f.transfer_id=?`
    ).bind(c, b).first();
    const admin = await isAdmin(request, env);
    if (!row || row.status !== 'ready' || !row.done || !row.drive_id) return new Response('File not found', { status: 404 });
    if (row.expires_at < now && !admin) return new Response('This transfer has expired', { status: 410 });
    if (row.pass_hash && !admin && !(await validUnlock(env, b, url.searchParams.get('k')))) return new Response('Password required', { status: 401 });

    const inline = url.searchParams.get('inline') === '1';
    const h = new Headers();
    h.set('content-type', row.type || 'application/octet-stream');
    h.set('content-disposition', disposition(inline ? 'inline' : 'attachment', row.name));
    h.set('accept-ranges', 'bytes');
    h.set('cache-control', 'private, no-store');
    if (method === 'HEAD') { h.set('content-length', String(row.size)); return new Response(null, { status: 200, headers: h }); }
    if (row.size === 0) { h.set('content-length', '0'); return new Response('', { status: 200, headers: h }); }

    const range = request.headers.get('range');
    const g = await gfetch(env, `/drive/v3/files/${encodeURIComponent(row.drive_id)}?alt=media&acknowledgeAbuse=true`, { headers: range ? { range } : {} });
    if (g.status === 404) return new Response('File missing from Google Drive (it may have been deleted there).', { status: 404 });
    if (!g.ok) return new Response('Google Drive error ' + g.status + ': ' + (await g.text()).slice(0, 200), { status: 502 });
    for (const k of ['content-length', 'content-range']) { const v = g.headers.get(k); if (v) h.set(k, v); }

    const firstChunk = !range || /^bytes=0-/.test(range);
    if (!inline && !admin && firstChunk && url.searchParams.get('nc') !== '1') {
      context.waitUntil(env.DB.batch([
        env.DB.prepare(`UPDATE files SET downloads=downloads+1 WHERE id=?`).bind(c),
        env.DB.prepare(`UPDATE transfers SET downloads=downloads+1, last_download_at=? WHERE id=?`).bind(now, b),
      ]).then(() => notifyFirstDownload(env, origin, b, row.name, request)));
    }
    return new Response(g.body, { status: g.status, headers: h });
  }

  // ===== uploads (you, or a factory using your "Request files" link) =====
  if (a === 'upload' && b === 'start' && method === 'POST') {
    const fid = url.searchParams.get('f');
    const f = await env.DB.prepare(`SELECT f.*, t.status, t.folder_id, t.title FROM files f JOIN transfers t ON t.id=f.transfer_id WHERE f.id=?`).bind(fid).first();
    if (!f || f.status !== 'uploading') return fail('Upload not found', 404);
    if (!(await canUpload(request, env, f.transfer_id))) return fail('Not allowed', 403);
    if (f.done) return json({ done: true, next: f.size });
    if (f.session_url) return json({ done: false, next: 0, resumed: true });
    const meta = { name: f.name.split('/').pop(), parents: [f.folder_id], description: `DropLink ${f.transfer_id} · ${f.title}` };
    if (f.size === 0) {
      const r = await gfetch(env, '/drive/v3/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...meta, mimeType: f.type }) });
      if (!r.ok) return fail('Google Drive error: ' + (await r.text()).slice(0, 200), 502);
      await env.DB.prepare(`UPDATE files SET done=1, drive_id=? WHERE id=?`).bind((await r.json()).id, fid).run();
      return json({ done: true, next: 0 });
    }
    const r = await gfetch(env, '/upload/drive/v3/files?uploadType=resumable&fields=id', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': f.type, 'x-upload-content-length': String(f.size) },
      body: JSON.stringify(meta),
    });
    if (!r.ok) return fail('Google Drive refused the upload: ' + (await r.text()).slice(0, 200), 502);
    const sessionUrl = r.headers.get('location');
    if (!sessionUrl) return fail('Google Drive did not return an upload session', 502);
    await env.DB.prepare(`UPDATE files SET session_url=? WHERE id=?`).bind(sessionUrl, fid).run();
    return json({ done: false, next: 0 });
  }
  if (a === 'upload' && b === 'chunk' && method === 'PUT') {
    const fid = url.searchParams.get('f'), off = Number(url.searchParams.get('o'));
    const f = await env.DB.prepare(`SELECT f.transfer_id, f.size, f.session_url, f.done, t.status FROM files f JOIN transfers t ON t.id=f.transfer_id WHERE f.id=?`).bind(fid).first();
    if (!f || f.status !== 'uploading' || !f.session_url) return fail('Upload not found', 404);
    if (!(await canUpload(request, env, f.transfer_id))) return fail('Not allowed', 403);
    if (f.done) return json({ done: true, next: f.size });
    const buf = await request.arrayBuffer();
    if (!(off >= 0) || off + buf.byteLength > f.size || !buf.byteLength) return fail('Bad chunk range');
    const end = off + buf.byteLength - 1;
    const r = await fetch(f.session_url, { method: 'PUT', redirect: 'manual', body: buf, headers: { 'content-range': `bytes ${off}-${end}/${f.size}` } });
    if (r.status === 308) return json({ done: false, next: committed(r) });
    if (r.status === 200 || r.status === 201) {
      const meta = await r.json().catch(() => ({}));
      await env.DB.prepare(`UPDATE files SET done=1, drive_id=?, session_url=NULL WHERE id=?`).bind(meta.id || null, fid).run();
      return json({ done: true, next: f.size });
    }
    if (r.status === 404 || r.status === 410) return fail('Upload session expired — please start again', 410);
    return fail('Google Drive error ' + r.status + ': ' + (await r.text()).slice(0, 200), 502);
  }
  if (a === 'upload' && b === 'status' && method === 'GET') {
    const fid = url.searchParams.get('f');
    const f = await env.DB.prepare(`SELECT transfer_id, size, session_url, done FROM files WHERE id=?`).bind(fid).first();
    if (!f) return fail('Upload not found', 404);
    if (!(await canUpload(request, env, f.transfer_id))) return fail('Not allowed', 403);
    if (f.done) return json({ done: true, next: f.size });
    if (!f.session_url) return json({ done: false, next: 0 });
    const r = await fetch(f.session_url, { method: 'PUT', redirect: 'manual', headers: { 'content-range': `bytes */${f.size}` } });
    if (r.status === 308) return json({ done: false, next: committed(r) });
    if (r.status === 200 || r.status === 201) {
      const meta = await r.json().catch(() => ({}));
      await env.DB.prepare(`UPDATE files SET done=1, drive_id=?, session_url=NULL WHERE id=?`).bind(meta.id || null, fid).run();
      return json({ done: true, next: f.size });
    }
    return fail('Upload session expired — please start again', 410);
  }

  // ===== public "Request files" page =====
  if (a === 'rq' && b && !c && method === 'GET') {
    const q = await env.DB.prepare(`SELECT * FROM requests WHERE id=?`).bind(b).first();
    if (!q || q.status === 'deleted') return fail('This upload link does not exist.', 404);
    if (q.status === 'closed' || q.expires_at < now) return json({ closed: true, title: q.title, sender: env.SENDER_NAME || '' }, 410);
    return json({ id: q.id, title: q.title, message: q.message, expires_at: q.expires_at, max_bytes: q.max_bytes,
      sender: env.SENDER_NAME || '', locked: !!q.pass_hash });
  }
  if (a === 'rq' && b && c === 'unlock' && method === 'POST') {
    const q = await env.DB.prepare(`SELECT id, pass_hash, pass_salt FROM requests WHERE id=? AND status='open'`).bind(b).first();
    if (!q) return fail('Not found', 404);
    const { password } = await request.json().catch(() => ({}));
    if (!q.pass_hash || safeEq(await sha256(q.pass_salt + '|' + password), q.pass_hash)) return json({ token: await unlockToken(env, 'rq.' + q.id, now + DAY) });
    await new Promise(r => setTimeout(r, 700));
    return fail('Wrong password', 401);
  }
  if (a === 'rq' && b && c === 'transfers' && method === 'POST') {
    const q = await env.DB.prepare(`SELECT * FROM requests WHERE id=?`).bind(b).first();
    if (!q || q.status !== 'open' || q.expires_at < now) return fail('This upload link is closed.', 410);
    const body = await request.json();
    if (q.pass_hash && !(await validUnlock(env, 'rq.' + q.id, body.k))) return fail('Password required', 401);
    const name = String(body.name || '').trim().slice(0, 80);
    if (!name) return fail('Please enter your name');
    const files = Array.isArray(body.files) ? body.files : [];
    const total = files.reduce((s, f) => s + Math.max(0, Number(f.size) || 0), 0);
    if (total > q.max_bytes) return fail(`Too large: maximum ${fmtSize(q.max_bytes)} per upload on this link.`, 413);
    const fromEmail = cleanEmails([body.email])[0] || null;
    const t = await createTransfer(env, {
      title: `${q.title} — from ${name}`, message: String(body.note || ''), files,
      expires: now + (q.keep_days || 30) * DAY, notify: 0,
      extra: { request_id: q.id, from_name: name, from_email: fromEmail, from_note: String(body.note || '').slice(0, 2000) },
    });
    return json({ id: t.id, files: t.files, up: await hmac(secretOf(env), 'up.' + t.id) });
  }
  if (a === 'rq' && b && c === 'finalize' && method === 'POST') {
    const { tid } = await request.json().catch(() => ({}));
    const t = await env.DB.prepare(`SELECT * FROM transfers WHERE id=? AND request_id=?`).bind(tid, b).first();
    if (!t || !(await canUpload(request, env, tid))) return fail('Not allowed', 403);
    const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM files WHERE transfer_id=? AND (done=0 OR drive_id IS NULL)`).bind(tid).first();
    if (pending.n > 0) return fail(`${pending.n} file(s) did not finish uploading`);
    await env.DB.batch([
      env.DB.prepare(`UPDATE transfers SET status='ready' WHERE id=? AND status='uploading'`).bind(tid),
      env.DB.prepare(`UPDATE requests SET uploads=uploads+1 WHERE id=?`).bind(b),
    ]);
    context.waitUntil(notifyAdmin(env, `📥 ${t.from_name} uploaded ${t.file_count} file${t.file_count > 1 ? 's' : ''}: ${t.title}`, simpleEmail(
      `${t.from_name} sent you files`,
      [`<b>${esc(t.title)}</b>`, `${t.file_count} file(s) · ${fmtSize(t.total_size)}`, t.from_email ? `Email: ${esc(t.from_email)}` : '', t.from_note ? `Note: ${esc(t.from_note)}` : ''],
      'Open files', `${origin}/d/${tid}`)));
    return json({ ok: true });
  }

  // ===== everything below needs admin =====
  if (!(await isAdmin(request, env))) return fail('Please log in', 401);

  // create transfer: one Drive sub-folder; upload sessions are opened later, one per file (/api/upload/start)
  if (a === 'transfers' && !b && method === 'POST') {
    const body = await request.json();
    let expires = Number(body.expiresAt) || now + (Number(body.days) || 7) * DAY;
    expires = Math.min(Math.max(expires, now + 3600000), now + 365 * DAY);
    const t = await createTransfer(env, { title: body.title, message: body.message, files: body.files, expires, password: body.password,
      notify: body.notify && env.NOTIFY_EMAIL ? 1 : 0 });
    return json({ id: t.id, files: t.files, link: `${origin}/d/${t.id}` });
  }

  // finalize + optional email
  if (a === 'transfers' && b && c === 'finalize' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const pending = await env.DB.prepare(`SELECT COUNT(*) AS n FROM files WHERE transfer_id=? AND (done=0 OR drive_id IS NULL)`).bind(b).first();
    if (pending.n > 0) return fail(`${pending.n} file(s) did not finish uploading`);
    await env.DB.prepare(`UPDATE transfers SET status='ready' WHERE id=? AND status='uploading'`).bind(b).run();
    const recipients = cleanEmails(body.recipients);
    const emailed = recipients.length ? await emailTransfer(env, origin, b, recipients) : [];
    return json({ ok: true, link: `${origin}/d/${b}`, emailed });
  }

  // list (dashboard)
  if (a === 'transfers' && !b && method === 'GET') {
    try { await cleanup(env, 5); } catch (e) {}
    const { results: transfers } = await env.DB.prepare(
      `SELECT id,title,message,created_at,expires_at,status,total_size,file_count,downloads,last_download_at,recipients,
              (pass_hash IS NOT NULL) AS locked, notify, request_id, from_name, from_email, from_note
       FROM transfers WHERE status IN ('ready','expired') AND created_at > ? ORDER BY created_at DESC LIMIT 300`
    ).bind(now - 120 * DAY).all();
    const { results: files } = await env.DB.prepare(
      `SELECT f.id,f.transfer_id,f.name,f.size,f.type,f.downloads FROM files f JOIN transfers t ON t.id=f.transfer_id
       WHERE t.status='ready' ORDER BY f.name`
    ).all();
    const byT = {};
    for (const f of files) (byT[f.transfer_id] ||= []).push(f);
    for (const t of transfers) { t.files = byT[t.id] || []; t.recipients = JSON.parse(t.recipients || '[]'); t.link = `${origin}/d/${t.id}`; }
    return json({ transfers, usage: await usage(env), now });
  }

  if (a === 'transfers' && b && c === 'extend' && method === 'POST') {
    const { days } = await request.json().catch(() => ({}));
    const d = Math.min(Math.max(Number(days) || 7, 1), 90);
    const t = await env.DB.prepare(`SELECT expires_at FROM transfers WHERE id=? AND status='ready'`).bind(b).first();
    if (!t) return fail('Transfer not found or already expired', 404);
    const exp = Math.max(t.expires_at, now) + d * DAY;
    await env.DB.prepare(`UPDATE transfers SET expires_at=? WHERE id=?`).bind(exp, b).run();
    return json({ ok: true, expires_at: exp });
  }
  if (a === 'transfers' && b && c === 'email' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const recipients = cleanEmails(body.recipients);
    if (!recipients.length) return fail('Enter at least one valid email');
    return json({ ok: true, emailed: await emailTransfer(env, origin, b, recipients, body.message) });
  }
  if (a === 'transfers' && b && c === 'notify' && method === 'POST') {
    const { on } = await request.json().catch(() => ({}));
    await env.DB.prepare(`UPDATE transfers SET notify=?, notified=0 WHERE id=?`).bind(on ? 1 : 0, b).run();
    return json({ ok: true });
  }
  if (a === 'transfers' && b && !c && method === 'DELETE') {
    await purge(env, b, 'deleted');
    return json({ ok: true });
  }

  // ----- contact groups -----
  if (a === 'groups' && !b && method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT id, name, emails FROM groups ORDER BY name COLLATE NOCASE`).all();
    return json({ groups: results.map(g => ({ ...g, emails: JSON.parse(g.emails || '[]') })) });
  }
  if (a === 'groups' && !b && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 60);
    const emails = cleanEmails(body.emails);
    if (!name) return fail('Enter a group name');
    if (!emails.length) return fail('Add at least one valid email');
    const id = body.id || rid(8);
    await env.DB.prepare(`INSERT OR REPLACE INTO groups (id, name, emails, created_at) VALUES (?,?,?,?)`).bind(id, name, JSON.stringify(emails), now).run();
    return json({ ok: true, id });
  }
  if (a === 'groups' && b && method === 'DELETE') {
    await env.DB.prepare(`DELETE FROM groups WHERE id=?`).bind(b).run();
    return json({ ok: true });
  }

  // ----- file requests (factories upload to you) -----
  if (a === 'requests' && !b && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || '').trim().slice(0, 140);
    if (!title) return fail('Enter a title, e.g. "Lab test reports for PO 30727"');
    const id = rid(9);
    let passHash = null, passSalt = null;
    if (body.password) { passSalt = rid(12); passHash = await sha256(passSalt + '|' + body.password); }
    const days = Math.min(Math.max(Number(body.days) || 14, 1), 365);
    const keep = Math.min(Math.max(Number(body.keepDays) || 30, 1), 365);
    const maxB = Math.min(Math.max(Number(body.maxGb) || 2, 0.1), 10) * 1024 ** 3;
    await env.DB.prepare(`INSERT INTO requests (id,title,message,created_at,expires_at,keep_days,max_bytes,status,pass_hash,pass_salt) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, title, String(body.message || '').slice(0, 3000), now, now + days * DAY, keep, Math.round(maxB), 'open', passHash, passSalt).run();
    const recipients = cleanEmails(body.recipients);
    const emailed = recipients.length ? await emailRequest(env, origin, id, recipients) : [];
    return json({ ok: true, id, link: `${origin}/r/${id}`, emailed });
  }
  if (a === 'requests' && !b && method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT r.id,r.title,r.message,r.created_at,r.expires_at,r.keep_days,r.max_bytes,r.status,r.uploads,r.recipients,(r.pass_hash IS NOT NULL) AS locked,
         (SELECT COUNT(*) FROM transfers t WHERE t.request_id=r.id AND t.status='ready') AS received
       FROM requests r WHERE r.status IN ('open','closed') ORDER BY r.created_at DESC LIMIT 200`).all();
    for (const r of results) { r.link = `${origin}/r/${r.id}`; r.recipients = JSON.parse(r.recipients || '[]'); }
    return json({ requests: results });
  }
  if (a === 'requests' && b && c === 'close' && method === 'POST') {
    const { open } = await request.json().catch(() => ({}));
    if (open) await env.DB.prepare(`UPDATE requests SET status='open', expires_at=MAX(expires_at, ?) WHERE id=?`).bind(now + 7 * DAY, b).run();
    else await env.DB.prepare(`UPDATE requests SET status='closed' WHERE id=?`).bind(b).run();
    return json({ ok: true });
  }
  if (a === 'requests' && b && c === 'email' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const recipients = cleanEmails(body.recipients);
    if (!recipients.length) return fail('Enter at least one valid email');
    return json({ ok: true, emailed: await emailRequest(env, origin, b, recipients) });
  }
  if (a === 'requests' && b && !c && method === 'DELETE') {
    await env.DB.prepare(`UPDATE requests SET status='deleted' WHERE id=?`).bind(b).run();
    return json({ ok: true });
  }

  if (a === 'usage') return json(await usage(env));

  return fail('Not found', 404);
}
