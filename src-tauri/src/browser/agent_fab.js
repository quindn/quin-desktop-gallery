/* ------------------------------------------------------- floating buttons under a video
 * Like the mobile browsers (UC, Quetta): when a video is under the pointer — or has just started — two buttons
 * float below it: "Quin Player" (apply our player onto this video) and "Download". Nothing is forced: the site's
 * player stays as it is until the button is pressed.
 */
const fab = { host: null, box: null, btnP: null, btnD: null, target: null, hideT: 0, raf: 0, pointerIn: false, shownAt: 0 };

const FAB_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:'Segoe UI',system-ui,-apple-system,sans-serif}
.f{position:fixed;display:flex;gap:6px;padding:5px;border-radius:14px;background:rgba(18,18,26,.88);border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 26px rgba(0,0,0,.45);pointer-events:auto;opacity:0;transform:translateY(-4px);transition:opacity .18s,transform .18s;backdrop-filter:blur(10px)}
.f.on{opacity:1;transform:none}
.fb{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px 0 10px;border-radius:10px;font-size:12.5px;font-weight:700;color:#fff;background:rgba(255,255,255,.12);white-space:nowrap;transition:background .15s,transform .1s}
.fb:hover{background:rgba(255,255,255,.22)}.fb:active{transform:scale(.96)}
.fb.d{background:linear-gradient(135deg,#6366f1,#8b5cf6)}.fb.d:hover{filter:brightness(1.12)}
.fb.p.on{background:rgba(139,140,248,.45)}
.fb svg{width:17px;height:17px;fill:currentColor}
`;

const FAB_PLAY = 'M8 5v14l11-7z';
const FAB_DL = 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z';
const FAB_X = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

function fabSvg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d);
  s.appendChild(p);
  return s;
}

function ensureFab() {
  if (fab.host) return;
  fab.host = topLayerHost('fab');
  const root = fab.host.attachShadow({ mode: 'closed' });
  root.adoptedStyleSheets = [css(FAB_CSS)];
  fab.box = el('div', 'f');
  fab.btnP = el('button', 'fb p');
  fab.btnD = el('button', 'fb d');
  fab.btnP.addEventListener('click', (e) => {
    if (!e.isTrusted || !fab.target) return;
    const v = fab.target.el;
    if (hasSkin(v)) removeSkin(v);
    else applySkin(v);
    paintFab();
  });
  fab.btnD.addEventListener('click', (e) => {
    if (!e.isTrusted || !fab.target) return;
    post({ t: 'act', op: 'fab-download', dom: fab.target.id });
    flash(fab.target.el, 'Downloading…', 0);
  });
  fab.box.addEventListener('pointerenter', () => {
    fab.pointerIn = true;
    clearTimeout(fab.hideT);
  });
  fab.box.addEventListener('pointerleave', () => {
    fab.pointerIn = false;
    scheduleFabHide(1200);
  });
  fab.box.append(fab.btnP, fab.btnD);
  root.append(fab.box);
  (document.body || document.documentElement).appendChild(fab.host);
}

function paintFab() {
  if (!fab.target) return;
  const skinned = hasSkin(fab.target.el);
  fab.btnP.textContent = '';
  fab.btnP.append(fabSvg(skinned ? FAB_X : FAB_PLAY), document.createTextNode(skinned ? 'Original player' : 'Quin Player'));
  fab.btnP.classList.toggle('on', skinned);
  fab.btnP.title = skinned ? 'Give the site\'s own player back' : 'Play this video with Quin Player';
  fab.btnD.textContent = '';
  fab.btnD.append(fabSvg(FAB_DL), document.createTextNode('Download'));
  fab.btnD.title = 'Download this video';
}

function fabEligible(r) {
  const el = r.el;
  if (el.tagName !== 'VIDEO' || !el.isConnected) return false;
  const b = el.getBoundingClientRect();
  return b.width >= 200 && b.height >= 110 && visibleRatio(el, b) > 0.4;
}

function placeFab() {
  cancelAnimationFrame(fab.raf);
  if (!fab.target || !fab.host) return;
  const el = fab.target.el;
  if (!el.isConnected) return hideFab();
  const b = el.getBoundingClientRect();
  const w = fab.box.offsetWidth || 260;
  const h = fab.box.offsetHeight || 42;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // under the video when there is room, otherwise just inside its lower edge
  let top = b.bottom + 8;
  if (top + h > vh - 6) top = Math.min(b.bottom - h - 62, vh - h - 6);
  const left = clamp(b.left + 8, 6, Math.max(6, vw - w - 6));
  fab.box.style.left = left + 'px';
  fab.box.style.top = Math.max(6, top) + 'px';
  fab.raf = requestAnimationFrame(placeFab);
}

function showFab(r) {
  if (!on() || cfg.fab === false || !fabEligible(r)) return;
  ensureFab();
  fab.target = r;
  paintFab();
  showTop(fab.host);
  fab.box.classList.add('on');
  fab.shownAt = Date.now();
  placeFab();
  scheduleFabHide(2800);
}

function hideFab() {
  cancelAnimationFrame(fab.raf);
  if (fab.box) fab.box.classList.remove('on');
  clearTimeout(fab.hideT);
  fab.hideT = setTimeout(() => {
    if (fab.host && !(fab.box && fab.box.classList.contains('on'))) {
      try {
        fab.host.hidePopover();
      } catch (_) {}
    }
  }, 250);
  fab.target = null;
}

function scheduleFabHide(ms) {
  clearTimeout(fab.hideT);
  fab.hideT = setTimeout(() => {
    if (fab.pointerIn) return scheduleFabHide(1500);
    hideFab();
  }, ms);
}

/* the video under the pointer */
function videoAtPoint(x, y) {
  let best = null;
  recs.forEach((r) => {
    if (r.el.tagName !== 'VIDEO') return;
    const b = r.el.getBoundingClientRect();
    if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom && fabEligible(r)) {
      if (!best || (r.score || 0) > (best.score || 0)) best = r;
    }
  });
  return best;
}

let fabMoveT = 0;
window.addEventListener(
  'pointermove',
  (e) => {
    if (!on() || cfg.fab === false || !e.isTrusted || fabMoveT) return;
    fabMoveT = setTimeout(() => {
      fabMoveT = 0;
    }, 90);
    const r = videoAtPoint(e.clientX, e.clientY);
    if (r) {
      if (!fab.target || fab.target !== r || !fab.box.classList.contains('on')) showFab(r);
      else scheduleFabHide(2800);
    } else if (fab.target && !fab.pointerIn) scheduleFabHide(900);
  },
  { capture: true, passive: true }
);

/* a video that just started playing shows the buttons for a moment, like the mobile browsers do */
document.addEventListener(
  'playing',
  (e) => {
    const r = isMedia(e.target) && recs.get(e.target);
    if (!r || !on() || cfg.fab === false) return;
    setTimeout(() => {
      if (!fab.target || !fab.box.classList.contains('on')) showFab(r);
    }, 700);
  },
  true
);
