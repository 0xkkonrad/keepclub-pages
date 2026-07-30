/* Cross-device progress sync for keep club.
 *
 * A device generates one key. The same key follows every built-in course, while
 * each course keeps its own server revision and blob. Only the SHA-256 hash of
 * the key crosses the network; knowing the key is the permission.
 *
 * Imported decks stay local. Their cards and media live in IndexedDB and can be
 * much larger than the progress-only backend's bounded JSON blobs.
 */
'use strict';

(function (root) {

const ENDPOINT = 'https://dyaxdgpaideblyhpxyft.supabase.co';
// Publishable by design. The anon key grants access only to two RPC functions,
// and both require a non-enumerable key hash.
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR5YXhkZ3BhaWRlYmx5aHB4eWZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxMTg2MjUsImV4cCI6MjEwMDY5NDYyNX0.CDDeyQso3XnxiYg0f5x4uy99n6JoyHgEqm1cJN0wvIk';

// This odd-looking name shipped with the disabled transport. It is retained
// deliberately: changing a storage key would silently forget a device's sync
// identity on upgrade.
const KEY = 'munin/sync-off';
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 25;
const GROUP = 5;
const RETRY_WAIT = 1200;
const MAX_ROUNDS = 4;
const REQUEST_TIMEOUT = 15000;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : (d || 0));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cfg = {
  app: '',
  supported: false,
  sanitise: (s) => s,
  onMerged: () => {},
  onStatus: () => {},
};
let running = null;
let pending = null;
let timer = null;
const requests = new Set();
// A network response belongs to the identity that started it. Turning Sync off
// or joining a different key increments this generation, so an old response
// cannot put the removed key back into storage or merge the old account into
// the new one.
let identityGeneration = 0;

function cancelRequests() {
  for (const request of requests) request.abort();
  requests.clear();
}

/* ─────────────────────────── keys ─────────────────────────── */

function makeKey() {
  const bytes = new Uint8Array(KEY_CHARS);
  crypto.getRandomValues(bytes);
  let value = '';
  for (let i = 0; i < KEY_CHARS; i++) value += B32[bytes[i] & 31];
  return value;
}

function normaliseKey(input) {
  const value = String(input || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  for (const char of value) if (!B32.includes(char)) return null;
  return value.length === KEY_CHARS ? value : null;
}

function formatKey(key) {
  return (String(key || '').match(new RegExp('.{1,' + GROUP + '}', 'g')) || []).join('-');
}

async function hashKey(key) {
  const bytes = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(key)
  );
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ─────────────────────────── local identity ─────────────────────────── */

function readBox() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw.key !== 'string') return null;
    const key = normaliseKey(raw.key);
    if (!key) return null;

    // A legacy single-course record is folded into the current course when it
    // is first read. No released keep club build wrote one, but the archived
    // Day Skipper client did.
    if (!raw.courses && cfg.app) {
      return {
        v: 1,
        key,
        courses: {
          [cfg.app]: { rev: num(raw.rev), at: num(raw.at), err: raw.err || '' },
        },
      };
    }
    return { v: 1, key, courses: obj(raw.courses) };
  } catch (e) {
    return null;
  }
}

function writeBox(box) {
  try {
    localStorage.setItem(KEY, JSON.stringify(box));
    return true;
  } catch (e) {
    // Sync still works for this page; it simply cannot resume after a reload.
    return false;
  }
}

function readLocal() {
  if (!cfg.supported || !cfg.app) return null;
  const box = readBox();
  if (!box) return null;
  const course = obj(box.courses)[cfg.app];
  return {
    key: box.key,
    rev: num(course && course.rev),
    at: num(course && course.at),
    err: course && course.err ? String(course.err) : '',
  };
}

function writeLocal(record) {
  let box = readBox();
  if (!box || box.key !== record.key) {
    box = { v: 1, key: record.key, courses: {} };
  }
  box.courses = obj(box.courses);
  box.courses[cfg.app] = {
    rev: num(record.rev),
    at: num(record.at),
    err: record.err || '',
  };
  writeBox(box);
}

