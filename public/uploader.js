// Shared upload engine for DropLink (used by the Send page and the Request-files page)
// Each file is sent in 16 MB pieces, in order (Google Drive needs that); several files go at once.
const PART = 16 * 1024 * 1024;
const PARALLEL = 4;
async function runUpload(items, state, H = {}) {
  $('#pFiles').innerHTML = items.map((f, i) => `<li>${fileIcon(f.name)}<div class="fname"><b>${esc(f.name)}</b>
     <div class="bar ${f.done ? 'ok' : ''}" style="margin-top:6px"><i id="fb${i}" style="width:${f.done ? 100 : 0}%"></i></div></div>
     <span class="small muted" id="fs${i}" style="min-width:70px;text-align:right">${f.done ? 'Done' : fmtSize(f.size)}</span></li>`).join('');

  // engine: each file goes up in order (Google Drive needs that), several files at once
  const total = items.reduce((s, f) => s + f.size, 0) || 1;
  const inflight = new Map();   // fileIndex -> bytes sent in current chunk
  const t0 = Date.now(); let lastB = 0, lastT = t0, speed = 0;
  const sentNow = () => items.reduce((s, f) => s + f.loaded, 0) + [...inflight.values()].reduce((s, v) => s + v, 0);
  lastB = sentNow();
  const tick = setInterval(() => {
    const now = Date.now(), cur = sentNow();
    const inst = (cur - lastB) / ((now - lastT) / 1000 || 1);
    speed = speed ? speed * 0.7 + inst * 0.3 : inst; lastB = cur; lastT = now;
    const pct = Math.min(100, (cur / total) * 100);
    $('#pPct').textContent = Math.floor(pct) + '%'; $('#pBar').style.width = pct + '%';
    const eta = speed > 0 ? (total - cur) / speed : 0;
    const nDone = items.filter(x => x.done).length;
    if (!state.retrying) $('#pInfo').textContent = `${nDone} of ${items.length} files done · ${fmtSize(cur)} of ${fmtSize(total)} · ${fmtSize(Math.max(0, speed))}/s` + (eta > 1 ? ` · ${eta > 90 ? Math.ceil(eta / 60) + ' min' : Math.ceil(eta) + ' sec'} left` : '');
    items.forEach((f, i) => {
      if (f.done) return;
      const el = $('#fb' + i); if (el) el.style.width = ((f.loaded + (inflight.get(i) || 0)) / f.size * 100) + '%';
    });
  }, 500);

  function putChunk(i, off, blob) {
    return new Promise((resolve, reject) => {
      const f = items[i];
      const xhr = new XMLHttpRequest(); state.xhrs.add(xhr);
      xhr.open('PUT', `/api/upload/chunk?f=${f.id}&o=${off}`);
      for (const k in H) xhr.setRequestHeader(k, H[k]);
      xhr.upload.onprogress = (e) => inflight.set(i, e.loaded);
      const end = () => { state.xhrs.delete(xhr); inflight.delete(i); };
      xhr.onload = () => {
        end();
        let d = {}; try { d = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status === 200) resolve(d);
        else { const err = new Error(d.error || 'HTTP ' + xhr.status); err.fatal = xhr.status === 410 || xhr.status === 404 || xhr.status === 400; reject(err); }
      };
      xhr.onerror = () => { end(); reject(new Error('Network error')); };
      xhr.onabort = () => { end(); const e = new Error('cancelled'); e.fatal = true; reject(e); };
      xhr.send(blob);
    });
  }
  async function uploadFile(i) {
    const f = items[i];
    $('#fs' + i).textContent = 'Starting…';
    let off = 0, tries = 0, resumed = false;
    for (;;) {   // open the Google Drive upload for this file
      try { const st = await api('upload/start?f=' + f.id, { method: 'POST', body: {}, headers: H }); if (st.done) { finishFile(i); return; } resumed = !!st.resumed; break; }
      catch (err) {
        if (state.cancelled || err.status === 404 || ++tries > 5) throw err;
        await new Promise(r => setTimeout(r, 1500 * tries));
      }
    }
    tries = 0;
    if (resumed) { try { const s0 = await api('upload/status?f=' + f.id, { headers: H }); off = s0.next || 0; if (s0.done) { finishFile(i); return; } } catch (e) {} }
    $('#fs' + i).textContent = fmtSize(f.size);
    while (!state.cancelled) {
      try {
        const r = await putChunk(i, off, f.file.slice(off, Math.min(f.size, off + PART)));
        tries = 0; state.retrying = false;
        off = r.next; f.loaded = Math.min(off, f.size);
        if (r.done) break;
      } catch (err) {
        if (err.fatal || state.cancelled || ++tries > 6) throw err;
        state.retrying = true;
        $('#pInfo').textContent = `Connection issue — retrying (${tries}/6)…`;
        await new Promise(r => setTimeout(r, 1500 * tries * tries));
        try { const s = await api('upload/status?f=' + f.id, { headers: H }); off = s.next; f.loaded = off; if (s.done) break; } catch (e) {}
      }
    }
    if (state.cancelled) return;
    finishFile(i);
  }
  function finishFile(i) {
    const f = items[i]; f.done = true; f.loaded = f.size;
    const el = $('#fb' + i); el.style.width = '100%'; el.parentNode.classList.add('ok'); $('#fs' + i).textContent = 'Done';
  }

  const queue = items.map((f, i) => i).filter(i => !items[i].done).sort((x, y) => items[y].size - items[x].size);
  let failed = null;
  async function worker() {
    while (queue.length && !failed && !state.cancelled) {
      const i = queue.shift();
      try { await uploadFile(i); } catch (e) { failed = failed || e; }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  clearInterval(tick);
  return { failed, total };
}
