/* ------------------------------------------------------------- Quin Player (skin)
 * Applied to a page's own <video> ONLY when the user asks (the floating "Quin Player" button): the site keeps
 * playing the video (MSE, DRM, ads logic all untouched), our controls are drawn over it and drive that same
 * element. Removing the skin gives the original player back.
 */
const skins = new Map(); // video element -> skin

const SKIN_CSS = `
:host{all:initial}
*{box-sizing:border-box;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;-webkit-user-select:none;user-select:none}
.sk{position:fixed;overflow:hidden;color:#fff;pointer-events:none;background:transparent;border-radius:0;--acc:#8b8cf8}
.sk.hide{cursor:none}
.surface{position:absolute;inset:0;pointer-events:auto;cursor:pointer}
.sk.hide .surface{cursor:none}
.center{position:absolute;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;border-radius:50%;background:rgba(15,15,22,.6);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.8);transition:opacity .25s,transform .25s;pointer-events:none}
.center.on{opacity:1;transform:scale(1)}
.center svg{width:38px;height:38px;fill:#fff}
.spin{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:4px solid rgba(255,255,255,.22);border-top-color:#fff;animation:sp .8s linear infinite;opacity:0;transition:opacity .2s;pointer-events:none}
.spin.on{opacity:1}
@keyframes sp{to{transform:rotate(360deg)}}
.err{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(20,20,29,.9);border-radius:12px;padding:12px 18px;font-size:13px;display:none;max-width:80%;text-align:center;pointer-events:none}
.top,.bot{position:absolute;left:0;right:0;pointer-events:none;transition:opacity .25s,transform .25s}
.top{top:0;padding:12px 14px 30px;background:linear-gradient(180deg,rgba(0,0,0,.72),rgba(0,0,0,0));display:flex;align-items:center;gap:10px}
.bot{bottom:0;padding:34px 14px 10px;background:linear-gradient(0deg,rgba(0,0,0,.86) 15%,rgba(0,0,0,0))}
.sk.hide .top{opacity:0;transform:translateY(-8px)}
.sk.hide .bot{opacity:0;transform:translateY(8px)}
.ttl{flex:1;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 4px rgba(0,0,0,.6)}
.b{all:unset;box-sizing:border-box;pointer-events:auto;cursor:pointer;min-width:36px;height:36px;padding:0 8px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:#fff;font-size:12.5px;font-weight:700;transition:background .15s,transform .1s}
.b:hover{background:rgba(255,255,255,.18)}.b:active{transform:scale(.92)}
.b svg{width:22px;height:22px;fill:currentColor}
.b.on{color:var(--acc)}
.b.pp{width:44px;height:44px;border-radius:50%;background:rgba(255,255,255,.14)}
.b.pp svg{width:26px;height:26px}
.seek{position:relative;height:22px;pointer-events:auto;cursor:pointer;display:flex;align-items:center;touch-action:none}
.track{position:relative;width:100%;height:4px;border-radius:99px;background:rgba(255,255,255,.22);transition:height .12s}
.seek:hover .track,.seek.drag .track{height:7px}
.buf{position:absolute;top:0;bottom:0;background:rgba(255,255,255,.32);border-radius:99px}
.played{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,#6366f1,var(--acc));border-radius:99px}
.knob{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.5);transform:scale(0);transition:transform .12s}
.seek:hover .knob,.seek.drag .knob{transform:scale(1)}
.tip{position:absolute;bottom:22px;transform:translateX(-50%);background:rgba(20,20,29,.95);padding:3px 8px;border-radius:7px;font-size:12px;font-weight:600;pointer-events:none;opacity:0;white-space:nowrap}
.seek:hover .tip{opacity:1}
.row{display:flex;align-items:center;gap:2px;margin-top:2px;flex-wrap:nowrap}
.time{font-size:12.5px;font-variant-numeric:tabular-nums;padding:0 8px;color:#e8e8f0;white-space:nowrap}
.sp{flex:1}
.vol{display:flex;align-items:center}
.vs{width:0;overflow:hidden;transition:width .2s;display:flex;align-items:center;pointer-events:auto}
.vol:hover .vs,.vol.open .vs{width:84px}
.vs input{width:74px;margin:0 6px;accent-color:#8b8cf8;cursor:pointer}
.live{pointer-events:auto;cursor:pointer;background:#ef4444;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:800;letter-spacing:.6px;margin:0 6px}
.live.off{background:rgba(255,255,255,.2)}
.menu{position:absolute;bottom:64px;right:14px;background:rgba(20,20,29,.97);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:6px;min-width:130px;display:none;pointer-events:auto;box-shadow:0 12px 36px rgba(0,0,0,.55);max-height:60%;overflow:auto}
.menu.open{display:block}
.mi{all:unset;box-sizing:border-box;display:block;width:100%;padding:7px 12px;border-radius:8px;font-size:13px;cursor:pointer;color:#f2f2f7}
.mi:hover{background:rgba(255,255,255,.12)}.mi.on{color:var(--acc);font-weight:700}
.toast{position:absolute;top:56px;left:50%;transform:translateX(-50%);background:rgba(20,20,29,.9);padding:6px 14px;border-radius:999px;font-size:12.5px;font-weight:600;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.on{opacity:1}
`;

