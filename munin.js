/* keep club — the shell in front of the courses.
 *
 * Boot order: this file decides which course is active (localStorage), replays
 * that course's cached loading screen before the first paint, fetches its
 * course.json, injects the theme (accent vars + boot scene), then loads the
 * course's own doodles.js and finally app.js — which reads the COURSE global
 * for its deck, art maps and storage key. With no course picked it renders the
 * shelf instead and app.js never loads.
 *
 * Courses never share theme files: each folder under courses/ is complete in
 * itself. Two files being identical is a coincidence, not a link.
 *
 * Munin's own theme is not a special case — it is the DEFAULT every course
 * falls back into, slot by slot (MUNIN.theme below). A course that brings an
 * accent and no frieze gets its accent and Munin's frieze; a deck someone
 * imported brings none of it and is dressed entirely by Munin.
 *
 * The MUNIN object and munin/... storage names are compatibility identifiers,
 * not the public brand. Existing installs and review histories depend on them.
 */
'use strict';

const MUNIN = {
  lastKey: 'munin/last-course',
  /* Every place that names a storage slot names it here. These templates used
   * to be written out by hand in app.js, store.js and the orphan sweep, which
   * is three chances to change one of them and not the others. */
  stateKey: (id) => 'munin/' + id + '/state/v1',
  resetKey: (id) => 'munin/' + id + '/state/v1/reset',
  /* The cards a person wrote into this deck, and their edits to the deck's
   * own cards. A sibling of the state document rather than a key inside it:
   * mergeState() in sync.js builds a fresh object and copies only the keys it
   * knows, so a key it has never heard of is not skipped but dropped, and the
   * adopted result is then written back over the original. Cards kept in there
   * would be destroyed by a mistake in a file that is not about cards. */
  cardsKey: (id) => 'munin/' + id + '/cards/v1',
  bootKey: (id) => 'munin/boot/' + id,
  registry: 'courses/index.json',

  /* A course id is a folder name and goes straight into a URL, so it is
   * checked as a shape rather than against a list: the resume path must not
   * have to wait for the registry to load before it can boot a course.
   * A string, and not something that merely stringifies into one — `["x"]`
   * used to pass and fetch a course called x. */
  idOk: (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id),

  /* Munin's own theme: the default for every slot a course leaves empty. */
  theme: {
    accent: { light: '#0e3f39', dark: '#35917f', inkLight: '#fffdf7', inkDark: '#141519' },
    boot: { art: 'tower', line: 'Loading…' },
    fallback: 'perch',
    /* Ten of them, named. The frieze is ten drawings and no more — that is
     * what fits a 320px screen without a sideways scrollbar — so it cannot be
     * "whatever MUNIN_DOODLE holds": the set grew to fourteen the day the
     * hoard needed fourteen distinct drawings. The gate keeps this a subset. */
    friezeArt: ['perch', 'peek', 'flap', 'carry', 'roost',
      'hoard', 'puff', 'strut', 'quill', 'bow'],
    /* Where progress lives is said in "how this works" on the picker, and again
     * by Sync's own state line in Settings. This is the deck's caveat. */
    notice: 'Revision material.',
  },
};
globalThis.MUNIN = MUNIN;

const isLocal = (id) => /^local-[a-z0-9]+$/.test(String(id || ''));

/* A partial deploy must fail closed. sync.js normally defines this first; the
 * fallback keeps progress local and makes the unavailable state explicit. */
if (!globalThis.DSSync) {
  globalThis.DSSync = {
    KEY: 'munin/sync-off',
    KEY_CHARS: 25,
    enabled: () => false,
    status: () => ({ on: false, available: false }),
    schedule: () => {},
    sync: async () => {},
    stable: (s) => JSON.stringify(s),
    formatKey: () => '—',
    normaliseKey: () => null,
    init: () => {},
    turnOn: () => null,
    turnOff: () => {},
  };
}

/* The colour theme belongs to Munin, not to a course: the shelf paints before
 * any course is booted, and a preference stored per course would flip as you
 * switched between them. One key, read before the first paint.
 *
 * TWO STATES, and neither of them is the device. "Auto" was a third position in
 * the cycle until 28 July 2026, and it was a question nobody has: once you have
 * chosen light or dark, a control that offers to un-choose is asking you about
 * something you already settled. Following the device replaced it for half a
 * day and went the same way — Munin is drawn on paper, and it opens on paper
 * whatever the phone thinks. DEFAULT IS LIGHT. Dark is a choice, the button is
 * how you make it, and it is remembered.
 *
 * `get()` is what was chosen and may be null. `showing()` is what is on screen
 * and never is, because a colour is always showing. Reaching for get() where
 * showing() belongs is how a null ends up rendered as a theme name. */
const MuninTheme = {
  key: 'munin/theme',
  /** The choice: 'light', 'dark', or null for "never said". */
  get() {
    const t = localStorage.getItem(MuninTheme.key);
    return t === 'light' || t === 'dark' ? t : null;
  },
  /** The colour actually on screen. Never null: an unchosen install is light. */
  showing() {
    return MuninTheme.get() || 'light';
  },
  set(t) {
    localStorage.setItem(MuninTheme.key, t);
    MuninTheme.apply();
  },
  /** The button does one thing: it shows you the other one. */
  cycle() {
    MuninTheme.set(MuninTheme.showing() === 'dark' ? 'light' : 'dark');
  },
  apply() {
    // Always written, even unchosen: app.css has no prefers-color-scheme block
    // to fall through to any more, and the attribute is what a test can read.
    document.documentElement.setAttribute('data-theme', MuninTheme.showing());
    const dark = MuninTheme.showing() === 'dark';
    const meta = document.getElementById('theme-color');
    if (meta) meta.setAttribute('content', dark ? '#141519' : '#f0eee7');
    // Every glyph on the page — the shelf's and the course header's — says the
    // same thing, because they are the same setting. The attribute carries the
    // name as well as the drawing: it is what a test can read, and what tells
    // you which state you are in when the SVG is a wall of path data.
    const name = dark ? 'night' : 'day';
    for (const g of document.querySelectorAll('[data-theme-glyph]')) {
      g.dataset.themeGlyph = name;
      g.innerHTML = muninGlyph(name);
    }
  },
};
globalThis.MuninTheme = MuninTheme;

/* Fragment navigation is not routing. The app uses history entries for
 * screens and overlays, so letting the skip link write a #fragment also fires
 * popstate in some browsers and can send the reader back to Home immediately
 * after they skipped into Progress. Resolve its current target ourselves: the
 * shell points it at the shelf and app.js points it at the visible screen. */
document.querySelector('.skip')?.addEventListener('click', (event) => {
  const href = event.currentTarget.getAttribute('href') || '';
  if (!href.startsWith('#') || href.length < 2) return;
  const target = document.getElementById(href.slice(1));
  if (!target || !target.getClientRects().length) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'start' });
});

/* No prefers-color-scheme listener. Sunset used to change the app's colour
 * under an install that had chosen nothing; nothing follows the device now, so
 * there is nothing to follow it with. */

/* ── installing ───────────────────────────────────────────────────────────
 *
 * Captured here, at parse time, because the shell is the only script that is
 * always running: Chrome decides the app is installable and fires
 * beforeinstallprompt as soon as the manifest and the worker are in hand —
 * which on the shelf is before any course, and so before app.js exists. The
 * event does not queue. With nobody listening it is simply gone for the life of
 * the page, and the offer never appears anywhere. (Day Skipper shipped that bug
 * once, from one screen; Munin's boot order would have re-earned it.)
 *
 * Munin holds the event; the picker and Settings both just draw it. */
