/* ---------------------------------------------------------------- the corner popup
 * A download manager for the page, in the spirit of Max Video Downloader: every video / audio the page
 * offers with thumbnail, duration, format, size and quality; rename before saving; live progress in the
 * row; cancel; "show in folder"; download all. Lives in the top frame only.
 */
const popup = {
  host: null, wrap: null, ui: {}, open: false, items: [], group: 'video', sel: null, filter: '',
  bitmaps: new Map(), notice: '', noticeT: 0, dl: new Map(), quality: new Map(), names: new Map(),
  editing: null, pendingRender: false, pendingSelect: null, rows: new Map(),
};
const GROUPS = [
  ['video', 'Video'],
  ['audio', 'Audio'],
  ['other', 'Other'],
];

const POPUP_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
button{font-family:inherit}
.w{position:fixed;pointer-events:none;z-index:1;display:flex;flex-direction:column;gap:8px;max-width:calc(100vw - 24px)}
.w.br{right:14px;bottom:14px;align-items:flex-end}.w.bl{left:14px;bottom:14px;align-items:flex-start}
.w.tr{right:14px;top:14px;align-items:flex-end;flex-direction:column-reverse}.w.tl{left:14px;top:14px;align-items:flex-start;flex-direction:column-reverse}
.badge{pointer-events:auto;display:flex;align-items:center;gap:7px;height:38px;padding:0 13px 0 11px;border-radius:999px;background:linear-gradient(135deg,rgba(99,102,241,.95),rgba(139,92,246,.95));color:#fff;font-size:13px;font-weight:700;cursor:pointer;user-select:none;box-shadow:0 6px 22px rgba(80,70,200,.45),0 0 0 1px rgba(255,255,255,.18) inset;transition:transform .15s,box-shadow .15s}
.badge:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(80,70,200,.55),0 0 0 1px rgba(255,255,255,.25) inset}
.badge svg{width:18px;height:18px;fill:currentColor}
.badge .n{background:rgba(255,255,255,.25);border-radius:999px;min-width:20px;height:20px;line-height:20px;text-align:center;font-size:12px;padding:0 6px}
.badge.pulse{animation:pulse 1.2s ease-out 2}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(139,92,246,.7)}100%{box-shadow:0 0 0 16px rgba(139,92,246,0)}}
.panel{pointer-events:auto;width:420px;max-width:calc(100vw - 28px);max-height:min(78vh,660px);display:none;flex-direction:column;border-radius:16px;background:rgba(20,20,29,.96);color:#f2f2f7;border:1px solid rgba(255,255,255,.12);box-shadow:0 18px 60px rgba(0,0,0,.55);overflow:hidden}
.panel.open{display:flex}
.hd{display:flex;align-items:center;gap:8px;padding:12px 14px 6px}
.hd b{font-size:14px;flex:1;letter-spacing:.1px}
.hd .kb{font-size:10.5px;color:#9a9aab;border:1px solid rgba(255,255,255,.16);border-radius:6px;padding:1px 6px}
.x{all:unset;cursor:pointer;width:26px;height:26px;text-align:center;line-height:26px;border-radius:50%;color:#b4b4c2;font-size:16px}
.x:hover{background:rgba(255,255,255,.12);color:#fff}
.search{margin:2px 14px 6px;display:flex;align-items:center;background:rgba(255,255,255,.07);border-radius:10px;padding:0 10px;border:1px solid transparent}
.search:focus-within{border-color:#7c83f0}
.search input{all:unset;flex:1;height:32px;font-size:12.5px;color:#f2f2f7}
.search input::placeholder{color:#8b8b9c}
.tabs{display:flex;gap:4px;padding:0 12px}
.tab{all:unset;cursor:pointer;padding:6px 12px;border-radius:9px;font-size:12px;color:#b4b4c2}
.tab:hover{background:rgba(255,255,255,.08)}.tab.on{background:rgba(124,131,240,.28);color:#fff}
.tab i{font-style:normal;opacity:.75;margin-left:5px}
.bar{display:flex;align-items:center;gap:8px;padding:9px 14px}
.btn{all:unset;cursor:pointer;background:rgba(255,255,255,.1);color:#f2f2f7;font-size:12px;font-weight:600;padding:7px 12px;border-radius:9px;white-space:nowrap}
.btn:hover{background:rgba(255,255,255,.18)}
.btn.pri{background:#7c83f0;color:#fff}.btn.pri:hover{filter:brightness(1.1)}
.btn[disabled]{opacity:.4;cursor:default;filter:none}
.note{font-size:11.5px;color:#7fdca0;flex:1;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.list{overflow-y:auto;padding:2px 10px 10px;display:flex;flex-direction:column;gap:8px;min-height:70px}
.empty{padding:22px 12px;color:#9a9aab;font-size:12.5px;text-align:center;line-height:1.55}
.row{display:flex;flex-direction:column;gap:9px;padding:10px;border-radius:12px;background:rgba(255,255,255,.055);border:1px solid transparent}
.row.sel{border-color:#7c83f0;background:rgba(124,131,240,.13)}
.top{display:flex;gap:11px}
.th{position:relative;width:128px;height:72px;flex:none;border-radius:9px;background:#0d0d14;overflow:hidden;cursor:pointer}
.th canvas{width:128px;height:72px;display:block}
.dur{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.8);color:#fff;font-size:11px;font-weight:600;padding:1px 5px;border-radius:5px}
.mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.ttl{font-size:13px;line-height:1.3;max-height:2.6em;overflow:hidden;word-break:break-word;cursor:text}
.ttl:hover{color:#c7caff}
.rn{all:unset;box-sizing:border-box;width:100%;font-size:13px;color:#fff;background:rgba(0,0,0,.35);border:1px solid #7c83f0;border-radius:7px;padding:4px 7px}
.meta{display:flex;flex-wrap:wrap;gap:4px}
.chip{font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:6px;background:rgba(255,255,255,.12);color:#d6d6e2}
.chip.drm{background:rgba(245,158,11,.22);color:#fbbf24}.chip.live{background:rgba(239,68,68,.25);color:#fca5a5}.chip.act{background:rgba(52,211,153,.2);color:#6ee7b7}.chip.fmt{background:rgba(124,131,240,.28);color:#c7caff}
.acts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.q{all:unset;cursor:pointer;background:rgba(255,255,255,.1);color:#f2f2f7;font-size:12px;padding:6px 26px 6px 10px;border-radius:9px;background-image:linear-gradient(45deg,transparent 50%,#b4b4c2 50%),linear-gradient(135deg,#b4b4c2 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px;background-size:5px 5px;background-repeat:no-repeat}
.q option{background:#1c1c28;color:#f2f2f7}
.grow{flex:1}
.ic{all:unset;cursor:pointer;width:32px;height:30px;text-align:center;line-height:30px;font-size:13px;border-radius:9px;background:rgba(255,255,255,.1);color:#f2f2f7}
.ic:hover{background:rgba(255,255,255,.2)}.ic[disabled]{opacity:.35;cursor:default}
.prog{display:flex;flex-direction:column;gap:5px}
.pb{height:6px;border-radius:99px;background:rgba(255,255,255,.12);overflow:hidden}
.pb i{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#6366f1,#a78bfa);transition:width .25s}
.pb.done i{background:#34d399}.pb.err i{background:#f87171}
.pt{display:flex;align-items:center;gap:8px;font-size:11.5px;color:#b4b4c2}
.pt .g{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pt.ok{color:#6ee7b7}.pt.bad{color:#fca5a5}.pt.warn{color:#fbbf24}
.lnk{all:unset;cursor:pointer;color:#c7caff;font-size:11.5px;text-decoration:underline}
.ft{padding:8px 14px 10px;font-size:10.5px;color:#8b8b9c;border-top:1px solid rgba(255,255,255,.08);line-height:1.55}
.ft b{color:#c7caff;font-weight:600}
`;

const ICON_DL = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';

function svgIcon(d, size) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size || 18));
  s.setAttribute('height', String(size || 18));
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', 'currentColor');
  s.appendChild(p);
  return s;
}

function ensurePopup() {
  if (!IS_TOP || popup.host) return;
  popup.host = topLayerHost('popup');
  const root = popup.host.attachShadow({ mode: 'closed' });
  root.adoptedStyleSheets = [css(POPUP_CSS)];
  const wrap = el('div', 'w ' + cfg.corner);
  const badge = el('div', 'badge');
  badge.setAttribute('role', 'button');
  badge.setAttribute('aria-label', 'Media on this page');
  badge.title = 'Media on this page (' + cfg.popupKey + ')';
  const count = el('span', 'n', '0');
  badge.append(svgIcon(ICON_DL, 18), count);
  badge.addEventListener('click', (e) => e.isTrusted && togglePopup());

  const panel = el('div', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Media on this page');
  const hd = el('div', 'hd');
  const title = el('b', '', 'Media on this page');
  const kb = el('span', 'kb', cfg.popupKey);
  const close = el('button', 'x', '×');
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', (e) => e.isTrusted && setPopup(false));
  hd.append(title, kb, close);

  const search = el('div', 'search');
  const input = document.createElement('input');
  input.placeholder = 'Filter by name or type  ( / )';
  input.setAttribute('aria-label', 'Filter');
  input.addEventListener('input', () => {
    popup.filter = input.value.trim().toLowerCase();
    renderPopup();
  });
  search.append(input);

  const tabs = el('div', 'tabs');
  const tabBtns = {};
  for (const [g, name] of GROUPS) {
    const b = el('button', 'tab');
    b.append(document.createTextNode(name), el('i', '', '0'));
    b.addEventListener('click', (e) => e.isTrusted && setGroup(g));
    tabs.append(b);
    tabBtns[g] = b;
  }
  const bar = el('div', 'bar');
  const all = el('button', 'btn pri', 'Download all');
  all.addEventListener('click', (e) => e.isTrusted && act('downloadAll'));
  const links = el('button', 'btn', 'Copy links');
  links.addEventListener('click', (e) => e.isTrusted && copyAllLinks());
  const note = el('div', 'note');
  bar.append(all, links, note);
  const list = el('div', 'list');
  const ft = el('div', 'ft');
  panel.append(hd, search, tabs, bar, list, ft);
  wrap.append(panel, badge);
  root.append(wrap);
  popup.wrap = wrap;
  popup.ui = { badge, count, panel, tabBtns, all, links, note, list, input, ft, kb };
  (document.body || document.documentElement).appendChild(popup.host);
  showTop(popup.host);
}

function visibleItems() {
  const q = popup.filter;
  return popup.items.filter((i) => i.group === popup.group && (!q || (i.title + ' ' + i.format + ' ' + (i.url || '')).toLowerCase().includes(q)));
}

function shortcutHint() {
  return cfg.popupKey + ' open/close · ↑↓ select · Enter or D download · Shift+D all · P play · C copy · R rename · [ ] quality · / filter · 1 2 3 tabs · Esc';
}

function renderPopup() {
  if (!IS_TOP) return;
  ensurePopup();
  if (popup.editing) {
    popup.pendingRender = true;
    return;
  }
  const ui = popup.ui;
  const counts = { video: 0, audio: 0, other: 0 };
  popup.items.forEach((i) => counts[i.group]++);
  const shown = counts.video + counts.audio;
  const hide = !popup.open && (shown === 0 || (document.fullscreenElement && !popup.open) || cfg.badge === false);
  ui.badge.style.display = hide ? 'none' : 'flex';
  ui.count.textContent = String(shown);
  popup.wrap.className = 'w ' + cfg.corner;
  ui.panel.classList.toggle('open', popup.open);
  ui.kb.textContent = cfg.popupKey;
  for (const [g] of GROUPS) {
    ui.tabBtns[g].classList.toggle('on', g === popup.group);
    ui.tabBtns[g].lastChild.textContent = String(counts[g]);
  }
  if (!popup.open) return;
  ui.ft.textContent = shortcutHint();
  const items = visibleItems();
  if (!items.some((i) => i.id === popup.sel)) popup.sel = items.length ? items[0].id : null;
  const dl = items.filter((i) => i.canDownload && !i.protected && !i.live);
  ui.all.disabled = dl.length === 0;
  ui.all.textContent = 'Download all' + (dl.length ? ' (' + dl.length + ')' : '');
  ui.all.style.display = popup.group === 'other' ? 'none' : '';
  ui.links.style.display = popup.group === 'other' || !items.some((i) => i.url) ? 'none' : '';
  ui.note.textContent = popup.notice;
  ui.list.textContent = '';
  popup.rows.clear();
  if (!items.length) {
    ui.list.append(
      el(
        'div',
        'empty',
        popup.filter
          ? 'Nothing matches "' + popup.filter + '".'
          : popup.group === 'other'
            ? 'Nothing here. Subtitles, tiny clips and streaming pieces are listed in this tab.'
            : 'No ' + popup.group + ' found yet. Start the video: everything the page loads shows up here.'
      )
    );
    return;
  }
  for (const it of items) {
    const row = rowFor(it);
    popup.rows.set(it.id, row);
    ui.list.append(row.node);
    paintProgress(it.id);
  }
  const selEl = ui.list.querySelector('.sel');
  if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: 'nearest' });
}

function chosenQuality(it) {
  return popup.quality.has(it.id) ? popup.quality.get(it.id) : 0;
}

function rowFor(it) {
  const node = el('div', 'row' + (it.id === popup.sel ? ' sel' : ''));
  node.dataset.id = it.id;
  node.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    if (popup.sel !== it.id) {
      popup.sel = it.id;
      reportPopup();
      renderPopup();
    }
  });
  const top = el('div', 'top');
  const th = el('div', 'th');
  th.title = it.canPlay ? 'Play in Quin Gallery' : '';
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 144;
  drawThumb(cv, it.id);
  th.append(cv);
  if (it.live) th.append(el('div', 'dur', 'LIVE'));
  else if (it.duration) th.append(el('div', 'dur', fmtDur(it.duration)));
  th.addEventListener('click', (e) => {
    if (!e.isTrusted || !it.canPlay) return;
    e.stopPropagation();
    popup.sel = it.id;
    act('play', it.id);
  });
  const mid = el('div', 'mid');
  const ttl = el('div', 'ttl', popup.names.get(it.id) || it.filename || it.title || it.url || 'Untitled');
  ttl.title = (it.url || it.title || '') + '\n(click to rename)';
  ttl.addEventListener('click', (e) => {
    if (!e.isTrusted || !it.canDownload) return;
    e.stopPropagation();
    startRename(it, ttl);
  });
  const meta = el('div', 'meta');
  meta.append(el('span', 'chip fmt', it.format));
  const sel = chosenQuality(it);
  const h = sel || it.height;
  if (h) meta.append(el('span', 'chip', h + 'p'));
  if (it.size) meta.append(el('span', 'chip', fmtSize(it.size)));
  if (it.live) meta.append(el('span', 'chip live', 'LIVE'));
  if (it.protected) {
    const c = el('span', 'chip drm', 'DRM' + (it.protected !== 'DRM' ? ' · ' + it.protected : ''));
    c.title = 'Protected stream: it can only be played by the site itself';
    meta.append(c);
  }
  if (it.aes) meta.append(el('span', 'chip', 'AES'));
  if (it.active) meta.append(el('span', 'chip act', 'playing'));
  if (it.viaPage) meta.append(el('span', 'chip', 'page player'));
  mid.append(ttl, meta);
  top.append(th, mid);

  const acts = el('div', 'acts');
  if (it.canDownload && !it.protected) {
    const vs = it.variants || [];
    if (vs.length) {
      const q = el('select', 'q');
      q.title = 'Quality';
      q.append(new Option('Best quality', '0'));
      vs.forEach((v) => q.append(new Option(v.label, String(v.height))));
      q.value = String(chosenQuality(it));
      q.addEventListener('change', () => popup.quality.set(it.id, Number(q.value)));
      q.addEventListener('click', (e) => e.stopPropagation());
      acts.append(q);
    } else if (it.viaPage) {
      const b = el('button', 'btn', popup.asked && popup.asked.has(it.id) ? 'Loading qualities…' : 'Qualities ▾');
      b.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        (popup.asked = popup.asked || new Set()).add(it.id);
        b.textContent = 'Loading qualities…';
        post({ t: 'formats', id: it.id });
      });
      acts.append(b);
    }
  }
  acts.append(el('span', 'grow'));
  const mk = (cls, label, tip, op, disabled) => {
    const b = el('button', cls, label);
    b.title = tip;
    b.disabled = !!disabled;
    b.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      popup.sel = it.id;
      act(op, it.id);
    });
    return b;
  };
  acts.append(mk('ic', '▶', 'Play in Quin Gallery', 'play', !it.canPlay));
  if (it.url) acts.append(mk('ic', '⧉', 'Copy link', 'copy', false));
  const dlBtn = mk('btn pri', 'Download', it.canDownload ? 'Download' : it.note || 'Cannot be downloaded', 'download', !it.canDownload);
  acts.append(dlBtn);

  const prog = el('div', 'prog');
  prog.style.display = 'none';
  node.append(top, acts, prog);
  return { node, prog, dlBtn, acts };
}

/* Progress lives in the row itself (patched in place, so typing / selecting is never interrupted). */
function paintProgress(id) {
  const row = popup.rows.get(id);
  if (!row) return;
  const p = popup.dl.get(id);
  row.prog.textContent = '';
  if (!p) {
    row.prog.style.display = 'none';
    return;
  }
  row.prog.style.display = 'flex';
  const bar = el('div', 'pb' + (p.status === 'done' ? ' done' : p.status === 'error' || p.status === 'cancelled' ? ' err' : ''));
  const fill = document.createElement('i');
  fill.style.width = Math.max(p.status === 'running' || p.status === 'queued' ? 3 : 0, Math.min(100, p.percent || 0)) + '%';
  bar.append(fill);
  const line = el('div', 'pt');
  const g = el('span', 'g');
  if (p.status === 'queued') g.textContent = 'Waiting…';
  else if (p.status === 'running') {
    const parts = [Math.round(p.percent || 0) + '%'];
    if (p.speed) parts.push(fmtSize(p.speed) + '/s');
    if (p.total) parts.push(fmtSize(p.downloaded || 0) + ' of ' + fmtSize(p.total));
    if (p.eta != null) parts.push(fmtDur(p.eta) + ' left');
    g.textContent = parts.join(' · ');
  } else if (p.status === 'done') {
    g.textContent = (p.verified === false ? 'Saved, but ' + (p.warning || 'the check failed') : p.verified ? 'Saved and verified · ' : 'Saved · ') + (p.file || '');
    line.classList.add(p.verified === false ? 'warn' : 'ok');
  } else if (p.status === 'error') {
    g.textContent = p.error || 'Failed';
    line.classList.add('bad');
  } else g.textContent = 'Cancelled';
  line.append(g);
  const link = (label, op) => {
    const b = el('button', 'lnk', label);
    b.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      post({ t: 'act', op, task: p.task, id: id });
    });
    return b;
  };
  if (p.status === 'running' || p.status === 'queued') line.append(link('Cancel', 'cancel'));
  if (p.status === 'done') line.append(link('Show in folder', 'reveal'));
  if (p.status === 'error' || p.status === 'cancelled') {
    const retry = el('button', 'lnk', 'Retry');
    retry.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      popup.dl.delete(id);
      act('download', id);
    });
    line.append(retry);
  }
  row.prog.append(bar, line);
}

function startRename(it, ttl) {
  const input = document.createElement('input');
  input.className = 'rn';
  input.value = popup.names.get(it.id) || it.filename || it.title || '';
  popup.editing = it.id;
  ttl.replaceWith(input);
  input.focus();
  input.select();
  const finish = (save) => {
    if (popup.editing !== it.id) return;
    popup.editing = null;
    if (save && input.value.trim()) popup.names.set(it.id, input.value.trim().slice(0, 110));
    popup.pendingRender = false;
    renderPopup();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function drawThumb(cv, id) {
  const g = cv.getContext('2d');
  const bmp = popup.bitmaps.get(id);
  if (bmp) {
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    return;
  }
  const grad = g.createLinearGradient(0, 0, cv.width, cv.height);
  grad.addColorStop(0, '#22222e');
  grad.addColorStop(1, '#3a3a52');
  g.fillStyle = grad;
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = 'rgba(255,255,255,.55)';
  g.beginPath();
  g.moveTo(cv.width / 2 - 20, cv.height / 2 - 26);
  g.lineTo(cv.width / 2 + 28, cv.height / 2);
  g.lineTo(cv.width / 2 - 20, cv.height / 2 + 26);
  g.fill();
}

function setPopup(open) {
  if (!IS_TOP) return;
  popup.open = open;
  ensurePopup();
  renderPopup();
  reportPopup();
  if (open) {
    showTop(popup.host);
    if (popup.ui.input) popup.ui.input.blur();
  }
}
function togglePopup() {
  if (!IS_TOP) {
    try {
      parent.postMessage({ qg: NONCE, k: 'toggle' }, '*');
    } catch (_) {}
    return;
  }
  setPopup(!popup.open);
}
function setGroup(g) {
  popup.group = g;
  popup.sel = null;
  renderPopup();
  reportPopup();
}
function reportPopup() {
  post({ t: 'popup', open: popup.open, group: popup.group, selected: popup.sel || '' });
}

function act(op, id) {
  const it = popup.items.find((i) => i.id === id);
  const msg = { t: 'act', op, id: id || '', group: popup.group };
  if (it && (op === 'download' || op === 'play')) {
    const q = chosenQuality(it);
    if (q) msg.quality = q;
    const nm = popup.names.get(it.id);
    if (nm) msg.name = nm;
  }
  post(msg);
  setNotice(op === 'copy' ? 'Link copied' : op === 'play' ? 'Opening in the player…' : op === 'downloadAll' ? 'Starting downloads…' : 'Starting download…');
}

function copyAllLinks() {
  const urls = visibleItems().filter((i) => i.url);
  if (!urls.length) return;
  post({ t: 'act', op: 'copy-links', group: popup.group });
  setNotice(urls.length + ' link' + (urls.length > 1 ? 's' : '') + ' copied');
}

function setNotice(text) {
  popup.notice = text;
  clearTimeout(popup.noticeT);
  popup.noticeT = setTimeout(() => {
    popup.notice = '';
    if (popup.open && popup.ui.note) popup.ui.note.textContent = '';
  }, 3500);
  if (popup.open && popup.ui.note) popup.ui.note.textContent = text;
}

function setThumbs(map) {
  if (!IS_TOP || !map) return;
  const jobs = Object.keys(map).map(async (id) => {
    try {
      const bin = atob(map[id]);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      popup.bitmaps.set(id, await createImageBitmap(new Blob([u8], { type: 'image/jpeg' })));
    } catch (_) {}
  });
  Promise.all(jobs).then(() => popup.open && renderPopup());
}

function setProgress(itemId, p) {
  if (!IS_TOP || !p) return;
  popup.dl.set(itemId, p);
  paintProgress(itemId);
  if (p.status === 'done' || p.status === 'error') setNotice(p.status === 'done' ? 'Saved ' + (p.file || '') : p.error || 'Download failed');
}

function selectItem(id) {
  if (!IS_TOP) return;
  const it = popup.items.find((i) => i.id === id);
  if (it) {
    popup.group = it.group;
    popup.sel = id;
    popup.pendingSelect = null;
    if (popup.open) renderPopup();
  } else popup.pendingSelect = id;
}

/* Keys while the popup is open (returns true when it consumed the key). */
function popupKey(e) {
  const k = e.key;
  if (k === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (popup.ui.input && popup.filter) {
      popup.ui.input.value = '';
      popup.filter = '';
      renderPopup();
    } else setPopup(false);
    return true;
  }
  if (popup.editing) return false;
  const eat = () => {
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  if (k === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !editable(e.target)) {
    if (popup.ui.input) popup.ui.input.focus();
    return eat();
  }
  if (editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return false;
  const items = visibleItems();
  const idx = items.findIndex((i) => i.id === popup.sel);
  const cur = items[idx];
  switch (k) {
    case 'ArrowDown':
      if (items.length) popup.sel = items[Math.min(items.length - 1, idx + 1)].id;
      renderPopup();
      reportPopup();
      return eat();
    case 'ArrowUp':
      if (items.length) popup.sel = items[Math.max(0, idx - 1)].id;
      renderPopup();
      reportPopup();
      return eat();
    case 'Enter':
    case 'd':
      if (cur && cur.canDownload) act('download', cur.id);
      return eat();
    case 'D':
      act('downloadAll');
      return eat();
    case 'p':
    case 'P':
      if (cur && cur.canPlay) act('play', cur.id);
      return eat();
    case 'c':
    case 'C':
      if (cur && cur.url) act('copy', cur.id);
      return eat();
    case 'r':
    case 'R':
    case 'F2': {
      const row = cur && popup.rows.get(cur.id);
      const t = row && row.node.querySelector('.ttl');
      if (cur && cur.canDownload && t) startRename(cur, t);
      return eat();
    }
    case '[':
    case ']': {
      if (cur && cur.canDownload && cur.viaPage && !(cur.variants && cur.variants.length)) {
        // a page-owned player: ask the video engine which qualities exist
        (popup.asked = popup.asked || new Set()).add(cur.id);
        post({ t: 'formats', id: cur.id });
        setNotice('Looking up the qualities…');
      } else if (cur && cur.variants && cur.variants.length) {
        const hs = [0].concat(cur.variants.map((v) => v.height));
        const at = hs.indexOf(chosenQuality(cur));
        popup.quality.set(cur.id, hs[(at + (k === ']' ? 1 : hs.length - 1)) % hs.length]);
        renderPopup();
      }
      return eat();
    }
    case '1':
      setGroup('video');
      return eat();
    case '2':
      setGroup('audio');
      return eat();
    case '3':
      setGroup('other');
      return eat();
    case 'Tab': {
      const order = GROUPS.map((g) => g[0]);
      setGroup(order[(order.indexOf(popup.group) + (e.shiftKey ? order.length - 1 : 1)) % order.length]);
      return eat();
    }
  }
  return false;
}
