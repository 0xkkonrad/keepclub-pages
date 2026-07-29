/* Offline support.
 *
 * The shell and the card data are precached so the app opens with no network at
 * all. Diagrams are a few megabytes, so they are cached as they are first seen
 * rather than forced down on install — with a button in Progress → Offline to
 * pull the lot deliberately before you lose signal.
 *
 * One cache for the shell, one per course. They used to share a single cache
 * named after a hash of everything shipped, so editing one card in one course
 * evicted the app and every other course for everyone. They also used to share
 * a hand-written list of every course's files, which is the third place a new
 * course had to be registered — and the one you find last, because forgetting
 * it ships a course that works online and 404s offline.
 *
 * BUILD is stamped by scripts/deploy-to-keepclub.sh from the content actually
 * shipped: without that, a cache-first shell never updates.
 */
const BUILD = { shell: '44004c3cad', courses: { 'day-skipper': '414a4cb020', 'competent-crew': 'cd7c69cb93' } };
const SHELL_V = 'munin-shell-' + BUILD.shell;
const courseV = (id) => 'munin-course-' + id + '-' + (BUILD.courses[id] || 'dev');
const SCOPE = new URL('./', self.registration.scope).pathname;

/* Everything a course may ship. Optional members are normal: Competent Crew
 * has no clips, an unillustrated course has no figures. */
const COURSE_FILES = ['course.json', 'doodles.js', 'cards.json', 'figures.json',
  'figures.css', 'videos.json', 'boot.html', 'boot.css'];

/** Which course a same-origin path belongs to, if any. */
function courseOf(pathname) {
  const m = /\/courses\/([a-z0-9][a-z0-9-]*)\//.exec(pathname);
  return m ? m[1] : null;
}

/* The course list, or NULL if it could not be read.
 *
 * The difference matters more here than anywhere else in the app: this list
 * decides which caches are still wanted, and `[]` from a failed read used to
 * mean "no course exists", so one unparseable response — a half-written
 * deploy, a proxy error page served as JSON — deleted every course's cache,
 * including the megabytes of diagrams somebody deliberately saved for a
 * flight. The cached copy is tried when the network will not answer. */
async function readCourses() {
  const parse = async (r) => {
    const idx = await r.json();
    if (!idx || !Array.isArray(idx.courses)) throw new Error('no course list');
    return idx.courses.filter((s) => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s));
  };
  try {
    const r = await fetch('courses/index.json', { cache: 'no-cache' });
    if (r.ok) return await parse(r);
  } catch (e) { /* offline, or the fetch itself failed */ }
  try {
    const hit = await caches.match('courses/index.json');
    if (hit) return await parse(hit);
  } catch (e) { /* a cached copy that is not the registry either */ }
  return null;
}

/** What we expect back for a given path. A 200 is not enough: a captive portal
 *  answers every request with its own sign-in page. */
function typeFor(pathname) {
  if (pathname.endsWith('.js')) return 'application/javascript';
  if (pathname.endsWith('.css')) return 'text/css';
  if (pathname.endsWith('.json') || pathname.endsWith('.webmanifest')) return 'application/json';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.woff2')) return 'font/woff2';
  return 'text/html';
}

function ok(r, expected) {
  if (!r || !r.ok || r.type === 'opaque') return false;
  const got = (r.headers.get('content-type') || '').split(';')[0].trim();
  if (!got) return true;                       // some static servers say nothing
  if (expected === 'application/javascript') {
    return /javascript|ecmascript/.test(got);
  }
  if (expected === 'application/json') {
    return /json|manifest/.test(got);
  }
  return got === expected;
}

/** A login portal is HTML too. The application document has two stable,
 * structural marks that neither course content nor an origin-wide error page
 * owns; require both before storing or serving a navigation as Munin. */