const MuninInstall = {
  event: null,

  installed() {
    // navigator.standalone is iOS's own, and the only signal there.
    return matchMedia('(display-mode: standalone)').matches
      || matchMedia('(display-mode: minimal-ui)').matches
      || matchMedia('(display-mode: fullscreen)').matches
      || navigator.standalone === true;
  },

  /* iOS has no install API at all, so the offer there is instructions. */
  ios() {
    const ua = navigator.userAgent;
    // iPadOS 13+ reports itself as a Mac. The touch points are the tell.
    return /iPhone|iPad|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  /* Firefox for Android installs PWAs from its own menu and does not hand the
   * page a beforeinstallprompt event. Hiding every install surface there made
   * a supported action undiscoverable. */
  firefoxAndroid() {
    return /Android/i.test(navigator.userAgent)
      && /Firefox\//i.test(navigator.userAgent);
  },

  /** Nothing to say to a browser that can neither prompt nor be told how. */
  offerable() {
    return !MuninInstall.installed()
      && (MuninInstall.event || MuninInstall.ios() || MuninInstall.firefoxAndroid());
  },

  async prompt() {
    // The event is single-use: Chrome invalidates it once prompt() is called,
    // and fires a fresh one if the offer is declined.
    const e = MuninInstall.event;
    MuninInstall.event = null;
    if (!e) return;
    e.prompt();
    await e.userChoice.catch(() => {});
    MuninInstall.refresh();
  },

  /* Both places that draw the offer, kept honest whenever the answer changes. */
  refresh() {
    renderShelfInstall();
    globalThis.renderInstall?.();
  },
};

addEventListener('beforeinstallprompt', (e) => {
  // Stops Chrome's own mini-infobar, so the offer appears once, in the app's
  // voice, on a screen it belongs on.
  e.preventDefault();
  MuninInstall.event = e;
  MuninInstall.refresh();
});

addEventListener('appinstalled', () => {
  MuninInstall.event = null;
  MuninInstall.refresh();
});

globalThis.MuninInstall = MuninInstall;

/* The picker's copy of the offer. First run is the one moment the app can say
 * "keep me" before anyone has picked anything, so it sits under the tiles —
 * below the thing you came for, never in front of it. It needs no dismissal:
 * installing removes it, and nothing else here is a nudge. */
function renderShelfInstall() {
  const card = document.getElementById('shelf-install');
  if (!card) return;
  if (!MuninInstall.offerable()) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const steps = card.querySelector('.shelf-install-steps');
  const btn = card.querySelector('#shelf-install-btn');
  btn.hidden = !MuninInstall.event;
  steps.hidden = !!MuninInstall.event;
  steps.innerHTML = MuninInstall.event ? ''
    : MuninInstall.firefoxAndroid()
      ? '<li>open the Firefox menu</li><li>choose “Install”</li>'
      : '<li>tap the share button in the browser bar</li><li>choose “Add to Home Screen”</li>';
}

function drawnAs(d, cls, style) {
  return `<svg class="dood ${cls || ''}" viewBox="0 0 32 32" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    ${style ? `style="${style}"` : ''}><path d="${d}"/></svg>`;
}

function muninDoodle(name, cls, style) {
  return drawnAs(MUNIN_DOODLE[name] || MUNIN_DOODLE.perch, cls, style);
}

/* ── pull to refresh ───────────────────────────────────────────────────────
 *
 * The browser's native gesture is disabled in app.css: it is absent in iOS
 * standalone mode and behaves differently across Android browsers. This is
 * the same contract as peanut-ui's custom gesture — 70px arm, 120px visual
 * ceiling, 80px while reloading — without adding a library to the offline
 * shell.
 *
 * A fixed-screen app has several possible scroll surfaces. Only the visible
 * one counts, and a dialog/lightbox never does: reloading halfway through an
 * import or while panning a diagram is not a refresh gesture. */
function initPullToRefresh() {
  const DIST_THRESHOLD = 70;
  const DIST_MAX = 120;
  const DIST_RELOAD = 80;
  const el = document.createElement('div');
  el.className = 'pull-refresh';
  el.id = 'pull-refresh';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="pull-refresh-content">
    <span class="pull-refresh-icon" aria-hidden="true">↓</span>
    <span class="pull-refresh-text">pull down to refresh</span>
  </div>`;
  document.body.prepend(el);

  const icon = el.querySelector('.pull-refresh-icon');
  const text = el.querySelector('.pull-refresh-text');
  let start = null;
  let distance = 0;
  let state = 'idle';
  let resetTimer = null;
  let reloadTimer = null;

  const blocked = () => {
    const boot = document.getElementById('boot');
    return (boot && !boot.hidden)
      || !!document.querySelector('.imp, .shelf.on[role="dialog"], .lightbox:not([hidden])');
  };

  const activeScroller = () => {
    const shelf = document.querySelector('.shelf.on:not([role="dialog"])');
    if (shelf) return shelf;
    return [...document.querySelectorAll('.screen:not([hidden]) .body')]
      .find((node) => node.getClientRects().length) || document.scrollingElement;
  };

  const canStart = (target) => {
    if (blocked() || window.scrollY > 0) return false;
    if (!(target instanceof Element)) return false;
    if (target.closest('input, select, textarea, [contenteditable="true"]')) return false;
    const scroller = activeScroller();
    return !scroller || scroller.scrollTop <= 0;
  };

  // pulltorefreshjs's resistance function: the first part of the drag moves
  // softly, a decisive pull crosses 70px, and no gesture opens more than 120px.
  const resisted = (raw) => {
    const extra = Math.max(0, raw);
    return Math.min(1, extra / DIST_THRESHOLD / 2.5) * Math.min(DIST_MAX, extra);
  };

  const setDistance = (next, dragging) => {
    distance = Math.max(0, Math.min(DIST_MAX, next));
    document.documentElement.style.setProperty('--pull-refresh-distance', distance + 'px');
    document.body.classList.toggle('pull-refresh-active', distance > 0);
    document.body.classList.toggle('pull-refresh-dragging', !!dragging);
    el.classList.toggle('on', distance > 0);
    el.classList.toggle('dragging', !!dragging);
    el.setAttribute('aria-hidden', distance > 0 ? 'false' : 'true');
  };

  const say = (next) => {
    state = next;
    el.classList.toggle('ready', next === 'ready');
    el.classList.toggle('refreshing', next === 'refreshing');
    if (next === 'ready') {
      icon.textContent = '↓';
      text.textContent = 'release to refresh';
    } else if (next === 'refreshing') {
      icon.textContent = '↻';
      text.textContent = 'refreshing…';
    } else if (next === 'blocked') {
      icon.textContent = '!';
      text.textContent = 'progress is not saved — refresh stopped';
    } else {
      icon.textContent = '↓';
      text.textContent = 'pull down to refresh';
    }
  };

  const reset = (delay = 0) => {
    clearTimeout(resetTimer);
    const finish = () => {
      start = null;
      say('idle');
      setDistance(0, false);
    };
    if (delay) resetTimer = setTimeout(finish, delay);
    else finish();
  };

  const safeToReload = () => {
    if (typeof globalThis.writeNow !== 'function') return true;
    try { return globalThis.writeNow() !== false; }
    catch (e) { console.error(e); return false; }
  };

  addEventListener('touchstart', (e) => {
    if (state === 'refreshing' || e.touches.length !== 1 || !canStart(e.target)) return;
    clearTimeout(resetTimer);
    const touch = e.touches[0];
    start = { id: touch.identifier, x: touch.clientX, y: touch.clientY, moved: false };
  }, { passive: true });

  addEventListener('touchmove', (e) => {
    if (!start || state === 'refreshing') return;
    const touch = Array.from(e.touches).find((point) => point.identifier === start.id);
    if (!touch) { reset(); return; }
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (!start.moved && Math.abs(dx) > Math.max(8, dy)) { reset(); return; }
    if (dy <= 0) {
      if (distance) setDistance(0, true);
      return;
    }
    start.moved = true;
    if (e.cancelable) e.preventDefault();
    const next = resisted(dy);
    setDistance(next, true);
    say(next > DIST_THRESHOLD ? 'ready' : 'pulling');
  }, { passive: false });

  const finish = () => {
    if (!start || state === 'refreshing') return;
    start = null;
    document.body.classList.remove('pull-refresh-dragging');
    el.classList.remove('dragging');
    if (state !== 'ready' || distance <= DIST_THRESHOLD) {
      reset();
      return;
    }
    if (!safeToReload()) {
      say('blocked');
      setDistance(DIST_RELOAD, false);
      reset(1400);
      return;
    }
    say('refreshing');
    setDistance(DIST_RELOAD, false);
    // Let the promised state paint before navigation. As in peanut-ui, do not
    // resolve back to idle: Android could otherwise arm a second pull while
    // the old document is still leaving.
    reloadTimer = setTimeout(() => location.reload(), 300);
  };

  addEventListener('touchend', finish, { passive: true });
  addEventListener('touchcancel', () => {
    if (state !== 'refreshing') reset();
  }, { passive: true });
  addEventListener('pagehide', () => clearTimeout(reloadTimer));
}

/* The theme toggle's three states, from Munin's chrome set rather than the
 * raven set — see design/raven-doodles/build.py for why those are two objects.
 * The Unicode fallback is not decoration: this runs before first paint, and a
 * toggle that draws nothing at all is a control nobody can find. */
const GLYPH_TEXT = { day: '☀', night: '☾', dusk: '◐' };
function muninGlyph(name) {
  const d = (globalThis.MUNIN_GLYPH || {})[name];
  return d ? drawnAs(d, 'dood-glyph') : (GLYPH_TEXT[name] || '');
}

/* One <style> block per boot: the scopes app.css declares its accent in,
 * overridden from course.json (or Munin's own ink teal on the shelf). There
 * were four; the prefers-color-scheme one went with app.css's, and `:root`
 * stays because it is what paints before the theme attribute is written. */
function injectAccent(a, paper) {
  const old = document.getElementById('course-theme');
  if (old) old.remove();
  const s = document.createElement('style');
  s.id = 'course-theme';
  const lightPaper = paper && COLOUR.test(paper.light) ? ` --surface: ${paper.light};` : '';
  const darkPaper = paper && COLOUR.test(paper.dark) ? ` --surface: ${paper.dark};` : '';
  s.textContent = `
    :root { --accent: ${a.light}; --accent-ink: ${a.inkLight}; --g4: ${a.light};${lightPaper} }
    :root[data-theme="light"] { --accent: ${a.light}; --accent-ink: ${a.inkLight}; --g4: ${a.light};${lightPaper} }
    :root[data-theme="dark"] { --accent: ${a.dark}; --accent-ink: ${a.inkDark}; --g4: ${a.dark};${darkPaper} }`;
  document.head.appendChild(s);
}

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

/* An accent goes into a style attribute and into a stylesheet, where a `;` or
 * a `}` is a way out of the declaration it was supposed to be. A colour that
 * is not a colour is a mistake in a course file, and it gets Munin's. */
const COLOUR = /^#[0-9a-f]{3,8}$/i;
function colours(a) {
  const t = MUNIN.theme.accent;
  const out = Object.assign({}, t);
  for (const k of Object.keys(t)) if (COLOUR.test(a && a[k])) out[k] = a[k];
  return out;
}

const PUBLIC_COLOUR = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const PUBLIC_LOADING_ANIMATIONS = new Set(['none', 'gentle-bob', 'pulse']);
const publicText = (value, maximum) =>
  typeof value === 'string' && value.trim() && [...value].length <= maximum ? value : null;

/* Imported records live in browser storage, which is a persistence boundary,
 * not a trust boundary. Recognise only the projection written by the public
 * v2 importer, only on keep imports, and map its descriptive names to the
 * shell's older internal token names here. Anki records intentionally never
 * enter this path. */
function publicPresentationOf(rec) {
  if (!rec || rec.importFormat !== 'keep'
      || !rec.presentation || typeof rec.presentation !== 'object'
      || Array.isArray(rec.presentation)) return null;
  const raw = rec.presentation;
  const theme = raw.theme && typeof raw.theme === 'object' && !Array.isArray(raw.theme)
    ? raw.theme : {};
  const colour = (name) => PUBLIC_COLOUR.test(theme[name]) ? theme[name] : null;
  const shelfArtwork = publicText(theme.shelfArtwork, 240);
  const sectionArtwork = publicText(theme.sectionArtwork, 240);
  const loadingArtwork = publicText(theme.loadingArtwork, 240);
  const loadingAnimation = PUBLIC_LOADING_ANIMATIONS.has(theme.loadingAnimation)
    ? theme.loadingAnimation : 'gentle-bob';
  return {
    shortTitle: publicText(raw.shortTitle, 60),
    tagline: publicText(raw.tagline, 200),
    accent: {
      light: colour('accentColor'),
      dark: colour('accentColorDark'),
      inkLight: colour('accentInkColor'),
      inkDark: colour('accentInkColorDark'),
    },
    paper: {
      light: colour('paperColor'),
      dark: colour('paperColorDark'),
    },
    loadingText: publicText(theme.loadingText, 120),
    shelfArtwork,
    sectionArtwork,
    loadingArtwork,
    loadingAnimation,
  };
}

/* One resolver for every imported-media surface: cards, packaged theme art,
 * and the shelf. It is deliberately source-indexed and only creates blob:
 * URLs for records already stored by the importer. Closing increments the
 * generation before revoking, so an IndexedDB read that finishes late cannot
 * resurrect a URL after its screen has gone away. */
function localMediaResolver(store, rec) {
  const urls = new Map();
  const pending = new Map();
  const mediaIndexBySource = rec.mediaIndexBySource
    && typeof rec.mediaIndexBySource === 'object'
    && !Array.isArray(rec.mediaIndexBySource)
    ? rec.mediaIndexBySource : {};
  let closed = false;
  let generation = 0;
  const mediaUrl = async (index) => {
    if (closed) return null;
    if (urls.has(index)) return urls.get(index);
    if (pending.has(index)) return pending.get(index);
    const requestedGeneration = generation;
    const load = store.mediaBlob(rec.id, index).then((blob) => {
      if (pending.get(index) === load) pending.delete(index);
      if (!blob || closed || requestedGeneration !== generation) return null;
      const url = URL.createObjectURL(blob);
      urls.set(index, url);
      return url;
    }, (error) => {
      if (pending.get(index) === load) pending.delete(index);
      throw error;
    });
    pending.set(index, load);
    return load;
  };
  return {
    mediaUrl,
    async resolveMediaSource(source) {
      if (typeof source !== 'string' || !Object.hasOwn(mediaIndexBySource, source)) return null;
      const index = mediaIndexBySource[source];
      return Number.isSafeInteger(index) && index >= 0 ? mediaUrl(index) : null;
    },
    close() {
      closed = true;
      generation++;
      pending.clear();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
    reopen() {
      closed = false;
    },
  };
}

/** Every slot a course left empty, filled from Munin's own theme. */
function withDefaults(c) {
  const t = MUNIN.theme;
  return Object.assign({}, c, {
    accent: colours(c.accent),
    boot: Object.assign({}, t.boot, c.boot || {}),
    fallback: c.fallback || t.fallback,
    sectionArt: c.sectionArt || {},
    groupArt: c.groupArt || {},
    friezeArt: (c.friezeArt && c.friezeArt.length) ? c.friezeArt : t.friezeArt,
    notice: c.notice || t.notice,
  });
}

/* ── the loading screen ───────────────────────────────────────────────────
 *
 * A course owns its loading screen: boot.html is the scene, boot.css is how it
 * moves, boot.line is what it says. Munin's raven is in index.html as the
 * default, so there is always a scene at first paint.
 *
 * The catch this solves: the course's scene cannot be known until course.json
 * has been fetched, which is the whole window the screen exists to cover. So
 * the scene the course drew last time is kept in localStorage and replayed
 * synchronously, here, before anything paints. First-ever open of a course
 * gets Munin's raven; every open after that gets the course's own.
 */
/* A cached scene is markup that goes into innerHTML, and localStorage is not
 * a trustworthy place to keep markup. `<script>` never runs through innerHTML,
 * but `onerror` and `onbegin` do, at parse time, before anything else on the
 * page — so a one-shot injection anywhere else on this origin (kkonrad.com
 * carries a whole site besides this app) would become code that runs inside
 * Munin on every visit, for ever, offline included. Parsed, stripped and
 * re-serialised: the same rule the importer applies to a stranger's cards. */
function safeScene(html) {
  const doc = new DOMParser().parseFromString(
    '<svg xmlns="http://www.w3.org/2000/svg">' + String(html) + '</svg>', 'image/svg+xml');
  if (doc.querySelector('parsererror')) return '';
  // `style` is on this list for the same reason the stylesheet beside it is
  // parsed: a scene is a drawing, and a drawing that brings rules of its own is
  // a way to dress the whole page from inside sanitised markup.
  for (const el of doc.querySelectorAll('script, foreignObject, iframe, image, use, style')) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const urls = [...a.value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)];
      const externalPaint = urls.some((m) => !m[2].trim().startsWith('#'));
      if (n === 'style' || externalPaint || n.startsWith('on')
          || (/^(href|xlink:href|src)$/.test(n) && !/^#/.test(a.value.trim()))) {
        el.removeAttribute(a.name);
      }
    }
  }
  return doc.documentElement.innerHTML;
}

/* The same distrust, for how the scene moves. A cached record is a stranger's
 * CSS if anything else on this origin ever wrote it, and CSS runs no script but
 * it can lay a full-viewport overlay over the app, pull in a whole stylesheet
 * with `@import`, or beacon what is on the page through attribute selectors —
 * and `#boot-style` is never removed. Parsed rather than pattern-matched, and
 * kept only where every selector stays inside the loading screen: a course
 * styles `#boot…` and its own `.boot-<course>` and nothing else. `~` and `+`
 * are refused because a sibling of the boot screen is the app.
 * (`replaceSync` drops `@import` itself — that one is the parser's doing.) */
function safeCss(css) {
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(String(css));
  } catch (e) {
    return '';                    // no parser to trust here, so no stylesheet
  }
  const scoped = (sel) => String(sel).split(',').every((s) => {
    const t = s.trim();
    return /^(#boot|\.boot-)/.test(t) && !/[~+]|:has\b/.test(t);
  });
  const resourcesAreLocal = (text) => {
    if (/\b(?:image-set|src)\s*\(/i.test(text)) return false;
    for (const m of String(text).matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
      if (!m[2].trim().startsWith('#')) return false;
    }
    return true;
  };
  const keep = (rules) => {
    const out = [];
    for (const r of rules) {
      if (r.selectorText !== undefined) {
        if (scoped(r.selectorText) && resourcesAreLocal(r.cssText)) out.push(r.cssText);
      } else if (r.cssRules && /^@(?:-webkit-)?keyframes\b/i.test(r.cssText)) {
        // A named grouping rule is not necessarily keyframes. In particular,
        // @layer also has a name, and copying its children verbatim let an
        // unscoped `body` rule escape the boot screen. Animation steps have no
        // selectors to scope; every other grouping still goes through keep().
        const inner = [...r.cssRules]
          .filter((step) => resourcesAreLocal(step.cssText))
          .map((step) => step.cssText).join('\n');
        if (inner) out.push(r.cssText.slice(0, r.cssText.indexOf('{') + 1) + inner + '}');
      } else if (r.cssRules && r.conditionText !== undefined) {
        const inner = keep(r.cssRules);                        // @media, @supports
        if (inner) out.push(r.cssText.slice(0, r.cssText.indexOf('{') + 1) + inner + '}');
      }
    }
    return out.join('\n');
  };
  return keep(sheet.cssRules);
}

function applyBoot(b) {
  const boot = document.getElementById('boot');
  if (!boot || !b) return;
  // The colour comes with the scene. Without it the replayed screen paints in
  // whatever the stylesheet's default accent happens to be until course.json
  // arrives — which is the whole window this screen exists to cover.
  // Through colours(), because an accent is interpolated straight into a
  // stylesheet and a cached record is no more trustworthy than a course file.
  if (b.accent) injectAccent(colours(b.accent));
  if (b.css) {
    const css = safeCss(b.css);
    if (css) {
      let style = document.getElementById('boot-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'boot-style';
        document.head.appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
    }
  }
  const scene = boot.querySelector('#boot-scene');
  // The scene is a course's own file, and it replaces markup rather than being
  // added to it — a second scene under the first is two loading screens.
  if (scene && b.html && scene.dataset.from !== b.from) {
    const clean = safeScene(b.html);
    if (clean) {
      scene.innerHTML = clean;
      scene.dataset.from = b.from || 'course';
    }
  }
  const line = boot.querySelector('#boot-line');
  if (line && b.line) line.textContent = b.line;
}

function readBootCache(id) {
  try {
    const raw = localStorage.getItem(MUNIN.bootKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function writeBootCache(id, b) {
  try {
    localStorage.setItem(MUNIN.bootKey(id), JSON.stringify(b));
  } catch (e) {
    // A full quota is not a reason to fail to boot; the scene simply arrives
    // late next time, exactly as it does on a first visit.
  }
}

function clearBootCache(id) {
  try { localStorage.removeItem(MUNIN.bootKey(id)); } catch (e) { /* best effort */ }
}

/** The scene the course about to open drew last time, before the first paint. */
function replayBoot(id) {
  if (!id || !(MUNIN.idOk(id) || isLocal(id))) return;
  applyBoot(readBootCache(id));
}

/* ── the splash ───────────────────────────────────────────────────────────
 *
 * The loading screen is held on purpose (28 July 2026). Measured against
 * production before this: 103ms on a cold visit and 21–39ms on a warm one —
 * two to four frames — because a cache-first service worker leaves nothing to
 * cover. The course's own scene was worse than invisible: it only paints from
 * visit two onward, and every visit from two onward is a warm one, so Day
 * Skipper's boat had never been on a screen for longer than three frames.
 *
 * So the screen is now shown rather than merely used. HOLD is the floor, not a
 * delay added to a load: a boot slower than this hides the screen when it is
 * ready and no later. DRAW (in app.css and in each course's boot.css) is under
 * HOLD so the drawing finishes drawing itself before anything fades.
 */
const SPLASH = { at: performance.now(), hold: 800, fade: 220, patience: 8000 };

/** Resolves once the screen has been up long enough to have been seen. */
function splashHeld() {
  const left = SPLASH.hold - (performance.now() - SPLASH.at);
  return left > 0 ? new Promise((r) => setTimeout(r, left)) : Promise.resolve();
}

/** Take the loading screen down: held to its floor, faded, then gone.
 *
 * Whatever replaces it must already be on the page when this is called — the
 * fade reveals what is behind, and behind a splash that goes first is nothing.
 */
let bootDone = false;
async function dismissBoot() {
  bootDone = true;
  const boot = document.getElementById('boot');
  if (!boot || boot.hidden) return;
  await splashHeld();
  boot.classList.add('going');
  await new Promise((r) => setTimeout(r, SPLASH.fade));
  boot.hidden = true;
  boot.classList.remove('going');   // the shelf overlay can raise it again
}
globalThis.MuninBoot = { dismiss: dismissBoot, splash: SPLASH };

/* Nothing may hold this screen for ever.
 *
 * Everything that takes the splash down runs inside app.js, and app.js is a
 * script that can fail to arrive or throw on the way in — a precached shell
 * against a redeployed index.html did exactly that, and the app was the word
 * "loading" for ever: opaque, ranked above the `courses` pill, no message, no
 * button, nothing to do but know to reload. This is the last resort, not a
 * timeout on the boot: whatever is still loading goes on loading behind it, and
 * a dismiss that arrives late still takes the screen down normally.
 *
 * SPLASH.patience is ten times the hold and longer than the picker's own
 * 8s fetch ceiling, so the honest answer at this point really is "something has
 * gone wrong", not "the network is slow today". */
function watchBoot() {
  setTimeout(() => {
    const boot = document.getElementById('boot');
    if (bootDone || !boot || boot.hidden || document.getElementById('boot-retry')) return;
    // app.js gets there first on the paths it knows about — a deck that will
    // not load or will not validate is already said in its own words, with its
    // own way off the screen. Two messages and two buttons is worse than one.
    const back = document.getElementById('boot-back');
    if (back && !back.hidden) return;
    const line = document.getElementById('boot-line');
    if (line) line.textContent = 'This is taking longer than it should have.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.id = 'boot-retry';
    btn.textContent = 'Reload';
    btn.addEventListener('click', () => location.reload());
    boot.appendChild(btn);
    btn.focus({ preventScroll: true });
  }, SPLASH.patience);
}

/* The scenes of the courses sitting on the shelf, fetched once the shelf is up
 * and drawn on nobody's critical path. Without this the FIRST tap on a tile
 * opens onto Munin's raven — the course's own drawing is only ever replayed
 * from a cache that that first open is what fills. A held splash made the miss
 * worth a full second of the wrong bird. course.json is already in hand from
 * drawing the tile, so this costs two small files per course, once. */
function prefetchScenes(metas) {
  for (const c of metas) {
    if (!c || readBootCache(c.id)) continue;
    c.base = c.base || 'courses/' + c.id + '/';
    // Failure is the status quo ante — a first open that draws the raven.
    cacheBootScene(c).catch(() => {});
  }
}

/* Cheap content stamp, so a redrawn scene swaps in the moment it arrives
 * instead of one visit later, and an unchanged one never re-renders. */
function stamp(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** A course's own loading screen, fetched and kept for next time.
 *
 * Returns the record, or null if the course ships no scene — in which case
 * Munin's raven stays, which is a slot left empty and not a failure. Throws
 * only on the network, so a caller can tell "no scene" from "not now".
 */
async function cacheBootScene(c) {
  if (isLocal(c.id)) return null;                  // an imported deck has no files
  const get = async (name) => {
    const r = await fetch(c.base + name, { cache: 'no-cache' });
    if (r.status === 404) return { missing: true, text: '' };
    if (!r.ok) throw new Error(`${name} returned ${r.status}`);
    return { missing: false, text: await r.text() };
  };
  const [scene, motion] = await Promise.all([get('boot.html'), get('boot.css')]);
  if (scene.missing || !scene.text) {
    // A definitive absence is an update, not an offline failure. Retaining the
    // old replay record made removed course branding permanent.
    clearBootCache(c.id);
    return null;
  }
  const html = scene.text;
  const css = motion.missing ? '' : motion.text;
  const b = {
    html, css, line: c.boot.line, accent: c.accent,
    from: c.id + '-' + stamp(html + css),
  };
  writeBootCache(c.id, b);
  return b;
}

/** The same, for the course opening right now: kept, and put on the screen. */
async function loadBootScene(c) {
  try {
    const b = await cacheBootScene(c);
    if (b) applyBoot(b);
  } catch (e) {
    // Offline. The default is already drawn.
  }
}

/** Everything a course needs once its theme is in hand. */
async function startCourse(c, loadDoodles) {
  globalThis.COURSE = c;
  injectAccent(c.accent, c.paper);
  const line = document.getElementById('boot-line');
  if (line && c.boot.line) line.textContent = c.boot.line;
  const bootScene = document.getElementById('boot-scene');
  if (bootScene && c.loadingArtworkUrl) {
    const image = document.createElement('img');
    image.className = 'boot-course-art';
    image.src = c.loadingArtworkUrl;
    image.alt = '';
    image.dataset.animation = c.loadingAnimation;
    bootScene.replaceChildren(image);
    bootScene.dataset.from = c.id + '-package-art';
  }
  document.title = 'keep club — ' + c.title;
  // A course that draws figures brings the stylesheet for them: its own nouns
  // — rigging, fenders, pontoons — used to be fifty rules in app.css, applied
  // over every deck including the ones about German verbs.
  if (!c.deck) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = c.base + 'figures.css';
    document.head.appendChild(link);
  }
  const scene = loadBootScene(c);
  await loadDoodles();
  // A course with no scene file of its own still gets its own drawing in
  // Munin's frame, rather than the raven belonging to another deck.
  const holder = document.querySelector('#boot-scene[data-from="munin"] path');
  if (holder && globalThis.DOODLE && DOODLE[c.boot.art]) holder.setAttribute('d', DOODLE[c.boot.art]);
  await loadScript('app.js');
  const h1 = document.getElementById('course-title');
  if (h1) {
    // What the header calls this course is the course's own business:
    // course.json's `short`, falling back to its full title. The shell used to
    // strip one awarding body's prefix with a regular expression, which is a
    // course's naming convention living in the engine.
    h1.textContent = c.short || c.title;
    // Munin lowercases its own chrome. A deck someone imported is titled in
    // their words, not Munin's, and the shelf already shows it as written.
    h1.classList.toggle('own', !!c.deck);
  }
  if (c.publicPresentation) {
    const sub = document.getElementById('home-sub');
    if (sub) {
      sub.textContent = c.tagline || '';
      sub.hidden = !c.tagline;
    }
  }
  mountShelfButton(c);
  await scene;
}

async function bootCourse(id) {
  const base = 'courses/' + id + '/';
  const r = await fetch(base + 'course.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('no course at ' + base);
  const c = withDefaults(await r.json());
  c.base = base;
  // The folder is the identity. course.json may name an id of its own and it
  // is ignored here: the two used to be able to disagree, and progress is
  // keyed on this — a folder renamed without editing its json silently forked
  // every user's history into a key nothing reads again.
  c.id = id;
  // A course with no doodles.js gets the raven set — a slot is never a hole.
  await startCourse(c, () => loadScript(base + 'doodles.js')
    .catch(() => { globalThis.DOODLE = MUNIN_DOODLE; }));
}

/* A deck someone imported. It has no folder: the cards and packaged media are
 * in IndexedDB, so the shell hands app.js the deck itself rather than a path to
 * fetch. Public v2 courses also bring a small validated presentation
 * projection; legacy Anki decks retain the shell defaults they have always
 * used. */
async function bootLocal(id) {
  const store = await import('./lib/store.js');
  const rec = await store.get(id);
  if (!rec) throw new Error('that deck is not here any more');

  // Imported media is resolved lazily by app.js when a card or Browse row is
  // rendered. Loading every Blob here made a 100 MiB deck consume all 100 MiB
  // before Home appeared.
  const media = localMediaResolver(store, rec);
  const { mediaUrl, resolveMediaSource } = media;
  const presentation = publicPresentationOf(rec);
  const loadingText = presentation?.loadingText || 'Loading your deck…';
  const line = document.getElementById('boot-line');
  if (line) line.textContent = loadingText;
  let loadingArtworkUrl = null;
  if (presentation?.loadingArtwork) {
    try {
      loadingArtworkUrl = await resolveMediaSource(presentation.loadingArtwork);
    } catch (e) {
      // A missing/corrupt optional drawing cannot stop the cards opening.
    }
  }
  addEventListener('pagehide', () => {
    media.close();
  });
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    media.reopen();
    // The DOM itself survived, but every blob: URL in it was revoked when the
    // page entered the back-forward cache. Turn those elements back into lazy
    // placeholders and let app.js hydrate only what is visible.
    for (const el of document.querySelectorAll('[data-munin-media]')) {
      el.removeAttribute('src');
      delete el.dataset.muninLoaded;
    }
    dispatchEvent(new Event('muninmediareset'));
  });

  mountReceipt(rec);
  await startCourse(withDefaults({
    id,
    title: rec.title,
    short: presentation?.shortTitle || undefined,
    tagline: presentation?.tagline || undefined,
    publicPresentation: !!presentation,
    base: '',
    accent: presentation?.accent,
    paper: presentation?.paper,
    boot: { art: rec.art || MUNIN.theme.boot.art, line: loadingText },
    loadingArtworkUrl,
    loadingAnimation: presentation?.loadingAnimation,
    sectionArtworkSource: presentation?.sectionArtwork,
    sectionArt: rec.sectionArt || {},
    groupArt: rec.groupArt || {},
    deck: rec.deck,
    // A deck whose document somebody wrote here, rather than one that came out
    // of a file. app.js needs it for one thing: the cards in that document are
    // cards a person wrote, and every screen that says who wrote a card should
    // say so about those too.
    own: rec.importFormat === 'own',
    mediaUrl,
    resolveMediaSource,
  }), async () => { globalThis.DOODLE = MUNIN_DOODLE; });
}

/* The receipt again, on Progress.
 *
 * "Drop it, get a receipt" is worth little if the receipt is gone the moment
 * you start studying: the numbers it holds — what was dropped and why, what the
 * import changed — are exactly what you want three weeks later, when a card is
 * missing and you are trying to work out whether it ever arrived. It is already
 * stored with the deck; this only draws it. */
async function mountReceipt(rec) {
  if (!rec.receipt) return;
  try {
    const { book, ensureCss } = await import('./lib/receipt.js');
    const host = document.querySelector('#s-stats .body');
    if (!host) return;
    ensureCss();
    const h = document.createElement('h2');
    h.className = 'h-sect';
    h.textContent = 'Where this deck came from';
    const box = document.createElement('div');
    box.innerHTML = book(rec.receipt);
    const when = document.createElement('p');
    when.className = 'key';
    const source = rec.receipt.type === 'keep'
      ? (rec.receipt.sourceKind === 'keep-package' ? 'a .keep package' : 'a .keep.yml course')
      : 'an anki package';
    when.textContent = `imported ${new Date(rec.created).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric' })} from ${source}`;
    host.append(h, when, box);
  } catch (e) {
    console.error(e);
  }
}

/* ── the shelf ───────────────────────────────────────────────────────────── */

const SHELF_CSS = `
  /* Both insets, the way .top and .lb-bar take them: this panel is pinned to
     the physical edges of the screen, so on a notched phone in standalone the
     wordmark and the theme button sat under the status bar. */
  .shelf { position: fixed; inset: 0; z-index: 90; overflow-y: auto;
    background: var(--bg); color: var(--text);
    padding: calc(28px + env(safe-area-inset-top)) 20px
    calc(28px + env(safe-area-inset-bottom)); display: none; }
  .shelf.on { display: block; }
  .shelf-inner { max-width: 430px; margin: 0 auto; }
  .shelf-mark { display: flex; align-items: center; gap: 10px; margin: 6px 0 4px; }
  .shelf-mark .dood { width: 34px; height: 34px; color: var(--accent); }
  .shelf-mark h1 { font-size: 1.3rem; font-weight: 500; letter-spacing: -.02em;
    margin: 0; text-transform: lowercase; }
  .shelf-mark .icon-btn { margin-left: auto; }
  /* The overlay's way out sits beside the theme button, not away from it. */
  .shelf-mark .shelf-x { margin-left: 0; }
  .shelf-intro { display: flex; align-items: center; gap: 12px; margin: 0 0 22px; }
  .shelf-sub { flex: 1; color: var(--muted); font-size: .84rem; margin: 0; }
  .shelf-share { flex: none; min-width: 88px; min-height: var(--tap); padding: 0 12px;
    background: var(--surface); color: var(--text); font: inherit; font-size: .78rem;
    text-transform: lowercase; cursor: pointer; border: var(--bw) solid var(--stroke);
    border-radius: 99px; box-shadow: var(--sh-sm); }
  .shelf-share:disabled { color: var(--muted); }
  .shelf-share:active:not(:disabled) { box-shadow: none; transform: translate(2px, 2px); }
  .shelf-tiles { display: flex; flex-direction: column; gap: 14px; }
  .shelf-tile { display: flex; align-items: center; gap: 12px; text-align: left;
    background: var(--surface); color: inherit; font: inherit; cursor: pointer;
    border: var(--bw) solid var(--stroke); border-left-width: 6px;
    border-left-color: var(--tile-accent, var(--stroke));
    border-radius: var(--r); box-shadow: var(--sh); padding: 14px 16px; min-height: var(--tap); }
  .shelf-tile .dood { width: 34px; height: 34px; flex: none; color: var(--tile-accent, var(--text)); }
  .shelf-art-frame { position: relative; width: 34px; height: 34px; flex: none;
    display: grid; place-items: center; }
  .shelf-art-frame .dood, .shelf-art-frame img {
    grid-area: 1 / 1; width: 100%; height: 100%; object-fit: contain;
  }
  /* A flex item will not shrink below its contents unless it is told it may,
   * and a title with no spaces in it is one very long word. */
  .shelf-tile > span { min-width: 0; overflow-wrap: anywhere; }
  /* A deck is titled by whoever made the .apkg, and the importer only started
   * capping that in July 2026 — a deck imported before it still holds the whole
   * string, and a twelve-thousand-character name grew this row until the ✕ and
   * "+ your own deck" were off the bottom of the screen. Two lines, whatever
   * arrives: the shelf is a list you choose from, not the place to read a name. */
  .shelf-tile b { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; font-weight: 500; font-size: .98rem; }
  .shelf-tile small { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; color: var(--muted); font-size: .8rem; text-transform: lowercase; }
  .shelf-tile.byo { border-style: dashed; border-left-width: var(--bw);
    box-shadow: none; color: var(--muted); justify-content: center; }
  /* A course that would not load. It stays on the shelf, and says so, because
   * a tile quietly missing is how you conclude your deck is gone. */
  .shelf-tile.broken { cursor: default; border-left-color: var(--stroke); }
  .shelf-tile.broken b { color: var(--muted); }
  /* An imported deck is the only thing here that can be got rid of, so it is
   * the only thing carrying a control. Two taps: the second one confirms. */
  .shelf-row { position: relative; display: flex; }
  .shelf-row .shelf-tile { flex: 1; padding-right: 52px; }
  .shelf-del { position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    min-width: 44px; min-height: 44px; background: none; border: 0; cursor: pointer;
    color: var(--muted); font: inherit; font-size: .95rem; border-radius: var(--r-sm); }
  .shelf-del[data-armed] { color: var(--accent); font-size: .74rem;
    text-transform: lowercase; min-width: 66px; }
  .shelf-install { margin-top: 26px; padding: 16px 18px 18px;
    background: var(--surface); border: var(--bw) dashed var(--stroke);
    border-radius: var(--r); }
  .shelf-install[hidden] { display: none; }
  .shelf-install b { display: block; font-weight: 500; font-size: .92rem;
    text-transform: lowercase; }
  .shelf-install p { margin: 4px 0 0; color: var(--muted); font-size: .8rem; }
  .shelf-install-steps { margin: 10px 0 0; padding-left: 20px; color: var(--text);
    font-size: .8rem; display: grid; gap: 4px; }
  .shelf-install-steps[hidden] { display: none; }
  .shelf-install-steps::marker, .shelf-install-steps li::marker { color: var(--muted); }
  #shelf-install-btn { margin-top: 12px; width: 100%; min-height: var(--tap);
    background: var(--surface); color: var(--text); font: inherit; font-size: .86rem;
    text-transform: lowercase; cursor: pointer;
    border: var(--bw) solid var(--stroke); border-radius: var(--r-sm);
    box-shadow: var(--sh-sm); }
  #shelf-install-btn[hidden] { display: none; }
  .shelf-note { margin-top: 22px; color: var(--muted); font-size: .78rem;
    text-transform: lowercase; text-align: center; }
  /* Over a course it says nothing — the ✕ needs no caption — but it stays in
   * the tree: the importer writes what it is doing into this line. */
  .shelf-note:empty { display: none; }
  /* In the header, beside the settings mark, in ordinary flow. It used to be
   * fixed to the top-right of the window with that mark floating under it: two
   * chips on two rows, hanging over whatever had scrolled beneath them. The
   * shell still owns it — it is the only way out of a course and only the
   * shell knows how to leave one — but app.css's .top-acts is the row it
   * stands in, and mountShelfButton() puts it there.
   * Paper, 2px ink, a hard shadow and the same 48px target as everything else,
   * matching the mark it now stands beside. It keeps a rank of its own because
   * it is what every modal in the app is measured against. */
  .shelf-btn { flex: none; z-index: 1;
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--surface); color: var(--text); font: inherit; font-size: .78rem;
    text-transform: lowercase; cursor: pointer; border: var(--bw) solid var(--stroke);
    border-radius: 99px; box-shadow: var(--sh-sm); padding: 5px 12px;
    min-height: var(--tap); }
  .shelf-btn:active { transform: translate(3px, 3px); box-shadow: 0 0 0 var(--stroke); }
  .shelf-btn .dood { width: 16px; height: 16px; }
  /* The fold that used to sit on Home, where it was four paragraphs of manual
   * wedged between the study button and the deck. This is the screen a person
   * is on before they have picked anything, and the one they come back to. */
  .shelf .how { margin-top: 22px; }`;

let shelfCssOn = false;
function ensureShelfCss() {
  if (shelfCssOn) return;
  shelfCssOn = true;
  const style = document.createElement('style');
  style.textContent = SHELF_CSS;
  document.head.appendChild(style);
}

const escHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Which courses ship with the app. One list, read at runtime: it used to be a
 * literal in this file, a second literal in the service worker's precache and
 * a third in refresh-courses.sh, and a course missing from the second worked
 * online and 404'd offline — the failure you find last.
 *
 * One shape: `{ "courses": [...] }`. This used to also accept a bare array,
 * which none of the three scripts that read the same file accept — tolerance
 * two readers out of five honour is a way to write a file that half the
 * toolchain rejects. */
async function readRegistry() {
  const r = await fetchWithTimeout(MUNIN.registry);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const idx = await r.json();
  if (!idx || !Array.isArray(idx.courses)) throw new Error('no course list in ' + MUNIN.registry);
  // A registered id that is not a usable id is a mistake in the one file that
  // says which courses exist — almost always a typo or a capital. It gets a
  // tile that says so rather than vanishing: a course quietly missing from the
  // shelf is how you conclude your deck is gone.
  const good = [], bad = [];
  for (const id of idx.courses) (MUNIN.idOk(id) ? good : bad).push(id);
  if (bad.length) console.error('not usable course ids in ' + MUNIN.registry + ':', bad);
  return { ids: good, bad: bad.map((b) => String(b).slice(0, 40)) };
}

/* Nothing the picker waits for may wait for ever. A request that hangs is not
 * a request that failed: the error paths here were all covered and a lie-fi
 * connection that never answers still left the shelf blank with no way back,
 * which is the exact failure the per-course try/catch was meant to end. */
const FETCH_MS = 8000;
function fetchWithTimeout(url, ms) {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), ms || FETCH_MS);
  return fetch(url, { cache: 'no-cache', signal: stop.signal })
    .finally(() => clearTimeout(t));
}

/** A course's description, or null with a reason. One course cannot take the
 *  picker down: this is the whole app's front door, and a mistyped course.json
 *  used to leave a blank page with no way back to anything. */
async function courseMeta(id) {
  try {
    const r = await fetchWithTimeout('courses/' + id + '/course.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const c = withDefaults(await r.json());
    c.id = id;
    if (!c.title) throw new Error('no title');
    return c;
  } catch (e) {
    console.error('course ' + id + ':', e);
    return null;
  }
}

/* Study history, the cards somebody wrote, and cached loading screens, for
 * decks that are not here.
 *
 * store.remove() deletes both of a deck's documents as it goes, but the deck
 * being removed may be the one open behind this overlay, and that session
 * writes its state again on the way out — so the key comes back a moment after
 * it was deleted, owned by nothing, for ever. Collecting orphans whenever the
 * shelf draws is the only point where the full list of decks is in hand anyway.
 *
 * DELETING IS ONLY EVER DONE FROM A LIST WE ACTUALLY HAVE. `null` means the
 * question could not be answered — a database that would not open, a registry
 * that would not load — and an unanswered question is not the answer "none of
 * them exist". Getting this wrong deletes a person's study history: an empty
 * deck list in a private window swept every imported deck's progress, and an
 * unreachable registry swept every course's cached loading screen. */
function sweepOrphans(decks, courses) {
  if (decks) {
    const live = new Set(decks.map((d) => d.id));
    for (const k of Object.keys(localStorage)) {
      // Both of a deck's documents, not only its review history: the cards
      // somebody wrote into it live in a sibling key (MUNIN.cardsKey) and are
      // as orphaned by the deck going as the history is. Swept together
      // because they are re-created together — an open tab that rewrites one
      // on the way out is just as able to rewrite the other.
      const s = /^munin\/(local-[a-z0-9]+)\/(?:state|cards)\/v1$/.exec(k);
      if (s && !live.has(s[1])) localStorage.removeItem(k);
    }
  }
  if (decks && courses) {
    const known = new Set(courses.concat(decks.map((d) => d.id)));
    for (const k of Object.keys(localStorage)) {
      const b = /^munin\/boot\/(.+)$/.exec(k);
      if (b && !known.has(b[1])) localStorage.removeItem(k);
    }
  }
}

/* A double-tap is one gesture, and one gesture must not be able to complete
 * both halves of a two-tap confirmation: the deck, its progress and the resume
 * pointer went, with "remove?" on screen for the ~50ms between the two clicks
 * and no undo anywhere. A confirm that arrives this soon after the arm is the
 * tail of the tap that armed it, and it is ignored — the button stays armed,
 * so the deliberate second tap that follows still works. */
const ARM_MS = 400;
let disarmAt = 0;
let armedAt = 0;
let impOpening = false;
let shelfOpening = false;
function disarm(root) {
  clearTimeout(disarmAt);
  armedAt = 0;
  for (const b of root.querySelectorAll('[data-armed]')) {
    delete b.dataset.armed;
    b.textContent = '✕';
    // The label is the whole safety mechanism for anyone not looking at the
    // screen: aria-label wins over contents, so a static one meant the button
    // said exactly the same thing armed as it did at rest.
    b.setAttribute('aria-label', 'Remove ' + b.dataset.name);
  }
}

/* The emblem comes out of course.json as the path itself. The shelf used to
 * fetch the whole 43 KB doodles.js and mine one path out of it with a regular
 * expression — two courses meant 86 KB of theme source parsed by the shell to
 * draw two tiles, and a doodle file that ever changed quotation marks would
 * have failed silently to a raven. */
function tileArt(path) {
  return `<svg class="dood" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${escHtml(path)}"/></svg>`;
}

function courseTile(c) {
  return `<button type="button" class="shelf-tile" data-course="${escHtml(c.id)}"
      style="--tile-accent:${escHtml(c.accent.light)}">
    ${tileArt(c.shelfPath || MUNIN_DOODLE[MUNIN.theme.fallback])}
    <span><b>${escHtml(c.title)}</b><small>${escHtml(c.tagline || '')}</small></span>
  </button>`;
}

function brokenTile(id) {
  return `<div class="shelf-tile broken">${muninDoodle('peek')}
    <span><b>${escHtml(id)}</b><small>this course would not load — reload, or check you are online</small></span>
  </div>`;
}

/* How much of a deck you have actually answered, for the row on the shelf.
 *
 * A deck's name, its card count, its date and even its raven are all worked
 * out from the deck itself, so importing the same file twice — which the
 * importer offers, in as many words — left two rows that were the same down to
 * the pixel. Removing the wrong one is two taps and there is no undo. What is
 * on each of them is the one thing that differs, and it is the thing you would
 * ask about anyway.
 *
 * A deck nobody has opened has no key at all, which is worth saying. A key we
 * cannot read is not a claim about anything, and says nothing. */
function deckProgress(id) {
  let raw = null;
  try {
    raw = localStorage.getItem(MUNIN.stateKey(id));
  } catch (e) {
    return '';
  }
  if (raw === null) return 'not started';
  try {
    const n = Object.keys(JSON.parse(raw).recs || {}).length;
    return n ? `${n.toLocaleString('en-GB')} answered` : 'not started';
  } catch (e) {
    return '';
  }
}

/* How many cards a deck holds, counting the ones written into it since.
 *
 * The number on the deck's record is what the file held the day it was read,
 * and nothing moves it afterwards — the record cannot simply be rewritten,
 * because store.put() clears a deck's whole media range before it writes and a
 * shelf that fixed a number would take every picture in the deck off with it.
 * So the layer is read here instead, the way import.js reads it: a live record
 * under a written id is a card the deck gained, an emptied one under a shipped
 * id is a card it lost to hiding. A document that will not parse contributes
 * nothing, which is exactly what it contributes to the deck. */
function deckCards(d) {
  const shipped = Number(d.cards) || 0;
  let cards = null;
  try {
    const raw = localStorage.getItem(MUNIN.cardsKey(d.id));
    cards = raw === null ? null : JSON.parse(raw).cards;
  } catch (e) {
    return shipped;
  }
  if (!cards || typeof cards !== 'object') return shipped;
  let total = shipped;
  for (const [id, rec] of Object.entries(cards)) {
    if (!rec || typeof rec !== 'object') continue;
    if (id.startsWith('u.')) { if (rec.front) total++; }
    else if (rec.hidden === true) total--;
  }
  return Math.max(0, total);
}

/* An imported deck is titled by whoever made the .apkg, so everything about it
 * on this screen is escaped. */
function localTile(d) {
  const art = MUNIN_DOODLE[d.art] || MUNIN_DOODLE[MUNIN.theme.fallback];
  const shelfArtwork = publicPresentationOf(d)?.shelfArtwork;
  const emblem = shelfArtwork
    ? `<span class="shelf-art-frame">${tileArt(art)}<img alt="" hidden
        data-local-shelf-art="${escHtml(shelfArtwork)}" data-local-deck="${escHtml(d.id)}"></span>`
    : tileArt(art);
  const done = deckProgress(d.id);
  const cards = deckCards(d);
  return `<div class="shelf-row">
    <button type="button" class="shelf-tile" data-course="${escHtml(d.id)}"
        style="--tile-accent:${escHtml(MUNIN.theme.accent.light)}">
      ${emblem}
      <span><b>${escHtml(d.title)}</b><small>your deck · ${cards.toLocaleString('en-GB')
      } ${cards === 1 ? 'card' : 'cards'} · ${
  new Date(d.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      }${done ? ' · ' + done : ''}</small></span>
    </button>
    <button type="button" class="shelf-del" data-del="${escHtml(d.id)}"
      data-name="${escHtml(d.title)}" aria-label="Remove ${escHtml(d.title)}">✕</button>
  </div>`;
}

/* Shelf metadata is intentionally small: list() never fetches cards or media.
 * Observe only the one declared shelf image per visible public course, then
 * resolve that source through its stored source→index map. No authored URL is
 * assigned to src, and closing the selector revokes every blob: URL it made. */
function hydrateLocalShelfArtwork(root, decks, store) {
  const byId = new Map((decks || []).map((deck) => [deck.id, deck]));
  const resolvers = new Map();
  let stopped = false;
  const load = async (image) => {
    const deck = byId.get(image.dataset.localDeck);
    const source = publicPresentationOf(deck)?.shelfArtwork;
    if (!deck || !source || source !== image.dataset.localShelfArt) return;
    let resolver = resolvers.get(deck.id);
    if (!resolver) {
      resolver = localMediaResolver(store, deck);
      resolvers.set(deck.id, resolver);
    }
    let url = null;
    try {
      url = await resolver.resolveMediaSource(source);
    } catch (error) {
      return;
    }
    if (!url || stopped || !image.isConnected
        || image.dataset.localShelfArt !== source) return;
    const fallback = image.parentElement?.querySelector('.dood');
    image.addEventListener('load', () => {
      if (!image.isConnected) return;
      image.hidden = false;
      if (fallback) fallback.hidden = true;
    }, { once: true });
    image.src = url;
  };
  const images = [...root.querySelectorAll('img[data-local-shelf-art]')];
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const image = entry.target.querySelector('img[data-local-shelf-art]');
        if (image) load(image);
      }
    }, { root, rootMargin: '80px' })
    : null;
  if (observer) {
    // The <img> stays hidden until it loads, so observe its always-visible
    // fallback frame rather than an element with no intersection box.
    for (const image of images) observer.observe(image.parentElement);
  } else {
    // Still one bounded image per course, never its card-media library.
    for (const image of images) load(image);
  }
  return () => {
    stopped = true;
    observer?.disconnect();
    for (const resolver of resolvers.values()) resolver.close();
    resolvers.clear();
  };
}

/** Share the app's course selector, never a deep link or anyone's local data. */
function shelfShareUrl() {
  return new URL('./', location.href).href;
}

async function copyShelfLink(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  // Older WebViews can share neither natively nor through the async clipboard.
  // Keep the last fallback local and short-lived; no link is left in the DOM.
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand?.('copy');
  field.remove();
  if (!copied) throw new Error('copy unavailable');
}

async function shareShelf(button, status) {
  const data = {
    title: 'keep club',
    text: 'membership pays in memories.',
    url: shelfShareUrl(),
  };
  const say = (message) => {
    clearTimeout(button._shareReset);
    button.textContent = message;
    status.textContent = message === 'copied' ? 'Link copied.' : `${message}.`;
    button._shareReset = setTimeout(() => {
      button.textContent = 'share';
      status.textContent = '';
    }, 2200);
  };

  button.disabled = true;
  try {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(data);
        say('shared');
        return;
      } catch (e) {
        // Closing the system sheet is a choice, not an error that needs a
        // warning or an unsolicited clipboard write.
        if (e?.name === 'AbortError') return;
      }
    }
    await copyShelfLink(data.url);
    say('copied');
  } catch (e) {
    console.error(e);
    say('try again');
  } finally {
    button.disabled = false;
  }
}