const SK_ICON = {
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  volHigh: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  volLow: 'M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z',
  volMute: 'M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z',
  fs: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
  fsx: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
  pip: 'M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 1.98 2 1.98h18c1.1 0 2-.88 2-1.98V5c0-1.1-.9-2-2-2zm0 16.01H3V4.98h18v14.03z',
  close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  dl: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  cc: 'M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z',
  loop: 'M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z',
  back: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
};

function skIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', SK_ICON[name]);
  s.appendChild(p);
  return s;
}

function skSet(btn, name) {
  btn.textContent = '';
  btn.appendChild(skIcon(name));
}

function hasSkin(v) {
  return skins.has(v);
}

/* Elements the site draws over the video (its own controls, big play button...). They stay under our
 * surface but would still show through, so they are hidden while our player is applied and restored after. */
function siteOverlays(video) {
  const out = [];
  const va = areaOf(video);
  let root = video.parentElement;
  for (let i = 0; i < 5 && root && root.parentElement; i++) {
    if (areaOf(root.parentElement) > va * 1.6) break;
    root = root.parentElement;
  }
  if (!root) return out;
  const vr = video.getBoundingClientRect();
  root.querySelectorAll('*').forEach((n) => {
    if (n === video || n.contains(video) || video.contains(n) || n.tagName === 'SOURCE' || n.tagName === 'TRACK') return;
    let cs;
    try {
      cs = getComputedStyle(n);
    } catch (_) {
      return;
    }
    if ((cs.position === 'absolute' || cs.position === 'fixed') && cs.visibility !== 'hidden') {
      const r = n.getBoundingClientRect();
      if (r.width && r.height && r.left >= vr.left - 4 && r.top >= vr.top - 4 && r.right <= vr.right + 4 && r.bottom <= vr.bottom + 4) out.push(n);
    }
  });
  return out.slice(0, 60);
}

