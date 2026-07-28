/* Munin — the shell in front of the courses.
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
 * Sync is deliberately OFF in this build. The live Day Skipper app at
 * /day-skipper shares this origin and its Supabase rows; Munin joining that
 * sync before the parity gate would corrupt real study state. DSSync below is
 * a stub with the full surface app.js touches.
 */
'use strict';

const MUNIN = {
  lastKey: 'munin/last-course',
  /* Every place that names a storage slot names it here. These templates used
   * to be written out by hand in app.js, store.js and the orphan sweep, which
   * is three chances to change one of them and not the others. */
  stateKey: (id) => 'munin/' + id + '/state/v1',
  resetKey: (id) => 'munin/' + id + '/state/v1/reset',
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
    boot: { art: 'perch', line: 'Loading…' },
    fallback: 'perch',
    /* Ten of them, named. The frieze is ten drawings and no more — that is
     * what fits a 320px screen without a sideways scrollbar — so it cannot be
     * "whatever MUNIN_DOODLE holds": the set grew to fourteen the day the
     * hoard needed fourteen distinct drawings. The gate keeps this a subset. */
    friezeArt: ['perch', 'peek', 'flap', 'carry', 'roost',
      'hoard', 'puff', 'strut', 'quill', 'bow'],
    notice: 'Revision material. Progress is stored on this device only.',
  },
};
globalThis.MUNIN = MUNIN;

const isLocal = (id) => /^local-[a-z0-9]+$/.test(String(id || ''));