/** The picker. `asOverlay` puts it in front of an open course; `say` is what
 *  went wrong on the way here, drawn where the tiles are. */
async function renderShelf(asOverlay, say) {
  if (!asOverlay) {
    injectAccent(MUNIN.theme.accent);
    document.title = 'keep club';
  }
  ensureShelfCss();

  // Neither the registry nor any one course may stop the picker drawing. The
  // shelf with nothing on it but "+ your own deck" is a bad day; a blank page
  // is a broken app.
  let ids = [], bad = [], lost = false;
  try {
    ({ ids, bad } = await readRegistry());
  } catch (e) {
    console.error('course list:', e);
    lost = true;
  }
  const metas = await Promise.all(ids.map(courseMeta));

  // Imported decks, if the browser will tell us about them. A database that
  // will not open is not a reason for the shelf to fail to draw — and `null`
  // rather than `[]`, because "we could not ask" must never be swept as "you
  // have none".
  let mine = null;
  let localStore = null;
  try {
    localStore = await import('./lib/store.js');
    mine = await localStore.list();
  } catch (e) {
    console.error(e);
  }
  try {
    sweepOrphans(mine, lost ? null : ids);
  } catch (e) {
    console.error(e);
  }

  const tiles = metas.map((c, i) => (c ? courseTile(c) : brokenTile(ids[i])))
    .concat(bad.map(brokenTile)).join('');
  const el = document.createElement('div');
  el.className = 'shelf on';
  if (asOverlay) {
    // A panel that covers everything is a dialog, and the importer next door
    // already spells out what that means: named, modal, and the only thing on
    // the page you can reach while it is up.
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Courses');
  }
  el.innerHTML = `<div class="shelf-inner">
    <div class="shelf-mark">${muninDoodle('tower')}<h1>keep club</h1>
      <button type="button" class="icon-btn" id="shelf-theme" aria-label="Switch colour theme"
        title="Switch colour theme"><span aria-hidden="true" data-theme-glyph></span></button>
      ${asOverlay ? `<button type="button" class="icon-btn shelf-x" id="shelf-x"
        aria-label="Close" title="Close">✕</button>` : ''}
    </div>
    <div class="shelf-intro">
      <p class="shelf-sub">membership pays in memories.</p>
      ${asOverlay ? '' : `<button type="button" class="shelf-share" id="shelf-share">share</button>
      <span class="sr" id="shelf-share-status" role="status" aria-live="polite"></span>`}
    </div>
    <div class="shelf-tiles">
      ${say ? `<div class="shelf-tile broken">${muninDoodle('peek')}
        <span><b>${escHtml(say)}</b><small>pick one below to carry on</small></span></div>` : ''}
      ${tiles}
      ${(mine || []).map(localTile).join('')}
      ${lost ? `<div class="shelf-tile broken">${muninDoodle('peek')}
        <span><b>the courses are not answering</b><small>reload, or check you are
        online — your own decks are unaffected</small></span></div>` : ''}
      <button type="button" class="shelf-tile byo" data-byo><span>+ your own deck</span></button>
    </div>
    <div class="shelf-install" id="shelf-install" hidden>
      <b>learn every day</b>
      <ol class="shelf-install-steps"></ol>
      <button type="button" id="shelf-install-btn" hidden>install</button>
    </div>
    <!-- What the app is, on the screen you meet before you have picked
         anything. It sat on Home under the study button, which is a manual
         offered to somebody who is already studying, and it was closed there
         every time. Folded, as it has always been: the summary is the
         invitation and the paragraphs are one tap away. -->
    <details class="how" id="how">
      <summary>How this works</summary>
      <p>You are shown a question. Try to answer it in your head, then tap the
         card to see whether you were right, and say how it went.</p>
      <p><b>Again</b> means you did not know it. <b>Hard</b> means you got there,
         slowly. <b>Good</b> means you knew it. <b>Easy</b> means it was obvious.
         Be honest — the app uses your answer to decide when to show the card
         next, so flattering yourself just means seeing it less.</p>
      <p>Cards you find hard come back within minutes. Cards you know come back
         in days, then weeks. That is the whole trick: you spend your time on
         the material you have not learned yet.</p>
      <p>Progress starts in this browser. Built-in courses only share it if
         you turn on Sync; imported decks always stay here. Export a backup
         from Settings before you change phone.</p>
    </details>
      <p class="shelf-note">${asOverlay ? ''
    : 'pick a course — it opens straight here next time'}</p>
  </div>`;
  document.body.appendChild(el);
  const stopShelfArtwork = localStore
    ? hydrateLocalShelfArtwork(el, mine, localStore) : () => {};
  const pageLeaving = () => stopShelfArtwork();
  addEventListener('pagehide', pageLeaving, { once: true });
  if (!asOverlay) {
    const main = el.querySelector('.shelf-inner');
    main.id = 'shelf-main';
    main.tabIndex = -1;
    document.querySelector('.skip')?.setAttribute('href', '#shelf-main');
  }
  el.querySelector('#shelf-theme').addEventListener('click', () => MuninTheme.cycle());
  // Only the cold picker carries it: mid-course there is a course to share, and
  // Done and Progress are where the app offers that.
  el.querySelector('#shelf-share')?.addEventListener('click', (e) =>
    shareShelf(e.currentTarget, el.querySelector('#shelf-share-status')));
  el.querySelector('#shelf-install-btn').addEventListener('click', () => MuninInstall.prompt());
  MuninTheme.apply();
  renderShelfInstall();

  /* Getting out of it. There was one way — tapping the 20px strip down either
   * edge — the note named a gesture that does nothing (the gap between two
   * tiles is inside the card), Escape did nothing, and focus stayed on the pill
   * the panel had just covered. Everything underneath is inert while it is up,
   * or four Tabs put the focus ring on a control nobody can see. Only what this
   * overlay made inert is given back: an importer opened on top of it inerts
   * this panel in turn, and neither may undo the other's work. */
  const opener = asOverlay ? document.querySelector('.shelf-btn') : null;
  const under = asOverlay
    ? [...document.body.children].filter((n) => n !== el && !n.inert) : [];
  const historyToken = asOverlay
    ? Date.now().toString(36) + Math.random().toString(36).slice(2) : '';
  const focusable = () => [...el.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]),'
      + ' [tabindex]:not([tabindex="-1"])'
  )].filter((node) => !node.hidden && !node.inert && node.getClientRects().length);
  const modalKeys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!e.repeat) closeOverlay();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = focusable();
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey
        && (document.activeElement === last || !el.contains(document.activeElement))) {
      e.preventDefault();
      first.focus();
    }
  };
  const pop = () => {
    if (history.state?.muninShelf === historyToken) return;
    closeOverlay(true);
  };
  function closeOverlay(fromHistory) {
    if (!fromHistory && history.state?.muninShelf === historyToken) {
      history.back();
      return;
    }
    removeEventListener('keydown', modalKeys);
    removeEventListener('popstate', pop);
    removeEventListener('pagehide', pageLeaving);
    stopShelfArtwork();
    for (const u of under) u.inert = false;
    el.remove();
    // Back to the control that opened it, not to the top of the document.
    if (opener && opener.isConnected) opener.focus();
  }
  if (asOverlay) {
    for (const u of under) u.inert = true;
    history.pushState(Object.assign({}, history.state, { muninShelf: historyToken }), '');
    addEventListener('popstate', pop);
    addEventListener('keydown', modalKeys);
    el.querySelector('#shelf-x').addEventListener('click', () => closeOverlay(false));
    el.querySelector('#shelf-x').focus();
    // Dismiss by clicking the backdrop, and only that. "Anything not inside the
    // card" looked equivalent and was not: the theme button redraws its own
    // glyph the moment it is pressed, so by the time the click reached here the
    // thing that had been clicked was a detached <path> with no ancestors at
    // all — and this panel tore itself off the page every time somebody changed
    // the colour from it. The test is where the click landed, which is the same
    // test the card sheet and the settings sheet use.
    el.addEventListener('click', (e) => {
      if (e.target === el) closeOverlay();
    });
  }

  el.addEventListener('click', async (e) => {
    const byo = e.target.closest('[data-byo]');
    if (byo) {
      // One importer. The module is fetched on the first tap and the second tap
      // of an ordinary double-tap lands inside that fetch, so the flag covers
      // the wait and the dialog itself covers everything after it: two stacked
      // importers are identical and opaque, and closing one reads as a ✕ that
      // does nothing while it hands the shelf behind back to the Tab key.
      if (impOpening || document.querySelector('.imp')) return;
      impOpening = true;
      const note = el.querySelector('.shelf-note');
      // Whatever this line was saying before, said again once the importer is
      // up: this is the shelf's own caption and the importer only borrows it
      // while the module is on its way. Left set, the shelf grew a permanent
      // "reading it here on your device — nothing is uploaded" — lowercase, no
      // subject, starting mid-clause — under a row of course tiles, which reads
      // as a glitch rather than as reassurance about a file you did not pick.
      const said = note.textContent;
      note.textContent = 'reading it here on your device — nothing is uploaded';
      try {
        const { openImporter } = await import('./import.js');
        openImporter();
        note.textContent = said;
      } catch (err) {
        console.error(err);
        note.textContent = 'the importer could not load — try again once you are online';
      } finally {
        impOpening = false;
      }
      return;
    }

    // Removing a deck takes two taps and no dialog: the button says what the
    // next tap does. Anything else you touch puts it away again — an armed
    // delete left sitting on the shelf is how you lose the wrong deck.
    const del = e.target.closest('[data-del]');
    if (!del) disarm(el);
    if (del) {
      if (!del.dataset.armed) {
        disarm(el);
        del.dataset.armed = '1';
        del.textContent = 'remove?';
        del.setAttribute('aria-label', 'Remove ' + del.dataset.name + ' — press again to confirm');
        armedAt = Date.now();
        clearTimeout(disarmAt);
        disarmAt = setTimeout(() => disarm(el), 5000);
        return;
      }
      // Still the same gesture. The arm stands, and so does its five seconds.
      if (Date.now() - armedAt < ARM_MS) return;
      const id = del.dataset.del;
      del.textContent = '…';
      try {
        await (await import('./lib/store.js')).remove(id);
      } catch (err) {
        console.error(err);
        del.textContent = '✕';
        return;
      }
      try {
        if (localStorage.getItem(MUNIN.lastKey) === id) localStorage.removeItem(MUNIN.lastKey);
      } catch (err) {
        console.warn('deck removed, but its resume pointer could not be cleared', err);
      }
      // If that was the deck being studied, the screen behind this overlay is
      // now a session over a deck that does not exist: answers would be written
      // to a key nothing will ever read again.
      if (globalThis.COURSE && COURSE.id === id) { location.reload(); return; }
      del.closest('.shelf-row').remove();
      return;
    }

    const tile = e.target.closest('[data-course]');
    if (!tile) return;
    if (asOverlay && tile.dataset.course === localStorage.getItem(MUNIN.lastKey)) {
      closeOverlay();
      return;
    }
    enterCourse(tile.dataset.course);
  });

  // Last, and only now: the shelf is on the page and every control on it
  // answers. A splash held over a shelf whose buttons are not wired yet is a
  // second of the app ignoring you.
  if (!asOverlay) {
    await dismissBoot();
    prefetchScenes(metas);
  }
}