function applySkin(video) {
  if (skins.has(video) || !on()) return null;
  const skin = { video, controls: video.controls, hidden: [], hideT: 0, raf: 0, dragging: false, lastMove: 0, menu: null, saved: {}, gone: false };
  skins.set(video, skin);
  video.controls = false;
  try {
    skin.hidden = siteOverlays(video).map((n) => {
      const prev = n.style.getPropertyValue('visibility');
      const prio = n.style.getPropertyPriority('visibility');
      n.style.setProperty('visibility', 'hidden', 'important');
      return { n, prev, prio };
    });
  } catch (_) {}

  const host = topLayerHost('skin');
  const root = host.attachShadow({ mode: 'closed' });
  root.adoptedStyleSheets = [css(SKIN_CSS)];
  const sk = el('div', 'sk');
  const surface = el('div', 'surface');
  const center = el('div', 'center');
  const spin = el('div', 'spin');
  const err = el('div', 'err');
  const toast = el('div', 'toast');
  const top = el('div', 'top');
  const ttl = el('div', 'ttl', (video.getAttribute('title') || document.title || 'Video').slice(0, 120));
  const dlBtn = el('button', 'b');
  dlBtn.title = 'Download this video';
  dlBtn.appendChild(skIcon('dl'));
  const closeBtn = el('button', 'b');
  closeBtn.title = 'Back to the site\'s player';
  closeBtn.appendChild(skIcon('close'));
  top.append(ttl, dlBtn, closeBtn);

  const bot = el('div', 'bot');
  const seek = el('div', 'seek');
  const track = el('div', 'track');
  const played = el('div', 'played');
  const knob = el('div', 'knob');
  const tip = el('div', 'tip', '0:00');
  track.append(played, knob);
  seek.append(track, tip);

  const row = el('div', 'row');
  const back = el('button', 'b');
  back.title = 'Back ' + cfg.seek + ' s (J)';
  back.appendChild(skIcon('back'));
  const pp = el('button', 'b pp');
  pp.title = 'Play / pause (K)';
  const fwd = el('button', 'b');
  fwd.title = 'Forward ' + cfg.seek + ' s (L)';
  const fwdIcon = skIcon('back');
  fwdIcon.style.transform = 'scaleX(-1)';
  fwd.appendChild(fwdIcon);
  const vol = el('div', 'vol');
  const mute = el('button', 'b');
  mute.title = 'Mute (M)';
  const vs = el('div', 'vs');
  const vr = document.createElement('input');
  vr.type = 'range';
  vr.min = '0';
  vr.max = '1';
  vr.step = '0.02';
  vs.append(vr);
  vol.append(mute, vs);
  const time = el('div', 'time', '0:00 / 0:00');
  const live = el('div', 'live', 'LIVE');
  live.style.display = 'none';
  const sp = el('div', 'sp');
  const speed = el('button', 'b', '1×');
  speed.title = 'Speed';
  const ccBtn = el('button', 'b');
  ccBtn.title = 'Subtitles';
  ccBtn.appendChild(skIcon('cc'));
  const loopBtn = el('button', 'b');
  loopBtn.title = 'Loop';
  loopBtn.appendChild(skIcon('loop'));
  const pipBtn = el('button', 'b');
  pipBtn.title = 'Picture in picture';
  pipBtn.appendChild(skIcon('pip'));
  const fsBtn = el('button', 'b');
  fsBtn.title = 'Fullscreen (F)';
  row.append(back, pp, fwd, vol, time, live, sp, speed, ccBtn, loopBtn, pipBtn, fsBtn);
  bot.append(seek, row);
  const menu = el('div', 'menu');
  sk.append(surface, center, spin, err, toast, top, bot, menu);
  root.append(sk);
  (document.body || document.documentElement).appendChild(host);
  showTop(host);
  Object.assign(skin, { host, sk, surface, center, spin, err, toast, played, knob, tip, time, live, pp, mute, vr, speed, fsBtn, seek, track, menu, ccBtn, loopBtn, pipBtn });

  const v = video;
  const closeMenu = () => {
    menu.classList.remove('open');
    skin.menu = null;
  };
  const showUi = () => {
    skin.lastMove = Date.now();
    sk.classList.remove('hide');
  };
  const pokeCenter = (icon) => {
    center.textContent = '';
    center.appendChild(skIcon(icon));
    center.classList.add('on');
    clearTimeout(skin.cT);
    skin.cT = setTimeout(() => center.classList.remove('on'), 520);
  };
  const say = (t) => {
    toast.textContent = t;
    toast.classList.add('on');
    clearTimeout(skin.tT);
    skin.tT = setTimeout(() => toast.classList.remove('on'), 1300);
  };
  const toggle = () => {
    if (v.paused) {
      v.play().catch(() => {});
      pokeCenter('play');
    } else {
      v.pause();
      pokeCenter('pause');
    }
  };
  const doSeek = (d) => {
    if (seekBy(v, d)) say((d > 0 ? '» ' : '« ') + Math.abs(d) + ' s');
  };
  const setVol = (x) => {
    v.volume = clamp(x, 0, 1);
    if (v.volume > 0) v.muted = false;
    say('Volume ' + Math.round(v.volume * 100) + '%');
  };
  const goFs = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else v.requestFullscreen().catch(() => {});
  };
  const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
  const openMenu = (items, anchor) => {
    if (skin.menu === anchor) return closeMenu();
    menu.textContent = '';
    items.forEach((it) => {
      const b = el('button', 'mi' + (it.on ? ' on' : ''), it.label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        it.run();
        closeMenu();
      });
      menu.appendChild(b);
    });
    menu.classList.add('open');
    skin.menu = anchor;
  };

  pp.addEventListener('click', toggle);
  back.addEventListener('click', () => doSeek(-cfg.seek));
  fwd.addEventListener('click', () => doSeek(cfg.seek));
  mute.addEventListener('click', () => {
    v.muted = !v.muted;
  });
  vr.addEventListener('input', () => setVol(Number(vr.value)));
  fsBtn.addEventListener('click', goFs);
  pipBtn.addEventListener('click', () => {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    else if (v.requestPictureInPicture) v.requestPictureInPicture().catch(() => say('Picture in picture is not available'));
  });
  loopBtn.addEventListener('click', () => {
    v.loop = !v.loop;
    loopBtn.classList.toggle('on', v.loop);
    say(v.loop ? 'Loop on' : 'Loop off');
  });
  speed.addEventListener('click', () => openMenu(rates.map((r) => ({ label: r + '×', on: v.playbackRate === r, run: () => (v.playbackRate = r) })), speed));
  ccBtn.addEventListener('click', () => {
    const tracks = Array.from(v.textTracks || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    if (!tracks.length) return say('No subtitles in this video');
    openMenu(
      [{ label: 'Off', on: tracks.every((t) => t.mode !== 'showing'), run: () => tracks.forEach((t) => (t.mode = 'disabled')) }].concat(
        tracks.map((t) => ({ label: t.label || t.language || 'Track', on: t.mode === 'showing', run: () => tracks.forEach((x) => (x.mode = x === t ? 'showing' : 'disabled')) }))
      ),
      ccBtn
    );
  });
  live.addEventListener('click', () => {
    if (v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1) - 0.5;
  });
  closeBtn.addEventListener('click', () => removeSkin(v));
  dlBtn.addEventListener('click', () => {
    post({ t: 'act', op: 'fab-download', dom: (recs.get(v) || {}).id || '' });
    say('Starting download…');
  });

  // click / double-click on the picture
  let clickT = 0;
  let lp = null;
  surface.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    closeMenu();
    if (Date.now() < skin.noClickUntil) return;
    clearTimeout(clickT);
    clickT = setTimeout(toggle, 230);
  });
  surface.addEventListener('dblclick', (e) => {
    if (!e.isTrusted) return;
    clearTimeout(clickT);
    const b = surface.getBoundingClientRect();
    const rel = (e.clientX - b.left) / b.width;
    if (rel < 0.33) doSeek(-cfg.seek);
    else if (rel > 0.67) doSeek(cfg.seek);
    else goFs();
  });
  surface.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted || e.button > 0) return;
    lp = setTimeout(() => {
      if (v.paused || v.duration === Infinity) return;
      skin.lpRate = v.playbackRate;
      v.playbackRate = 2;
      skin.noClickUntil = Date.now() + 900;
      say('2×');
    }, 500);
  });
  const endLp = () => {
    clearTimeout(lp);
    if (skin.lpRate) {
      v.playbackRate = skin.lpRate;
      skin.lpRate = 0;
      skin.noClickUntil = Date.now() + 350;
    }
  };
  surface.addEventListener('pointerup', endLp);
  surface.addEventListener('pointerleave', endLp);
  surface.addEventListener(
    'wheel',
    (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      if (e.shiftKey) doSeek(e.deltaY < 0 ? -5 : 5);
      else setVol(v.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    },
    { passive: false }
  );
  sk.addEventListener('pointermove', showUi);
  sk.addEventListener('pointerdown', showUi);

  // the seek bar
  const timeAt = (clientX) => {
    const b = track.getBoundingClientRect();
    const f = clamp((clientX - b.left) / Math.max(1, b.width), 0, 1);
    const end = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : v.duration;
    const start = v.seekable.length && v.duration === Infinity ? v.seekable.start(0) : 0;
    return { f, t: start + f * ((Number.isFinite(end) ? end : 0) - start) };
  };
  seek.addEventListener('pointermove', (e) => {
    const { f, t } = timeAt(e.clientX);
    tip.style.left = f * 100 + '%';
    tip.textContent = fmtDur(t);
    if (skin.dragging) {
      played.style.width = f * 100 + '%';
      skin.dragTime = t;
    }
  });
  seek.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    seek.setPointerCapture(e.pointerId);
    skin.dragging = true;
    seek.classList.add('drag');
    const { t } = timeAt(e.clientX);
    skin.dragTime = t;
  });
  const endDrag = () => {
    if (!skin.dragging) return;
    skin.dragging = false;
    seek.classList.remove('drag');
    if (Number.isFinite(skin.dragTime)) {
      const r = recs.get(v);
      if (r) {
        r.seekAt = performance.now();
        r.selfSeekAt = Date.now();
      }
      v.currentTime = seekClamp(v, skin.dragTime);
    }
  };
  seek.addEventListener('pointerup', endDrag);
  seek.addEventListener('pointercancel', endDrag);

  // state -> UI
  const sync = () => {
    if (skin.gone) return;
    // follow the video's box
    const b = v.getBoundingClientRect();
    const st = sk.style;
    st.left = b.left + 'px';
    st.top = b.top + 'px';
    st.width = b.width + 'px';
    st.height = b.height + 'px';
    sk.style.display = b.width < 40 || b.height < 40 || !v.isConnected ? 'none' : '';
    if (!v.isConnected) return removeSkin(v);
    const d = v.duration;
    const finite = Number.isFinite(d);
    const seekable = v.seekable.length ? v.seekable : null;
    const start = seekable && !finite ? seekable.start(0) : 0;
    const end = seekable ? seekable.end(seekable.length - 1) : finite ? d : 0;
    const span = Math.max(0.001, end - start);
    if (!skin.dragging) played.style.width = clamp(((v.currentTime - start) / span) * 100, 0, 100) + '%';
    knob.style.left = played.style.width;
    // buffered ranges
    const bufs = track.querySelectorAll('.buf');
    let n = 0;
    for (let i = 0; i < v.buffered.length && n < 6; i++, n++) {
      let node = bufs[n];
      if (!node) {
        node = el('div', 'buf');
        track.insertBefore(node, played);
      }
      node.style.left = clamp(((v.buffered.start(i) - start) / span) * 100, 0, 100) + '%';
      node.style.width = clamp(((v.buffered.end(i) - v.buffered.start(i)) / span) * 100, 0, 100) + '%';
    }
    for (let i = n; i < bufs.length; i++) bufs[i].remove();
    const isLive = d === Infinity;
    live.style.display = isLive ? '' : 'none';
    live.classList.toggle('off', isLive && seekable && end - v.currentTime > 6);
    time.textContent = isLive ? fmtDur(v.currentTime - start) : fmtDur(v.currentTime) + ' / ' + (finite ? fmtDur(d) : '--:--');
    skSet(pp, v.paused ? 'play' : 'pause');
    skSet(mute, v.muted || v.volume === 0 ? 'volMute' : v.volume < 0.5 ? 'volLow' : 'volHigh');
    if (document.activeElement !== vr) vr.value = String(v.muted ? 0 : v.volume);
    speed.textContent = (v.playbackRate === 1 ? '1' : String(v.playbackRate)) + '×';
    skSet(fsBtn, document.fullscreenElement ? 'fsx' : 'fs');
    spin.classList.toggle('on', !v.paused && v.readyState < 3 && !v.ended);
    if (v.error) {
      err.style.display = 'block';
      err.textContent = 'This video could not be played';
    } else err.style.display = 'none';
    // hide the controls when nothing happens
    if (!v.paused && !skin.dragging && !skin.menu && Date.now() - skin.lastMove > 2600) sk.classList.add('hide');
    else if (v.paused) sk.classList.remove('hide');
    skin.raf = requestAnimationFrame(sync);
  };
  skin.noClickUntil = 0;
  skin.say = say;
  skin.toggle = toggle;
  skin.doSeek = doSeek;
  skin.setVol = setVol;
  skin.goFs = goFs;
  skin.lastMove = Date.now();
  skin.raf = requestAnimationFrame(sync);
  say('Quin Player');
  reportSkins();
  return skin;
}