function enabled() {
  return !!readLocal();
}

function status() {
  if (!cfg.supported) return { on: false, available: false };
  const record = readLocal();
  return record
    ? {
        on: true,
        available: true,
        key: record.key,
        at: record.at,
        rev: record.rev,
        err: record.err,
      }
    : { on: false, available: true };
}

function turnOn(input) {
  if (!cfg.supported) return null;
  const key = input ? normaliseKey(input) : makeKey();
  if (!key) return null;
  const existing = readBox();
  // A different key is a different shared account. Revisions from the old key
  // mean nothing under it and must not be reused.
  const box = existing && existing.key === key
    ? existing
    : { v: 1, key, courses: {} };
  box.courses = obj(box.courses);
  if (!box.courses[cfg.app]) box.courses[cfg.app] = { rev: 0, at: 0, err: '' };
  if (!writeBox(box)) return null;
  identityGeneration++;
  cancelRequests();
  return key;
}

function turnOff() {
  let removed = false;
  try {
    localStorage.removeItem(KEY);
    removed = localStorage.getItem(KEY) === null;
  } catch (e) {
    // The UI must not claim Sync is off when storage refused the change.
  }
  if (!removed) return false;
  identityGeneration++;
  cancelRequests();
  clearTimeout(timer);
  return true;
}

/* ─────────────────────────── merge ─────────────────────────── */

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function pickRec(x, y) {
  if (!x) return y;
  if (!y) return x;
  let winner;
  if (num(x.rp) !== num(y.rp)) winner = num(x.rp) > num(y.rp) ? x : y;
  // Equal review counts are divergent answers to the same card. Keep the
  // relearning schedule when only one device lapsed, then the earlier due
  // date. Lapse count itself cannot choose the schedule: it is merged by max
  // below, and feeding that derived value back into the comparison made a
  // three-device merge depend on grouping order.
  else if ((x.st === 'l') !== (y.st === 'l')) winner = x.st === 'l' ? x : y;
  else if (num(x.due) !== num(y.due)) winner = num(x.due) < num(y.due) ? x : y;
  else {
    const xSchedule = Object.assign({}, x, { lp: 0 });
    const ySchedule = Object.assign({}, y, { lp: 0 });
    winner = stable(xSchedule) <= stable(ySchedule) ? x : y;
  }
  // Lapses are a lifetime counter. A later review record can legitimately win
  // the schedule while still having forked before a lapse on another device.
  return Object.assign({}, winner, { lp: Math.max(num(x.lp), num(y.lp)) });
}

function prevKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - 1);
  return date.getFullYear() + '-'
    + String(date.getMonth() + 1).padStart(2, '0') + '-'
    + String(date.getDate()).padStart(2, '0');
}

function streakFrom(days, lastDay) {
  if (!lastDay || !days[lastDay]) return 0;
  let count = 0;
  for (let key = lastDay; days[key]; key = prevKey(key)) count++;
  return count;
}

function mergeSettings(x, y) {
  let winner;
  if (num(x.at) !== num(y.at)) {
    winner = num(x.at) > num(y.at) ? x : y;
  } else {
    winner = stable(x) <= stable(y) ? x : y;
  }
  // Settings are one last-write-wins block. Filling an empty exam date from
  // the loser resurrected dates that a newer device had explicitly cleared
  // and made a three-way merge depend on grouping order.
  return Object.assign({}, winner);
}

/* ─────────────────────────── notes ─────────────────────────── */