/* Inside a course: a small pill that overlays the shelf. It never clears the
 * resume state — the next cold open still lands in the last course entered. */
function mountShelfButton(c) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'shelf-btn';
  b.innerHTML = muninDoodle('tower') + '<span>courses</span>';
  b.addEventListener('click', async () => {
    if (shelfOpening || document.querySelector('.shelf.on[role="dialog"]')) return;
    shelfOpening = true;
    try { await renderShelf(true); }
    finally { shelfOpening = false; }
  });
  ensureShelfCss();
  // First in the header's own corner, ahead of the settings mark. One button,
  // not one per screen: app.js's go() carries this same element into whichever
  // header is on screen, so there is a single control to focus, to inert and to
  // give the focus back to — and, appended to the end of the body as it once
  // was, it had been the last of thirty-three tab stops while sitting in the
  // top-right corner. Home's header is where it starts, because home is the
  // screen a course opens on.
  const slot = document.querySelector('#s-home .top-acts') || document.querySelector('.top-acts');
  if (slot) slot.prepend(b);
  else {
    const app = document.getElementById('app');
    if (app) app.before(b); else document.body.appendChild(b);
  }
}

/* Offline is the product, so the worker is registered by the shell rather
 * than from inside a course: it used to be app.js, which never runs on the
 * picker — a visitor who landed on the shelf, read it and left had installed
 * nothing at all, including the "install" offer's own reason for existing. */
function registerWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  /* A new worker skipWaiting()s and claims this page the moment it installs, so
   * from that instant a page that is still running is serving one generation's
   * scripts out of the next generation's cache — the mismatch the worker's
   * read-through only fixes for a load that starts after the change. One
   * reload, and it starts after it.
   *
   * NOT ON THE FIRST-EVER CLAIM. There was no controller when this page loaded,
   * so nothing it is running came from a worker and nothing it holds is stale:
   * reloading there is a visible flicker on every new visitor, for nothing.
   * The flag is what stops a claim during the reload from starting another. */
  const wasControlled = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ── going places ──────────────────────────────────────────────────────────
 *
 * Two screens, one address. Entering a course is a fresh load — a course
 * brings its own bundle, and the shell never loads a course file up front — so
 * the picker and the course are two history entries over the same URL, and
 * which of them an entry stands for is written on the entry. app.js stacks the
 * screens inside a course on top of these (its `stops`); this is the floor
 * underneath them.
 */
function place(where) {
  const st = history.state;
  // A stop app.js pushed that a reload mid-session left behind, with the course
  // coming back up over it: app.js steps past those itself on the first press,
  // and writing over one here would hide it from that. Landing on the picker
  // instead means app.js is not coming, so there is nobody to hide it from.
  if (st && st.stop && where === 'course') return;
  if (st && st.munin === where) return;
  history.replaceState({ munin: where }, '');
}

