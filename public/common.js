// Shared helpers for DropLink pages
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize(b) {
  b = Number(b) || 0;
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtDate(ms, time) {
  const o = { day: '2-digit', month: 'short', year: 'numeric' };
  if (time) Object.assign(o, { hour: '2-digit', minute: '2-digit' });
  return new Date(ms).toLocaleString('en-GB', o);
}
function timeLeft(ms) {
  const d = ms - Date.now();
  if (d <= 0) return 'Expired';
  const days = Math.floor(d / 864e5), hrs = Math.floor(d / 36e5) % 24;
  if (days >= 3) { const r = Math.round(d / 864e5); return `${r} days left`; }
  if (days >= 1) return `${days} day${days > 1 ? 's' : ''}${days < 3 && hrs ? ' ' + hrs + 'h' : ''} left`;
  const h = Math.floor(d / 36e5), m = Math.floor(d / 6e4) % 60;
  return h ? `${h}h ${m}m left` : `${m} min left`;
}
function ago(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
const ICONS = {
  pdf: ['#fdecec', '#d93a3a'], xls: ['#e7f7ee', '#12a150'], xlsx: ['#e7f7ee', '#12a150'], csv: ['#e7f7ee', '#12a150'],
  doc: ['#e8f0ff', '#2f6fe0'], docx: ['#e8f0ff', '#2f6fe0'], ppt: ['#fff1e6', '#d9620f'], pptx: ['#fff1e6', '#d9620f'],
  jpg: ['#f3ecff', '#7c4ddb'], jpeg: ['#f3ecff', '#7c4ddb'], png: ['#f3ecff', '#7c4ddb'], gif: ['#f3ecff', '#7c4ddb'], webp: ['#f3ecff', '#7c4ddb'],
  ai: ['#fff4e0', '#c77700'], psd: ['#e6f4ff', '#1b74c5'], zip: ['#f1f2f6', '#4b5563'], rar: ['#f1f2f6', '#4b5563'], '7z': ['#f1f2f6', '#4b5563'],
  mp4: ['#ffe9f2', '#d12b6f'], mov: ['#ffe9f2', '#d12b6f'], dwg: ['#e9f7f7', '#0f8a8a'],
};
function fileIcon(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase().slice(0, 4);
  const [bg, fg] = ICONS[ext] || ['#eef1ff', '#3b5bfd'];
  return `<div class="ficon" style="background:${bg};color:${fg}">${esc(ext && ext !== String(name).toLowerCase() ? ext.toUpperCase() : 'FILE')}</div>`;
}
const canPreview = (name) => /\.(pdf|png|jpe?g|gif|webp|svg|txt|mp4)$/i.test(name);
let _tt;
function toast(msg, ms = 2600) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(_tt); _tt = setTimeout(() => t.classList.remove('show'), ms);
}
async function copyText(s) {
  try { await navigator.clipboard.writeText(s); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = s; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast('Link copied');
}
async function api(path, opts = {}) {
  const o = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
  const r = await fetch('/api/' + path, o);
  let data; try { data = await r.json(); } catch (e) { data = {}; }
  if (!r.ok) { const e = new Error(data.error || ('Error ' + r.status)); e.status = r.status; e.data = data; throw e; }
  return data;
}
const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
document.addEventListener('DOMContentLoaded', () => {
  $$('.logo').forEach(l => l.innerHTML = LOGO);
  $$('.yr').forEach(y => y.textContent = new Date().getFullYear());
});