function removeSkin(video) {
  const skin = skins.get(video);
  if (!skin) return;
  skin.gone = true;
  cancelAnimationFrame(skin.raf);
  clearTimeout(skin.cT);
  clearTimeout(skin.tT);
  skins.delete(video);
  try {
    video.controls = skin.controls;
  } catch (_) {}
  skin.hidden.forEach(({ n, prev, prio }) => {
    try {
      if (prev) n.style.setProperty('visibility', prev, prio);
      else n.style.removeProperty('visibility');
    } catch (_) {}
  });
  try {
    skin.host.remove();
  } catch (_) {}
  reportSkins();
}

/* Tell the app which players wear the skin (tests / the panel). */
function reportSkins() {
  post({ t: 'skins', ids: Array.from(skins.keys()).map((v) => (recs.get(v) || {}).id).filter(Boolean) });
}

/* Keys while a skinned player is in use. */
window.addEventListener(
  'keydown',
  (e) => {
    if (!skins.size || !e.isTrusted || editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    let skin = null;
    skins.forEach((s) => {
      if (!skin || Date.now() - s.lastMove < Date.now() - skin.lastMove || document.fullscreenElement === s.video) skin = s;
    });
    if (!skin || (Date.now() - skin.lastMove > 15000 && document.fullscreenElement !== skin.video)) return;
    const v = skin.video;
    const eat = () => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    switch (e.key) {
      case ' ':
      case 'k':
      case 'K':
        eat();
        skin.toggle();
        break;
      case 'ArrowLeft':
        eat();
        skin.doSeek(e.shiftKey ? -10 : -5);
        break;
      case 'ArrowRight':
        eat();
        skin.doSeek(e.shiftKey ? 10 : 5);
        break;
      case 'j':
      case 'J':
        eat();
        skin.doSeek(-cfg.seek);
        break;
      case 'l':
      case 'L':
        eat();
        skin.doSeek(cfg.seek);
        break;
      case 'ArrowUp':
        eat();
        skin.setVol(v.volume + 0.05);
        break;
      case 'ArrowDown':
        eat();
        skin.setVol(v.volume - 0.05);
        break;
      case 'm':
      case 'M':
        eat();
        v.muted = !v.muted;
        break;
      case 'f':
      case 'F':
        eat();
        skin.goFs();
        break;
      case '<':
      case '>': {
        eat();
        const r = v.playbackRate + (e.key === '>' ? 0.25 : -0.25);
        v.playbackRate = clamp(r, 0.25, 4);
        skin.say(v.playbackRate + '×');
        break;
      }
      case 'Home':
        eat();
        v.currentTime = 0;
        break;
      case 'Escape':
        if (!document.fullscreenElement) {
          eat();
          removeSkin(v);
        }
        break;
      default:
        if (/^[0-9]$/.test(e.key) && Number.isFinite(v.duration)) {
          eat();
          v.currentTime = (v.duration * Number(e.key)) / 10;
        }
    }
  },
  true
);