async function appPageOk(r) {
  if (!ok(r, 'text/html')) return false;
  try {
    const html = await r.clone().text();
    return /\bid=["']app["']/.test(html)
      && /<script\b[^>]*\bsrc=["'][^"']*munin\.js["']/i.test(html);
  } catch (e) { return false; }
}

async function cachedAppPage() {
  for (const key of ['./', 'index.html']) {
    const hit = await caches.match(key, { ignoreSearch: true });
    if (await appPageOk(hit)) return hit;
  }
  return null;
}

// The install screenshots in shots/ are deliberately not in here: the browser
// reads them once, at install time, when it is by definition online. Precaching
// half a megabyte of shop window into the offline shell is the wrong trade.
const SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'sync.js',
  'munin.js',
  'doodles-munin.js',
  // The importer and its parsers. Loaded only when someone brings a deck, and
  // precached anyway: importing a file off your own disk is exactly the thing
  // that should not need a network.
  'import.js',
  'lib/anki.js',
  'lib/deck.js',
  'lib/html.js',
  // Public format-2 reader. These are dynamic imports at course boot; keeping
  // the exact graph in the shell makes an already-opened app able to restart
  // and read JSON or YAML-authored courses with no network.
  'lib/course.js',
  'lib/legacy-course.js',
  'lib/course-runtime.js',
  'lib/course-markdown.js',
  'lib/course-media.js',
  'lib/course-yaml.js',
  'lib/vendor/commonmark-parser-0.31.2.min.js',
  'lib/vendor/yaml-2.9.0.min.js',
  'lib/receipt.js',
  'lib/sqlite.js',
  'lib/store.js',
  'lib/template.js',
  'lib/unzip.js',
  // Imported by import.js AND by lib/deck.js. Missing here, the whole
  // importer module graph failed to resolve offline — which is the one place
  // it is most obviously supposed to work — and app.js's boot-time deck check
  // silently stopped running, because its import is a caught dynamic one.
  'lib/validate.js',
  'lib/vendor/fzstd.js',
  'manifest.webmanifest',
  'fonts/dm-mono-400.woff2',
  'fonts/architects-daughter.woff2',
  'fonts/dm-mono-500.woff2',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable.png',
  // The one list of courses. Every other place that needed it now reads it.
  'courses/index.json',
];
// './' is deliberately excluded: it reduces to the empty string, and
// `endsWith('')` is true of every path, which turned the runtime cache into
// "keep a permanent copy of every same-origin GET this page ever makes".
const SHELL_FILES = SHELL.filter((s) => s !== './');
const REQUIRED_SHELL = SHELL.filter((file) =>
  !file.startsWith('fonts/') && !/^icon-/.test(file));
const REQUIRED_COURSE = ['course.json', 'cards.json'];