/* Opening a course, from a tile or from the end of an import. The picker keeps
 * the entry it is on and the course goes on top of it, so Back comes back to
 * the picker instead of out of the app.
 *
 * From an overlay, consume that overlay (plus an importer and tab stop when
 * present) before reloading. Otherwise the old course or a vanished dialog is
 * the next entry and the first Back press appears to do nothing. The overlay
 * tokens are copied into the top state, so the exact number of entries to
 * unwind is explicit rather than guessed from the DOM.
 */
function enterCourse(id) {
  let remembered = true;
  try {
    localStorage.setItem(MUNIN.lastKey, id);
  } catch (e) {
    remembered = false;
    console.warn('course can open, but could not become the resume target', e);
  }

  // A one-shot deep link still opens a committed imported deck when only the
  // convenience pointer is blocked. replace() avoids leaving the finished
  // importer as a dead history entry underneath it.
  const load = () => {
    if (remembered) location.reload();
    else location.replace('./?course=' + encodeURIComponent(id));
  };
  const st = history.state || {};

  if (st.muninShelf) {
    let entries = 1; // the shelf overlay itself
    if (st.muninImporter) entries++;
    if (st.stop) entries++; // Browse/Progress (or another in-course stop)
    addEventListener('popstate', load, { once: true });
    history.go(-entries);
    return;
  }

  // Importing from the full picker already has the right shelf entry beneath
  // it. Turn the importer entry into the course instead of adding a third.
  if (st.muninImporter) {
    history.replaceState({ munin: 'course' }, '');
    load();
    return;
  }

  if (!history.state || st.munin === 'shelf') {
    history.pushState({ munin: 'course' }, '');
  }
  load();
}
MUNIN.enter = enterCourse;

