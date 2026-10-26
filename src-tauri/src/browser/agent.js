/* Quin Gallery page agent — injected into every frame of the built-in browser.
 *
 * - finds <video>/<audio> (dynamic ones, open shadow roots, iframes) and reports their state;
 * - ranks the players and picks the active one;
 * - adds gestures / shortcuts that drive the site's OWN player (it never replaces it,
 *   never patches fetch/XHR/MSE, never touches keys or licences);
 * - shows the corner popup (top frame) listing what the page offers.
 *
 * Talks to the app with chrome.webview.postMessage; everything the page sends is
 * validated on the Rust side, and the app only ever acts on ids it issued itself.
 */
(() => {
  'use strict';
  if (window.__qg) return;
  const NONCE = '__QG_NONCE__';
  const wv = window.chrome && window.chrome.webview;
  const rawPost = wv && typeof wv.postMessage === 'function' ? wv.postMessage.bind(wv) : null;
  // A real browser has no chrome.webview: keep our own reference to the channel, take it away from the page.
  try {
    if (window.chrome && window.chrome.webview) delete window.chrome.webview;
  } catch (_) {}
  try {
    if (window.chrome && window.chrome.webview) Object.defineProperty(window.chrome, 'webview', { value: undefined, configurable: true });
  } catch (_) {}
  const IS_TOP = window.top === window;
  const FID = Math.random().toString(36).slice(2, 8);
  const cfg = { mode: 'auto', seek: 10, corner: 'br', longPress: true, preload: true, popupKey: 'Alt+M' };
  let gotCfg = false;

  /* Messages go to the app as strings: the app's own message handler runs first and rejects
   * non-strings, which would stop the event from reaching ours. WebView2 only delivers messages
   * from the top document, so iframes hand theirs up to their parent, which passes them on. */
  const post = (o) => {
    try {
      o.doc = DOC;
      const m = JSON.stringify(o);
      if (IS_TOP) {
        if (rawPost) rawPost(m);
      } else parent.postMessage({ qg: NONCE, k: 'up', m }, '*');
    } catch (_) {}
  };
  // Which document of the tab a message belongs to (the top frame's id): the app drops what an old page still says.
  let DOC = IS_TOP ? FID : '';
  const T0 = Date.now();
  const on = () => cfg.mode !== 'off';
  // wait (briefly) for the app's settings before reporting anything, so "off" really is silent
  const active = () => on() && (gotCfg || Date.now() - T0 > 1500);
  const gesturesOn = () => cfg.mode === 'auto' || cfg.mode === 'gestures';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const isMedia = (n) => typeof HTMLMediaElement !== 'undefined' && n instanceof HTMLMediaElement;

  /* ------------------------------------------------------------ media tracking */
  const recs = new Map(); // element -> record
  const roots = new WeakSet();
  const dirty = new Set();
  let seq = 0;
  let flushT = 0;
  let lastPointer = { x: -1, y: -1, t: 0 };
  const EVENTS = ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'waiting', 'stalled', 'seeking', 'seeked', 'durationchange', 'ratechange', 'volumechange', 'emptied', 'ended', 'error', 'encrypted', 'resize', 'progress'];

  function track(el) {
    let r = recs.get(el);
    if (r) return r;
    r = { el, id: 'f' + FID + '-' + ++seq, thumb: null, thumbTries: 0, thumbAt: 0, thumbSent: false, encrypted: false, keySystem: '', rebuffers: 0, seekMs: null, seekAt: 0, siteSeeks: 0, selfSeekAt: 0, lastPlay: 0, preloaded: false, lp: null };
    recs.set(el, r);
    markDirty(r);
    return r;
  }

  function markDirty(r) {
    dirty.add(r);
    if (!flushT) flushT = setTimeout(flush, 350);
  }

  function attachRoot(root) {
    if (roots.has(root)) return;
    roots.add(root);
    // media events do not bubble (or cross shadow boundaries): capture on every root
    for (const ev of EVENTS) root.addEventListener(ev, onMediaEvent, true);
  }

  function onMediaEvent(e) {
    const el = e.target;
    if (!isMedia(el)) return;
    const r = track(el);
    switch (e.type) {
      case 'encrypted':
        r.encrypted = true;
        r.keySystem = keySystemOf(e) || r.keySystem;
        break;
      case 'waiting':
        if (!el.paused) r.rebuffers++;
        break;
      case 'seeking':
        // seeks the site made itself (ours happen right after we set currentTime)
        if (Date.now() - r.selfSeekAt > 400) r.siteSeeks++;
        break;
      case 'seeked':
        if (r.seekAt) {
          r.seekMs = Math.round(performance.now() - r.seekAt);
          r.seekAt = 0;
        }
        break;
      case 'playing':
        r.lastPlay = Date.now();
        maybePreload(r);
        break;
      case 'loadedmetadata':
      case 'loadeddata':
      case 'canplay':
        r.thumbTries = Math.min(r.thumbTries, 3);
        break;
    }
    if (e.type !== 'progress' || dirty.size < 20) markDirty(r);
  }

  /* PSSH system ids in the init data: name the DRM system, never read the payload. */
  function keySystemOf(e) {
    try {
      if (!e.initData) return '';
      const u = new Uint8Array(e.initData);
      const hex = (a, b) => Array.from(u.slice(a, b)).map((x) => x.toString(16).padStart(2, '0')).join('');
      const known = { edef8ba979d64acea3c827dcd51d21ed: 'Widevine', '9a04f07998404286ab92e65be0885f95': 'PlayReady', '94ce86fb07ff4f43adb893d2fa968ca2': 'FairPlay', '1077efecc0b24d02ace33c1e52e2fb4b': 'ClearKey' };
      for (let i = 0; i + 28 <= u.length; i++) {
        if (u[i + 4] === 0x70 && u[i + 5] === 0x73 && u[i + 6] === 0x73 && u[i + 7] === 0x68) {
          const name = known[hex(i + 12, i + 28)];
          if (name) return name;
        }
      }
    } catch (_) {}
    return '';
  }

  function collect(root, out, budget) {
    try {
      root.querySelectorAll('video,audio').forEach((el) => out.add(el));
      const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let n = 0;
      let node;
      while ((node = w.nextNode()) && n++ < budget) {
        if (node.shadowRoot) {
          attachRoot(node.shadowRoot);
          collect(node.shadowRoot, out, budget);
        }
      }
    } catch (_) {}
  }

  function scan() {
    if (!active()) return;
    const found = new Set();
    collect(document, found, 30000);
    found.forEach((el) => track(el));
    const gone = [];
    recs.forEach((r, el) => {
      if (!el.isConnected) {
        recs.delete(el);
        dirty.delete(r);
        gone.push(r.id);
      }
    });
    if (gone.length) post({ t: 'gone', ids: gone });
  }

  let scanT = 0;
  function scheduleScan(ms) {
    if (scanT) return;
    scanT = setTimeout(() => {
      scanT = 0;
      scan();
    }, ms || 500);
  }

  function ranges(tr, max) {
    const out = [];
    for (let i = 0; i < tr.length && i < max; i++) out.push([tr.start(i), tr.end(i)]);
    return out;
  }

  function bufferInfo(el) {
    const t = el.currentTime;
    let ahead = 0;
    for (let i = 0; i < el.buffered.length; i++) {
      if (t >= el.buffered.start(i) - 0.05 && t <= el.buffered.end(i)) {
        ahead = el.buffered.end(i) - t;
        break;
      }
    }
    const state = ahead < 2 ? 'critical' : ahead < 8 ? 'low' : ahead < 30 ? 'healthy' : 'full';
    return { ahead, state };
  }

  function visibleRatio(el, rect) {
    if (rect.width < 1 || rect.height < 1) return 0;
    const w = window.innerWidth || document.documentElement.clientWidth;
    const h = window.innerHeight || document.documentElement.clientHeight;
    const ix = Math.max(0, Math.min(rect.right, w) - Math.max(rect.left, 0));
    const iy = Math.max(0, Math.min(rect.bottom, h) - Math.max(rect.top, 0));
    let v = (ix * iy) / (rect.width * rect.height);
    try {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) v = 0;
    } catch (_) {}
    return v;
  }

  /* Active-player score (see the spec: playing, visible, big, audible, fullscreen, PiP, just touched...). */
  function score(r, rect, vis, biggest) {
    const el = r.el;
    let s = 0;
    const playing = !el.paused && !el.ended && el.readyState >= 2;
    if (playing) s += 40;
    if (vis > 0.75) s += 25;
    else if (vis > 0.25) s += 10;
    if (biggest) s += 25;
    if (!el.muted && el.volume > 0 && !el.paused) s += 15;
    if (document.fullscreenElement && (document.fullscreenElement === el || document.fullscreenElement.contains(el))) s += 15;
    if (document.pictureInPictureElement === el) s += 15;
    if (Date.now() - lastPointer.t < 5000 && lastPointer.x >= rect.left && lastPointer.x <= rect.right && lastPointer.y >= rect.top && lastPointer.y <= rect.bottom) s += 10;
    if (el.readyState >= 3) s += 10;
    if (vis === 0) s -= 40;
    if (el.tagName === 'VIDEO' && rect.width * rect.height < 100 * 56) s -= 35;
    if (el.muted && el.loop && el.autoplay) s -= 25;
    if (el.paused && r.lastPlay && Date.now() - r.lastPlay > 30000) s -= 30;
    return s;
  }

  function label(el) {
    const t = el.getAttribute('title') || el.getAttribute('aria-label') || (el.closest && (el.closest('[title]') || {}).title) || '';
    return String(t).slice(0, 200);
  }

  function snapAll() {
    let biggest = null;
    let bestArea = 0;
    const rects = new Map();
    recs.forEach((r) => {
      const rect = r.el.getBoundingClientRect();
      rects.set(r, rect);
      const a = rect.width * rect.height;
      if (r.el.tagName === 'VIDEO' && a > bestArea) {
        bestArea = a;
        biggest = r;
      }
    });
    const out = new Map();
    recs.forEach((r) => {
      const el = r.el;
      const rect = rects.get(r);
      const vis = visibleRatio(el, rect);
      const d = el.duration;
      const b = bufferInfo(el);
      const seekable = ranges(el.seekable, 4);
      const so = el.srcObject;
      const fs = document.fullscreenElement;
      r.vis = vis;
      r.score = score(r, rect, vis, r === biggest);
      out.set(r, {
        id: r.id,
        frameUrl: location.href.slice(0, 2048),
        tag: el.tagName.toLowerCase(),
        currentSrc: (el.currentSrc || el.getAttribute('src') || '').slice(0, 4096),
        srcObject: so ? (so.constructor && so.constructor.name) || 'Object' : '',
        duration: Number.isFinite(d) ? d : null,
        live: d === Infinity,
        currentTime: el.currentTime || 0,
        paused: el.paused,
        muted: el.muted,
        volume: el.volume,
        rate: el.playbackRate,
        readyState: el.readyState,
        bufferedAhead: b.ahead,
        bufferState: b.state,
        seekStart: seekable.length ? seekable[0][0] : null,
        seekEnd: seekable.length ? seekable[seekable.length - 1][1] : null,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        rectW: Math.round(rect.width),
        rectH: Math.round(rect.height),
        visible: Math.round(vis * 100) / 100,
        fullscreen: !!(fs && (fs === el || fs.contains(el))),
        pip: document.pictureInPictureElement === el,
        encrypted: r.encrypted || !!el.mediaKeys,
        keySystem: r.keySystem,
        score: r.score,
        title: label(el),
        rebuffers: r.rebuffers,
        seekMs: r.seekMs,
        thumb: r.thumb && !r.thumbSent ? r.thumb : null,
      });
    });
    return out;
  }

  function flush() {
    flushT = 0;
    if (!on() || !dirty.size) return;
    if (!active()) {
      flushT = setTimeout(flush, 300);
      return;
    }
    const snaps = snapAll();
    const batch = [];
    dirty.forEach((r) => {
      const s = snaps.get(r);
      if (s) {
        batch.push(s);
        if (s.thumb) r.thumbSent = true;
      }
    });
    dirty.clear();
    if (batch.length) post({ t: 'media', items: batch.slice(0, 40) });
  }

  /* One small still per player so the popup has thumbnails. A cross-origin video
   * without CORS taints the canvas: then the app grabs its own frame with FFmpeg instead. */
  function maybeThumb(r) {
    const el = r.el;
    if (r.thumb && Date.now() - r.thumbAt < 60000) return;
    if (el.tagName !== 'VIDEO' || el.readyState < 2 || !el.videoWidth || r.thumbTries >= 6 || r.encrypted) return;
    if (Date.now() - r.thumbAt < 4000) return;
    r.thumbAt = Date.now();
    r.thumbTries++;
    try {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = Math.max(1, Math.round((160 * el.videoHeight) / el.videoWidth));
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(el, 0, 0, c.width, c.height);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
      if (sum / (px.length / 64) / 3 < 6) return; // still black: try again later
      const url = c.toDataURL('image/jpeg', 0.6);
      r.thumb = url.slice(url.indexOf(',') + 1);
      r.thumbSent = false;
      markDirty(r);
    } catch (_) {
      r.thumbTries = 99; // tainted: do not keep trying
    }
  }

  /* Direct files only: let the browser fetch ahead for the player people are actually watching.
   * Never load() (that would reset the site's player), never touch streams or off-screen videos. */
  function maybePreload(r) {
    const el = r.el;
    if (!cfg.preload || r.preloaded || el.tagName !== 'VIDEO') return;
    const src = el.currentSrc || '';
    if (!/^https?:/i.test(src) || el.duration === Infinity || r.encrypted) return;
    if (r.vis < 0.25 || (navigator.connection && navigator.connection.saveData)) return;
    r.preloaded = true;
    if (el.preload !== 'auto') {
      try {
        el.preload = 'auto';
      } catch (_) {}
    }
  }

  function tick() {
    if (!active() || document.hidden) return;
    let any = false;
    recs.forEach((r) => {
      const wantsThumb = !r.thumb && r.thumbTries < 6 && r.el.tagName === 'VIDEO';
      if (!r.el.paused || wantsThumb || r.vis == null) {
        markDirty(r);
        any = true;
      }
      maybeThumb(r);
    });
    if (!any && dirty.size) flush();
  }

  function best(pred) {
    let top = null;
    recs.forEach((r) => {
      if (pred && !pred(r)) return;
      if (r.score == null) r.score = 0;
      if (!top || r.score > top.score) top = r;
    });
    return top;
  }
  function refreshScores() {
    snapAll();
  }

  /* ------------------------------------------------------------------ commands */
  function seekBy(el, delta) {
    const r = recs.get(el);
    const sk = el.seekable;
    if (!sk || !sk.length) return false;
    const target = seekClamp(el, el.currentTime + delta);
    if (r) {
      r.seekAt = performance.now();
      r.selfSeekAt = Date.now();
    }
    el.currentTime = target;
    return true;
  }
  function seekClamp(el, target) {
    const sk = el.seekable;
    if (!sk.length) return el.currentTime;
    for (let i = 0; i < sk.length; i++) if (target >= sk.start(i) && target <= sk.end(i)) return target;
    return clamp(target, sk.start(0), sk.end(sk.length - 1));
  }

  function runCmd(op, val, targetId) {
    let r = null;
    if (targetId) recs.forEach((x) => x.id === targetId && (r = x));
    else {
      refreshScores();
      r = best();
    }
    if (!r) return false;
    const el = r.el;
    switch (op) {
      case 'playPause':
        if (el.paused) el.play().catch(() => {});
        else el.pause();
        flash(el, el.paused ? '▶' : '❚❚', 0);
        return true;
      case 'seekBy': {
        const d = Number(val) || 0;
        if (!seekBy(el, d)) return true;
        flash(el, (d > 0 ? '» ' : '« ') + Math.abs(d) + ' s', d > 0 ? 1 : -1);
        return true;
      }
      case 'seekTo':
        if (el.seekable.length) {
          r.seekAt = performance.now();
          el.currentTime = seekClamp(el, Number(val) || 0);
        }
        return true;
      case 'setRate':
        el.playbackRate = clamp(Number(val) || 1, 0.25, 4);
        flash(el, el.playbackRate.toFixed(2).replace(/\.?0+$/, '') + '×', 0);
        return true;
      case 'setVolume':
        el.volume = clamp(Number(val), 0, 1);
        if (el.volume > 0) el.muted = false;
        flash(el, '🔊 ' + Math.round(el.volume * 100) + '%', 0);
        return true;
      case 'toggleMute':
        el.muted = !el.muted;
        flash(el, el.muted ? '🔇' : '🔊', 0);
        return true;
      case 'toggleFullscreen':
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else (el.parentElement || el).requestFullscreen().catch(() => {});
        return true;
      case 'togglePip':
        if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
        else if (el.requestPictureInPicture) el.requestPictureInPicture().catch(() => {});
        return true;
      case 'goLive':
        if (el.seekable.length) el.currentTime = el.seekable.end(el.seekable.length - 1) - 1;
        return true;
    }
    return false;
  }

  function cmd(op, val, targetId) {
    if (!on()) return;
    if (runCmd(op, val, targetId)) return;
    // not one of ours: pass it down to the iframes (with a target), or ask the app which player is active
    if (targetId) relay({ qg: NONCE, k: 'cmd', op, val, target: targetId });
    else if (IS_TOP) post({ t: 'cmd', op, val });
  }

  function relay(msg) {
    for (let i = 0; i < window.frames.length; i++) {
      try {
        window.frames[i].postMessage(msg, '*');
      } catch (_) {}
    }
  }

  /* -------------------------------------------------------------------- feedback */
  const css = (text) => {
    const s = new CSSStyleSheet();
    s.replaceSync(text);
    return s;
  };
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  function topLayerHost(id) {
    const h = document.createElement('div');
    h.setAttribute('popover', 'manual');
    h.setAttribute('data-qg', id);
    h.style.cssText = 'all:initial;position:fixed;inset:auto;margin:0;padding:0;border:0;background:transparent;overflow:visible;width:0;height:0;pointer-events:none;';
    return h;
  }
  function showTop(h) {
    try {
      h.hidePopover();
    } catch (_) {}
    try {
      h.showPopover();
    } catch (_) {}
  }

  const fx = { host: null, box: null, timer: 0 };
  function ensureFx() {
    if (fx.host) return;
    fx.host = topLayerHost('fx');
    const root = fx.host.attachShadow({ mode: 'closed' });
    root.adoptedStyleSheets = [
      css(`.b{position:fixed;transform:translate(-50%,-50%);background:rgba(15,15,20,.72);color:#fff;font:600 22px/1 'Segoe UI',system-ui,sans-serif;padding:12px 20px;border-radius:999px;backdrop-filter:blur(8px);box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transition:opacity .18s;white-space:nowrap}.b.on{opacity:1}`),
    ];
    fx.box = el('div', 'b');
    root.append(fx.box);
    (document.body || document.documentElement).appendChild(fx.host);
  }
  function flash(media, text, side) {
    if (!on()) return;
    try {
      ensureFx();
      const b = media.getBoundingClientRect();
      const x = b.left + b.width * (side < 0 ? 0.25 : side > 0 ? 0.75 : 0.5);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      fx.box.style.left = clamp(x, 60, vw - 60) + 'px';
      fx.box.style.top = clamp(b.top + b.height * 0.5, 40, vh - 40) + 'px';
      fx.box.textContent = text;
      showTop(fx.host);
      fx.box.classList.add('on');
      clearTimeout(fx.timer);
      fx.timer = setTimeout(() => {
        fx.box.classList.remove('on');
        setTimeout(() => {
          try {
            fx.host.hidePopover();
          } catch (_) {}
        }, 220);
      }, 700);
    } catch (_) {}
  }

  /* -------------------------------------------------------------------- gestures */
  const editable = (t) => {
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
  };
  const interactive = (path) => {
    for (const n of path) {
      if (!n || !n.tagName) continue;
      const tag = n.tagName;
      if (tag === 'VIDEO' || tag === 'AUDIO') return false;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
      const role = n.getAttribute && n.getAttribute('role');
      if (role === 'button' || role === 'slider' || role === 'menuitem' || role === 'link') return true;
    }
    return false;
  };
  function areaOf(e) {
    const b = e.getBoundingClientRect();
    return b.width * b.height;
  }
  /* The player under a mouse/touch event: the video in the event path, else a big video
   * whose box contains the point and whose player container is what was actually hit. */
  function mediaAtEvent(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const n of path) if (isMedia(n) && n.tagName === 'VIDEO' && recs.has(n)) return n;
    let pick = null;
    recs.forEach((r) => {
      const v = r.el;
      if (v.tagName !== 'VIDEO') return;
      const b = v.getBoundingClientRect();
      if (b.width < 200 || b.height < 110) return;
      if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) return;
      let hit = false;
      const va = b.width * b.height;
      for (const n of path) {
        if (n && n.contains && n.nodeType === 1 && n.contains(v) && areaOf(n) <= va * 3) {
          hit = true;
          break;
        }
      }
      if (hit && (!pick || (r.score || 0) > (recs.get(pick).score || 0))) pick = v;
    });
    return pick;
  }

  const acc = { side: 0, n: 0, t: 0 };
  function gestureSeek(media, side) {
    const now = Date.now();
    if (acc.side === side && now - acc.t < 700) acc.n++;
    else {
      acc.side = side;
      acc.n = 1;
    }
    acc.t = now;
    if (!seekBy(media, side * cfg.seek)) return;
    flash(media, (side > 0 ? '» ' : '« ') + acc.n * cfg.seek + ' s', side);
  }

  window.addEventListener(
    'dblclick',
    (e) => {
      if (!on() || !gesturesOn() || !e.isTrusted || e.button !== 0) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (interactive(path)) return;
      const m = mediaAtEvent(e);
      if (!m) return;
      const b = m.getBoundingClientRect();
      const rel = (e.clientX - b.left) / b.width;
      const side = rel < 0.35 ? -1 : rel > 0.65 ? 1 : 0;
      if (!side) return; // the middle keeps the site's own double-click (usually fullscreen)
      const r = recs.get(m);
      if (cfg.mode === 'gestures') {
        e.preventDefault();
        e.stopImmediatePropagation();
        gestureSeek(m, side);
      } else {
        // auto: only act when the site did not already seek by itself
        const before = r ? r.siteSeeks : 0;
        setTimeout(() => {
          if (r && r.siteSeeks === before) gestureSeek(m, side);
        }, 140);
      }
    },
    true
  );

  window.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY, t: Date.now() };
      if (!on() || !gesturesOn() || !e.isTrusted || e.button > 0) return;
      const touch = e.pointerType !== 'mouse';
      if (!touch && cfg.mode !== 'gestures') return;
      const m = mediaAtEvent(e);
      if (!m || interactive(e.composedPath ? e.composedPath() : [])) return;
      const r = recs.get(m);
      const b = m.getBoundingClientRect();
      r.g = { x: e.clientX, y: e.clientY, t0: m.currentTime, moved: false, mode: null, half: e.clientX < b.left + b.width / 2 ? 'l' : 'r', vol0: m.volume, w: b.width, h: b.height, id: e.pointerId, touch };
      clearTimeout(r.lpT);
      if (cfg.longPress && !m.paused && m.duration !== Infinity) {
        r.lpT = setTimeout(() => {
          if (!r.g || r.g.moved) return;
          r.lp = { rate: m.playbackRate };
          m.playbackRate = 2;
          flash(m, '2×', 0);
        }, 500);
      }
    },
    true
  );
  window.addEventListener(
    'pointermove',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY, t: Date.now() };
      recs.forEach((r) => {
        const g = r.g;
        if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x;
        const dy = e.clientY - g.y;
        if (!g.moved && Math.hypot(dx, dy) < 10) return;
        g.moved = true;
        clearTimeout(r.lpT);
        if (!g.touch) return;
        if (!g.mode) g.mode = Math.abs(dx) > Math.abs(dy) * 1.4 ? 'scrub' : Math.abs(dy) > Math.abs(dx) * 1.4 ? 'vol' : null;
        const m = r.el;
        if (g.mode === 'scrub' && m.seekable.length) {
          const dur = Number.isFinite(m.duration) ? m.duration : 600;
          const scale = dur < 300 ? 30 : dur < 1800 ? 120 : dur < 7200 ? 600 : 1800;
          g.target = seekClamp(m, g.t0 + (dx / g.w) * scale);
          const d = Math.round(g.target - g.t0);
          flash(m, (d >= 0 ? '+' : '−') + Math.abs(d) + ' s  →  ' + fmtDur(g.target), 0);
        } else if (g.mode === 'vol' && g.half === 'r') {
          m.volume = clamp(g.vol0 - dy / g.h, 0, 1);
          flash(m, '🔊 ' + Math.round(m.volume * 100) + '%', 0);
        }
      });
    },
    true
  );
  const endGesture = (e) => {
    recs.forEach((r) => {
      const g = r.g;
      if (!g || g.id !== e.pointerId) return;
      clearTimeout(r.lpT);
      if (r.lp) {
        r.el.playbackRate = r.lp.rate;
        r.lp = null;
        suppressClickUntil = Date.now() + 350;
      }
      if (g.mode === 'scrub' && g.target != null) {
        r.seekAt = performance.now();
        r.el.currentTime = g.target;
        suppressClickUntil = Date.now() + 350;
      }
      r.g = null;
    });
  };
  let suppressClickUntil = 0;
  window.addEventListener('pointerup', endGesture, true);
  window.addEventListener('pointercancel', endGesture, true);
  window.addEventListener(
    'click',
    (e) => {
      if (Date.now() < suppressClickUntil) {
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }
      // "always" mode: the 2nd click of a double-click on a side zone belongs to us, not to the player's own fullscreen toggle
      if (on() && cfg.mode === 'gestures' && e.isTrusted && e.detail === 2 && !interactive(e.composedPath ? e.composedPath() : [])) {
        const m = mediaAtEvent(e);
        if (!m) return;
        const b = m.getBoundingClientRect();
        const rel = (e.clientX - b.left) / b.width;
        if (rel < 0.35 || rel > 0.65) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }
    },
    true
  );
  /* A touch that starts on a player and moves sideways must be claimed on its very first move,
   * before the browser decides to scroll the page (then it would cancel the pointer stream). */
  window.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches && e.touches[0];
      if (!t) return;
      let claimed = false;
      recs.forEach((r) => {
        const g = r.g;
        if (!g || !g.touch) return;
        if (!g.mode) {
          const dx = t.clientX - g.x;
          const dy = t.clientY - g.y;
          if (Math.abs(dx) > 4 && Math.abs(dx) > Math.abs(dy) * 1.2) g.mode = 'scrub';
          else if (g.half === 'r' && Math.abs(dy) > 4 && Math.abs(dy) > Math.abs(dx) * 1.2) g.mode = 'vol';
        }
        if (g.mode) claimed = true;
      });
      if (claimed && e.cancelable) e.preventDefault();
    },
    { capture: true, passive: false }
  );

  window.addEventListener(
    'wheel',
    (e) => {
      if (!on() || !gesturesOn() || !e.isTrusted || !(e.altKey || e.shiftKey) || e.ctrlKey) return;
      const m = mediaAtEvent(e);
      if (!m) return;
      e.preventDefault();
      const up = e.deltaY < 0 || e.deltaX < 0;
      if (e.altKey) {
        m.volume = clamp(m.volume + (up ? 0.05 : -0.05), 0, 1);
        if (m.volume > 0) m.muted = false;
        flash(m, '🔊 ' + Math.round(m.volume * 100) + '%', 0);
      } else if (seekBy(m, up ? -5 : 5)) {
        flash(m, (up ? '« ' : '» ') + '5 s', up ? -1 : 1);
      }
    },
    { capture: true, passive: false }
  );

  function fmtDur(s) {
    if (s == null || !Number.isFinite(s)) return '';
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  }
  function fmtSize(b) {
    if (!b) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < 3) {
      b /= 1024;
      i++;
    }
    return (i ? b.toFixed(b >= 100 ? 0 : 1) : b) + ' ' + u[i];
  }

  /* -------------------------------------------------------------------- shortcuts */
  function matchKey(e, spec) {
    const parts = String(spec || '').split('+');
    const key = parts.pop().toLowerCase();
    const want = { alt: parts.includes('Alt'), ctrl: parts.includes('Ctrl'), shift: parts.includes('Shift') };
    return e.key.toLowerCase() === key && e.altKey === want.alt && e.ctrlKey === want.ctrl && e.shiftKey === want.shift && !e.metaKey;
  }
  function inPlayerScope(e, m) {
    const t = e.target;
    if (!t || t === document.body || t === document.documentElement || t === m) return true;
    let p = m.parentElement;
    const va = areaOf(m);
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
      if (areaOf(p) > va * 4) break;
      if (p.contains(t)) return true;
    }
    return false;
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (!on() || !e.isTrusted) return;
      if (matchKey(e, cfg.popupKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        togglePopup();
        return;
      }
      if (popup.open && popupKey(e)) return;
    },
    true
  );

  window.addEventListener(
    'keydown',
    (e) => {
      if (!on() || !gesturesOn() || !e.isTrusted || e.defaultPrevented || editable(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key;
      if (!/^(j|l|k|m|ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/i.test(key)) return;
      refreshScores();
      const r = best((x) => x.el.tagName === 'VIDEO' && (x.vis || 0) > 0.4 && (!x.el.paused || x.el.currentTime > 0));
      if (!r) return;
      const m = r.el;
      if (!inPlayerScope(e, m)) return;
      const big = e.shiftKey ? 10 : 5;
      switch (key.toLowerCase()) {
        case 'j':
          e.preventDefault();
          runCmd('seekBy', -cfg.seek, r.id);
          break;
        case 'l':
          e.preventDefault();
          runCmd('seekBy', cfg.seek, r.id);
          break;
        case 'k':
          e.preventDefault();
          runCmd('playPause', 0, r.id);
          break;
        case 'm':
          e.preventDefault();
          runCmd('toggleMute', 0, r.id);
          break;
        case 'arrowleft':
          e.preventDefault();
          runCmd('seekBy', -big, r.id);
          break;
        case 'arrowright':
          e.preventDefault();
          runCmd('seekBy', big, r.id);
          break;
        case 'arrowup':
        case 'arrowdown':
          // scrolling stays scrolling, unless the video is fullscreen or focused itself
          if (document.fullscreenElement || e.target === m) {
            e.preventDefault();
            runCmd('setVolume', clamp(m.volume + (key === 'ArrowUp' ? 0.05 : -0.05), 0, 1), r.id);
          }
          break;
      }
    },
    false
  );

  /*@@MODULES@@*/

  /* ----------------------------------------------------------- app <-> agent glue */
  function applyCfg(c) {
    if (!c) return;
    for (const k of ['mode', 'seek', 'corner', 'longPress', 'preload', 'popupKey', 'fab', 'badge']) if (c[k] !== undefined) cfg[k] = c[k];
    cfg.seek = clamp(Number(cfg.seek) || 10, 1, 120);
    gotCfg = true;
    if (IS_TOP) {
      if (!on()) {
        if (popup.host) popup.host.remove(), (popup.host = null);
      } else if (popup.host) renderPopup();
    }
    if (!on()) {
      Array.from(skins.keys()).forEach(removeSkin);
      if (typeof hideFab === 'function') hideFab();
    }
    if (on()) scheduleScan(50);
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.qg !== NONCE) return;
    switch (d.k) {
      case 'cfg':
        if (d.doc && !IS_TOP) DOC = String(d.doc).slice(0, 12);
        applyCfg(d.cfg);
        relay({ qg: NONCE, k: 'cfg', cfg: d.cfg, doc: DOC });
        break;
      case 'hi':
        if (gotCfg && e.source) {
          try {
            e.source.postMessage({ qg: NONCE, k: 'cfg', cfg, doc: DOC }, '*');
          } catch (_) {}
        }
        break;
      case 'cmd':
        if (!runCmd(d.op, d.val, d.target)) relay(d);
        break;
      case 'toggle':
        togglePopup();
        break;
      case 'up':
        if (typeof d.m === 'string' && d.m.length < 500000) {
          if (IS_TOP) {
            if (rawPost) rawPost(d.m);
          } else {
            try {
              parent.postMessage(d, '*');
            } catch (_) {}
          }
        }
        break;
    }
  });

  const api = {
    config: (c) => {
      applyCfg(c);
      relay({ qg: NONCE, k: 'cfg', cfg: c, doc: DOC });
    },
    items: (list) => {
      popup.items = Array.isArray(list) ? list : [];
      if (popup.pendingSelect) selectItem(popup.pendingSelect);
      if (IS_TOP && on()) renderPopup();
    },
    thumbs: setThumbs,
    notice: setNotice,
    progress: setProgress,
    select: selectItem,
    find: findText,
    findClear: findClear,
    // what the agent knows about this frame's players (diagnostics)
    debug: () => Array.from(recs.values()).map((r) => ({ id: r.id, thumb: r.thumb ? r.thumb.length : 0, tries: r.thumbTries, sent: r.thumbSent, score: r.score, vis: r.vis, rs: r.el.readyState })),
    // UI state for diagnostics and tests (nothing secret: it is what the page's own UI shows)
    state: () => {
      const rect = (n) => {
        if (!n) return null;
        const b = n.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      };
      return {
        popup: {
          open: popup.open,
          group: popup.group,
          sel: popup.sel,
          filter: popup.filter,
          rows: Array.from(popup.rows.keys()),
          dl: Array.from(popup.dl.entries()).map(([k, v]) => ({ id: k, status: v.status, percent: v.percent, task: v.task, file: v.file, verified: v.verified })),
          quality: Array.from(popup.quality.entries()),
          names: Array.from(popup.names.entries()),
          notice: popup.notice,
          badge: rect(popup.ui && popup.ui.badge),
          panel: rect(popup.ui && popup.ui.panel),
          items: popup.items.map((i) => ({ id: i.id, title: i.title, group: i.group, variants: (i.variants || []).length })),
        },
        skins: Array.from(skins.keys()).map((v) => {
          const k = skins.get(v);
          return { id: (recs.get(v) || {}).id, controls: v.controls, rect: rect(k.sk), seek: rect(k.seek), pp: rect(k.pp), fs: rect(k.fsBtn), speed: rect(k.speed), hidden: k.hidden.length };
        }),
        fab: { visible: !!(fab.box && fab.box.classList.contains('on')), target: fab.target && fab.target.id, rect: rect(fab.box), player: rect(fab.btnP), download: rect(fab.btnD) },
      };
    },
    popup: (op) => setPopup(op === 'toggle' ? !popup.open : op === 'open'),
    cmd,
  };
  Object.defineProperty(window, '__qg', { value: Object.freeze(api), enumerable: false });

  /* ------------------------------------------- page info, browser shortcuts, find, source scan */
  function pageIcon() {
    let best = null;
    document.querySelectorAll('link[rel~="icon"],link[rel="shortcut icon"],link[rel="apple-touch-icon"]').forEach((l) => {
      const href = l.href;
      if (!/^https?:/i.test(href)) return;
      const size = parseInt(String((l.sizes && l.sizes[0]) || '0').split('x')[0], 10) || 0;
      if (!best || size > best.size) best = { href, size };
    });
    return best ? best.href : location.origin + '/favicon.ico';
  }
  let lastPageSig = '';
  function reportPage(force) {
    if (!IS_TOP) return;
    let audible = false;
    recs.forEach((r, v) => {
      if (!v.paused && !v.muted && v.volume > 0 && !v.ended) audible = true;
    });
    const sig = location.href + '|' + document.title + '|' + audible;
    if (!force && sig === lastPageSig) return;
    lastPageSig = sig;
    post({ t: 'page', url: location.href, title: document.title, icon: pageIcon(), audible });
  }

  // The browser's own shortcuts, also when the page has the keyboard.
  const FWD = new Set(['Ctrl+T', 'Ctrl+W', 'Ctrl+Shift+T', 'Ctrl+L', 'Ctrl+F', 'Ctrl+D', 'Ctrl+H', 'Ctrl+J', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9', 'Alt+Home', 'Escape']);
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.metaKey) return;
      const name = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const combo = (e.ctrlKey ? 'Ctrl+' : '') + (e.shiftKey && name.length > 1 || (e.shiftKey && e.ctrlKey) ? 'Shift+' : '') + (e.altKey ? 'Alt+' : '') + name;
      if (!FWD.has(combo)) return;
      if (combo !== 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      post({ t: 'key', k: combo });
    },
    true
  );

  function findText(text, fwd, cs) {
    let count = 0;
    try {
      const body = (document.body && document.body.innerText) || '';
      const hay = cs ? body : body.toLowerCase();
      const needle = cs ? text : String(text).toLowerCase();
      if (needle) {
        let i = 0;
        while ((i = hay.indexOf(needle, i)) !== -1 && count < 100000) {
          count++;
          i += needle.length;
        }
      }
    } catch (_) {}
    let ok = false;
    try {
      ok = window.find(text, !!cs, !fwd, true, false, false, false);
    } catch (_) {}
    post({ t: 'found', ok, count });
  }
  function findClear() {
    try {
      getSelection().removeAllRanges();
    } catch (_) {}
  }

  /* Media the page's own source mentions (<source>, og:video, JSON state, links...): the app checks each
   * with a quick request and only lists what really is playable. */
  const scanSent = new Set();
  let scanCount = 0;
  const MEDIA_EXT = /\.(?:mp4|m3u8|mpd|webm|m4v|mov|mkv|mp3|m4a|aac|flac|ogg|opus)(?:[?#]|$)/i;
  function scanSource() {
    if (!on() || scanCount++ > 14) return;
    const found = new Set();
    const add = (u) => {
      if (!u || typeof u !== 'string') return;
      try {
        const a = new URL(u.trim(), document.baseURI);
        if ((a.protocol === 'http:' || a.protocol === 'https:') && a.href.length <= 2048) found.add(a.href);
      } catch (_) {}
    };
    try {
      document.querySelectorAll('video,audio,source,[data-video-url],[data-video-src],[data-mp4],[data-hls],[data-stream]').forEach((n) => {
        ['src', 'data-src', 'data-video-url', 'data-video-src', 'data-mp4', 'data-hls', 'data-stream'].forEach((a) => {
          const v = n.getAttribute && n.getAttribute(a);
          if (v && (MEDIA_EXT.test(v) || /^(VIDEO|AUDIO|SOURCE)$/.test(n.tagName))) add(v);
        });
      });
      document.querySelectorAll('meta[property="og:video"],meta[property="og:video:url"],meta[property="og:video:secure_url"],meta[property="og:audio"],meta[name="twitter:player:stream"]').forEach((m) => add(m.content));
      let n = 0;
      document.querySelectorAll('a[href]').forEach((a) => {
        if (n < 400 && MEDIA_EXT.test(a.getAttribute('href') || '')) {
          add(a.href);
          n++;
        }
      });
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          const walk = (o, d) => {
            if (!o || typeof o !== 'object' || d > 8) return;
            if (typeof o.contentUrl === 'string') add(o.contentUrl);
            for (const k in o) walk(o[k], d + 1);
          };
          walk(JSON.parse(s.textContent), 0);
        } catch (_) {}
      });
      const html = document.documentElement.innerHTML;
      if (html.length < 6e6) {
        const re = /https?:(?:\\?\/){2}(?:[^\s"'<>\\]|\\\/){4,300}?\.(?:mp4|m3u8|mpd|webm|m4v|mov|mp3|m4a)(?:\?(?:[^\s"'<>\\]|\\\/){0,400})?/gi;
        let m;
        let c = 0;
        while ((m = re.exec(html)) && c++ < 80) add(m[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&'));
      }
    } catch (_) {}
    const fresh = [];
    found.forEach((u) => {
      if (!scanSent.has(u) && fresh.length < 30) {
        scanSent.add(u);
        fresh.push(u);
      }
    });
    if (fresh.length) post({ t: 'scan', urls: fresh });
  }
  let srcScanT = 0;
  function scheduleSourceScan(ms) {
    if (srcScanT) return;
    srcScanT = setTimeout(() => {
      srcScanT = 0;
      scanSource();
    }, ms);
  }

  /* -------------------------------------------------------------------- start-up */
  attachRoot(document);
  const start = () => {
    scan();
    tick();
    reportPage(true);
    scheduleSourceScan(1200);
    setTimeout(() => scheduleSourceScan(1), 4500);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  window.addEventListener(
    'load',
    () => {
      scheduleScan(300);
      reportPage(true);
      scheduleSourceScan(900);
    },
    { once: true }
  );
  setInterval(() => reportPage(false), 1500);
  document.addEventListener('playing', () => scheduleSourceScan(1500), { capture: true, once: true });
  // observe the document itself: at document-start there is no <html> yet
  new MutationObserver(() => {
    scheduleScan(500);
    scheduleSourceScan(3000);
  }).observe(document, { childList: true, subtree: true });
  ['popstate', 'hashchange', 'pageshow'].forEach((ev) =>
    window.addEventListener(ev, () => {
      scheduleScan(400);
      reportPage(true);
    })
  );
  document.addEventListener('fullscreenchange', () => {
    recs.forEach(markDirty);
    if (IS_TOP && popup.host) renderPopup();
  });
  setInterval(tick, 1000);
  setInterval(() => !document.hidden && scheduleScan(10), 5000);

  // ask for the settings until they arrive (the app may still be wiring the page up)
  let asks = 0;
  const ask = () => {
    if (gotCfg || asks++ > 8) return;
    if (IS_TOP) post({ t: 'hello', top: true });
    else {
      try {
        parent.postMessage({ qg: NONCE, k: 'hi' }, '*');
      } catch (_) {}
    }
    setTimeout(ask, 300);
  };
  ask();
})();
