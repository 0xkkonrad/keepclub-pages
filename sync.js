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
// Publishable by design. The anon key grants access only to the versioned sync
// RPC boundary, and every call requires a non-enumerable key hash.
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
// The RPC name is the writer capability. Once a row has been written by this
// version, the backend refuses legacy writers that would erase pv and sr.
const WRITER_VERSION = 2;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : (d || 0));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cfg = {
  app: '',
  supported: false,
  sanitise: (s) => s,
  reconcile: (s) => s,
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
    // Whether the last failure is one only the person can clear. Read back off
    // the document rather than kept in memory, because the screen that says so
    // is usually reached on a later load than the round that failed.
    errYours: !!(course && course.errYours),
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
    errYours: !!record.errYours,
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
        errYours: record.errYours,
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

// `pv` is the strongest interval this lapse epoch has proved, even when an
// approaching exam keeps the actual scheduled interval (`ivl`) shorter. Old
// clients wrote pv=0 for review cards, so their interval is the compatible
// fallback. A valid `sr` marks a canonical record, so zero on one of those stays
// zero; malformed property presence is not allowed to certify zero proof.
// A learning card's ivl is only its next step, never proof.
function hasScheduleRevision(record) {
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'sr')) return false;
  const rp = num(record.rp);
  const sr = record.sr;
  return typeof sr === 'number'
    && Number.isInteger(sr) && sr >= 0 && sr <= rp;
}

function provenInterval(record) {
  const proof = num(record && record.pv);
  if (proof > 0) return proof;
  const legacy = record && !hasScheduleRevision(record);
  return legacy && record.st === 'r' ? Math.max(0, num(record.ivl)) : 0;
}

const EXAM_COMMIT_LIMIT = 8;

function examCommits(record) {
  const out = {};
  const interval = Math.max(0, num(record && record.ivl));
  const entries = Object.entries(obj(record && record.ec))
    .filter(([date, value]) => /^\d{4}-\d{2}-\d{2}$/.test(date)
      && typeof value === 'number' && Number.isInteger(value)
      && value >= 1 && value <= interval)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, EXAM_COMMIT_LIMIT);
  for (const [date, value] of entries) out[date] = value;
  return out;
}

function scheduleKey(record) {
  return stable(Object.assign({}, record, {
    rp: 0, lp: 0, pv: 0, ec: {},
  }));
}

/** Join answer-button promises only across byte-identical answer revisions.
 * A losing different schedule can never become the total-order winner later,
 * so its projection is irrelevant. Identical schedules can arise on devices
 * with different exam settings at the same revision; retain both dates, and
 * choose the earlier interval when the same date somehow produced two
 * promises. `sr` stays in the identity: the same ivl/due can recur at a newer
 * revision, and allowing an older promise to attach to that answer made a
 * three-device merge depend on grouping. */
function joinedExamCommits(records, winner) {
  const joined = {};
  const key = scheduleKey(winner);
  for (const record of records) {
    if (scheduleKey(record) !== key) continue;
    for (const [date, interval] of Object.entries(examCommits(record))) {
      if (!joined[date] || interval < joined[date]) joined[date] = interval;
    }
  }
  return Object.fromEntries(Object.entries(joined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, EXAM_COMMIT_LIMIT));
}

function canonicalRec(record) {
  if (!record) return undefined;
  const rp = Math.max(0, num(record.rp));
  const saved = hasScheduleRevision(record) ? record.sr : rp;
  const canonical = Object.assign({}, record, {
    rp,
    sr: saved,
    // lp is a causal epoch on this schedule branch, so it cannot outrun sr.
    lp: Math.min(saved, Math.max(0, num(record.lp))),
    pv: provenInterval(record),
  });
  const commits = examCommits(canonical);
  if (Object.keys(commits).length) canonical.ec = commits;
  else delete canonical.ec;
  return canonical;
}