/* ── one-time move from kkonrad.com/munin ────────────────────────────────
 *
 * localStorage and IndexedDB are origin-scoped, so a redirect alone would
 * strand progress on kkonrad.com. The retirement page opens keepclub.app with
 * a random fragment token, waits for this handshake, then sends only this
 * app's state and imported decks. The fragment never reaches either server.
 */
async function importLegacyPayload(payload) {
  const decks = Array.isArray(payload && payload.decks) ? payload.decks : [];
  const remap = {};
  let imported = 0;

  if (decks.length) {
    const store = await import('./lib/store.js');
    const taken = new Set((await store.list()).map((deck) => deck.id));
    for (const bundle of decks) {
      const record = bundle && bundle.record;
      const oldId = record && record.id;
      if (!/^local-[a-z0-9]+$/.test(String(oldId || ''))
          || !record.deck || !Array.isArray(record.deck.cards)) continue;

      let id = oldId;
      let shouldStore = true;
      const existing = await store.get(id);
      if (existing) {
        // Migration is an automatic copy, not the importer's explicit
        // "replace" choice. Card overlap cannot authorize overwriting a newer
        // deck already at keepclub.app: an older version naturally overlaps
        // most of its successor. An exact deck is already here; every other
        // collision gets a new id so both cards and both media sets survive.
        if (DSSync.stable(existing.deck) === DSSync.stable(record.deck)) {
          shouldStore = false;
        } else {
          do {
            id = 'local-' + Date.now().toString(36)
              + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
          } while (taken.has(id));
        }
      }
      taken.add(id);
      remap[oldId] = id;

      // The retired mirror ships media as {i, name, kind} with kinds 'img' and
      // 'snd'; store.put() keys on storageIndex and reads source/mediaType, so
      // the wire shape has to be translated here — the sender is frozen.
      const media = (Array.isArray(bundle.media) ? bundle.media : [])
        .filter((item) => Number.isInteger(Number(item.i)) && item.bytes)
        .map((item) => ({
          storageIndex: Number(item.i),
          source: String(item.name || ''),
          mediaType: item.kind === 'snd' || item.kind === 'audio' ? 'audio' : 'image',
          bytes: item.bytes instanceof Uint8Array
            ? item.bytes
            : new Uint8Array(item.bytes),
        }));
      if (shouldStore) {
        await store.put(Object.assign({}, record, { id }), media);
        imported++;
      }
    }
  }

  let histories = 0;
  const entries = Array.isArray(payload && payload.local) ? payload.local : [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    let [key, value] = entry;
    if (key === MUNIN.lastKey) continue; // land on the shelf and show the receipt

    const stateMatch = /^munin\/(local-[a-z0-9]+|[a-z0-9][a-z0-9-]{0,63})\/state\/v1$/.exec(key);
    if (stateMatch) {
      const id = remap[stateMatch[1]] || stateMatch[1];
      key = MUNIN.stateKey(id);
      let incoming, current;
      try {
        incoming = JSON.parse(value);
        current = JSON.parse(localStorage.getItem(key) || 'null');
      } catch (e) {
        continue;
      }
      localStorage.setItem(key, JSON.stringify(DSSync.mergeState(current, incoming)));
      histories++;
      continue;
    }

    // Theme and sync identity are global device choices. Keep a choice already
    // made on keepclub.app; otherwise carry the old one across.
    if ((key === MuninTheme.key || key === DSSync.KEY)
        && localStorage.getItem(key) === null) {
      localStorage.setItem(key, value);
    }
  }

  return { histories, imported };
}

