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
  } catch (e) {
    // Sync still works for this page; it simply cannot resume after a reload.
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
  writeBox(box);
  return key;
}

function turnOff() {
  try {
    localStorage.removeItem(KEY);
  } catch (e) {
    // Nothing else to do: the in-memory page will stop scheduling immediately.
  }
  clearTimeout(timer);
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
  if (num(x.rp) !== num(y.rp)) return num(x.rp) > num(y.rp) ? x : y;
  if (num(x.due) !== num(y.due)) return num(x.due) > num(y.due) ? x : y;
  if (num(x.lp) !== num(y.lp)) return num(x.lp) < num(y.lp) ? x : y;
  return stable(x) <= stable(y) ? x : y;
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
  let winner, loser;
  if (num(x.at) !== num(y.at)) {
    [winner, loser] = num(x.at) > num(y.at) ? [x, y] : [y, x];
  } else {
    [winner, loser] = stable(x) <= stable(y) ? [x, y] : [y, x];
  }
  const out = Object.assign({}, winner);
  if (!out.examDate && !out.examSkipped && loser.examDate) {
    out.examDate = loser.examDate;
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
  if (keys.length > 120) {
    keys.sort();
    for (const key of keys.slice(0, keys.length - 90)) delete days[key];
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
  const counted = Object.values(days).reduce((total, value) => total + num(value), 0);
  out.answers = Math.max(counted, num(a.answers), num(b.answers));

  out.ach = {};
  for (const [id, timestamp] of Object.entries(obj(a.ach)).concat(Object.entries(obj(b.ach)))) {
    const value = num(timestamp);
    if (value > 0 && (!out.ach[id] || value < out.ach[id])) out.ach[id] = value;
  }

  out.settings = mergeSettings(obj(a.settings), obj(b.settings));
  return out;
}

/* ─────────────────────────── transport ─────────────────────────── */

async function rpc(fn, body) {
  const response = await fetch(ENDPOINT + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: 'Bearer ' + ANON,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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

async function syncOnce(local) {
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
      if (error.code === '53400' && round < MAX_ROUNDS - 1) {
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
  writeLocal({ key: record.key, rev, at: Date.now(), err: '' });
  return state;
}

function sync(source) {
  if (running) {
    if (!pending) {
      pending = running.catch(() => {}).then(() => {
        pending = null;
        return sync(source);
      });
    }
    return pending;
  }

  cfg.onStatus({ busy: true });
  running = syncOnce(typeof source === 'function' ? source() : source)
    .then((merged) => {
      cfg.onMerged(merged);
      cfg.onStatus({ busy: false, ok: true, at: Date.now() });
      return merged;
    })
    .catch((error) => {
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
  pickRec,
  streakFrom,
  stable,
  app: () => cfg.app,
};

})(typeof globalThis !== 'undefined' ? globalThis : this);