function pickRec(rawX, rawY) {
  const x = canonicalRec(rawX);
  const y = canonicalRec(rawY);
  if (!x && !y) return undefined;
  const lapses = Math.max(num(x && x.lp), num(y && y.lp));
  const current = [x, y].filter((record) => record && record.lp === lapses);
  let winner = current[0];
  for (const record of current.slice(1)) {
    if (record.sr !== winner.sr) winner = record.sr > winner.sr ? record : winner;
    // Equal schedule revisions are divergent answers to the same card. Keep
    // relearning, then the earlier due date, as the conservative total order.
    else if ((record.st === 'l') !== (winner.st === 'l')) {
      winner = record.st === 'l' ? record : winner;
    } else if (num(record.due) !== num(winner.due)) {
      winner = num(record.due) < num(winner.due) ? record : winner;
    } else {
      // History and proof are derived joins. Blanking them prevents a merge's
      // synthetic maxima from influencing a later schedule tie.
      const a = Object.assign({}, record, { rp: 0, sr: 0, lp: 0, pv: 0, ec: {} });
      const b = Object.assign({}, winner, { rp: 0, sr: 0, lp: 0, pv: 0, ec: {} });
      winner = stable(a) <= stable(b) ? record : winner;
    }
  }

  // Schedule, answer history and proof are separate monotonic facts. Restrict
  // schedule and proof to the newest lapse epoch, but retain the largest answer
  // count even when it came from an older offline branch.
  const merged = Object.assign({}, winner, {
    rp: Math.max(num(x && x.rp), num(y && y.rp)),
    sr: winner.sr,
    lp: lapses,
    pv: Math.max(...current.map((record) => record.pv)),
  });
  const commits = joinedExamCommits(current, winner);
  if (Object.keys(commits).length) merged.ec = commits;
  else delete merged.ec;
  return merged;
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

/* ────────────────────── what you write ────────────────────── */

/* Notes and the cards you write merge as separately-stamped records, never as
 * one block.
 *
 * Settings are one thing a person changes, so last-write-wins over the whole
 * block is honest there. Notes are many things they write, and two devices
 * between one sync and the next routinely both have new ones — merged as a
 * block, whichever device wrote fewer of them would simply lose them. So each
 * record carries its own `at` (when it was written) and `ed` (when it last
 * changed), and the union is taken id by id. A card you wrote, and an edit you
 * made to a card the course ships, are the same shape and the same question.
 *
 * Deleting is the half that needs the care. A plain union resurrects every note
 * the other device has not heard about yet, so a delete is recorded rather than
 * dropped: the record stays, its words emptied, its `ed` newer than the words it
 * replaces — and that empty record beats the older ones on the device that
 * still has them. An empty note is therefore the delete marker, which is also
 * why the app refuses to store an empty note as a note; an emptied card record
 * is the same marker, and carries `hidden` when what it records is a course
 * card taken out rather than one of your own deleted.
 *
 * The markers are what makes this converge, and they are also why the entry
 * count is capped. Dropping the oldest markers can only bring back something
 * deleted more than WRITTEN_SLOTS entries ago, on a device that has been away
 * across all of them; an unbounded set on a bounded server blob is the worse
 * failure, because it takes the review history down with it.
 *
 * Live records are capped separately, and lower. Capping the entries alone was
 * not the same promise: app.js refuses the 201st note on one device, but three
 * devices holding 200 each merged to 600 live notes inside the entry budget, so
 * a deck could arrive back over a limit the app had already told the person
 * about — and then lose 200 of them to the next delete marker instead. Every
 * number here is the same number in app.js. What goes is counted, because the
 * one thing this must never be is quiet: see takeNoteDrops(), takeCardDrops().
 */

/* Where the ceilings come from, which was a guess in this repo until it was not.
 *
 * The backend is the one in content/day-skipper/supabase/migrations/
 * 20260727080812_sync_blobs.sql: one jsonb blob per (app, key hash), and
 * sync_put refuses a write over `sync.apps.max_bytes` with SQLSTATE 22023,
 * measured as octet_length(p_data::text). Both built-in courses are inserted at
 * the column default, so the bound is this number and not an assumption.
 *
 * 262,144 bytes is the WHOLE blob: review history, the day calendar, the
 * milestones, the settings, and everything a person has written. The history is
 * the part nobody chooses — Day Skipper's 537 cards, every one of them
 * answered, are 57 KB of records, and 400 days of calendar another 6 KB — so
 * about 66 KB is spoken for before anybody writes a word, and it grows with the
 * deck rather than with the person. That leaves roughly 190 KB.
 *
 * A note at its 2,000-character ceiling stores at about 2.1 KB; a card, having
 * two sides, about 4.2 KB. So what follows is ONE budget shared by notes and
 * cards rather than one each: two independent ceilings of 200 describe 800 KB
 * of writing inside a 256 KB blob, and the thing that loses when the blob will
 * not fit is the review history sharing the document.
 *
 * The ceiling is a count and not a byte count, deliberately. Eviction has to be
 * a prefix of a total order or a three-device merge stops converging, and
 * "keep records until the bytes run out" is not one: drop a long record and a
 * shorter one behind it moves up into the space, so merging a with b then c can
 * keep a different set from merging b with c then a. Records are counted here,
 * and the byte bound is enforced where it can be exact and where nothing is
 * lost by it — once, on the way out, in syncOnce().
 */
const MAX_BYTES = 262144;
// Live records one deck may hold, notes and your own cards together. Must match
// app.js's WRITTEN_LIVE — the app enforces it as you type and the merge
// enforces it as devices meet, and two different ceilings would mean a note
// accepted here and dropped one sync later.
const WRITTEN_LIVE = 200;
// Stored entries: the live records plus the emptied ones that record a delete,
// a hide or a revert. Must match app.js's WRITTEN_SLOTS.
const WRITTEN_SLOTS = 400;
// An id is used as an object key, here and in app.js's sanitisers, which is the
// one thing about it that has to be true. Hex is what app.js writes for a note;
// anything else came from somewhere else and is not stored under a key of its
// choosing.
const NOTE_ID = /^[a-z0-9]{1,64}$/;
// A card record is keyed either by an id this app wrote — the reserved `u.`
// prefix no shipped course may use — or by the id the course shipped the card
// under, which is an override. Both mirror cardIdOk() in app.js exactly: an id
// this file keeps and that file drops would arrive on every single sync.
const CARD_ID = /^u\.[a-f0-9]{1,32}$/;
const COURSE_CARD_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const cardIdOk = (id) => (id.startsWith('u.') ? CARD_ID.test(id) : COURSE_CARD_ID.test(id));
// Live records the merges since the last reading had to drop. A merge happens
// where nobody is looking — in the middle of a sync round, several times over —
// so it cannot speak for itself; it counts instead, and the app asks afterwards.
let noteDrops = 0;
let cardDrops = 0;

/** How many of somebody's words the merge dropped, once. Read and cleared
 *  together: this exists so the app can say it happened, and saying it twice
 *  for one loss would be its own kind of wrong. */
function takeNoteDrops() {
  const total = noteDrops;
  noteDrops = 0;
  return total;
}

/** The same, for cards. Two counters rather than one, because the sentence the
 *  app says names what went, and a card that went is not a note that went. */
function takeCardDrops() {
  const total = cardDrops;
  cardDrops = 0;
  return total;
}

/* One stamped record against another, for a note and for a card alike: it is
 * the same question — which of these two is the current one — and a second
 * answer to it would be a second answer to the tombstone question. */
function pickWritten(x, y) {
  if (!x) return y;
  if (!y) return x;
  let winner;
  if (num(x.ed) !== num(y.ed)) winner = num(x.ed) > num(y.ed) ? x : y;
  // On a tie, compared with `at` blanked, exactly as pickRec compares with the
  // lapse count blanked and for the same reason: `at` is derived by the line
  // below rather than held by either device, so feeding it back into the
  // comparison made a three-device merge depend on which pair met first — and
  // it sorts ahead of the words, so a rewritten stamp decided which words won.
  else {
    const xa = Object.assign({}, x, { at: 0 });
    const ya = Object.assign({}, y, { at: 0 });
    winner = stable(xa) <= stable(ya) ? x : y;
  }
  // When something was written is a fact about the past, and the earliest claim
  // is the true one — the same rule the milestones keep. Carrying the winner's
  // own stamp instead made a list re-order itself after a sync, which reads as
  // the app shuffling notes nobody touched.
  const written = [num(x.at), num(y.at)].filter((value) => value > 0);
  return Object.assign({}, winner, { at: written.length ? Math.min(...written) : 0 });
}

/** What makes a record of each kind live rather than a delete marker. */
const LIVE_FIELD = { note: 'text', card: 'front' };

/* obj() around the record as well as the block: this is the one entry point a
 * caller reaches with blocks it assembled itself rather than with the output of
 * a union, and a null under an id would otherwise throw on the read below —
 * inside a sync round, where a thrown error is a sync that never happened. */
function writtenEntries(block, kind) {
  const field = LIVE_FIELD[kind];
  return Object.entries(obj(block))
    .map(([id, raw]) => {
      const rec = obj(raw);
      return { kind, id, rec, live: !!rec[field] };
    });
}

/* Live records before delete markers, newest edit first, then the kind, then
 * the id. Total, so what a ceiling keeps never depends on which object the
 * entries were read out of: an eviction that depended on iteration order would
 * make a three-device merge depend on which pair was merged first. The kind is
 * in the order because notes and cards share one ceiling and two records of
 * different kinds can carry the same stamp. */
function writtenOrder(x, y) {
  if (x.live !== y.live) return x.live ? -1 : 1;
  if (num(x.rec.ed) !== num(y.rec.ed)) return num(y.rec.ed) - num(x.rec.ed);
  if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
  return x.id < y.id ? -1 : 1;
}

/** Take entries in that order until a ceiling stops them.
 *
 * Both ceilings are read off the one order, which is what keeps the merge
 * associative: whether an entry survives depends only on the entries ahead of
 * it, and every live record is ahead of every marker. The markers then fill
 * whatever the live records left of the entry budget. */
function keepWritten(entries) {
  entries.sort(writtenOrder);
  const out = { notes: {}, cards: {} };
  let kept = 0, live = 0;
  for (const entry of entries) {
    if (kept >= WRITTEN_SLOTS) break;
    if (entry.live) {
      if (live >= WRITTEN_LIVE) {
        if (entry.kind === 'note') noteDrops++; else cardDrops++;
        continue;
      }
      live++;
    }
    out[entry.kind === 'note' ? 'notes' : 'cards'][entry.id] = entry.rec;
    kept++;
  }
  return out;
}

function unionOf(a, b, kind, idOk) {
  const entries = [];
  const field = LIVE_FIELD[kind];
  for (const id of new Set(Object.keys(a).concat(Object.keys(b)))) {
    if (!idOk(id)) continue;
    const rec = pickWritten(
      a[id] === undefined ? null : obj(a[id]),
      b[id] === undefined ? null : obj(b[id])
    );
    entries.push({ kind, id, rec, live: !!rec[field] });
  }
  return entries;
}

/* One kind on its own. Capping a block against the joint ceilings before the
 * two blocks meet cannot change what survives — the order over one kind is the
 * joint order with the other kind taken out, so anything this drops the joint
 * pass would have dropped too — and it keeps mergeNotes() a whole answer for
 * app.js, which calls it on its own when a backup file is restored. */
function mergeNotes(a, b) {
  return keepWritten(unionOf(a, b, 'note', (id) => NOTE_ID.test(id))).notes;
}

function mergeCards(a, b) {
  return keepWritten(unionOf(a, b, 'card', cardIdOk)).cards;
}

/** The one ceiling notes and cards share, over both blocks at once. */
function capWritten(notes, cards) {
  return keepWritten(
    writtenEntries(notes, 'note').concat(writtenEntries(cards, 'card'))
  );
}

/** The document as Postgres writes it back, which is what sync_put measures.
 *
 * Not JSON.stringify. jsonb does not store the text it was sent — it parses it
 * and re-serialises, and its text form puts a space after every `:` and every
 * `,`. A blob of five thousand keys is therefore five thousand bytes bigger
 * there than here, and a check that measured the smaller number would wave
 * through blobs the server then refuses, which is the exact round trip this
 * measurement exists to save. Erring the other way costs a person nothing: the
 * refusal below is local and everything they wrote is still on the device. */
function pgJson(value) {
  if (Array.isArray(value)) return '[' + value.map(pgJson).join(', ') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .map((key) => JSON.stringify(key) + ': ' + pgJson(value[key]))
      .join(', ') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function blobBytes(value) {
  return new TextEncoder().encode(pgJson(value)).length;
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
  // The two things a person writes, merged kind by kind and then held to the
  // one ceiling they share. Nothing above this line is touched by either: a
  // card record arriving as a delete marker takes the card out of the deck, and
  // it must not take the review history for that card with it in the same tick.
  // Records are keyed by card id and this file would be the worst possible
  // place to delete one from — the app that can see whether the card is really
  // gone, and can say so out loud, does that sweep locally.
  const written = capWritten(
    mergeNotes(obj(a.notes), obj(b.notes)),
    mergeCards(obj(a.cards), obj(b.cards))
  );
  out.notes = written.notes;
  out.cards = written.cards;
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

  // Reconcile even when GET finds no row: the first upload is still an ingress
  // boundary and must not publish a schedule inconsistent with its exam.
  let state = cfg.reconcile(cfg.sanitise(local));
  let rev = 0;
  let changed = false;
  const rows = await rpc('sync_get_v2', {
    p_app: cfg.app,
    p_key_hash: keyHash,
    p_writer_version: WRITER_VERSION,
  });
  if (Array.isArray(rows) && rows.length) {
    rev = num(rows[0].rev);
    const remote = cfg.sanitise(rows[0].data);
    const merged = cfg.reconcile(mergeState(local, remote));
    changed = stable(merged) !== stable(remote);
    state = merged;
  } else {
    changed = true;
  }

  for (let round = 0; changed && round < MAX_ROUNDS; round++) {
    // Checked here rather than trusted to the counted ceilings, because the
    // ceilings count records and the server counts bytes. Over the bound the
    // server answers 22023 and stores nothing, so sending it costs a round trip
    // and returns a sentence nobody can act on. Refusing here loses nothing —
    // every word is still on this device — and names the way out. Inside the
    // loop, because a revision conflict merges another device's writing in.
    if (blobBytes(state) > MAX_BYTES) {
      // Marked as the person's to fix, not the network's. Every other failure
      // here is worth another go on its own; this one produces the same answer
      // for ever, and a screen promising that it will try again is a screen
      // telling somebody to wait for something that cannot happen.
      const full = new Error('the notes and cards in this deck are more than sync can '
        + 'carry, so nothing was sent; deleting some of them lets the rest through');
      full.yours = true;
      throw full;
    }
    let result;
    try {
      result = await rpc('sync_put_v2', {
        p_app: cfg.app,
        p_key_hash: keyHash,
        p_rev: rev,
        p_data: state,
        p_writer_version: WRITER_VERSION,
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
    state = cfg.reconcile(mergeState(state, theirs));
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
        writeLocal(Object.assign({}, record,
          { err: error.message || 'failed', errYours: !!error.yours }));
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
  WRITER_VERSION,
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
  mergeCards,
  capWritten,
  takeNoteDrops,
  takeCardDrops,
  MAX_BYTES,
  WRITTEN_LIVE,
  WRITTEN_SLOTS,
  blobBytes,
  pickRec,
  pickWritten,
  streakFrom,
  stable,
  app: () => cfg.app,
};

})(typeof globalThis !== 'undefined' ? globalThis : this);