async function cacheComplete(name, files, prefix = '') {
  if (!(await caches.keys()).includes(name)) return false;
  const cache = await caches.open(name);
  for (const file of files) {
    const hit = await cache.match(prefix + file);
    if (!ok(hit, typeFor(file))) return false;
    if (!prefix && (file === './' || file === 'index.html')
        && !(await appPageOk(hit))) return false;
  }
  return true;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const existed = (await caches.keys()).includes(SHELL_V);
    const shell = await caches.open(SHELL_V);
    // One file at a time, because addAll is all-or-nothing over two dozen of
    // them: a single 404 — a partial rsync, a CDN that has not caught up — used
    // to reject the whole install, so skipWaiting() never ran and a first-ever
    // registration was thrown away. The app then had no offline at all, and no
    // way to say so, while Progress went on promising the cards work offline
    // once you have opened it. A missing font is not a reason to have no shell,
    // exactly as one bad course is not a reason to have no app (below).
    await Promise.all(SHELL.map((f) => shell.add(f)
      .catch((e) => console.warn('munin: shell ' + f + ' not cached', e))));
    // caches.open() made the cache before a byte was fetched. If nothing at all
    // landed — installed with no network, or a deploy that is simply not there
    // — an empty cache under the CURRENT name is a shell that answers nothing
    // and that activate will never sweep, because current is exactly what it
    // keeps. Drop it and let the next install start from nothing instead.
    if (!(await cacheComplete(SHELL_V, REQUIRED_SHELL))) {
      if (!existed) await caches.delete(SHELL_V);
      throw new Error('munin: required offline shell is incomplete');
    }
    // Each course into its own cache, and one course that will not install is
    // not a reason for the app to have no offline shell at all.
    for (const id of (await readCourses()) || []) {
      const cache = await caches.open(courseV(id));
      let healthy = true;
      for (const f of COURSE_FILES) {
        const path = 'courses/' + id + '/' + f;
        try {
          const r = await fetch(path, { cache: 'reload' });
          // Optional 404 is part of the course format. A server error or a
          // captive-portal body is a partial deploy, and must reject this
          // generation rather than evicting the last complete one.
          if (r.status === 404 && !REQUIRED_COURSE.includes(f)) continue;
          if (!ok(r, typeFor(f))) {
            healthy = false;
            console.warn('munin: ' + id + '/' + f + ' returned an invalid response');
            continue;
          }
          await cache.put(path, r);
        } catch (e) {
          healthy = false;
          console.warn('munin: ' + id + '/' + f + ' not cached', e);
        }
      }
      if (!healthy
          || !(await cacheComplete(courseV(id), REQUIRED_COURSE, 'courses/' + id + '/'))) {
        await caches.delete(courseV(id));
        console.warn('munin: required files for ' + id + ' are incomplete; keeping any older cache');
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ids = await readCourses();
    const live = new Set([SHELL_V]);
    for (const id of ids || []) {
      const current = courseV(id);
      if (await cacheComplete(current, REQUIRED_COURSE, 'courses/' + id + '/')) {
        live.add(current);
      } else {
        // A partial course update is not evidence that the last offline copy
        // should be erased. Runtime fallbacks use caches.match(), so the older
        // generation remains usable until a complete one installs.
        for (const name of await caches.keys()) {
          if (name.startsWith('munin-course-' + id + '-')
              && await cacheComplete(name, REQUIRED_COURSE, 'courses/' + id + '/')) {
            live.add(name);
          }
        }
      }
    }
    for (const k of await caches.keys()) {
      if (!/^munin-/.test(k) || live.has(k)) continue;
      // Only Munin's own caches, and only the ones no longer current: a course
      // whose cards changed loses its own cache and keeps everyone else's.
      // WITHOUT A LIST, NOTHING BELONGING TO A COURSE IS TOUCHED — an
      // unreadable registry is not evidence that every course was removed,
      // and treating it as such threw away saved diagrams by the megabyte.
      if (ids === null && /^munin-course-/.test(k)) continue;
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

/** Where a request belongs: its course's cache, or the shell's. */
function cacheFor(pathname) {
  const id = courseOf(pathname);
  return id ? courseV(id) : SHELL_V;
}

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'prefetch' && Array.isArray(e.data.urls)) {
    e.waitUntil((async () => {
      const total = e.data.urls.length;
      let done = 0, failed = 0;
      const requestId = typeof e.data.requestId === 'string' ? e.data.requestId : '';
      const client = e.source;
      const say = async (type) => {
        try {
          if (client && client.postMessage) {
            client.postMessage({ type, done, total, failed, requestId });
          }
        } catch (err) { /* the requesting tab may close while caching continues */ }
      };
      for (const u of e.data.urls) {
        try {
          const url = new URL(u, location.href);
          const id = url.origin === location.origin ? courseOf(url.pathname) : null;
          if (!id || !url.pathname.includes('/courses/' + id + '/img/')) {
            throw new Error('not a course image');
          }
          // A course's diagrams belong in that course's cache, so pulling one
          // course down for a flight does not push another one out.
          const cache = await caches.open(cacheFor(url.pathname));
          const existing = await cache.match(url.href);
          if (existing && !ok(existing, 'image/png')) await cache.delete(url.href);
          if (!existing || !ok(existing, 'image/png')) {
            const response = await fetch(url.href, { cache: 'reload' });
            if (!ok(response, 'image/png')) throw new Error('not a valid image response');
            await cache.put(url.href, response.clone());
          }
        } catch (err) {
          failed++;   // one missing diagram must not abort the rest
        }
        done++;
        await say('prefetching');   // megabytes on a weak signal need to show movement
      }
      await say('prefetched');
    })());
  }
});

/* A page and the code it names have to come from the same deploy.
 *
 * The page is network-first and app.js/app.css are cache-first, so a deploy
 * that renamed one element id in index.html AND in app.js — an ordinary
 * refactor — handed the new page the old code: app.js threw on an element that
 * was no longer there, dismissBoot() was never reached, and the held splash sat
 * saying "loading deck…" with no button and no message. The next load recovered,
 * which is no comfort to whoever met the first one.
 *
 * So when the page off the network is not the page we hold, the code cached
 * beside it is a deploy behind by definition, and for the rest of that load the
 * shell's scripts and stylesheets ask the network before the cache. The
 * strategy is unchanged — they are still cached, still revalidated, and a
 * network that will not answer still falls back to the copy we have, which is
 * exactly what it did before. This only declines to serve one page two
 * generations of itself while it still has the choice.
 *
 * The cached page doubles as the mark for which generation the cached CODE is,
 * which is why it is only moved once the code has actually been caught up (see
 * the navigation branch). Moving it on its own moved the dead load from the
 * first refresh after a deploy to the second, which is not a fix. */
const CODE = /\.(js|css)$/;
let mixedShell = false;

/** Is the page off the network a different page from the one we hold? */
async function pageChanged(res) {
  try {
    const had = await (await caches.open(SHELL_V)).match('./');
    if (!had) return false;            // nothing yet to be out of step with
    return (await had.text()) !== (await res.text());
  } catch (e) { return false; }        // a page we cannot compare is not evidence
}

/** Pull the shell's scripts and stylesheets down again, and say so only if
 *  every one of them is now what the network is serving. Anything less and the
 *  old page stays cached, so the next load treats the code as stale again —
 *  which is the right answer rather than a failure. */
async function catchCodeUp() {
  try {
    const c = await caches.open(SHELL_V);
    const stale = (await c.keys()).filter((k) => CODE.test(new URL(k.url).pathname));
    const got = await Promise.all(stale.map(async (k) => {
      // 'reload' because the browser's own HTTP cache is just as capable of
      // handing back the copy we are trying to get away from.
      const r = await fetch(k.url, { cache: 'reload' }).catch(() => null);
      return ok(r, typeFor(new URL(k.url).pathname)) ? { key: k, response: r } : null;
    }));
    // Validate the entire code set before changing any of it. Otherwise a
    // failure late in the list leaves the cached old page beside half-new code
    // even though this function correctly reports "not caught up".
    if (!got.every(Boolean)) return false;
    await Promise.all(got.map(({ key, response }) => c.put(key, response)));
    return true;
  } catch (e) { return false; }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Public creator docs share the deployment but are not the app shell. Leave
  // them to the browser/network; an offline docs request must not unexpectedly
  // open the study app from cached index.html.
  if (url.pathname === SCOPE + 'docs'
      || url.pathname.startsWith(SCOPE + 'docs/')) return;

  // Card data and the clip map: network first so a rebuilt deck or a newly
  // attached clip arrives, cache as the fallback.
  if (url.pathname.endsWith('cards.json') || url.pathname.endsWith('videos.json')
      || url.pathname.endsWith('figures.json')) {
    e.respondWith(
      fetch(req).then(async (r) => {
        // Only a real deck gets cached. One 404 during a deploy used to become
        // the permanent offline copy, and the app then failed exactly when
        // being offline was the point.
        if (ok(r, 'application/json')) {
          const copy = r.clone();
          caches.open(cacheFor(url.pathname)).then((c) => c.put(req, copy));
          return r;
        }
        // A server that answers is not necessarily a server with this deploy:
        // 404/503 and captive-portal HTML should fall back to the last valid
        // complete course just like a rejected fetch does.
        const hit = await caches.match(req);
        return ok(hit, 'application/json') ? hit : r;
      }).catch(async () => {
        const hit = await caches.match(req);
        return ok(hit, 'application/json') ? hit : Response.error();
      })
    );
    return;
  }

  // A navigation is the whole app: serve the shell whatever query string is on
  // the URL, so a shared or tagged link is not a blank page offline.
  if (req.mode === 'navigate') {
    const isRoot = url.pathname === SCOPE || url.pathname === SCOPE + 'index.html';
    e.respondWith(
      fetch(req)
        .then(async (r) => {
          if (isRoot && !(await appPageOk(r))) {
            return (await cachedAppPage()) || r;
          }
          // Only the app's own page may be stored as the shell. This used to
          // cache *any* navigation in scope, so opening a sibling file once
          // meant the app booted into that file for ever after, offline.
          if (isRoot) {
            const copy = r.clone();
            // Awaited, because the answer has to be known before the browser
            // parses this page and asks for the scripts it names.
            const changed = await pageChanged(r.clone());
            mixedShell = changed;
            // A new page is safe only beside all of its code. If even one
            // script/style is a partial-deploy response, serve the complete old
            // page too; mixing either direction is a dead loading screen.
            if (changed && !(await catchCodeUp())) {
              return (await cachedAppPage()) || r;
            }
            await (await caches.open(SHELL_V)).put('./', copy);
          }
          return r;
        })
        .catch(async () => (await cachedAppPage()) || Response.error())
    );
    return;
  }

  // Video is never cached. 53 MB of clips would evict the shell that makes the
  // app work offline in the first place, to store something you watch once.
  if (url.pathname.includes('/video/')) return;

  const isShell = SHELL_FILES.some((s) => url.pathname.endsWith('/' + s));
  // A course's own files are matched by where they live rather than by a list
  // naming each course, which is what made adding a course a service-worker
  // edit — and, when it was forgotten, a course that worked online only.
  const isCourseFile = !!courseOf(url.pathname)
    && COURSE_FILES.some((s) => url.pathname.endsWith('/' + s));
  const isImage = url.pathname.includes('/img/') || /\/icon-[\w-]+\.png$/.test(url.pathname);

  // Only our own files are cached. Anything else on the origin — the rest of
  // the site this app is a subdirectory of — is left alone.
  if (!isShell && !isCourseFile && !isImage) return;

  if (isShell || isCourseFile) {
    // Stale while revalidate: instant from cache, but a shipped fix to app.js
    // — or a course's redrawn loading screen — lands on the next load instead
    // of never. Except for the shell's own code on a load whose page did not
    // match the one we had cached: see pageChanged.
    const skewed = mixedShell && isShell && CODE.test(url.pathname);
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((r) => {
          // A hotel-WiFi sign-in page is a 200. Without the type check it
          // becomes the cached app.js and the app never boots again.
          if (ok(r, typeFor(url.pathname))) {
            caches.open(cacheFor(url.pathname)).then((c) => c.put(req, r.clone()));
            return r;
          }
          return hit || r;
        }).catch(() => hit);
        return skewed ? net : (hit || net);
      })
    );
    return;
  }

  // Diagrams: cache first, they never change without a new cache version.
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (ok(r, 'image/png')) caches.open(cacheFor(url.pathname)).then((c) => c.put(req, r.clone()));
      return r;
    }))
  );
});