/* Notes merge as a set of separately-stamped records, never as one block.
 *
 * Settings are one thing a person changes, so last-write-wins over the whole
 * block is honest there. Notes are many things they write, and two devices
 * between one sync and the next routinely both have new ones — merged as a
 * block, whichever device wrote fewer of them would simply lose them. So each
 * note carries its own `at` (when it was written) and `ed` (when it last
 * changed), and the union is taken id by id.
 *
 * Deleting is the half that needs the care. A plain union resurrects every note
 * the other device has not heard about yet, so a delete is recorded rather than
 * dropped: the record stays, its text emptied, its `ed` newer than the text it
 * replaces — and that empty record beats the older words on the device that
 * still has them. An empty note is therefore the delete marker, which is also
 * why the app refuses to store an empty note as a note.
 *
 * The markers are what makes this converge, and they are also why the entry
 * count is capped. Dropping the oldest markers can only bring back a note that
 * was deleted more than NOTE_SLOTS entries ago, on a device that has been away
 * across all of them; an unbounded set on a bounded server blob is the worse
 * failure, because it takes the review history down with it.
 *
 * Live notes are capped separately, and lower. Capping the entries alone was
 * not the same promise: app.js refuses the 201st note on one device, but three
 * devices holding 200 each merged to 600 live notes inside the entry budget, so
 * a deck could arrive back over a limit the app had already told the person
 * about — and then lose 200 of them to the next delete marker instead. The two
 * numbers are the same number in both files. Words that go are counted, because
 * the one thing this must never be is quiet: see takeNoteDrops().
 */
const NOTE_SLOTS = 400;
// Live notes one deck may hold. Must match app.js's NOTE_MAX — the app enforces
// it as you type and the merge enforces it as devices meet, and two different
// ceilings would mean a note accepted here and dropped one sync later.
const NOTE_LIVE = 200;
// An id is used as an object key, here and in app.js's sanitiser, which is the
// one thing about it that has to be true. Hex is what app.js writes; anything
// else came from somewhere else and is not stored under a key of its choosing.
const NOTE_ID = /^[a-z0-9]{1,64}$/;
// Live notes the merges since the last reading had to drop. A merge happens
// where nobody is looking — in the middle of a sync round, several times over —
// so it cannot speak for itself; it counts instead, and the app asks afterwards.
let noteDrops = 0;

/** How many of somebody's words the merge dropped, once. Read and cleared
 *  together: this exists so the app can say it happened, and saying it twice
 *  for one loss would be its own kind of wrong. */
function takeNoteDrops() {
  const total = noteDrops;
  noteDrops = 0;
  return total;
}

function pickNote(x, y) {
  if (!x) return y;
  if (!y) return x;
  let winner;
  if (num(x.ed) !== num(y.ed)) winner = num(x.ed) > num(y.ed) ? x : y;
  else winner = stable(x) <= stable(y) ? x : y;
  // When a note was written is a fact about the past, and the earliest claim is
  // the true one — the same rule the milestones keep. Carrying the winner's own
  // stamp instead made a list re-order itself after a sync, which reads as the
  // app shuffling notes nobody touched.
  const written = [num(x.at), num(y.at)].filter((value) => value > 0);
  return Object.assign({}, winner, { at: written.length ? Math.min(...written) : 0 });
}

function mergeNotes(a, b) {
  const entries = [];
  for (const id of new Set(Object.keys(a).concat(Object.keys(b)))) {
    if (!NOTE_ID.test(id)) continue;
    entries.push([id, pickNote(
      a[id] === undefined ? null : obj(a[id]),
      b[id] === undefined ? null : obj(b[id])
    )]);
  }
  // Live notes before delete markers, newest first, id last so the order is
  // total: an eviction that depended on iteration order would make a
  // three-device merge depend on which pair was merged first.
  entries.sort((x, y) => {
    const liveX = x[1].text ? 0 : 1, liveY = y[1].text ? 0 : 1;
    if (liveX !== liveY) return liveX - liveY;
    if (num(x[1].ed) !== num(y[1].ed)) return num(y[1].ed) - num(x[1].ed);
    return x[0] < y[0] ? -1 : 1;
  });
  // Both ceilings are read off that one order, which is what keeps the merge
  // associative: whether an entry survives depends only on the entries ahead of
  // it, and every live note is ahead of every marker. The markers then fill
  // whatever the live notes left of the entry budget.
  const out = {};
  let kept = 0, live = 0;
  for (const [id, note] of entries) {
    if (kept >= NOTE_SLOTS) break;
    if (note.text) {
      if (live >= NOTE_LIVE) { noteDrops++; continue; }
      live++;
    }
    out[id] = note;
    kept++;
  }
  return out;
}