/* app.js calls these; every one is a no-op that reports "sync off". */
globalThis.DSSync = {
  KEY: 'munin/sync-off',
  enabled: () => false,
  status: () => ({}),
  schedule: () => {},
  sync: async () => {},
  stable: (s) => JSON.stringify(s),
  formatKey: () => '—',
  normaliseKey: (k) => k,
  init: () => {},
  turnOn: () => {},
  turnOff: () => {},
};

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

  /** Nothing to say to a browser that can neither prompt nor be told how. */
  offerable() {
    return !MuninInstall.installed() && (MuninInstall.event || MuninInstall.ios());
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
function injectAccent(a) {
  const old = document.getElementById('course-theme');
  if (old) old.remove();
  const s = document.createElement('style');
  s.id = 'course-theme';
  s.textContent = `
    :root { --accent: ${a.light}; --accent-ink: ${a.inkLight}; --g4: ${a.light}; }
    :root[data-theme="light"] { --accent: ${a.light}; --accent-ink: ${a.inkLight}; --g4: ${a.light}; }
    :root[data-theme="dark"] { --accent: ${a.dark}; --accent-ink: ${a.inkDark}; --g4: ${a.dark}; }`;
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
  injectAccent(c.accent);
  const line = document.getElementById('boot-line');
  if (line && c.boot.line) line.textContent = c.boot.line;
  document.title = 'Munin — ' + c.title;
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

/* A deck someone imported. It has no folder and no files: the cards are in
 * IndexedDB and its pictures are blobs, so the shell hands app.js the deck
 * itself rather than a path to fetch. It brings no theme of its own, so
 * withDefaults dresses it entirely in Munin's — the same fallback any course
 * gets for the slots it leaves empty. */
async function bootLocal(id) {
  const store = await import('./lib/store.js');
  const rec = await store.get(id);
  if (!rec) throw new Error('that deck is not here any more');

  // Imported media is resolved lazily by app.js when a card or Browse row is
  // rendered. Loading every Blob here made a 100 MiB deck consume all 100 MiB
  // before Home appeared.
  const urls = new Map();
  const pending = new Map();
  let mediaClosed = false;
  let mediaGeneration = 0;
  const mediaUrl = async (index) => {
    if (mediaClosed) return null;
    if (urls.has(index)) return urls.get(index);
    if (pending.has(index)) return pending.get(index);
    const generation = mediaGeneration;
    const load = store.mediaBlob(id, index).then((blob) => {
      if (pending.get(index) === load) pending.delete(index);
      if (!blob || mediaClosed || generation !== mediaGeneration) return null;
      const url = URL.createObjectURL(blob);
      urls.set(index, url);
      return url;
    }, (e) => {
      if (pending.get(index) === load) pending.delete(index);
      throw e;
    });
    pending.set(index, load);
    return load;
  };
  addEventListener('pagehide', () => {
    mediaClosed = true;
    mediaGeneration++;
    pending.clear();
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  });
  addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    mediaClosed = false;
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
    base: '',
    boot: { art: rec.art || MUNIN.theme.boot.art, line: 'Loading your deck…' },
    sectionArt: rec.sectionArt || {},
    groupArt: rec.groupArt || {},
    deck: rec.deck,
    mediaUrl,
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
    when.textContent = `imported ${new Date(rec.created).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric' })} from an anki package`;
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
  .shelf-sub { color: var(--muted); font-size: .84rem; margin: 0 0 22px; }
  .shelf-tiles { display: flex; flex-direction: column; gap: 14px; }
  .shelf-tile { display: flex; align-items: center; gap: 12px; text-align: left;
    background: var(--surface); color: inherit; font: inherit; cursor: pointer;
    border: var(--bw) solid var(--stroke); border-left-width: 6px;
    border-left-color: var(--tile-accent, var(--stroke));
    border-radius: var(--r); box-shadow: var(--sh); padding: 14px 16px; min-height: var(--tap); }
  .shelf-tile .dood { width: 34px; height: 34px; flex: none; color: var(--tile-accent, var(--text)); }
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
  .shelf-btn { position: fixed; top: calc(10px + env(safe-area-inset-top)); right: 12px;
    z-index: 80; display: inline-flex; align-items: center; gap: 6px;
    background: var(--surface); color: var(--text); font: inherit; font-size: .78rem;
    text-transform: lowercase; cursor: pointer; border: var(--bw) solid var(--stroke);
    border-radius: 99px; box-shadow: var(--sh-sm); padding: 5px 12px;
    /* The one control that changes course, pinned where a phone's own chrome
     * crowds it, held to the same 48px as every other target in the app. */
    min-height: var(--tap); }
  .shelf-btn .dood { width: 16px; height: 16px; }
  /* Mid-session the pill would sit on the study header; a session is not the
   * moment to change course anyway. Home, Browse and Progress keep it. */
  body:has(#s-study:not([hidden])) .shelf-btn { display: none; }`;

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

/* Study history, and cached loading screens, for decks that are not here.
 *
 * store.remove() deletes the state key as it goes, but the deck being removed
 * may be the one open behind this overlay, and that session writes its state
 * again on the way out — so the key comes back a moment after it was deleted,
 * owned by nothing, for ever. Collecting orphans whenever the shelf draws is
 * the only point where the full list of decks is in hand anyway.
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
      const s = /^munin\/(local-[a-z0-9]+)\/state\/v1$/.exec(k);
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

/* An imported deck is titled by whoever made the .apkg, so everything about it
 * on this screen is escaped. */
function localTile(d) {
  const art = MUNIN_DOODLE[d.art] || MUNIN_DOODLE[MUNIN.theme.fallback];
  const done = deckProgress(d.id);
  return `<div class="shelf-row">
    <button type="button" class="shelf-tile" data-course="${escHtml(d.id)}"
        style="--tile-accent:${escHtml(MUNIN.theme.accent.light)}">
      ${tileArt(art)}
      <span><b>${escHtml(d.title)}</b><small>your deck · ${Number(d.cards).toLocaleString('en-GB')
      } cards · ${new Date(d.created).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
      }${done ? ' · ' + done : ''}</small></span>
    </button>
    <button type="button" class="shelf-del" data-del="${escHtml(d.id)}"
      data-name="${escHtml(d.title)}" aria-label="Remove ${escHtml(d.title)}">✕</button>
  </div>`;
}

/** The picker. `asOverlay` puts it in front of an open course; `say` is what
 *  went wrong on the way here, drawn where the tiles are. */
async function renderShelf(asOverlay, say) {
  if (!asOverlay) {
    injectAccent(MUNIN.theme.accent);
    document.title = 'Munin';
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
  try {
    mine = await (await import('./lib/store.js')).list();
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
    <div class="shelf-mark">${muninDoodle('perch')}<h1>munin</h1>
      <button type="button" class="icon-btn" id="shelf-theme" aria-label="Switch colour theme"
        title="Switch colour theme"><span aria-hidden="true" data-theme-glyph></span></button>
      ${asOverlay ? `<button type="button" class="icon-btn shelf-x" id="shelf-x"
        aria-label="Close" title="Close">✕</button>` : ''}
    </div>
    <p class="shelf-sub">a friendly raven who remembers for you</p>
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
      <p>spacing only pays if you turn up. one tap from your home screen, and the cards work with no signal.</p>
      <ol class="shelf-install-steps"></ol>
      <button type="button" id="shelf-install-btn" hidden>install</button>
    </div>
    <p class="shelf-note">${asOverlay ? 'tap the ✕ to go back to your course'
    : 'pick a course — it opens straight here next time'}</p>
  </div>`;
  document.body.appendChild(el);
  el.querySelector('#shelf-theme').addEventListener('click', () => MuninTheme.cycle());
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
    // Dismiss by clicking off the card, not by clicking anything that is not a
    // tile: the theme button and the remove button live up here too.
    el.addEventListener('click', (e) => {
      if (!e.target.closest('.shelf-inner')) closeOverlay();
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
      note.textContent = 'reading it here on your device — nothing is uploaded';
      try {
        const { openImporter } = await import('./import.js');
        openImporter();
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
  b.innerHTML = muninDoodle('perch') + '<span>courses</span>';
  b.addEventListener('click', async () => {
    if (shelfOpening || document.querySelector('.shelf.on[role="dialog"]')) return;
    shelfOpening = true;
    try { await renderShelf(true); }
    finally { shelfOpening = false; }
  });
  ensureShelfCss();
  // In front of the app, not after it. Appended to the end of the body it was
  // the last of thirty-three tab stops while sitting in the top-right corner:
  // the only route to another course, thirty-three presses away. The skip link
  // stays first — this goes between it and the screens.
  const app = document.getElementById('app');
  if (app) app.before(b); else document.body.appendChild(b);
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

(function main() {
  MuninTheme.apply();
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
  const target = backToShelf ? null : (q && known(q) ? q : stored);

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
    renderShelf(false, q ? missing(q) : '').catch(console.error);
  }
})();