function receiveLegacyMigration() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const token = params.get('move');
  const source = window.opener;
  const legacyOrigin = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? 'http://127.0.0.1:8766'
    : 'https://kkonrad.com';
  if (!source || !/^[A-Za-z0-9_-]{16,128}$/.test(String(token || ''))) {
    return Promise.resolve('');
  }

  return new Promise((resolve) => {
    const finish = (message) => {
      removeEventListener('message', onMessage);
      clearTimeout(timeout);
      const url = new URL(location.href);
      url.hash = '';
      history.replaceState(history.state, '', url.pathname + url.search);
      resolve(message);
    };
    const onMessage = async (event) => {
      if (event.origin !== legacyOrigin || event.source !== source
          || event.data?.type !== 'keepclub:migration'
          || event.data?.token !== token) return;
      try {
        const result = await importLegacyPayload(event.data.payload);
        source.postMessage({
          type: 'keepclub:migration-complete',
          token,
          result,
        }, legacyOrigin);
        const parts = [];
        if (result.histories) {
          parts.push(`${result.histories} progress ${result.histories === 1 ? 'record' : 'records'}`);
        }
        if (result.imported) {
          parts.push(`${result.imported} imported ${result.imported === 1 ? 'deck' : 'decks'}`);
        }
        finish(parts.length
          ? `moved ${parts.join(' and ')} from kkonrad.com`
          : 'there was no keep club progress to move');
      } catch (error) {
        console.error('legacy migration:', error);
        source.postMessage({
          type: 'keepclub:migration-failed',
          token,
          error: error && error.message ? error.message : 'move failed',
        }, legacyOrigin);
        finish('the move could not finish — your original data is still safe on kkonrad.com');
      }
    };
    addEventListener('message', onMessage);
    const timeout = setTimeout(() => {
      finish('the move timed out — your original data is still safe on kkonrad.com');
    }, 120000);
    source.postMessage({ type: 'keepclub:migration-ready', token }, legacyOrigin);
  });
}

/* Back out of a course, and Forward back into it.
 *
 * The press lands on the entry underneath without loading anything — the shell
 * is still running the course it was running, and the entry now says shelf. So
 * reload, which is the same fresh load entering a course is, in the other
 * direction: the boot below reads the entry and draws the picker. */
addEventListener('popstate', () => {
  const want = history.state && history.state.munin;
  const inCourse = !!globalThis.COURSE;
  if (inCourse) {
    if (want === 'shelf') location.reload();
    return;
  }
  if (want !== 'course') return;
  // Forward, back into the course this entry stands for — unless it stands for
  // nothing, which is what a deck removed from under it leaves behind. Carry
  // the press on down rather than spending it on an entry with no screen.
  if (localStorage.getItem(MUNIN.lastKey)) location.reload();
  else history.back();
});

(async function main() {
  const migrationSay = await receiveLegacyMigration();
  MuninTheme.apply();
  initPullToRefresh();
  registerWorker();
  watchBoot();
  const known = (id) => MUNIN.idOk(id) || isLocal(id);
  // ?course=<id> deep-links a course, and becomes the resume target once it
  // has actually opened. Written eagerly, a stale or mistyped shared link
  // overwrote the resume pointer and the failure handler then deleted it, so
  // one tap on a dead link cost you the course you were in the middle of.
  const q = new URLSearchParams(location.search).get('course');
  const stored = localStorage.getItem(MUNIN.lastKey);
  /* The bare URL used to mean two things at once: "the picker" and "resume
   * where I was". A Back press out of a course lands on it needing the first
   * and would get the second — the course opening itself again, which is a
   * press that does nothing. Which one it is, is written on the history entry
   * (see place() and the popstate handler below), so the address can stay the
   * one address the whole app lives at. A cold open has no entry state at all
   * and still resumes; a deep link says what it wants out loud and wins. */
  const backToShelf = !q && !!(history.state && history.state.munin === 'shelf');
  const target = migrationSay ? null : (backToShelf ? null : (q && known(q) ? q : stored));

  /* ONE SHOT, and this is where it is spent. Entering a course is a reload,
   * which keeps the query string, so a parameter left in the address bar beat
   * the picker on every boot after the first: you tapped Competent Crew, the
   * page reloaded, and the deep-linked course opened again — and a deck you
   * imported under such a URL sat on the shelf and could never be opened,
   * which reads as "my import vanished". Consumed here, whether it was any
   * good or not, so that from now on the picker is what says where you go. */
  if (q !== null) {
    const u = new URL(location.href);
    u.searchParams.delete('course');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }

  // The scene is replayed for whatever is actually about to open — the query
  // is read first for that reason, or a deep link paints the course you were
  // in last for as long as the new one takes to arrive.
  replayBoot(target);

  /* A course that is not here used to drop you on the ordinary first-run shelf,
   * so a stale link somebody sent you was indistinguishable from a first visit
   * — and `?course=Day-Skipper`, which is the right course with a capital in
   * it, from a name nobody has ever heard of. The shelf says it, the way it
   * already says a registry would not answer. */
  const missing = (id) => (isLocal(id)
    ? 'that deck is not on this device any more'
    : 'that course is not here');

  if (target && known(target)) {
    /* A cold open resumes the last course, and Back out of a course is the
     * picker — but on a cold open there is nothing underneath to come back to,
     * so the picker is put there. Only where the entry is brand new: a reload
     * of a course sits on an entry that already says "course", and a second
     * copy on every reload would be a Back press per reload. Not under a deep
     * link either — that Back belongs to whoever's page you were on. */
    if (!q && history.state === null) {
      history.replaceState({ munin: 'shelf' }, '');
      history.pushState({ munin: 'course' }, '');
    }
    place('course');
    (isLocal(target) ? bootLocal(target) : bootCourse(target))
      // The course is already open at this point. A quota/security failure in
      // the small resume pointer must not be reported as if the deck failed to
      // load and cover the usable app with the shelf.
      .then(() => {
        try { localStorage.setItem(MUNIN.lastKey, target); }
        catch (e) { console.warn('course opened, but could not become the resume target', e); }
      })
      .catch((e) => {
        // A deck that was deleted, or a course that was renamed, sends you to
        // the shelf instead of to a dead screen. Only the stored pointer is
        // forgotten, and only if it is the thing that failed.
        console.error(e);
        if (stored === target) localStorage.removeItem(MUNIN.lastKey);
        place('shelf');
        renderShelf(false, missing(target)).catch(console.error);
      });
  } else {
    place('shelf');
    renderShelf(false, migrationSay || (q ? missing(q) : '')).catch(console.error);
  }
})().catch(console.error);