/* Commutative and idempotent: syncing the same pair repeatedly cannot inflate
 * counters, while the record with the most review history always survives. */
function mergeState(a, b) {
  a = obj(a);
  b = obj(b);
  const out = { v: Math.max(num(a.v, 1), num(b.v, 1)), recs: {} };

  for (const id of new Set(Object.keys(obj(a.recs)).concat(Object.keys(obj(b.recs))))) {
    out.recs[id] = pickRec(obj(a.recs)[id], obj(b.recs)[id]);
  }

  const days = {};
  for (const key of new Set(Object.keys(obj(a.days)).concat(Object.keys(obj(b.days))))) {
    days[key] = Math.max(num(obj(a.days)[key]), num(obj(b.days)[key]));
  }

  out.day = (a.day || '') > (b.day || '') ? a.day : b.day;
  const lastA = a.lastDay || '';
  const lastB = b.lastDay || '';
  out.lastDay = (lastA > lastB ? lastA : lastB) || null;

  const carried = [a, b]
    .filter((state) => (state.lastDay || null) === out.lastDay)
    .map((state) => num(state.streak));
  out.streak = Math.max(streakFrom(days, out.lastDay), 0, ...carried);

  const keys = Object.keys(days);
  if (keys.length > 420) {
    keys.sort();
    for (const key of keys.slice(0, keys.length - 400)) delete days[key];
  }
  out.days = days;

  const today = (state) => (state.day === out.day ? state : null);
  const todayA = today(a);
  const todayB = today(b);
  out.newDone = Math.max(todayA ? num(todayA.newDone) : 0,
    todayB ? num(todayB.newDone) : 0);
  out.revDone = Math.max(todayA ? num(todayA.revDone) : 0,
    todayB ? num(todayB.revDone) : 0);

  out.revTotal = Math.max(num(a.revTotal), num(b.revTotal));
  out.revGood = Math.min(out.revTotal, Math.max(num(a.revGood), num(b.revGood)));
  // A personal best is monotonic just like lifetime answer totals. Keeping the
  // maximum also makes the merge commutative across three devices.
  out.bestClean = Math.max(num(a.bestClean), num(b.bestClean));
  const counted = Object.values(days).reduce((total, value) => total + num(value), 0);
  out.answers = Math.max(counted, num(a.answers), num(b.answers));

  out.ach = {};
  for (const [id, timestamp] of Object.entries(obj(a.ach)).concat(Object.entries(obj(b.ach)))) {
    const value = num(timestamp);
    if (value > 0 && (!out.ach[id] || value < out.ach[id])) out.ach[id] = value;
  }

  out.settings = mergeSettings(obj(a.settings), obj(b.settings));
  out.notes = mergeNotes(obj(a.notes), obj(b.notes));
  return out;
}

/* ─────────────────────────── transport ─────────────────────────── */

async function rpc(fn, body) {
  const stop = new AbortController();
  requests.add(stop);
  const timeout = setTimeout(() => stop.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(ENDPOINT + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: {
        apikey: ANON,
        Authorization: 'Bearer ' + ANON,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: stop.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('sync timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
    requests.delete(stop);
  }
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // The status below is more useful than a JSON parse error from a proxy.
  }
  if (!response.ok) {
    const error = new Error((parsed && parsed.message) || ('HTTP ' + response.status));
    error.code = parsed && parsed.code;
    throw error;
  }
  return parsed;
}

async function syncOnce(local, generation) {
  const record = readLocal();
  if (!record) throw new Error('sync is off');
  const keyHash = await hashKey(record.key);

  let state = local;
  let rev = 0;
  let changed = false;
  const rows = await rpc('sync_get', { p_app: cfg.app, p_key_hash: keyHash });
  if (Array.isArray(rows) && rows.length) {
    rev = num(rows[0].rev);
    const remote = cfg.sanitise(rows[0].data);
    const merged = mergeState(local, remote);
    changed = stable(merged) !== stable(remote);
    state = merged;
  } else {
    changed = true;
  }

  for (let round = 0; changed && round < MAX_ROUNDS; round++) {
    let result;
    try {
      result = await rpc('sync_put', {
        p_app: cfg.app,
        p_key_hash: keyHash,
        p_rev: rev,
        p_data: state,
      });
    } catch (error) {
      // A first-write race produces 23505: both devices observed no row and
      // one inserted first. Retrying turns it into the ordinary revision
      // conflict path. 53400 is the backend's one-write-per-second throttle.
      if ((error.code === '53400' || error.code === '23505')
          && round < MAX_ROUNDS - 1) {
        await sleep(RETRY_WAIT);
        continue;
      }
      throw error;
    }

    const row = Array.isArray(result) ? result[0] : result;
    if (row && row.ok) {
      rev = num(row.rev);
      changed = false;
      break;
    }
    rev = num(row && row.rev);
    const theirs = cfg.sanitise(row && row.data);
    state = mergeState(state, theirs);
    changed = stable(state) !== stable(theirs);
    if (changed) await sleep(RETRY_WAIT);
  }

  if (changed) throw new Error('sync stayed busy; it will retry');
  const current = readLocal();
  if (generation !== identityGeneration || !current || current.key !== record.key) {
    return { state, stale: true };
  }
  writeLocal({ key: record.key, rev, at: Date.now(), err: '' });
  return { state, stale: false };
}

function sync(source) {
  if (!enabled()) return Promise.resolve();
  if (running) {
    if (!pending) {
      pending = running.catch(() => {}).then(() => {
        pending = null;
        return sync(source);
      });
    }
    return pending;
  }

  const generation = identityGeneration;
  cfg.onStatus({ busy: true });
  running = syncOnce(typeof source === 'function' ? source() : source, generation)
    .then((result) => {
      if (result.stale) {
        cfg.onStatus({ busy: false });
        return undefined;
      }
      cfg.onMerged(result.state);
      cfg.onStatus({ busy: false, ok: true, at: Date.now() });
      return result.state;
    })
    .catch((error) => {
      if (generation !== identityGeneration) {
        cfg.onStatus({ busy: false });
        return undefined;
      }
      const record = readLocal();
      if (record) {
        writeLocal(Object.assign({}, record, { err: error.message || 'failed' }));
      }
      cfg.onStatus({ busy: false, ok: false, error: error.message || 'failed' });
      throw error;
    })
    .finally(() => {
      running = null;
    });
  return running;
}

function schedule(getState, ms) {
  if (!enabled()) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    sync(getState).catch(() => {});
  }, ms || 5000);
}

function init(options) {
  cfg = Object.assign(cfg, options || {});
  cfg.app = typeof cfg.app === 'string' ? cfg.app : '';
  cfg.supported = cfg.supported !== false
    && /^[a-z0-9][a-z0-9-]{0,63}$/.test(cfg.app);
}

root.DSSync = {
  KEY,
  KEY_CHARS,
  ENDPOINT,
  init,
  enabled,
  status,
  sync,
  schedule,
  turnOn,
  turnOff,
  makeKey,
  normaliseKey,
  formatKey,
  hashKey,
  mergeState,
  mergeSettings,
  mergeNotes,
  takeNoteDrops,
  NOTE_LIVE,
  pickRec,
  pickNote,
  streakFrom,
  stable,
  app: () => cfg.app,
};

})(typeof globalThis !== 'undefined' ? globalThis : this);
