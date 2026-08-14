/* Munin — the review engine, over whichever course the shell has resolved.
 *
 * Everything here is shared by every course: the scheduler, screens, session,
 * and the adapter into achievements.js. What a course brings arrives on the
 * COURSE global that munin.js sets — its deck, its art maps, its accent, its
 * loading screen, and the names and drawings for the hoard. Nothing in this
 * file may name a course, a subject, or a drawing from one course's set; the
 * separation gate in tests/ fails the build if it does.
 *
 * No dependencies after the first load. Review history lives in localStorage
 * under one key; built-in courses may also copy it through opt-in Sync.
 *
 * Scheduling is SM-2 with the awkward parts removed: two learning steps, four
 * grades, ease clamped to a sane band, and a session-local relearn queue so a
 * card you got wrong comes back a few cards later instead of on a wall clock.
 */
'use strict';

const KEY = MUNIN.stateKey(COURSE.id);
// The cards you wrote and the edits you made, in their own document beside the
// review history rather than inside it. See MUNIN.cardsKey for why.
const CARDS_KEY = MUNIN.cardsKey(COURSE.id);
const STUDY_LOCK_KEY = KEY + '/study-lock';
const RESET_KEY = MUNIN.resetKey(COURSE.id);
// An active queue is tab-local, not account progress. sessionStorage survives
// a refresh in this tab without making an in-progress session follow someone
// to another device through Sync or a backup.
const ACTIVE_STUDY_KEY = 'keep-club/' + COURSE.id + '/active-study-session/v1';
const DAY = 86400000;
const MIN_EASE = 1.3, MAX_EASE = 2.8, MAX_IVL = 400;
// Three lapses, not Anki's six: six never fires inside a few weeks of revision,
// so the warning would arrive after the exam it was meant to prevent.
const LEECH_AT = 3;
// How many cards a deliberate "study ahead" or "no cards due in this section"
// session serves. Unbounded, it hands over the entire remaining deck.
const AHEAD_BATCH = 20;
// A note is a person's own words about the deck, so it is plain text, it is
// theirs, and it is bounded. Both caps are enforced on the way in and again on
// the way back out of storage: the sync blob a built-in course uploads is
// bounded at the far end, and one deck's notes must not be what fills it — the
// review history is in the same document and would go down with it.
const NOTE_LEN = 2000;
// The two things a person writes into a deck — notes, and cards — share one
// ceiling rather than holding one each. What bounds them is the sync blob, and
// the blob is one document: two independent ceilings would describe far more
// writing than it can hold, and what loses when it will not fit is the review
// history travelling beside it. The arithmetic, and the byte bound it is cut
// from, are written out in sync.js above MAX_BYTES.
//
// Live records this deck may hold. Past this the app says so rather than
// silently dropping the oldest, which is somebody's writing. Must match
// sync.js's WRITTEN_LIVE: this is the number a person is told about while they
// type, and the merge has to arrive at the same one when devices meet.
const WRITTEN_LIVE = 200;
// Stored entries: the live records plus the emptied ones that record a delete,
// a hide or a revert. Must match sync.js's WRITTEN_SLOTS — the merge caps to
// the same number, and a sanitiser with a lower cap would throw away what the
// merge just kept.
const WRITTEN_SLOTS = 400;
// Ids are written by newNoteId() and are hex. They are checked rather than
// trusted because a note id is used as an object key, and `{}['__proto__'] = v`
// sets a prototype instead of a property — a restored file or a synced blob is
// exactly where a key like that would arrive from.
const NOTE_ID = /^[a-z0-9]{1,64}$/;
// A card side is Markdown a person typed, bounded on the way in and again on
// the way back out of storage, exactly as a note is. The longest side any
// shipped course uses is 922 characters, so this ceiling is a long way past the
// card anybody is fixing when they meet it.
const CARD_LEN = 2000;
// A card you write takes a reserved id, and the layer accepts nothing else
// under that prefix. Checked rather than trusted because it becomes an object
// key, the same argument as NOTE_ID; and reserved in both directions, because
// the course readers refuse a shipped course that uses the prefix
// (RESERVED_ID_PREFIX in web/lib/legacy-course.js).
const CARD_ID = /^u\.[a-f0-9]{1,32}$/;
// A card the course shipped keeps the id the course gave it, which is the
// stable-id grammar the readers enforce (web/lib/course.js). An override is
// keyed by that id, so this is the other shape the layer accepts.
const COURSE_CARD_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// Where a card you wrote goes when the section it named is not in the deck any
// more — a course update that dropped that section, or a document edited by
// hand. A card is never dropped for it; see cardsWithLayer().
const LOOSE_SECTION = 'u.loose';
// Stamped into every exported file so restore can tell a real backup from any
// other JSON someone happens to pick.
const EXPORT_APP = 'munin/' + COURSE.id;
const EXPORT_FORMAT = 1;
// A <input type="date"> fires `change` on every keystroke in the year segment,
// so typing 2026 walks through 0002, 0020 and 0202 on its way. Anything outside
// this window is someone mid-keystroke, not a date they mean.
const EXAM_MIN_YEAR = 2020, EXAM_MAX_YEAR = 2040;

/** A real local-calendar date inside the range the controls offer.
 *
 * Date.parse normalises impossible dates instead of refusing them: February 31
 * becomes March 3. A restored or synced value like that is blank in a native
 * date field while still changing the scheduler, which is the worst possible
 * disagreement between a setting and what it does. Round-trip the parts so an
 * impossible day can never enter scheduling. */
function validExamDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < EXAM_MIN_YEAR || year > EXAM_MAX_YEAR) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year
    && date.getMonth() === month - 1
    && date.getDate() === day;
}

// A course may name the exam it was built for (course.json examDate); a fresh
// install starts there rather than asking. It is changed in Settings, and
// clearing it goes back to plain spacing. No valid date in the course → no default.
const EXAM_DEFAULT = validExamDate(COURSE.examDate) ? COURSE.examDate : '';
// Not every course is sat. `"exam": false` in course.json takes the ask, the
// Settings row and the countdown off that course altogether; absent means yes,
// so a course that says nothing keeps what it has always had.
const EXAM_ON = COURSE.exam !== false;
// The text sizes offered, smallest first. Names rather than numbers: the pixels
// belong to app.css (`:root[data-font=…]`), which is the only place that knows
// what the type scale is measured in, and a number stored here would be a
// second opinion about it. 'default' is 15px — the size the app was drawn at,
// and what anyone who has never opened this setting is already reading. It is
// also the floor now: the step below it was 13px, which is smaller than the
// app draws anything else, and the scale runs up from here to 23 rather than
// stopping at 19. A save holding the step that went comes back as 'default'
// through the sanitiser, which is the smallest there is now — the same 15px
// that device would be offered on a fresh install.
const FONT_SIZES = ['default', 'large', 'xlarge', 'huge', 'biggest'];
const FONT_DEFAULT = 'default';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ─────────────────────────── doodles ─────────────────────────── */

/* The drawings themselves live in web/doodles.js, generated by src/doodles.py:
 * they are re-drawn there at build time so the line looks hand-made, which is
 * not something to do at runtime on a phone. That file declares `DOODLE` and is
 * loaded before this one, because the boot screen draws one immediately. */


/* The drawing goes inside a sized wrapper rather than being sized itself: an
 * <svg> that is a flex item ignores its own width and fills the slot, which put
 * ten 48px-tall boats across a 320px screen the first time this shipped. */
/* A drawing is a string, and only a string. `DOODLE[name]` is an index into a
 * plain object, so a course naming a drawing "constructor" or "toString" got a
 * truthy non-path back and short-circuited every fallback below it — a blank
 * drawing, no warning, and the gate could not see it because the gate looked
 * the same way. */
const pathOf = (set, name) => (typeof set[name] === 'string' ? set[name] : null);

function doodlePath(name) {
  // Munin's own set is consulted before the course's fallback: a name this
  // course does not draw but Munin does — the raven the hoard's defaults are
  // written in — is drawn by Munin, rather than collapsing into fourteen
  // copies of one course drawing. The two key spaces do not overlap (the
  // separation gate holds them apart), so this cannot capture a course's name.
  return pathOf(DOODLE, name) || pathOf(MUNIN_DOODLE, name)
    || pathOf(DOODLE, COURSE.fallback) || Object.values(DOODLE).find((v) => typeof v === 'string');
}

function doodle(name, cls, style) {
  const d = doodlePath(name);
  // pathLength="1" costs nothing where nothing reads it, and it is what lets
  // the achievement sheet's .redraw class draw any doodle with one CSS rule —
  // the same trick the boot raven and a card's own figure already use.
  return `<span class="dood ${cls || ''}"${style ? ` style="${style}"` : ''} aria-hidden="true">`
    + `<svg class="doodle" viewBox="0 0 32 32"><path pathLength="1" d="${d}"/></svg></span>`;
}

let DECK = null;                 // normalized runtime course
let COURSE_MEDIA = null;         // lazy descriptive media renderer
let RUNTIME_SOURCE_FORMAT = 'legacy-v1';
let FIGURES = null;              // figures.json — the labelled doodles
let byId = new Map();
let sectionOf = new Map();       // section id -> {sectionId, title, cardCount}
let groupOf = new Map();         // group id -> {groupId, title, cardCount, sectionIds}
let groupFor = new Map();        // section id -> group id
let state = null;
let session = null;
let undoStack = [];

/* A review state is one JSON document, so two tabs cannot safely grade it at
 * once: whichever whole document writes last erases the other answer. Keep one
 * active study writer per course. The short lease recovers from a killed tab;
 * every answer re-checks ownership, so a simultaneous start still has one
 * winner before either state mutation. */
const STUDY_OWNER = (crypto.randomUUID && crypto.randomUUID())
  || Math.random().toString(36).slice(2) + Date.now().toString(36);
const STUDY_LOCK_TTL = 15000;
let studyHeartbeat = null;

function readStudyLock() {
  try {
    const lock = JSON.parse(localStorage.getItem(STUDY_LOCK_KEY) || 'null');
    return lock && typeof lock.owner === 'string' && Number.isFinite(Number(lock.at))
      ? lock : null;
  } catch (e) { return null; }
}

function ownsStudyLock() {
  return readStudyLock()?.owner === STUDY_OWNER;
}

function touchStudyLock() {
  if (!ownsStudyLock()) return false;
  try {
    localStorage.setItem(STUDY_LOCK_KEY, JSON.stringify({ owner: STUDY_OWNER, at: Date.now() }));
    return ownsStudyLock();
  } catch (e) { return false; }
}

function claimStudyLock() {
  const held = readStudyLock();
  const age = held ? Date.now() - Number(held.at) : Infinity;
  if (held && held.owner !== STUDY_OWNER && age >= 0 && age < STUDY_LOCK_TTL) {
    return false;
  }
  try {
    localStorage.setItem(STUDY_LOCK_KEY, JSON.stringify({ owner: STUDY_OWNER, at: Date.now() }));
  } catch (e) {
    return false;
  }
  if (!ownsStudyLock()) return false;
  clearInterval(studyHeartbeat);
  studyHeartbeat = setInterval(() => {
    if (session && !touchStudyLock()) loseStudyLock();
  }, 4000);
  return true;
}

function releaseStudyLock() {
  clearInterval(studyHeartbeat);
  studyHeartbeat = null;
  if (!ownsStudyLock()) return;
  try { localStorage.removeItem(STUDY_LOCK_KEY); } catch (e) { /* lease expires */ }
}

function loseStudyLock() {
  clearInterval(studyHeartbeat);
  studyHeartbeat = null;
  if (session) leaveStudy(false);
  toast('Another tab is studying this deck. This session was stopped before any progress was lost.');
}

/* ─────────────────────────── storage ─────────────────────────── */

function freshState() {
  return {
    v: 1,
    recs: {},                    // card id -> {st, step, ivl, ea, due, rp, lp}
    day: dayKey(Date.now()),
    newDone: 0,
    revDone: 0,
    streak: 0,
    lastDay: null,
    days: {},                    // dayKey -> answers, for the streak
    revTotal: 0,
    revGood: 0,
    answers: 0,                  // every grade ever, for the hoard
    bestClean: 0,                // longest run without Again, across sessions
    ach: {},                     // achievement id -> unlocked timestamp
    notes: {},                   // note id -> {at, ed, text}; empty text = deleted
    // Light by default rather than following the system: the paper, the ink
    // outlines and the hard shadows are the design, and the derived dark set is
    // the fallback for people who go looking for it.
    settings: {
      newPerDay: 20, maxRev: 120, shuffle: true,
      examDate: EXAM_DEFAULT, examSkipped: false,
      fontSize: FONT_DEFAULT,
    },
  };
}

/* Numbers interpolated into innerHTML are coerced, not trusted: a restored
 * backup is the one place a string can reach these templates. */
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** Deterministic comparison for converged documents whose object insertion
 * order came from different tabs. JSON text order is not data: comparing the
 * raw strings here can make two semantically identical tabs rewrite forever. */
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isPlainObject(value)) return '{' + Object.keys(value).sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}
/** Cut user-authored text without leaving half of a surrogate pair behind. */
const cutCodePoints = (value, limit) => {
  const text = String(value == null ? '' : value);
  const points = [...text];
  return points.length <= limit ? text : points.slice(0, limit).join('');
};
/** "1 day", not "1 days" — the app counts down to a date, so it hits 1 often. */
const plural = (v, word) => `${n(v)} ${n(v) === 1 ? word : word + 's'}`;
/** "a", "a and b", "a, b and c".
 *
 * Three things can be in this deck's backup — review history, notes, and the
 * cards somebody wrote — and any one of them can be the only one there is. The
 * sentences that name them were each built by hand out of nested conditionals,
 * which is how the export toast came to tell a deck full of hand-written cards
 * that it held nothing but settings. */
const listWords = (parts) => (parts.length < 2
  ? (parts[0] || '')
  : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]);

/* Live notes the sanitiser has dropped and nobody has been told about yet. The
 * sanitiser runs before there is a screen to say it on — it is the first thing
 * boot() does — so it counts, and the places that can speak ask. */
let notesDropped = 0;

/** Make any stored or imported blob safe to run on.
 *
 * Everything here has been seen to break the app for real: a value missing
 * `days` threw on the first answer and wrote itself back, `recs` as a string
 * made boot throw before the loading screen came down, and a non-numeric
 * interval produced a NaN due date that removed a card from scheduling for
 * good. Trust nothing that came out of storage or off disk. */
function sanitise(raw) {
  const base = freshState();
  if (!isPlainObject(raw)) return base;
  const s = Object.assign(base, raw);
  // Everything this function does not name is carried through, which is how a
  // key from a newer build survives an older one. The cards you write are the
  // exception, and they are the exception on purpose: they live in a document
  // of their own beside this one (MUNIN.cardsKey), a merged blob carries both,
  // and this is the sanitiser the state half of it goes through. Left on the
  // object, the block would be written into the document that must not hold it
  // and would sit there as a second, staler copy of somebody's cards.
  delete s.cards;
  s.settings = Object.assign(freshState().settings, isPlainObject(raw.settings) ? raw.settings : {});

  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  s.settings.newPerDay = Math.round(num(s.settings.newPerDay, 0, 200, 20));
  s.settings.maxRev = Math.round(num(s.settings.maxRev, 10, 999, 120));
  // A corrupt backup or old experimental build must not pin the settings
  // winner with Infinity, a string, or a timestamp outside JavaScript's date
  // range. Zero means the block predates timestamped settings sync.
  s.settings.at = Math.round(num(s.settings.at, 0, 8.64e15, 0));
  s.settings.shuffle = !!s.settings.shuffle;
  s.settings.examSkipped = !!s.settings.examSkipped;
  // Anything that is not one of the five steps is the default size, which also
  // covers the two cases that matter: every save written before this setting
  // existed has no fontSize at all, and those people must go on reading the app
  // at exactly the size they have always read it at; and a save holding the
  // 13px step that has since been dropped lands on the smallest step there is.
  // The value is written straight into an attribute selector, so it is checked
  // against the list rather than merely coerced to a string.
  if (!FONT_SIZES.includes(s.settings.fontSize)) s.settings.fontSize = FONT_DEFAULT;
  // The default exam date belongs to a fresh install only. A restored backup
  // that never had one must not silently inherit it — that would compress every
  // interval on someone else's deck the moment they imported it.
  const rawExam = isPlainObject(raw.settings) ? raw.settings.examDate : undefined;
  if (typeof rawExam !== 'string') s.settings.examDate = '';
  if (!validExamDate(s.settings.examDate)) {
    s.settings.examDate = '';
  }

  const recs = {};
  if (isPlainObject(raw.recs)) {
    for (const [id, r] of Object.entries(raw.recs)) {
      if (!isPlainObject(r)) continue;
      const st = r.st === 'r' ? 'r' : 'l';
      recs[id] = {
        st,
        step: Math.round(num(r.step, 0, 9, 0)),
        ivl: Math.round(num(r.ivl, 0, MAX_IVL, st === 'r' ? 1 : 0)),
        ea: num(r.ea, MIN_EASE, MAX_EASE, 2.5),
        due: num(r.due, 0, 8.64e15, Date.now()),
        rp: Math.round(num(r.rp, 0, 1e6, 0)),
        lp: Math.round(num(r.lp, 0, 1e6, 0)),
        pv: Math.round(num(r.pv, 0, MAX_IVL, 0)),
      };
    }
  }
  s.recs = recs;
  s.days = isPlainObject(raw.days) ? raw.days : {};
  for (const [k, v] of Object.entries(s.days)) {
    const stamp = /^\d{4}-\d{2}-\d{2}$/.test(k) ? Date.parse(k + 'T00:00:00') : NaN;
    if (!Number.isFinite(Number(v)) || Number.isNaN(stamp) || dayKey(stamp) !== k) {
      delete s.days[k];
    } else {
      s.days[k] = Math.max(0, Math.round(Number(v)));
    }
  }
  s.streak = Math.round(num(s.streak, 0, 1e5, 0));
  s.newDone = Math.round(num(s.newDone, 0, 1e6, 0));
  s.revDone = Math.round(num(s.revDone, 0, 1e6, 0));
  s.revTotal = Math.round(num(s.revTotal, 0, 1e9, 0));
  s.revGood = Math.round(num(s.revGood, 0, s.revTotal, 0));
  // The old build recorded the 20-card clean-run unlock but not the underlying
  // best. Preserve the minimum fact that unlock proves when upgrading.
  const legacyClean = isPlainObject(raw.ach) && Number(raw.ach['clean-run']) > 0 ? 20 : 0;
  s.bestClean = Math.round(num(s.bestClean, 0, 1e9, legacyClean));

  // An older save has no lifetime counter. Sum the day history rather than
  // starting at zero, or upgrading resets the hoard for everyone.
  s.answers = Math.round(num(
    raw.answers,
    0, 1e9,
    Object.values(s.days).reduce((t, v) => t + Number(v || 0), 0)
  ));
  // Only ids this build knows about, and only real timestamps: an unlock date of
  // "yes" renders as Invalid Date in the log for ever.
  const ach = {};
  if (isPlainObject(raw.ach)) {
    for (const [id, ts] of Object.entries(raw.ach)) {
      if (!ACH_IDS.has(id)) continue;
      const t = Number(ts);
      if (Number.isFinite(t) && t > 0) ach[id] = Math.round(t);
    }
  }
  s.ach = ach;

  // Notes are the one part of this document a person wrote themselves, which
  // makes them the one part with no shape the app can predict. Everything here
  // has a way of arriving: a restored backup written by an older build with no
  // notes at all, a synced blob that spent time in a database, a file someone
  // edited by hand. A note whose text is a number renders as "[object
  // Object]" at best and throws at worst, and either way it does it on the
  // screen that is meant to be showing what they wrote.
  const notes = {};
  if (isPlainObject(raw.notes)) {
    const entries = [];
    for (const [id, note] of Object.entries(raw.notes)) {
      if (!NOTE_ID.test(id) || !isPlainObject(note)) continue;
      // Tabs and newlines are text a person typed and are kept. The rest of the
      // C0 range is not: it survives JSON, it is invisible in the panel, and it
      // is the difference between what the list shows and what is stored.
      const text = cutCodePoints(
        (typeof note.text === 'string' ? note.text : '')
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''),
        NOTE_LEN,
      );
      const at = Math.round(num(note.at, 0, 8.64e15, 0));
      // An edit stamp that is missing falls back to the written stamp rather
      // than to zero: zero would lose every merge against a device that has
      // the same note, including the copy this one is about to delete.
      entries.push([id, { at, ed: Math.round(num(note.ed, 0, 8.64e15, at)), text }]);
    }
    // More entries than this build stores can only come from somewhere else.
    // Delete markers go first, then the oldest — the same order the merge
    // evicts in, so a round trip through Sync does not change what survives.
    // Both ceilings are applied here for the same reason and in the same way as
    // in sync.js's mergeNotes: the live one is the promise the panel makes while
    // somebody types, and a document arriving from a file or a database is
    // exactly where more than that can turn up.
    entries.sort(noteEntryOrder);
    let kept = 0, live = 0;
    for (const [id, note] of entries) {
      if (kept >= WRITTEN_SLOTS) break;
      if (note.text) {
        if (live >= WRITTEN_LIVE) { notesDropped++; continue; }
        live++;
      }
      notes[id] = note;
      kept++;
    }
  }
  s.notes = notes;

  if (typeof s.day !== 'string') s.day = dayKey(Date.now());
  if (typeof s.lastDay !== 'string' || !s.days[s.lastDay]) s.lastDay = null;
  return s;
}

function load() {
  let s = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) s = JSON.parse(raw);
  } catch (e) {
    console.warn('progress unreadable, starting fresh', e);
  }
  state = sanitise(s);
  // Establish the baseline before the first settings edit. Leaving this null
  // meant the first change after a cold open was not timestamped, so another
  // device's older settings could win the next sync.
  settingsShape = JSON.stringify(Object.assign({}, state.settings, { at: 0 }));
  rollDay();
}

let saveTimer = null;
let discardStateOnLeave = false;
let saveBlocked = false;
function readResetStamp() {
  try { return localStorage.getItem(RESET_KEY); } catch (e) { return resetStamp; }
}
let resetStamp = null;
resetStamp = readResetStamp();
function liveForeignStudyLock() {
  const held = readStudyLock();
  if (!held || held.owner === STUDY_OWNER) return false;
  const age = Date.now() - Number(held.at);
  return age >= 0 && age < STUDY_LOCK_TTL;
}

function refuseForeignWrite() {
  if (session || !liveForeignStudyLock()) return false;
  // The active tab owns the whole review document. Throw away this idle tab's
  // tentative mutation and re-adopt the durable copy rather than letting a
  // settings write erase a grade—or letting the next grade erase the setting.
  try {
    const raw = localStorage.getItem(KEY);
    state = sanitise(raw ? JSON.parse(raw) : null);
    if (DECK) {
      sweepUnknownRecords();
      settingsShape = JSON.stringify(Object.assign({}, state.settings, { at: 0 }));
      applyTheme();
      applyFontSize();
      if (current === 'home') renderHome();
      if (current === 'stats') renderStats();
      if (current === 'browse') renderBrowse();
      renderNotesIfOpen();
      renderSetupIfOpen();
    }
  } catch (e) { /* retain the last readable in-memory state */ }
  toast('Another tab is studying this deck. Finish there before changing progress or settings.');
  return true;
}

function publishStateReset() {
  const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  // The marker goes first: every other live or suspended tab must suppress its
  // stale write before this tab removes the old whole-document account.
  localStorage.setItem(RESET_KEY, stamp);
  localStorage.removeItem(STUDY_LOCK_KEY);
  localStorage.removeItem(KEY);
  resetStamp = stamp;
  discardStateOnLeave = false;
}
function save(preserveIdleBranch = true) {
  clearTimeout(saveTimer);
  if (refuseForeignWrite()) return false;
  saveTimer = setTimeout(() => writeNow(preserveIdleBranch), 250);
  return true;
}
/* Settings sync as one block, last write wins, which needs a time they were
 * last written. Stamped here rather than in each handler: there are eight
 * places settings change, and the ninth would have been the one that forgot. */
let settingsShape = null;

/** A readable review document from storage, or null.
 *
 * Kept separate from load(): a write may need the durable copy without
 * replacing the tab's pending changes first. */
function stateDocument(text) {
  if (typeof text !== 'string' || !text) return null;
  try { return sanitise(JSON.parse(text)); } catch (e) { return null; }
}

/** Merge idle-tab copies with the same convergent algebra device Sync uses.
 *
 * The study lease serialises grades, but idle tabs can both write notes,
 * cards, or settings. localStorage operations are atomic one at a time, not as
 * a read/change/write transaction, so re-reading before a write narrows the
 * race and storage-event healing closes it: the event carries the overwritten
 * branch even when the durable value has already moved again. */
function mergeStateDocuments(...copies) {
  if (!globalThis.DSSync || !DSSync.mergeState) return;
  let merged = state;
  for (const copy of copies) {
    if (copy) merged = DSSync.mergeState(merged, copy);
  }
  state = sanitise(merged);
}

function writeNow(preserveIdleBranch = false) {
  clearTimeout(saveTimer);
  // A different tab may have explicitly replaced this deck and started over.
  // Its tombstone is persistent, so even a suspended tab that missed the
  // storage event cannot recreate the deleted account on pagehide.
  if (discardStateOnLeave || readResetStamp() !== resetStamp) {
    discardStateOnLeave = true;
    return true;
  }
  if (refuseForeignWrite()) return false;
  const shape = JSON.stringify(Object.assign({}, state.settings, { at: 0 }));
  if (settingsShape !== null && shape !== settingsShape) state.settings.at = Date.now();
  // Ordinary debounced edits preserve a branch another idle tab completed
  // before this setItem. Explicit replacement paths (restore, reset, eviction)
  // pass false: merging the value they deliberately supersede would resurrect
  // the records they just removed. Storage-event healing still closes a truly
  // simultaneous ordinary-write race below.
  if (preserveIdleBranch) {
    let durableText = null;
    try { durableText = localStorage.getItem(KEY); } catch (e) { /* setItem reports below */ }
    mergeStateDocuments(stateDocument(durableText));
  }
  settingsShape = JSON.stringify(Object.assign({}, state.settings, { at: 0 }));
  let wrote = false;
  try {
    const wasBlocked = saveBlocked;
    localStorage.setItem(KEY, JSON.stringify(state));
    wrote = true;
    saveBlocked = false;
    if (wasBlocked) {
      toast('Progress is saving again.');
      if (current === 'stats' || !$('#setup').hidden) renderBackupState();
    }
  } catch (e) {
    saveBlocked = true;
    toast('Progress is not saving — stop here and export a backup from Settings.', true);
    if (current === 'stats' || !$('#setup').hidden) renderBackupState();
  }
  // Never mid-session: adopting a merged state would swap the deck out from
  // under the card on screen. The upload waits for the walk back to Progress.
  if (globalThis.DSSync && !session) DSSync.schedule(syncPayload);
  return wrote;
}
function flushAndReleaseStudyLock() {
  if (writeNow()) {
    releaseStudyLock();
  } else {
    // Do not invite a second writer onto state that this tab could not commit.
    // The short lease still recovers automatically if this page is gone.
    clearInterval(studyHeartbeat);
    studyHeartbeat = null;
  }
}
// The importer's explicit "replace it and start over" can run over this live
// course. Without suppressing pagehide, the old page rewrote the state key
// immediately after the importer removed it.
MUNIN.abandonState = (id) => {
  if (id !== COURSE.id) return;
  discardStateOnLeave = true;
  clearTimeout(saveTimer);
  clearStudySession();
};
addEventListener('pagehide', () => {
  persistStudySession();
  flushAndReleaseStudyLock();
});
addEventListener('pageshow', (e) => {
  // pagehide releases the lease so a page in the back-forward cache cannot
  // block another tab while suspended. If it comes back with its in-memory
  // session intact, reclaim when free or stop immediately when another tab
  // took over.
  if (e.persisted && session && !claimStudyLock()) loseStudyLock();
});

/* Coming back to the app is the other moment the other device's session is
 * most likely to be sitting there waiting. Opening it covers a cold load, but
 * an installed app resumed from the background never runs boot() again, so
 * without this a phone that is never fully closed would only ever push.
 *
 * Throttled, because backgrounding and foregrounding is something a phone does
 * on its own, several times, while you are reading one card. */
const RESUME_AFTER = 60000;
function syncOnReturn() {
  if (document.hidden || !DECK || session) return;
  if (!globalThis.DSSync || !DSSync.enabled()) return;
  if (Date.now() - (DSSync.status().at || 0) < RESUME_AFTER) return;
  runSync();
}
addEventListener('visibilitychange', () => {
  if (document.hidden) writeNow(); else syncOnReturn();
});
// Signal came back. Whatever failed while it was gone is worth another go, and
// this is the only thing that makes "it will try again" true without a button.
addEventListener('online', syncOnReturn);

/* Two tabs on the same deck used to overwrite each other silently — whichever
 * saved last won, and the other tab's answers were gone. Adopt the other tab's
 * state unless we are mid-session, in which case say so rather than yanking the
 * card out from under the reader. */
addEventListener('storage', (e) => {
  if (e.key === STUDY_LOCK_KEY) {
    if (session && !ownsStudyLock()) loseStudyLock();
    return;
  }
  if (e.key === RESET_KEY && e.newValue !== resetStamp) {
    // "Start over" is deck-wide, not tab-local. Stop every stale writer before
    // it can resurrect the removed state, then reload the replacement deck.
    resetStamp = e.newValue;
    discardStateOnLeave = true;
    clearTimeout(saveTimer);
    releaseStudyLock();
    session = null;
    location.reload();
    return;
  }
  if (e.key === CARDS_KEY) {
    // Two idle tabs can both write cards: the study lease is only held while
    // somebody is answering. Take the other tab's document rather than drawing
    // a deck that no longer exists — but not mid-session, where the deck would
    // change under the card on screen. No sweep either: a card deleted over
    // there must not take its review history here in the same tick.
    if (!shippedCourse) return;
    if (session) {
      toast('Another tab is changing the cards in this deck. Close one, or the deck will not add up.');
      return;
    }
    if (e.newValue === null) {
      loadCardLayer();
      applyCardLayer().then(renderDeckChanged).catch(console.error);
      return;
    }
    const incoming = cardLayerDocument(e.newValue);
    let durable = null;
    try { durable = cardLayerDocument(localStorage.getItem(CARDS_KEY)); } catch (err) { /* use event */ }
    if (incoming.ok) cardLayer = mergedCards(cardLayer, incoming.cards);
    if (durable && durable.ok) cardLayer = mergedCards(cardLayer, durable.cards);
    capWrittenBlocks();
    const durableCards = durable && durable.ok ? durable.cards : {};
    if (stableJson(cardLayer) !== stableJson(durableCards)) writeCardLayer();
    applyCardLayer().then(renderDeckChanged).catch(console.error);
    return;
  }
  if (e.key !== KEY || !e.newValue || !DECK) return;
  let incoming;
  try { incoming = JSON.parse(e.newValue); } catch (err) { return; }
  if (session) {
    toast('Another tab is studying this deck. Close one, or your progress will not add up.');
    return;
  }
  let durableText = null;
  try { durableText = localStorage.getItem(KEY); } catch (err) { /* the event is still readable */ }
  const durable = stateDocument(durableText);
  mergeStateDocuments(sanitise(incoming), durable);
  sweepUnknownRecords();
  // This was another tab's write, not a fresh local settings decision.
  settingsShape = JSON.stringify(Object.assign({}, state.settings, { at: 0 }));
  applyTheme();
  applyFontSize();
  if (current === 'home') renderHome();
  if (current === 'stats') renderStats();
  if (current === 'browse') renderBrowse();
  renderNotesIfOpen();
  renderSetupIfOpen();
  // If this event is the branch another tab overwrote, put the union back. An
  // identical document is left alone so converged tabs do not echo forever.
  if (!durable || stableJson(state) !== stableJson(durable)) writeNow();
});

/* ─────────────────────────── dates ─────────────────────────── */

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Add local calendar days, not 24-hour blocks. The spring clock change makes
 * one local day 23 hours; adding milliseconds at 23:30 skipped a whole date. */
function addCalendarDays(ts, days) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** Yesterday's key, worked out on the calendar rather than by subtracting 24
 *  hours — on the two clock-change days a year, 24 hours ago is either still
 *  today or the day before yesterday, and the streak resets for no reason. */
function yesterdayKey() {
  const d = new Date(Date.now());
  d.setDate(d.getDate() - 1);
  return dayKey(d.getTime());
}

/** Roll the per-day counters over, and keep the streak honest. */
function rollDay() {
  const today = dayKey(Date.now());
  if (state.day === today) return;
  state.day = today;
  state.newDone = 0;
  state.revDone = 0;
  // a streak survives one calendar day's gap only
  if (state.lastDay !== yesterdayKey() && state.lastDay !== today) state.streak = 0;
  save();
}

function countStudiedToday() {
  return state.days[state.day] || 0;
}

function noteAnswered() {
  const t = state.day;
  state.days[t] = (state.days[t] || 0) + 1;
  state.answers = n(state.answers) + 1;
  if (state.lastDay !== t) {
    state.streak = state.lastDay === yesterdayKey() ? state.streak + 1 : 1;
    state.lastDay = t;
  }
  // Keep enough calendar evidence for the one-year club milestone. This used
  // to retain only 90 days, which made a 365-day streak mathematically
  // unreachable once club streaks were derived across courses.
  const keys = Object.keys(state.days);
  if (keys.length > 420) {
    keys.sort();
    for (const k of keys.slice(0, keys.length - 400)) delete state.days[k];
  }
}

/* ─────────────────────────── scheduling ─────────────────────────── */

function newRec() {
  // pv = the interval a relapsed card gets back when it re-graduates
  return { st: 'l', step: 0, ivl: 0, ea: 2.5, due: 0, rp: 0, lp: 0, pv: 0 };
}

/** New cards to introduce today.
 *
 * With an exam date set, the manual figure is a floor rather than the answer:
 * 20 a day gets through 537 cards in 27 days, so if the exam is in three weeks
 * a fifth of the deck would never be seen once. Aim to finish introducing by
 * 60% of the way to the date, leaving the rest of the run for review. */
function newBudget() {
  const manual = state.settings.newPerDay;
  // Zero is an instruction, not a floor to negotiate up from. `Math.max` below
  // meant that a course shipping an exam date carried on introducing twenty a
  // day however firmly the reader had switched new cards off.
  if (manual <= 0) return 0;
  const d = daysToExam();
  if (d === null || d <= 0) return manual;
  const unseen = DECK ? DECK.cards.filter((c) => !state.recs[c.cardId]).length : 0;
  if (!unseen) return manual;
  return Math.max(manual, Math.ceil(unseen / Math.max(1, Math.round(d * 0.6))));
}

/** Whole days from today to the exam, or null if no date is set. */
function daysToExam() {
  // A course with no exam has no countdown, whatever a restored backup or a
  // synced settings block happens to carry in this field.
  if (!EXAM_ON) return null;
  const d = state.settings.examDate;
  if (!validExamDate(d)) return null;
  const [year, month, day] = d.split('-').map(Number);
  const t = new Date(year, month - 1, day).getTime();
  return Math.round((startOfDay(t) - startOfDay(Date.now())) / DAY);
}

function fuzz(days) {
  if (days < 3) return days;
  const spread = Math.max(1, Math.round(days * 0.05));
  return days + (Math.floor(Math.random() * (spread * 2 + 1)) - spread);
}

/** The longest interval allowed right now — shortened once an exam date is set.
 *
 * Cepeda et al. (2008) put the best gap at roughly 10–20% of the interval you
 * need to remember over. Studying for a date, that interval is the days left,
 * so a card scheduled past the exam is a card you have stopped revising. */
function ceiling() {
  const d = daysToExam();
  // A date in the past is a typo or an exam already sat. Either way it must not
  // cap anything: `Math.round(-300 * 0.2)` floors to 1 day and makes the whole
  // deck due daily, for ever, with no way back.
  if (d === null || d < 0) return MAX_IVL;
  return Math.max(1, Math.min(MAX_IVL, Math.round(d * 0.2)));
}

/** What the next interval would be, in days. 0 means "again this session". */
function preview(rec, g) {
  const cap = ceiling();
  const lim = (d) => Math.min(cap, MAX_IVL, d);
  if (!rec || rec.st === 'l') {
    if (g === 1) return 0;
    // Hard keeps a card in the session, but not forever: three goes and it
    // leaves, otherwise a card you keep calling hard never ends.
    if (g === 2) return (rec && rec.step >= 2) ? lim(rec.pv || 1) : 0;
    if (g === 3) return lim((rec && rec.pv) || 1);
    return lim(rec && rec.pv ? Math.max(rec.pv, 2) : 4);
  }
  const ea = rec.ea;
  // Again sends a review card back into this session; the interval it comes out
  // with is decided when it graduates, so there is no number to promise here.
  if (g === 1) return 0;
  // Hard holds the interval where it is. Growing it — which plain SM-2 does —
  // means a card you always find hard drifts out to months and stops being
  // revised at all, which is the opposite of what "hard" is telling you.
  if (g === 2) return lim(Math.max(1, rec.ivl));
  if (g === 3) return lim(Math.max(rec.ivl + 1, Math.round(rec.ivl * ea)));
  return lim(Math.max(rec.ivl + 2, Math.round(rec.ivl * ea * 1.3)));
}

/** The interval a grade will really schedule — the jitter rolled in, once.
 *
 * preview() is the number before the fuzz, and grade() used to fuzz it again
 * after reveal() had already printed it on the button: sixteen labels in twenty
 * were wrong, and good and easy often showed the same day with nothing to
 * choose between them. Rolled here, so the number promised and the number
 * applied are the same number. */
function scheduled(rec, g) {
  const out = preview(rec, g);
  // 0 is "again this session", which is not a date and does not get jittered.
  if (out <= 0) return 0;
  // Hard means "leave the gap where it is". Fuzzing an unchanged interval turns
  // that into a random walk that drifts over repeated presses; the jitter is
  // only there to break up clumps of cards scheduled together.
  const jitter = !(rec && rec.st === 'r' && g === 2);
  return Math.min(ceiling(), MAX_IVL, Math.max(1, jitter ? fuzz(out) : out));
}

/** Apply a grade. Returns 'stay' if the card should come back this session.
 *
 * `ivl` is the figure reveal() printed on the button that was pressed. Rolled
 * once there and passed in here, because a second roll is a second answer.
 *
 * `practising` is a session over cards that are not due yet, and it writes
 * nothing down. The rules below still run — they are what decides whether a
 * card comes back before this session ends — but they run on a copy that goes
 * out of scope with the answer. Answering a card fifteen seconds after you
 * last answered it used to grow its interval as though a day had passed, so a
 * quiet afternoon of extra work pushed the whole deck out to the cap. */
function grade(id, g, ivl, practising) {
  const stored = state.recs[id];
  const rec = practising ? Object.assign({}, stored || newRec()) : (stored || newRec());
  const isNew = !stored;
  const wasReview = rec.st === 'r';
  if (!practising) state.recs[id] = rec;
  rec.rp++;

  if (wasReview && !practising) {
    state.revTotal++;
    if (g > 1) state.revGood++;
  }

  let outcome = 'done';
  // Worked out before anything below moves the ease, or the card is scheduled
  // off a number the button never showed.
  const out = Number.isFinite(ivl) ? ivl : scheduled(rec, g);

  if (rec.st === 'l') {
    if (g === 1) { rec.step = 0; outcome = 'stay'; }
    else if (g === 2 && rec.step < 2) { rec.step++; outcome = 'stay'; }
    else { rec.st = 'r'; rec.ivl = out; rec.pv = 0; }
  } else {
    if (g === 1) {
      rec.lp++;
      rec.ea = Math.max(MIN_EASE, rec.ea - 0.2);
      // Remember 40% of the interval so re-graduating restores most of what was
      // learned instead of dropping the card back to one day. Losing six good
      // reviews over one slip is a punishment nobody has time for.
      rec.pv = Math.max(1, Math.round(rec.ivl * 0.4));
      rec.st = 'l';
      rec.step = 1;
      outcome = 'stay';
    } else {
      // The interval is computed from the ease the button was *labelled* with,
      // then the ease moves. Bumping first made Easy schedule a day further out
      // than the button had just promised.
      rec.ivl = out;
      if (g === 2) rec.ea = Math.max(MIN_EASE, rec.ea - 0.15);
      if (g === 4) rec.ea = Math.min(MAX_EASE, rec.ea + 0.15);
    }
  }

  if (rec.st === 'r') {
    rec.due = addCalendarDays(Date.now(), rec.ivl);
  } else {
    // A learning card is ordered by the session queue, not the clock — but it
    // still needs a real due date, or a session abandoned half way leaves cards
    // that are permanently "due now" and invisible to the forecast.
    rec.due = addCalendarDays(Date.now(), 1);
  }

  // A practice round ends here. The day's numbers, the streak and the totals
  // are the day's: none of this was work the plan asked for, and a streak kept
  // alive on cards that were not due is a streak that means nothing.
  if (practising) return outcome;

  if (isNew) state.newDone++;
  else if (wasReview) state.revDone++;
  noteAnswered();
  save();
  return outcome;
}

/* One vocabulary everywhere. The Progress screen used to say "known well" for
 * the same thing the study chip called "mature". */
const STATE_WORDS = {
  new: 'not seen before',
  learning: 'still learning',
  young: 'bedding in',
  mature: 'known well',
};

function stateOf(id) {
  const r = state.recs[id];
  if (!r) return 'new';
  if (r.st === 'l') return 'learning';
  return r.ivl >= 21 ? 'mature' : 'young';
}

function isDue(id, now) {
  const r = state.recs[id];
  return !!r && r.st === 'r' && r.due <= now;
}

/** The deck walked in theme order: [group, [section, …]] per theme.
 *
 * Home, Browse and Progress all list the same twenty-four sections, and before
 * this they listed them three times as one flat column. An app that groups the
 * syllabus on one screen and not on the next is telling you two different
 * things about the syllabus. */
function byGroup() {
  return [...groupOf.values()]
    .map((g) => [g, g.sectionIds.map((id) => sectionOf.get(id)).filter(Boolean)]);
}

function counts(sectionKey) {
  const now = Date.now();
  const test = scopeTest(sectionKey);
  let due = 0, fresh = 0, learning = 0, seen = 0, mature = 0;
  for (const c of DECK.cards) {
    if (!test(c)) continue;
    const r = state.recs[c.cardId];
    if (!r) { fresh++; continue; }
    seen++;
    if (r.st === 'l') learning++;
    else {
      if (r.ivl >= 21) mature++;
      if (r.due <= now) due++;
    }
  }
  return { due, fresh, learning, seen, mature };
}

/* ─────────────────────────── video ─────────────────────────── */

/* 54 Maritime Master clips, attached to the 58 cards they plainly answer.
 * They are hosted with the app but never precached: the shell is 2.6 MB and
 * has to stay openable on no signal, so a clip is only fetched when someone
 * asks for it. Every failure mode here ends in "no video on this card", never
 * in a broken card. */
let VIDEOS = { clips: {}, cards: {}, credit: null };

const clipsFor = (cardId) => (VIDEOS.cards[cardId] || [])
  .map((c) => VIDEOS.clips[c]).filter(Boolean);

function fmtClock(sec) {
  const s = Math.max(0, Math.round(n(sec)));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Poster frames come from the clip itself at t=1s rather than 54 extra image
 * files: preload="metadata" fetches a few tens of KB, not the video.
 *
 * The path is COURSE.base like every other course asset. Root-relative it named
 * a directory Munin has never had, so every thumbnail on a Day Skipper card was
 * a dead request — inherited from the standalone app, where the course and the
 * app root were the same folder. */
function thumbHtml(clip, label) {
  return `<button class="vthumb" data-clip="${escapeHtml(clip.f)}"
      aria-label="Play ${escapeHtml(label || clip.t)} — ${fmtClock(clip.d)}">
    <video src="${COURSE.base}video/${escapeHtml(clip.f)}#t=1" muted playsinline preload="metadata"></video>
    <span class="vplay" aria-hidden="true">▶</span>
    <span class="vlen">${fmtClock(clip.d)}</span>
  </button>`;
}

function playerHtml(clip) {
  // Who made the clips is the course's business — videos.json says it, and
  // course.json says it if videos.json does not. Munin used to carry one
  // course's video credit as a literal in the engine.
  const by = str(VIDEOS.credit && VIDEOS.credit.name,
    str(COURSE.credit && COURSE.credit.name, 'the course'));
  // The credit row lives outside the black box so the box wraps the picture
  // exactly — inside, its own text was setting the player's width.
  return `<div class="vplayer">
    <video src="${COURSE.base}video/${escapeHtml(clip.f)}" playsinline controls autoplay preload="auto"></video>
  </div>
  <div class="vbar">
    <span class="vby">${escapeHtml(by)}${clip.u
      ? ` · <a href="${escapeHtml(clip.u)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</span>
    <button class="link-btn" data-collapse type="button">close</button>
  </div>
  <p class="vcap">${escapeHtml(clip.t)}</p>`;
}

/** The clips for the card on screen, under the answer. */
/* Draw the card's labelled doodle, if it has one.
 *
 * The drawing is authored once in src/figures.py and reused across the cards
 * that share it; `card.figure.highlightedLabels` says which labels this card is
 * asking about, and everything else on the drawing dims to context. With no
 * highlighted-label list every label lights, which is what a card wanting the
 * whole picture means.
 *
 * The SVG body is trusted markup from the build, not user content, which is
 * why it can go in as innerHTML — the same contract as the card text. */
function figureSVG(card, cls) {
  const def = FIGURES && card.figure && FIGURES[card.figure.figureId];
  if (!def) return '';
  return `<svg class="figure${cls ? ' ' + cls : ''}" viewBox="${def.vb}" role="img"`
    + ` aria-label="${escAttr(figureAlt(card, def))}">${def.b}</svg>`;
}

/* Light the labels this card asked for. Everything else on the drawing stays,
   dimmed — that is what lets one drawing serve several cards. */
function litFigure(root, card) {
  const labels = card.figure && card.figure.highlightedLabels;
  const on = labels && labels.length ? new Set(labels) : null;
  root.querySelectorAll('[data-l]').forEach((el) => {
    el.classList.toggle('on', !on || on.has(el.getAttribute('data-l')));
  });
}

/* What a pen cannot draw. A draw-on works by hijacking stroke-dasharray, so a
   stroke that is already dashed cannot keep its dash while it is being drawn —
   and in these figures a dash carries meaning. Same for the swept arcs, which
   are areas rather than lines, and the filled shapes, where hiding the outline
   leaves the fill sitting there on its own. */
/* Which elements cannot take a pen.
 *
 * A pen is stroke-dasharray, so anything already using dashes for meaning, or
 * filled rather than drawn, has to fade instead. Half of that is the figure
 * LANGUAGE and belongs here — a dash, a cut, a swept arc, a fill. The other
 * half is whichever of a course's own nouns happen to be dashed or filled: its
 * sails, its fenders, its jackstays. Those come from course.json's
 * `figures.noPen`, because the class list and the stylesheet that styles it
 * are the same course's business and they used to be able to disagree — the
 * engine named f-sail and f-fender, and a course that drew neither still paid
 * for them while a course that drew something else got no say at all. */
const FIG_NO_PEN_ENGINE = ['f-dash', 'f-dash-acc', 'f-dash-red', 'f-cut', 'f-arc', 'f-arc-on'];
const FIG_NO_PEN = new RegExp('(^|\\s)(' + FIG_NO_PEN_ENGINE
  .concat(((COURSE.figures && COURSE.figures.noPen) || [])
    .filter((c) => typeof c === 'string' && /^[a-z][a-z0-9-]*$/.test(c)))
  .join('|') + '|fill-[a-z]+)(\\s|$)');

/* Set a figure drawing itself.
 *
 * Which elements can take a pen is decided at render time rather than in the
 * build: figures.json is generated by a course's own repository, and a rule
 * applied here cannot fall out of step with a build nobody re-ran. It is one
 * pass over ~40 elements when a card renders.
 *
 * Order matters twice. pathLength and the kind classes go on before anything is
 * measured; --tgt is read after them and before `fig-draw`, so what it records
 * is the element's resting opacity under this card's dimming — read it any
 * later and it records whatever the animation happens to be showing, which for
 * a label with a delay is zero, and every label then fades in to invisible. */
function drawFigureOn(root) {
  const svg = root.querySelector('.figure');
  if (!svg) return;
  svg.classList.remove('fig-draw');
  const els = svg.querySelectorAll('path, text');
  els.forEach((el) => {
    const kind = el.tagName === 'text' ? 'lab'
      : FIG_NO_PEN.test(el.getAttribute('class') || '') ? 'soft'
        : 'pen';
    el.classList.add(kind);
    if (kind === 'pen') el.setAttribute('pathLength', '1');
  });
  /* getComputedStyle returns an empty declaration for an element that is not
     being rendered — one still detached from the document, or inside a closed
     <details>. Measuring there sets --tgt to nothing, every fade then ends at
     full opacity, and the drawing finishes with all of its labels lit: the
     dimming that lets one figure serve six cards, gone. So measure first, and
     if the answer is not a real one, leave the figure alone. Static is already
     correct; it simply does not animate. */
  const tgt = [...els].map((el) => getComputedStyle(el).opacity);
  if (tgt.some((v) => v === '')) return;
  els.forEach((el, k) => el.style.setProperty('--tgt', tgt[k]));
  // Reading the cascade above flushed style, so removing `fig-draw` and adding
  // it back here is a restart rather than a no-op — which is what a figure
  // being shown a second time needs.
  svg.classList.add('fig-draw');
}

/* One string for one affordance. Study said "Tap to enlarge", Browse said "Tap
 * the diagram to enlarge" and, two lines further down, "Tap the drawing to
 * enlarge" — three wordings for the same tap on the same picture. */
const ENLARGE_HINT = 'Tap to enlarge';

function renderCardFigure(card) {
  const box = $('#card-figure');
  const def = card && card.figure && FIGURES && FIGURES[card.figure.figureId];
  if (!def) {
    box.hidden = true;
    $('#figure-plate').innerHTML = '';
    return;
  }
  const plate = $('#figure-plate');
  plate.innerHTML = figureSVG(card);
  litFigure(plate, card);
  plate.setAttribute('aria-label', `Enlarge the drawing: ${stripTags(card.front)}`);
  // A middot, because the hand face all but swallows a full stop at this size:
  // "…as if you were facing forward. Tap to enlarge." rendered as one run-on
  // sentence ending in an instruction. And the same four words wherever the
  // offer is made — Browse used to say "Tap the diagram to enlarge" for the
  // identical affordance one screen away.
  $('#figure-cap').textContent = def.cap + ' · ' + ENLARGE_HINT;
  box.hidden = false;
  // No drawFigureOn() here: this runs while #answer-wrap is still hidden.
  // reveal() sets the drawing going, once the answer is on screen.
}

/* Screen readers get the terms the card is actually asking about, not a list
   of everything drawn — the dimmed labels are context the eye skips. */
function figureAlt(card, def) {
  const labels = card.figure.highlightedLabels;
  const on = (labels && labels.length ? labels : def.l).map((s) => s.replace(/-/g, ' '));
  return `${def.cap} Labelled: ${on.join(', ')}.`;
}

function escAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Descriptive attachments for one authored side of a card. */
function mediaForSide(card, side) {
  return COURSE_MEDIA ? COURSE_MEDIA.mediaForSide(card, side) : [];
}

/** The legacy built-in diagram continues through its established plate. */
function backImage(card) {
  return RUNTIME_SOURCE_FORMAT !== 'course-v2' && card && Array.isArray(card.media)
    ? card.media.find((item) => item && item.side === 'back'
      && item.mediaType === 'image' && typeof item.source === 'string')
    : null;
}

/** Images this course can fetch into its course cache deliberately.
 *
 * Legacy courses have one established back-side diagram. Format 2 can attach
 * several descriptive images to either side, and all of them are part of the
 * offline promise shown in Settings. */
function offlineImages() {
  const items = [];
  for (const card of DECK.cards) {
    if (RUNTIME_SOURCE_FORMAT === 'course-v2') {
      for (const side of ['front', 'back']) {
        items.push(...mediaForSide(card, side).filter((item) =>
          item && item.mediaType === 'image' && typeof item.source === 'string'));
      }
    } else {
      const image = backImage(card);
      if (image) items.push(image);
    }
  }
  return items;
}

/** Whether this card has a second side to reveal.
 *
 * This is the single Study/Browse decision. It deliberately covers every
 * descriptive back-side attachment plus the two legacy presentation views
 * produced at normalization time: labelled figures and lazy course clips.
 * A front-only card may still have any amount of front-side media. */
function hasBackContent(card) {
  return !!(card && (
    (typeof card.back === 'string' && card.back.trim().length)
    || mediaForSide(card, 'back').length
    || card.figure
    || clipsFor(card.cardId).length
  ));
}

function courseMediaUrl(item) {
  return COURSE.base + item.source.split('/').map(encodeURIComponent).join('/');
}

function renderDescriptiveMediaInto(host, card, side, load = true) {
  if (!host) return null;
  if (RUNTIME_SOURCE_FORMAT !== 'course-v2' || !COURSE_MEDIA) {
    host.replaceChildren();
    host.hidden = true;
    return host;
  }
  return COURSE_MEDIA.renderCourseMediaInto(host, card, side, COURSE, {
    load,
    onOpenImage: (media, resolvedUrl) => openLightbox(card, media, resolvedUrl),
  });
}

function hydrateDescriptiveMedia(root) {
  if (RUNTIME_SOURCE_FORMAT === 'course-v2' && COURSE_MEDIA) {
    COURSE_MEDIA.hydrateCourseMedia(root, COURSE);
  }
}

function renderCardVideo(card) {
  const host = $('#card-video');
  const clips = clipsFor(card.cardId);
  host.hidden = !clips.length;
  if (!clips.length) { host.innerHTML = ''; return; }
  // data-card is what "close" uses to rebuild the thumbnails; without it the
  // player collapsed into an empty row.
  host.innerHTML = `<p class="h-sect vhead">${clips.length === 1 ? 'A clip on this' : 'Clips on this'}</p>
    <div class="vrow" data-card="${escapeHtml(card.cardId)}">${clips.map((c) => thumbHtml(c)).join('')}</div>`;
}

/* One handler for both screens: a thumbnail swaps itself for a player, and the
 * player collapses back to the thumbnail. Only one plays at a time. */
function wireVideo(rootSel) {
  $(rootSel).addEventListener('click', (e) => {
    const thumb = e.target.closest('.vthumb');
    if (thumb) {
      const clip = Object.values(VIDEOS.clips).find((c) => c.f === thumb.dataset.clip);
      if (!clip) return;
      $$('.vplayer video').forEach((v) => v.pause());
      const row = thumb.closest('.vrow');
      row.dataset.open = thumb.dataset.clip;
      row.innerHTML = playerHtml(clip);
      return;
    }
    if (e.target.closest('[data-collapse]')) {
      const row = e.target.closest('.vrow');
      const cardId = row.dataset.card;
      const clips = cardId ? clipsFor(cardId) : reelClips();
      row.removeAttribute('data-open');
      row.innerHTML = clips.map((c) => thumbHtml(c)).join('');
    }
  });
}

/* ─────────────────────── milestones ─────────────────────── */

/* Every word below is a course's where a course cares and Munin's where it
 * does not, so every one is taken only when it is the kind of thing it is
 * supposed to be. A `notice` of `42` used to replace the whole fineprint with
 * "42" rather than falling back to the line it exists to fall back to. */
const str = (v, fallback) => (typeof v === 'string' && v ? v : fallback);

/* Rules, scope, copy policy and share priority live in one deterministic
 * engine. The shell supplies facts and storage; courses may only theme words
 * and art through the engine's deliberately narrow catalog adapter. */
const AchievementEngine = globalThis.KeepClubAchievements;
const ACHIEVEMENTS = AchievementEngine.catalog(COURSE);
const ACH_IDS = new Set(ACHIEVEMENTS.map((a) => a.id));
const HOARD_TITLE = AchievementEngine.collectionTitle(COURSE);
const CLUB_ACH_IDS = new Set(ACHIEVEMENTS
  .filter((achievement) => achievement.scope === 'club')
  .map((achievement) => achievement.id));

/** Read one state per course, replacing this course's possibly stale stored
 * copy with the in-memory document being graded. No storage key is renamed or
 * copied: the club view is a derived lens over the existing progress blobs. */
function clubStates() {
  const out = [];
  let usedCurrent = false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!/^munin\/(?:local-[a-z0-9]+|[a-z0-9][a-z0-9-]{0,63})\/state\/v1$/.test(key || '')) continue;
      if (key === KEY) {
        out.push(state);
        usedCurrent = true;
        continue;
      }
      try {
        const value = JSON.parse(localStorage.getItem(key));
        if (isPlainObject(value)) out.push(value);
      } catch (e) { /* one unreadable old deck contributes nothing */ }
    }
  } catch (e) { /* blocked storage contributes nothing */ }
  if (!usedCurrent && state) out.push(state);
  return out;
}

function clubFacts() {
  return AchievementEngine.aggregateClubStates(clubStates());
}

function achievementContext(sess, at = Date.now()) {
  const club = clubFacts();
  const course = AchievementEngine.contextFromDeck({
    at,
    state,
    deck: DECK,
    course: COURSE,
    session: sess,
    clubStreak: club.clubStreak,
    personalBest: Math.max(club.personalBest, n(sess && sess.maxClean)),
    previousLastDay: sess && sess.previousClubLastDay,
  });
  return Object.assign({}, course, {
    clubAnswers: club.answers,
    clubSolid: club.solidCards,
    clubStreak: club.clubStreak,
    repeatAnswers: club.repeatAnswers,
    repeatGood: club.repeatGood,
    repeatAccuracy: club.repeatAnswers
      ? Math.round((club.repeatGood / club.repeatAnswers) * 100) : 0,
  });
}

function checkAchievements(sess) {
  if (!DECK) return [];
  const now = Date.now();
  const club = clubFacts();
  const unlocked = Object.assign({}, state.ach);
  for (const id of CLUB_ACH_IDS) {
    if (club.unlocked[id] && (!unlocked[id] || club.unlocked[id] < unlocked[id])) {
      unlocked[id] = club.unlocked[id];
    }
  }
  const result = AchievementEngine.evaluate({
    at: now,
    context: achievementContext(sess, now),
    unlocked,
    course: COURSE,
  });
  const fresh = result.newlyUnlocked;
  if (fresh.length) {
    for (const achievement of fresh) state.ach[achievement.id] = achievement.at;
    if (sess) {
      sess.newAchievements = sess.newAchievements || [];
      for (const achievement of fresh) {
        if (!sess.newAchievements.some((item) => item.id === achievement.id)) {
          sess.newAchievements.push(achievement);
        }
      }
    }
    save();
    queueUnlocks(fresh);
    for (const achievement of fresh) {
      const delivery = globalThis.KeepNotifications?.notifyAchievement?.({
        id: achievement.id,
        title: achievement.title,
        body: achievement.description,
        url: './',
      });
      if (delivery && typeof delivery.catch === 'function') delivery.catch(() => {});
    }
    if (current === 'stats') renderAch();
  }
  return fresh;
}

/* Unlocks arrive one at a time. Two at once — 50 cards and a clean run on the
 * same answer — used to draw the second one straight over the first. */
let unlockQueue = [];
let unlockTimer = null;
let currentUnlockId = null;

function queueUnlocks(list) {
  unlockQueue.push(...list);
  if (!unlockTimer) showNextUnlock();
}

/* Emptied on the way out, rather than hidden. It is a live region: whatever is
 * in it is in the accessibility tree whether or not it is on screen, and it
 * cannot be taken out of the tree instead — a region that is display:none at
 * the moment its text changes is announced unreliably (see .toast.away). */
function stowUnlock() {
  currentUnlockId = null;
  $('#unlock').classList.add('away');
  $('#unlock-key').textContent = '';
  $('#unlock-title').textContent = '';
  $('#unlock-sub').textContent = '';
}

function showNextUnlock() {
  const el = $('#unlock');
  const a = unlockQueue.shift();
  if (!a) { unlockTimer = null; stowUnlock(); return; }
  currentUnlockId = a.id;
  $('#unlock-art').innerHTML = doodle(a.art);
  $('#unlock-key').textContent = 'unlocked';
  $('#unlock-title').textContent = a.title;
  $('#unlock-sub').textContent = a.description;
  el.classList.remove('away');
  // Same element, second unlock: the entry animation only replays after a reflow.
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  unlockTimer = setTimeout(() => {
    stowUnlock();
    unlockTimer = setTimeout(showNextUnlock, 280);
  }, 3200);
}

function dismissUnlock() {
  clearTimeout(unlockTimer);
  unlockTimer = null;
  stowUnlock();
  if (unlockQueue.length) unlockTimer = setTimeout(showNextUnlock, 220);
}

function retractUnlocks(ids) {
  const removed = new Set(ids);
  if (!removed.size) return;
  unlockQueue = unlockQueue.filter((achievement) => !removed.has(achievement.id));
  if (!removed.has(currentUnlockId)) return;
  clearTimeout(unlockTimer);
  unlockTimer = null;
  stowUnlock();
  if (unlockQueue.length) unlockTimer = setTimeout(showNextUnlock, 220);
}

let lastDoneMoment = null;
let membershipMoment = null;
let monthlyMoment = null;
let progressMoments = new Map();

function visibleUnlocks() {
  const unlocked = Object.assign({}, state.ach);
  const club = clubFacts();
  for (const id of CLUB_ACH_IDS) {
    if (club.unlocked[id] && (!unlocked[id] || club.unlocked[id] < unlocked[id])) {
      unlocked[id] = club.unlocked[id];
    }
  }
  return unlocked;
}

function shareStat(moment) {
  const p = moment.payload || {};
  switch (moment.family) {
    case 'club-streak':
      return { stat: `${n(p.target || p.value)} days`, label: 'in a row at the club' };
    case 'memories-kept':
      return moment.id.startsWith('solid-pct-')
        ? { stat: `${n(p.target || p.value)}%`, label: 'of this deck kept solid' }
        : { stat: String(n(p.target || p.value)), label: 'memories kept solid' };
    case 'personal-best':
      return { stat: String(n(p.value || p.target)), label: 'remembered without an again' };
    case 'activity':
      return { stat: String(n(p.target || p.value)), label: 'answers at the club' };
    case 'anki-keeper':
      return { stat: String(n(p.target || p.value)), label: 'imported reviews kept local' };
    case 'monthly-recap':
      return { stat: String(n(p.studyDays)), label: `study days in ${moment.label || 'the month'}` };
    case 'membership':
      return p.clubStreak
        ? { stat: `${n(p.clubStreak)} days`, label: 'current club streak' }
        : { stat: String(n(p.solidCards)), label: 'memories kept solid' };
    case 'mastery':
      return { stat: '100%', label: moment.id === 'deck-kept' ? 'of this deck kept' : 'section kept' };
    case 'club-life':
      if (moment.id === 'steady-hand') {
        return { stat: '90%+', label: 'recall over at least 100 repeat cards' };
      }
      return {};
    default:
      return {};
  }
}

/* What a family is called out loud. Shared between the share card's eyebrow
 * and the achievement sheet's, so the same family never has two names. */
const FAMILY_LABEL = Object.freeze({
  activity: 'club activity',
  'club-streak': 'club streak',
  'memories-kept': 'memories kept',
  'personal-best': 'personal best',
  'club-life': 'club life',
  exploration: 'exploration',
  mastery: 'course milestone',
  recovery: 'recovery',
  'anki-keeper': 'imported reviews',
  comeback: 'comeback',
  'monthly-recap': 'monthly recap',
  membership: 'club membership',
});

function shareModel(moment) {
  const stat = shareStat(moment);
  const imported = /^local-[a-z0-9]+$/.test(COURSE.id);
  const artName = str(moment.art, 'tower');
  return {
    label: FAMILY_LABEL[moment.family] || 'member achievement',
    title: moment.title,
    body: moment.description,
    stat: stat.stat,
    statLabel: stat.label,
    accent: COURSE.accent && COURSE.accent.light,
    tower: { path: pathOf(MUNIN_DOODLE, 'tower'), viewBox: '0 0 32 32' },
    // Club totals are not owned by whichever course happened to be open when
    // Share was tapped. Only a course-scoped moment earns a course deep link.
    course: imported || moment.scope !== 'course' ? null : {
      kind: 'built-in',
      id: COURSE.id,
      title: COURSE.title,
      accent: COURSE.accent && COURSE.accent.light,
      art: {
        path: pathOf(DOODLE, artName) || pathOf(MUNIN_DOODLE, artName),
        viewBox: '0 0 32 32',
      },
    },
  };
}

async function shareMoment(moment, button, status) {
  if (!moment || !moment.shareable || !globalThis.KeepShare) return;
  const old = button && button.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Making card…';
  }
  if (status) status.textContent = '';
  try {
    const result = await KeepShare.share(shareModel(moment), { baseUrl: location.href });
    const line = result.status === 'shared' ? 'Shared.'
      : result.status === 'copied' ? 'Copied — ready to paste.'
        : result.status === 'downloaded' ? 'Card downloaded.'
          : result.status === 'cancelled' ? ''
            : 'Sharing is not available in this browser.';
    if (status) status.textContent = line;
    else if (line) toast(line);
  } catch (e) {
    if (status) status.textContent = 'Could not make the share card. Try again.';
    else toast('Could not make the share card. Try again.', true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = old;
    }
  }
}

/* Same retrigger trick as showNextUnlock(): remove, force a reflow, add back,
 * so tapping the same earned row twice in a row plays the bounce both times. */
function celebrateRow(row) {
  row.classList.remove('pop');
  void row.offsetWidth;
  row.classList.add('pop');
}

function renderAch() {
  const h = $('#hoard-title');
  if (h) h.textContent = HOARD_TITLE;
  const unlocked = visibleUnlocks();
  const at = Date.now();
  const context = achievementContext(null, at);
  const keptSections = (context.keptSectionKeys || []).map((key) => {
    const section = sectionOf.get(key);
    return { key, title: section && section.title, art: SECTION_ART[key] || COURSE.fallback };
  });
  const sectionMoments = AchievementEngine.sessionMoments({
    at,
    course: COURSE,
    context: Object.assign({}, context, { newlyKeptSections: keptSections }),
  }).filter((moment) => moment.id.startsWith('section-kept:'));
  const personalBest = AchievementEngine.buildPersonalBestMoment({
    at,
    bestClean: context.personalBest,
    course: COURSE,
  });
  progressMoments = new Map(sectionMoments
    .concat(personalBest ? [personalBest] : [])
    .map((moment) => [moment.id, moment]));
  const got = ACHIEVEMENTS.filter((a) => unlocked[a.id]).length;
  $('#ach-count').textContent = got
    ? `${got} of ${ACHIEVEMENTS.length} earned. They unlock as you revise — there is nothing to collect deliberately.`
    : `Nothing in the log yet. ${ACHIEVEMENTS.length} of them turn up as you revise.`;
  // Forty rows under a sentence saying there are forty, twenty-six of them
  // wearing the same drawing, is the sentence proved by repetition. What is
  // worth showing is the rung you are on next — and one rung of three different
  // ladders, not three steps of the same one, so the first locked row of each
  // of the first three families is the one that stays out. Nothing is removed:
  // the sentence counts them, and the rest are one press away.
  const nextUp = new Set();
  const laddersShown = new Set();
  for (const a of ACHIEVEMENTS) {
    if (unlocked[a.id] || nextUp.size >= 3 || laddersShown.has(a.family)) continue;
    laddersShown.add(a.family);
    nextUp.add(a.id);
  }
  const staticRows = ACHIEVEMENTS.map((a) => {
    const on = unlocked[a.id];
    const when = on ? ` · ${longDate(dayKey(on))}` : '';
    const body = `${doodle(a.art)}
      <span class="a-txt"><b>${escapeHtml(a.title)}</b><small>${escapeHtml(a.description)}${escapeHtml(when)}</small></span>`;
    if (!on) return `<li class="locked${nextUp.has(a.id) ? ' next' : ''}">${body}</li>`;
    // One tap target, whatever the achievement is worth: it opens the sheet,
    // which decides for itself whether there is a Share button to offer.
    return `<li class="earned"><button class="ach-tap" type="button" data-ach-id="${escapeHtml(a.id)}"
      aria-label="${escapeHtml(a.title)}, earned${escapeHtml(when)}">${body}</button></li>`;
  }).join('');
  const repeatableRows = [...progressMoments.values()].map((moment) => `
    <li class="earned repeatable"><button class="ach-tap" type="button"
      data-moment-id="${escapeHtml(moment.id)}" aria-label="${escapeHtml(moment.title)}">${doodle(moment.art)}
      <span class="a-txt"><b>${escapeHtml(moment.title)}</b>
        <small>${escapeHtml(moment.description)} · ${moment.family === 'personal-best'
          ? 'current best' : 'currently solid'}</small></span>
    </button></li>`).join('');
  const list = $('#ach-list');
  list.innerHTML = staticRows + repeatableRows;
  // Folded only where there is a wall to fold. A log with a handful of rungs
  // left in it is a list, not a wall, and a button under it would be worse.
  const folded = ACHIEVEMENTS.length - got > 8;
  list.classList.toggle('folded', folded);
  const more = $('#ach-more');
  more.hidden = !folded;
  more.textContent = `Show all ${ACHIEVEMENTS.length}`;
}

let achSheetOpener = null;

/* How many of this achievement's family are already earned, out of how many
 * there are — not which rung it is. club-life is a set of unrelated finds,
 * not a ladder, so a rank number would claim an order none of them keep;
 * "X of Y" is true of every family, ladder or not. Repeatable moments (a
 * personal best, a section kept) are not in ACHIEVEMENTS at all — they have
 * no fixed family size to be a fraction of. */
function achFamilyProgress(record) {
  if (!record || record.kind === 'repeatable' || !record.family) return null;
  const siblings = ACHIEVEMENTS.filter((item) => item.family === record.family);
  if (siblings.length < 2) return null;
  const unlocked = visibleUnlocks();
  const got = siblings.filter((item) => unlocked[item.id]).length;
  return `${got} of ${siblings.length} ${FAMILY_LABEL[record.family] || 'club milestones'}`;
}

function openAchSheet(record, opener) {
  if (!record) return;
  const panel = $('#ach-sheet');
  achSheetOpener = opener || null;
  $('#ach-sheet-h').textContent = record.title;
  $('#ach-sheet-kind').textContent = FAMILY_LABEL[record.family] || 'club milestone';
  // A fresh element every open, never a class toggled on a reused one: the
  // stroke-redraw animation plays once per element, and this is what lets the
  // same family's next find redraw again instead of arriving already-drawn.
  $('#ach-sheet-art').innerHTML = doodle(record.art, 'ach-sheet-art redraw');
  // Repeatable moments are recomputed at render time, so their own `at` is
  // this render, not the day the moment first became true — stating it as an
  // earned date would be a fabricated one.
  const earnedLine = record.kind === 'repeatable' || !record.at
    ? '' : ` · earned ${longDate(dayKey(record.at))}`;
  $('#ach-sheet-desc').textContent = record.description + earnedLine;
  const rank = achFamilyProgress(record);
  $('#ach-sheet-rank').textContent = rank || '';
  $('#ach-sheet-rank').hidden = !rank;
  $('#ach-sheet-share-status').textContent = '';
  const shareBtn = $('#ach-sheet-share');
  shareBtn.hidden = !record.shareable;
  shareBtn.disabled = false;
  shareBtn.textContent = 'Share';
  shareBtn.onclick = () => shareMoment(record, shareBtn, $('#ach-sheet-share-status'));
  if (panel.hidden) {
    panel.hidden = false;
    document.body.style.overflow = 'hidden';
    // The same containment the lightbox and notes use, for the same reason:
    // aria-modal says the rest of the page is not there, and only inert makes
    // that true for the Tab key. The sheet is a sibling of #app, not inerting
    // itself.
    setBackgroundInert(true);
    pushStop('ach-sheet');
  }
  $('#ach-sheet-close').focus({ preventScroll: true });
}

function closeAchSheet(fromHistory) {
  const panel = $('#ach-sheet');
  if (panel.hidden) return;
  panel.hidden = true;
  document.body.style.overflow = '';
  setBackgroundInert(false);
  $('#ach-sheet-share').onclick = null;
  if (achSheetOpener && achSheetOpener.isConnected && achSheetOpener.focus) {
    achSheetOpener.focus({ preventScroll: true });
  }
  achSheetOpener = null;
  if (!fromHistory && stops[stops.length - 1] === 'ach-sheet') history.back();
}

/* A drawing for each of the 24 chapters. Picked for the thing the chapter is
 * actually about — dividers for position fixing, a propeller for engines — so
 * the row is scannable once you have met it a few times. */
const SECTION_ART = COURSE.sectionArt || {};

/* Format 2 deliberately has one course-level sectionArtwork: it is the
 * default mark repeated anywhere a section needs an emblem, not a hidden
 * per-section selection language. Built-in named section art remains more
 * specific and wins. The package source stays inert in data-* until the shared
 * IndexedDB resolver gives the <img> a blob: URL; it is never interpolated into
 * an SVG path. */
function sectionMark(sectionId, cls) {
  if (SECTION_ART[sectionId]) return doodle(SECTION_ART[sectionId], cls);
  const source = COURSE.sectionArtworkSource;
  if (!source) return doodle(COURSE.fallback, cls);
  return `<span class="dood course-section-art ${cls || ''}" aria-hidden="true">
    <svg class="doodle" viewBox="0 0 32 32"><path d="${doodlePath(COURSE.fallback)}"/></svg>
    <img alt="" hidden data-course-section-art="${escAttr(source)}">
  </span>`;
}

/* One drawing per group of sections, for the Browse index. Several repeat a
 * drawing one of their own sections already uses — a group's emblem being the
 * most obvious thing in it is the point, and the two never appear at the same
 * size or in the same place. Keys come from src/groups.py, which is also what
 * refuses to build a deck with a section in no group. */
const GROUP_ART = COURSE.groupArt || {};

/* The frieze along the top of the home screen: ten drawings, filled in as the
 * deck gets started. It is the streak and the percentage said as a picture. */
const FRIEZE_ART = COURSE.friezeArt || [];

/* The ground the drawings stand on. Ten evenly spaced accent drawings across
 * the full width of the top of a screen is the geometry of a toolbar, and the
 * eye read it as ten buttons; one line under their feet makes them one object,
 * and an object standing on a line is obviously a picture rather than a row of
 * targets. It carries no progress of its own — that is still the earned ink
 * against the unearned above it — so it is one unbroken line, not a track that
 * fills.
 *
 * Drawn rather than a `border-bottom`: a ruled 1px line under a row of
 * hand-drawn creatures reads as a table header. The wobble is a fixed sum, not
 * Math.random — a line that re-draws itself every time the frieze re-renders
 * is a line that twitches every time a card is graded. */
function friezeRule() {
  let d = 'M0 3';
  for (let i = 1; i <= 24; i++) {
    d += ` L${(i * 100 / 24).toFixed(2)} ${(3 + Math.sin(i * 1.7) * 0.55).toFixed(2)}`;
  }
  // The viewBox is stretched to whatever width the header is, so the stroke has
  // to opt out of that scaling or the pen thickens with the screen.
  return '<span class="frieze-rule"><svg viewBox="0 0 100 6" preserveAspectRatio="none">'
    + `<path d="${d}" vector-effect="non-scaling-stroke"/></svg></span>`;
}

function renderFrieze() {
  const el = $('#frieze');
  if (!el || !DECK) return;
  const seen = DECK.cards.filter((c) => state.recs[c.cardId]).length;
  const filled = seen === 0 ? 0 : Math.max(1, Math.round((seen / DECK.cards.length) * FRIEZE_ART.length));
  el.innerHTML = FRIEZE_ART
    // The index, not a delay: each drawing runs an entrance and an idle, and a
    // single inline `animation-delay` would set both of them — starting the
    // idle before the hop it is supposed to follow. app.css does the sums.
    .map((k, i) => doodle(k, i < filled ? '' : 'unearned', `--i:${i}`))
    .join('')
    // A course that draws no frieze gets no lone line across its header.
    + (FRIEZE_ART.length ? friezeRule() : '');
}

/* ─────────────────────────── session ─────────────────────────── */

function buildSession(sectionKey, opts) {
  opts = opts || {};
  const now = Date.now();
  const pool = DECK.cards.filter(scopeTest(sectionKey));

  const learning = pool.filter((c) => state.recs[c.cardId] && state.recs[c.cardId].st === 'l');
  let reviews = pool.filter((c) => isDue(c.cardId, now));
  let fresh = pool.filter((c) => !state.recs[c.cardId]);

  const revRoom = Math.max(0, state.settings.maxRev - state.revDone);
  const newRoom = Math.max(0, newBudget() - state.newDone);

  if (opts.ahead) {
    // Studying ahead: pull the soonest-due cards even though they are not due yet.
    const notYet = pool
      .filter((c) => state.recs[c.cardId] && state.recs[c.cardId].st === 'r'
        && state.recs[c.cardId].due > now)
      .sort((a, b) => state.recs[a.cardId].due - state.recs[b.cardId].due)
      .slice(0, AHEAD_BATCH);
    reviews = reviews.concat(notYet);
    // Studying ahead is the app's own suggestion, so it honours the daily new
    // number: at zero it pulls reviews forward and introduces nothing.
    fresh = newBudget() > 0 ? fresh.slice(0, AHEAD_BATCH) : [];
  } else {
    // `slice(0, revRoom)` and not `revRoom || reviews.length`: a spent budget is
    // 0, which is falsy, and the fallback then served the entire backlog — the
    // cap vanished at exactly the moment it was supposed to bite.
    reviews = shuffle(reviews).slice(0, revRoom);
    fresh = fresh.slice(0, opts.allNew ? AHEAD_BATCH : newRoom);
  }

  const rest = shuffle(learning).concat(shuffle(reviews));
  // New cards get spread through the queue rather than dumped at one end: a run
  // of unseen cards is where sessions start to feel like a wall. Note `total` is
  // computed once — reading `rest.length` inside the loop while shifting off it
  // walks the bound down to meet the counter and drops half the session.
  const queue = [];
  const total = rest.length + fresh.length;
  const step = fresh.length ? Math.max(1, Math.round(total / fresh.length)) : 0;
  let fi = 0, ri = 0;
  for (let k = 0; k < total; k++) {
    if (step && k % step === 0 && fi < fresh.length) queue.push(fresh[fi++]);
    else if (ri < rest.length) queue.push(rest[ri++]);
    else if (fi < fresh.length) queue.push(fresh[fi++]);
  }

  if (!state.settings.shuffle && !sectionKey) {
    const order = new Map(DECK.sections.map((s, i) => [s.sectionId, i]));
    queue.sort((a, b) => order.get(a.sectionId) - order.get(b.sectionId));
  }

  return {
    section: sectionKey,
    queue: queue.map((c) => c.cardId),
    total: queue.length,
    done: 0,
    again: 0,
    good: 0,
    missed: [],                  // card ids whose first pass included Again
    // Nothing is started in a practice round — the unseen cards in it are shown
    // and forgotten — so the summary does not claim any were.
    startedNew: opts.ahead ? 0 : fresh.length,
    revealed: false,
    reel: [],                   // clips for the cards graded Again or Hard
    reelCards: [],              // card ids, retained until a late clip map lands
    ahead: !!opts.ahead,
    clean: 0,
    maxClean: 0,
    sectionKeys: [],
    newAchievements: [],
  };
}

/** Keep only the transient study screen in this tab.
 *
 * Review records still live in the unchanged per-course localStorage key. The
 * queue belongs in sessionStorage: it survives Reload, but it is not exported,
 * synced, or mistaken for progress on another device. */
function clearStudySession() {
  try { sessionStorage.removeItem(ACTIVE_STUDY_KEY); }
  catch (e) { /* private/storage-blocked contexts simply cannot resume */ }
}

function persistStudySession() {
  if (!session || current !== 'study' || !session.queue.length) return;
  const active = {
    section: session.section || null,
    queue: session.queue.slice(),
    total: n(session.total),
    done: n(session.done),
    again: n(session.again),
    good: n(session.good),
    clean: n(session.clean),
    maxClean: n(session.maxClean),
    missed: Array.isArray(session.missed) ? session.missed.slice() : [],
    startedNew: n(session.startedNew),
    revealed: !!session.revealed,
    reel: Array.isArray(session.reel) ? session.reel.slice() : [],
    reelCards: Array.isArray(session.reelCards) ? session.reelCards.slice() : [],
    ahead: !!session.ahead,
    sectionKeys: Array.isArray(session.sectionKeys) ? session.sectionKeys.slice() : [],
  };
  try {
    sessionStorage.setItem(ACTIVE_STUDY_KEY, JSON.stringify({
      version: 1,
      courseId: COURSE.id,
      progressAnswers: n(state.answers),
      resetStamp: readResetStamp(),
      active,
    }));
  } catch (e) { /* progress still saves; only refresh-resume is unavailable */ }
}

function resumableStudySession() {
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(ACTIVE_STUDY_KEY) || 'null'); }
  catch (e) {
    clearStudySession();
    return null;
  }
  if (!isPlainObject(saved) || saved.version !== 1 || saved.courseId !== COURSE.id
      || n(saved.progressAnswers) !== n(state.answers)
      || saved.resetStamp !== readResetStamp() || !isPlainObject(saved.active)) {
    if (saved) clearStudySession();
    return null;
  }

  const raw = saved.active;
  const queue = Array.isArray(raw.queue) ? raw.queue.slice() : [];
  const knownQueue = queue.length > 0 && queue.length <= DECK.cards.length
    && queue.every((id) => typeof id === 'string' && byId.has(id))
    && new Set(queue).size === queue.length;
  const whole = (value, lo, hi) => Number.isInteger(Number(value))
    && Number(value) >= lo && Number(value) <= hi ? Number(value) : null;
  const done = whole(raw.done, 0, DECK.cards.length);
  const total = whole(raw.total, 1, DECK.cards.length);
  const section = raw.section === null || raw.section === undefined
    ? null : (typeof raw.section === 'string' && sectionOf.has(raw.section) ? raw.section : false);
  if (!knownQueue || done === null || total === null
      || total !== done + queue.length || section === false) {
    clearStudySession();
    return null;
  }
  const ids = (value) => Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === 'string' && byId.has(id)))]
      .slice(0, DECK.cards.length)
    : [];
  const strings = (value) => Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string' && item.length <= 256))]
      .slice(0, DECK.cards.length)
    : [];
  return {
    section,
    queue,
    total,
    done,
    again: whole(raw.again, 0, DECK.cards.length * 10) || 0,
    good: whole(raw.good, 0, DECK.cards.length * 10) || 0,
    clean: whole(raw.clean, 0, DECK.cards.length * 10) || 0,
    maxClean: whole(raw.maxClean, 0, DECK.cards.length * 10) || 0,
    missed: ids(raw.missed),
    startedNew: whole(raw.startedNew, 0, total) || 0,
    revealed: !!raw.revealed,
    reel: strings(raw.reel),
    reelCards: ids(raw.reelCards),
    ahead: !!raw.ahead,
    sectionKeys: Array.isArray(raw.sectionKeys)
      ? [...new Set(raw.sectionKeys.filter((key) => sectionOf.has(key)))]
      : [],
    // Unlock records shown pre-refresh are already in state.ach; the finish
    // screen simply cannot replay them as this session's hero after a reload.
    newAchievements: [],
  };
}

function restoreStudySession() {
  const restored = resumableStudySession();
  if (!restored) return false;
  if (!claimStudyLock()) {
    toast('This session is still open in another tab.');
    return false;
  }
  const wasRevealed = restored.revealed;
  session = restored;
  // The pre-refresh club snapshot is gone with the old page. Re-baseline from
  // the current blobs: answers already recorded before the reload now count as
  // "before this session", so a moment can only be missed, never invented.
  const resumedClub = clubFacts();
  const resumedContext = AchievementEngine.contextFromDeck({
    at: Date.now(),
    state,
    deck: DECK,
    course: COURSE,
    session,
  });
  session.initialBestClean = resumedClub.personalBest;
  session.previousClubLastDay = resumedClub.lastDay;
  session.initialKeptSections = resumedContext.keptSectionKeys.slice();
  undoStack = [];
  settleDock(false);
  go('study');
  // Reload replaced the current history entry while the shell reopened the
  // course. Mark that same entry as Study instead of pushing one more copy on
  // every refresh.
  stops.push('study');
  history.replaceState({ stop: 'study' }, '');
  showCard();
  if (wasRevealed && !session.revealed) reveal();
  return true;
}

/** How many cards a study-ahead session will really serve.
 *
 * The same arithmetic as the ahead branch above, counted rather than built:
 * the home button used to be sized from the unseen cards alone, and said
 * twenty over a session of forty. */
function aheadSize(sectionKey) {
  const now = Date.now();
  let learning = 0, due = 0, notYet = 0, fresh = 0;
  for (const c of DECK.cards.filter(scopeTest(sectionKey))) {
    const r = state.recs[c.cardId];
    if (!r) { fresh++; continue; }
    if (r.st === 'l') learning++;
    else if (r.due <= now) due++;
    else notYet++;
  }
  return learning + due + Math.min(AHEAD_BATCH, notYet)
    + (newBudget() > 0 ? Math.min(AHEAD_BATCH, fresh) : 0);
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ─────────────────────────── screens ─────────────────────────── */

const SCREENS = ['home', 'study', 'done', 'browse', 'stats'];
let current = 'home';

function focusScreen(name) {
  const screen = $('#s-' + name);
  const target = screen.querySelector('h1, h2') || screen.querySelector('.body');
  if (!target) return;
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}

function go(name, moveFocus = false) {
  current = name;
  for (const s of SCREENS) $('#s-' + s).hidden = s !== name;
  $('#nav').hidden = name === 'study';
  const tab = name === 'browse' ? 'browse' : name === 'stats' ? 'stats' : 'home';
  $$('#nav button').forEach((b) => {
    const on = b.dataset.go === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'page' : 'false');
  });
  if (name === 'home') renderHome();
  if (name === 'stats') renderStats();
  // Back to the first page, and back to the deck. Coming back to Browse having
  // once pressed Show more to the end rebuilt all 537 rows, then scrolled to
  // the top past every one — and the cards you hid came back open over a screen
  // nobody had asked them of, because that flag outlived the screen it belongs
  // to.
  if (name === 'browse') { browseLimit = BROWSE_FIRST; showingHidden = false; renderBrowse(); }
  // The `courses` pill is the shell's, and there is exactly one of it: it used
  // to be fixed to the window, and inlined into the header it would otherwise
  // have to be three buttons, three things to focus, three to inert, three for
  // the picker to hand focus back to. Carry the one element into whichever
  // header is on screen instead. Study and Done have no corner to put it in,
  // which is right — a session is not the moment to change course — and it
  // simply stays where it was, on a screen that is now hidden.
  const acts = $('#s-' + name + ' .top-acts');
  const pill = document.querySelector('.shelf-btn');
  if (acts && pill && pill.parentElement !== acts) acts.prepend(pill);
  const body = $('#s-' + name).querySelector('.body');
  if (body && name !== 'study') body.scrollTop = 0;
  // "Skip to content" pointed at #main, which was the home screen's <main> and
  // nobody else's — from every other screen it jumped into a hidden section and
  // dropped focus on the floor. Aim the link at whatever is on screen rather
  // than moving the id about: the study screen's body already answers to
  // #card-scroll, and an element cannot hold two ids.
  if (body) {
    // Its own id, not a borrowed "main": two elements answering to the same one
    // means querySelector picks the first, which is on a screen that is hidden.
    if (!body.id) body.id = name + '-main';
    body.tabIndex = -1;
    $('.skip').setAttribute('href', '#' + body.id);
  }
  // Tapping a tab leaves focus on the tab, which is the last thing in the
  // document: for a keyboard the next Tab leaves the page entirely. Land on the
  // heading of the screen that just appeared instead.
  if (moveFocus) focusScreen(name);
}

/* Tapping a tab, as opposed to the app moving itself between screens.
 *
 * Home is the floor of a course and the tabs sit one press above it: Back from
 * Browse or Progress comes home, and walking Browse → Progress → Browse is
 * still one press deep, so it takes one press to leave whichever one you are
 * looking at. Pressing Home unwinds that stop rather than pushing another —
 * the same trip, through the same handler, as pressing Back. */
function goTab(name) {
  if (name === 'home') {
    if (stops[stops.length - 1] === 'tab') { history.back(); return; }
    go('home', true);
    return;
  }
  go(name, true);
  if (stops[stops.length - 1] !== 'tab') pushStop('tab');
}

/* ── home ── */

/** Cards that have gone wrong enough times that answering them again is not the
 *  answer — you need to go and read the material. */
function leeches() {
  return DECK.cards.filter((c) => {
    const r = state.recs[c.cardId];
    return r && r.lp >= LEECH_AT;
  });
}

/** Format a yyyy-mm-dd string the way a person would say it.
 *
 * en-GB, named, everywhere a date is printed. `undefined` hands the choice to
 * whatever locale the browser happens to be set to, and on a machine set to the
 * United States an app that says colour, harbour and almanac printed
 * "Tuesday, September 15, 2026" — three American dates undoing a lot of
 * carefully built voice. The deck's language is the app's, not the device's. */
function longDate(iso) {
  const t = Date.parse(iso + 'T00:00:00');
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** How many days it takes to introduce the rest of the deck at the current pace. */
function daysToSeeAll(unseen) {
  const pace = newBudget();
  return pace > 0 ? Math.ceil(unseen / pace) : Infinity;
}

function renderAskExam() {
  // The exam date decides the entire daily workload, so it is asked for early —
  // buried in settings, nobody ever finds it, and they walk into the exam
  // having seen half the deck.
  // Shown until a date is set or the prompt is dismissed — not just on day one.
  // Booking the exam a week in is the common case, and by then a "seen === 0"
  // prompt would be long gone with no way back to it except the third tab.
  $('#ask-exam').hidden = !EXAM_ON || !!(state.settings.examDate || state.settings.examSkipped);
}

/** True once this has printed a pacing sentence of its own, which is the note
 *  under the Study button said again in other numbers — see renderHome(). */
function renderExamBanner(c) {
  const el = $('#exam-banner');
  const d = daysToExam();
  if (d === null) { el.hidden = true; return false; }
  el.hidden = false;
  if (d < 0) {
    el.className = 'banner';
    el.innerHTML = `<b>Exam date has passed.</b> Clear it in Settings → Studying to go back to normal spacing.`;
    return false;
  }
  const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
  const pace = newBudget();
  const introDays = c.fresh ? daysToSeeAll(c.fresh) : 0;
  const tight = c.fresh > 0 && introDays > Math.max(1, d);
  el.className = 'banner' + (tight ? ' tight' : '');
  // "the remaining 527" over a deck of 537 read as a countdown of the whole
  // deck, ten cards short, beside a note underneath that counted all 537. It
  // counts the cards you have not seen, so it says so — the same words the
  // tight branch beside it has always used.
  // Once the date is set the ask that took it is gone, and this line stood in
  // its place with nothing on it to press: changing the date meant going and
  // finding it in a sheet. The line that states the fact carries the way to
  // amend it, quietly, the way the rest of the app's second offers are drawn.
  const amend = ' <button class="link-btn banner-link" type="button"'
    + ' data-open-setup>Change it in settings</button>';
  el.innerHTML = (tight
    ? `<b>Exam ${when}.</b> At ${pace} new cards a day, the ${c.fresh} you have not seen take ${introDays} days. You will not get through the deck — raise the daily number in Settings, or accept that you will skip some sections.`
    : `<b>Exam ${when}.</b> ${c.fresh
        ? `${pace} new cards a day gets you through the ${c.fresh} you have not seen in time.`
        : 'You have seen every card at least once.'} Every card comes back at least once before you sit it.`) + amend;
  return true;
}

function renderLeechRow() {
  const el = $('#leech-row');
  const l = leeches();
  if (!l.length) { el.hidden = true; return; }
  el.hidden = false;
  el.querySelector('span').textContent =
    `${l.length} card${l.length === 1 ? '' : 's'} keep${l.length === 1 ? 's' : ''} slipping`;
}

/* ── install ── */

/* This lives in Settings, under "this device", and not on Study.
 *
 * It used to be a card on the home screen, which made it a nudge: something you
 * had not asked for, in the way of the button you came for. So it needed a
 * "Not now", and the dismissal needed a thirty-day snooze, and the offer had to
 * be withheld until you had answered a card so a first-time visitor was not
 * asked to install an app they had not used. None of that is needed for a row
 * in Settings. It is a control you go looking for, so it is simply there
 * whenever installing is possible, and there is nothing to dismiss — hiding a
 * setting from yourself is not a thing a setting should do. */

/* The event itself is captured in munin.js, at parse time. The shell is the
 * only script that always runs: on the picker there is no course yet, so an
 * app.js listener would be registered long after Chrome had fired and dropped
 * it. Munin holds it and tells this screen when the answer changes; the picker
 * draws the same offer for people who never open Settings. */

function renderInstall() {
  const card = $('#install-card');
  // A browser that can neither prompt nor be told how, and an app already on
  // the home screen, both have nothing to say here — so the section is not there.
  if (!MuninInstall.offerable()) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#install-btn').hidden = !MuninInstall.event;
  // Why it is worth doing, not what it technically is. The mechanics only earn
  // their place on iOS, where the browser cannot do it for you.
  $('#install-note').textContent = MuninInstall.event
    ? 'Spacing only pays if you turn up. One tap from your home screen, and the cards work with no signal.'
    : MuninInstall.firefoxAndroid()
      ? 'Spacing only pays if you turn up. Open the Firefox menu and choose “Install”; it is one tap from then on.'
      : 'Spacing only pays if you turn up. Tap the share button, then “Add to Home Screen”, and it is one tap from then on.';
}

function renderHome() {
  rollDay();
  renderFrieze();
  const c = counts(null);
  const revRoom = Math.max(0, state.settings.maxRev - state.revDone);
  const newRoom = Math.max(0, newBudget() - state.newDone);
  const dueNow = Math.min(c.due, revRoom) + c.learning;
  const newNow = Math.min(c.fresh, newRoom);

  const homeSub = $('#home-sub');
  homeSub.textContent = COURSE.publicPresentation && COURSE.tagline
    ? COURSE.tagline
    : `${plural(DECK.cards.length, 'card')} · ${plural(DECK.sections.length, 'section')}`;
  homeSub.hidden = false;

  // On day one every one of these reads as zero or nonsense — "0 to review" and
  // "0% started" tell a first-time reader nothing except that they have failed
  // at something. They appear once there is something to count.
  $('#today-counts').hidden = c.seen === 0;
  $('#today-counts').innerHTML = `
    <div class="due"><b>${dueNow}</b><span>to review</span></div>
    <div><b>${newNow}</b><span>new today</span></div>
    <div><b>${Math.round((c.seen / DECK.cards.length) * 100)}%</b><span>of the deck started</span></div>`;

  const btn = $('#study-all');
  const totalNow = dueNow + newNow;
  if (totalNow > 0) {
    btn.textContent = `Study ${totalNow} card${totalNow === 1 ? '' : 's'}`;
    btn.dataset.mode = 'normal';
    // Say the finishing date, not the rate. "20 a day" makes the reader do the
    // division; most will not, and will find out too late that it does not fit.
    const pace = newBudget();
    $('#today-note').textContent = !c.fresh
      ? 'You have seen every card at least once. From here it is all repeats.'
      : pace > 0
        // "all 1 in 1 day" about a deck of one card, the way the exam hint
        // below already handles the same sentence about the same number.
        ? `At ${pace} new cards a day you will have seen ${DECK.cards.length === 1
          ? 'it' : `all ${n(DECK.cards.length)}`} in ${plural(daysToSeeAll(c.fresh), 'day')}.`
        : `New cards are switched off, so ${c.fresh} of ${DECK.cards.length} will stay unseen. Raise the daily number in Settings.`;
  } else {
    // The size of the session that this button actually starts. Sized from the
    // unseen cards alone it promised twenty and handed over forty, because the
    // ahead branch adds a batch of not-yet-due reviews on top of them.
    const batch = aheadSize(null);
    const pace = newBudget();
    // Called practice on the button, because that is what it is: the cards it
    // hands over are ones you have already answered or have not met yet, and
    // none of it counts. "Do 20 more now" read as twenty more off the plan.
    btn.textContent = c.fresh && batch ? `Practise ${batch} now` : 'Practise ahead';
    btn.dataset.mode = 'ahead';
    $('#today-note').textContent = pace === 0 && c.fresh
      ? `New cards are switched off, so ${c.fresh} of ${DECK.cards.length} will stay unseen. Raise the daily number in Settings.`
      : c.fresh
        ? `Today's ${pace} are done and nothing is due. You can practise ${batch} now: nothing you answer counts, and nothing moves. ${c.fresh} cards left to see.`
        : 'Nothing is due. Practice pulls forward the cards scheduled soonest and leaves the schedule exactly where it is — worth it the week before the exam, not before.';
  }

  const today = countStudiedToday();
  $('#today-done').hidden = today === 0;
  $('#today-done').textContent = `You have answered ${today} card${today === 1 ? '' : 's'} today.`;

  renderAskExam();
  // One pacing sentence at a time. With a date set, the banner above the Study
  // button and the note under it are the same claim in different arithmetic —
  // "20 a day gets you through the 527 you have not seen in time" over the
  // button, "at 20 a day you will have seen all 537 in 27 days" under it — and
  // a reader left doing sums on their own home screen is the opposite of calm.
  // The banner wins: it is the one that knows about the date. The note keeps
  // its text and loses its space, so nothing that reads this line goes blind.
  $('#today-note').hidden = renderExamBanner(c);
  renderLeechRow();

  const list = $('#section-list');
  list.innerHTML = '';
  // counts() walks the whole deck, so it is called once per section and the
  // theme's total is added up from those rather than costing a second pass.
  const themes = byGroup().map(([g, inside]) => {
    const rows = inside.map((s) => {
      const sc = counts(s.sectionId);
      return { s, sc, pending: Math.min(sc.due, 999) + sc.learning };
    });
    return {
      g,
      rows,
      waiting: rows.reduce((t, r) => t + r.pending, 0),
      unseen: rows.reduce((t, r) => t + r.sc.fresh, 0),
    };
  });
  /* Which themes stand open.
   *
   * The question Home answers is "where do I go next", so a theme with cards
   * waiting answers it and is open. With nothing waiting, the first theme you
   * have not finished is the answer instead. On a deck you have been all the
   * way through, nothing opens: there is nothing left to point at, and the
   * badge on each heading already says so. */
  const anyWaiting = themes.some((t) => t.waiting > 0);
  const firstUnfinished = anyWaiting ? -1 : themes.findIndex((t) => t.unseen > 0);
  for (const [i, { g, rows, waiting }] of themes.entries()) {
    let host = list;
    if (g.title) {
      // The heading says what is waiting inside the theme, because the answer
      // used to be twenty-four rows of column you had to read to work it out.
      // Folded, that badge is the whole of what a closed theme has to say.
      const part = document.createElement('details');
      part.className = 'part';
      part.open = anyWaiting ? waiting > 0 : i === firstUnfinished;
      const h = document.createElement('summary');
      h.className = 'h-part';
      h.innerHTML = `<span>${escapeHtml(g.title)}</span>`
        + (waiting ? `<span class="h-part-n">${n(waiting)} to review</span>` : '');
      part.appendChild(h);
      list.appendChild(part);
      host = part;
    }
    const ul = document.createElement('ul');
    ul.className = 'sections';
    for (const { s, sc, pending } of rows) {
      const pct = Math.round(((sc.mature + (sc.seen - sc.learning - sc.mature) * 0.5)
        / s.cardCount) * 100);
      // The meta line says what the number means. A bare badge on an untouched
      // section reads as "12 due" when it means "12 you have never seen".
      let meta;
      // Counted through plural(): a section can hold one card, and a deck
      // written here starts as one section holding exactly one.
      // What is waiting is the badge's job and the theme heading's above it —
      // printed here as well it was one number in four pieces of furniture on
      // one row: heading, meta line, badge and bar. The meta says what the badge
      // cannot, which is how big the section is.
      if (pending) meta = plural(s.cardCount, 'card');
      // No badge and an empty meter already say it, twice over. Printed down
      // twenty-four rows it was the same two words twenty-four times.
      else if (sc.seen === 0) meta = plural(s.cardCount, 'card');
      else if (sc.fresh) meta = `${sc.fresh} new left · ${plural(s.cardCount, 'card')}`;
      else meta = `all ${s.cardCount} scheduled · ${pct}% known well`;

      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = `
        ${sectionMark(s.sectionId, 'sect-art')}
        <span class="sect-name">${escapeHtml(s.title)}</span>
        ${pending ? `<span class="sect-badge">${pending}</span>` : ''}
        <span class="sect-meta">${meta}</span>
        ${pct > 0 ? `<span class="sect-meter"><i style="width:${Math.min(100, pct)}%"></i></span>` : ''}`;
      // The badge is a bare number and reads out as one, so the count it stands
      // for is spelled into the label the row is announced under.
      b.setAttribute('aria-label',
        `${s.title}. ${pending ? `${pending} to review. ` : ''}${meta}. Study this section.`);
      b.addEventListener('click', () => startSession(s.sectionId));
      li.appendChild(b);
      ul.appendChild(li);
    }
    host.appendChild(ul);
  }
  renderNotesRow();
  hydrateSectionArtwork(list);
}

/* ── notes ── */

/* Your own words about this deck.
 *
 * Plain text and nothing else: no markup, no pictures, no links, no markdown.
 * A note is stored as text and rendered as text, and those are the same fact —
 * there is no formatting to strip on the way out because none was ever kept on
 * the way in. That is the whole feature, and it is deliberately the whole
 * feature: a deck of flashcards is not a place to have built a second editor.
 *
 * They live in this deck's own state document, alongside the review history,
 * because that document is already the per-deck thing. It already survives a
 * reload and the sanitiser, it already rides along in an exported backup, and
 * it is already covered by the single-writer rule that stops two tabs
 * overwriting each other's work. It also answers the question the feature
 * would otherwise leave open: the shell deletes that document when a deck is
 * removed (sweepOrphans in munin.js), so a deck's notes are removed with the
 * deck they were about, and nothing survives it pointing at cards that are
 * gone. Erasing progress is the one thing that does NOT take them — a note is
 * not review history, and that button does not offer to destroy one.
 */

/** Delete markers last, then oldest last. Shared by the sanitiser and, in the
 *  same shape, by sync.js: both cap the number of stored entries, and two caps
 *  that evicted different records would make a sync flip the set back and
 *  forth for ever. Total, including the id, so the order never depends on
 *  which object the entries were read out of. */
function noteEntryOrder(a, b) {
  const liveA = a[1].text ? 0 : 1, liveB = b[1].text ? 0 : 1;
  if (liveA !== liveB) return liveA - liveB;
  if (n(a[1].ed) !== n(b[1].ed)) return n(b[1].ed) - n(a[1].ed);
  return a[0] < b[0] ? -1 : 1;
}

/** Two sets of notes, kept together.
 *
 * Restoring a backup is the one place outside Sync where two of these meet, and
 * it is the same meeting: two documents that each hold words somebody wrote,
 * and deletes on both sides that must not be undone by the other side's copy.
 * So it is settled by the same algebra, called rather than copied — a second
 * implementation would be a second answer to the tombstone question, and only
 * one of them could be right. */
function mergedNotes(mine, theirs) {
  if (globalThis.DSSync && DSSync.mergeNotes) return DSSync.mergeNotes(mine, theirs);
  // With sync.js missing there is no pickNote to call, and a restore is not the
  // moment to improvise one. Keep every record this device holds and take the
  // ids only the file has: nothing anybody can currently read goes away, which
  // is the whole reason this function exists.
  return Object.assign({}, theirs, mine);
}

/** The notes there are, newest written first. */
function liveNotes() {
  return Object.entries(state.notes)
    .filter(([, note]) => !!note.text)
    // Written order, not edited order. Sorted by the edit stamp instead,
    // correcting a typo in the oldest note threw it to the top of the list —
    // the app re-arranging a page in front of someone who only fixed a word.
    .sort((a, b) => n(b[1].at) - n(a[1].at) || (a[0] < b[0] ? 1 : -1))
    .map(([id, note]) => Object.assign({ id }, note));
}

/** Hex, and short. See NOTE_ID: this value becomes an object key, and
 *  crypto.randomUUID() is undefined outside a secure context — which includes
 *  the plain-http origin the suites run against. */
function newNoteId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

let noteEditing = null;

function noteSays(line) {
  const el = $('#notes-say');
  if (el) el.textContent = line || '';
}

function clearNoteInvalid() {
  const box = $('#notes-text');
  box.removeAttribute('aria-invalid');
  box.removeAttribute('aria-describedby');
}

function noteInvalid(line) {
  const box = $('#notes-text');
  noteSays(line);
  box.setAttribute('aria-invalid', 'true');
  box.setAttribute('aria-describedby', 'notes-say');
  box.focus({ preventScroll: true });
}

/* Every note write goes through here.
 *
 * The review document is one JSON value, so a note is written under the same
 * single-writer rule as a grade: save() hands back false when another tab holds
 * the study lease, and by then refuseForeignWrite() has already re-read that
 * tab's durable copy over this one. Re-drawing from `state` afterwards is not
 * housekeeping, then — it is how the refused edit disappears from the screen
 * again, rather than sitting there looking saved. */
function commitNotes(say) {
  const wrote = save();
  if (wrote) clearNoteInvalid();
  renderNotes();
  renderNotesRow();
  // The toast for a refused write ranks below this panel, so the panel says it
  // itself. A message about the thing you just typed belongs next to it anyway.
  noteSays(wrote ? (say || '') : 'Another tab is studying this deck. Finish there before writing notes.');
  return wrote;
}

/** Whatever a person typed, as far as it is a note at all. */
function noteTextFrom(input) {
  const text = String(input == null ? '' : input)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return cutCodePoints(text, NOTE_LEN);
}

function addNote(input) {
  const text = noteTextFrom(input);
  if (!text) {
    noteInvalid('A note needs some words.');
    return false;
  }
  if (liveWrittenCount() >= WRITTEN_LIVE) {
    noteSays(`This deck already holds ${WRITTEN_LIVE} notes and cards of your own. `
      + 'Delete one to write another.');
    return false;
  }
  const now = Date.now();
  state.notes[newNoteId()] = { at: now, ed: now, text };
  return commitNotes('Note added.');
}

function editNote(id, input) {
  const note = state.notes[id];
  if (!note || !note.text) return false;
  const text = noteTextFrom(input);
  // Emptying a note is not a note. An empty record is what a delete looks like
  // in storage (see sync.js), so an empty edit is offered as a delete rather
  // than quietly performing one.
  if (!text) {
    noteInvalid('A note needs some words. Use Delete to take it away.');
    return false;
  }
  if (text === note.text) return true;
  note.text = text;
  note.ed = Date.now();
  return commitNotes('Note saved.');
}

function deleteNote(id) {
  const note = state.notes[id];
  if (!note || !note.text) return false;
  // Emptied, not removed. The record is the evidence that the note was deleted
  // here; drop it entirely and the next sync with a device that still has it
  // hands it straight back.
  note.text = '';
  note.ed = Date.now();
  return commitNotes('Note deleted.');
}

/** The row on Home that opens the panel, in this deck's numbers. */
function renderNotesRow() {
  const row = $('#notes-row-say');
  if (!row) return;
  const count = liveNotes().length;
  row.textContent = count
    ? `${count} note${count === 1 ? '' : 's'} on this deck`
    : 'Anything about this deck the cards do not say';
}

function renderNotes() {
  const list = $('#notes-list');
  if (!list) return;
  const notes = liveNotes();
  $('#notes-empty').hidden = notes.length > 0;
  // escapeHtml, not innerHTML with the raw string: this is the one text in the
  // app that a person typed into it, so it is also the one text that is theirs
  // to type "<img onerror=…>" into. Whitespace is preserved by .note-text's
  // pre-wrap — the line breaks are the only shape plain text has.
  list.innerHTML = notes.map((note) => `<li data-note="${escapeHtml(note.id)}">
      <p class="note-text">${escapeHtml(note.text)}</p>
      <div class="note-foot">
        <span class="note-when">${escapeHtml(noteWhen(note))}</span>
        <button class="link-btn" type="button" data-note-edit
          aria-label="Edit this note">Edit</button>
        <button class="link-btn" type="button" data-note-delete
          aria-label="Delete this note">Delete</button>
      </div>
    </li>`).join('');
  // `saveBtn`, not `save`: there is a save() in this file that writes the whole
  // document, and a local const of that name inside a render function is a trap
  // for whoever adds the next line to it.
  const saveBtn = $('#notes-save');
  const editing = noteEditing && state.notes[noteEditing] && state.notes[noteEditing].text;
  if (!editing) noteEditing = null;
  saveBtn.textContent = editing ? 'Save note' : 'Add note';
  $('#notes-cancel').hidden = !editing;
  $('#notes-text').setAttribute('aria-label', editing ? 'Edit note' : 'New note');
}

/** When it was written, and whether it has been changed since. */
function noteWhen(note) {
  const written = new Date(n(note.at)).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' });
  // A minute's slack: `ed` is stamped by the same clock a moment after `at`,
  // and a note created and never touched again must not claim it was edited.
  return n(note.ed) - n(note.at) > 60000 ? `${written} · edited` : written;
}

function startNoteEdit(id) {
  const note = state.notes[id];
  if (!note || !note.text) return;
  noteEditing = id;
  const box = $('#notes-text');
  box.value = note.text;
  renderNotes();
  box.focus({ preventScroll: true });
  // The caret at the end, not at the start: this is the note you already wrote,
  // and what you came to do is add to it or fix the end of it.
  box.setSelectionRange(box.value.length, box.value.length);
  noteSays('Editing a note.');
}

function cancelNoteEdit() {
  noteEditing = null;
  $('#notes-text').value = '';
  clearNoteInvalid();
  renderNotes();
  noteSays('');
}

let notesOpener = null;

function openNotes(opener) {
  const panel = $('#notes');
  if (!panel.hidden) return;
  notesOpener = opener || null;
  noteEditing = null;
  $('#notes-text').value = '';
  clearNoteInvalid();
  noteSays('');
  renderNotes();
  panel.hidden = false;
  document.body.style.overflow = 'hidden';
  // The same containment the lightbox uses, for the same reason: aria-modal
  // says the rest of the page is not there, and only inert makes that true for
  // the Tab key. The panel is a sibling of #app so it is not inerting itself.
  setBackgroundInert(true);
  $('#notes-text').focus({ preventScroll: true });
  pushStop('notes');
}

function closeNotes(fromHistory) {
  const panel = $('#notes');
  if (panel.hidden) return;
  panel.hidden = true;
  document.body.style.overflow = '';
  setBackgroundInert(false);
  noteEditing = null;
  $('#notes-text').value = '';
  clearNoteInvalid();
  if (notesOpener && notesOpener.isConnected && notesOpener.focus) {
    notesOpener.focus({ preventScroll: true });
  }
  notesOpener = null;
  if (!fromHistory && stops[stops.length - 1] === 'notes') history.back();
}

/** Re-draw the panel when the state under it was replaced by another tab or by
 *  a sync, rather than leaving a list of notes that are no longer there. */
function renderNotesIfOpen() {
  if (!$('#notes').hidden) renderNotes();
}

/* ── cards you write ── */

/* Your own cards, and your edits to the deck's own, as a layer over what the
 * course ships.
 *
 * Nothing here changes the deck. A built-in course's cards.json, or the record
 * an import wrote into the database, is read exactly as it was shipped; this
 * layer goes over the top on the way to DECK.cards, on every boot. That is what
 * makes an edit to a course card free to take back — drop the record and the
 * shipped card is there again — and it is what lets a course be updated
 * underneath you without touching a word you wrote.
 *
 * It lives in its own document beside the review history, not inside it. See
 * MUNIN.cardsKey: the state document is rebuilt key by key when devices meet,
 * and a key that file has never heard of is dropped rather than skipped.
 *
 * Three kinds of record, one shape, keyed by card id, {at, ed, …} like a note:
 *
 *   written   an id of your own — CARD_ID — carrying front, back and section.
 *   override  keyed by a shipped card's own id, carrying front, back and `was`:
 *             a fingerprint of the official text at the moment you edited it,
 *             so the app can tell later that the author has rewritten it under
 *             you. That field is the one that cannot be added afterwards —
 *             every override written before it existed would have an unknown
 *             provenance for ever.
 *   emptied   no front. The layer contributes nothing for this id: for a card
 *             you wrote that is the delete, and for a course card it is the
 *             revert, the shipped card coming back. `hidden` on an emptied
 *             record is the third case — a course card that should not exist.
 *             Emptied rather than removed, with a newer `ed`, exactly as a
 *             deleted note is: a record that is simply dropped is handed
 *             straight back by the next device that still has it.
 *
 * Both sides are Markdown, in the small subset the course format already
 * supports, rendered to sanitized HTML when they are saved and again every time
 * they are loaded. That is the whole reason a card can be written into an Anki
 * import: what the layer produces is the representation every deck in this app
 * is already made of, so nothing downstream has to know which kind of deck it
 * is reading, and `**bold**` cannot come out as four asterisks on a card.
 */

let cardLayer = {};              // card id -> {at, ed, front, back, section, was, hidden}
let cardLayerLoaded = false;     // whether this tab knows what that document holds
let cardsDropped = 0;            // live records the sanitiser dropped, unspoken
let shippedCourse = null;        // the deck as the course reader produced it
let shippedById = new Map();     // the cards it shipped, before the layer

/** Delete markers last, then oldest last — noteEntryOrder, on the field that
 *  makes a card record live. Total, including the id, so what survives a cap
 *  never depends on which object the entries were read out of. */
function cardEntryOrder(a, b) {
  const liveA = a[1].front ? 0 : 1, liveB = b[1].front ? 0 : 1;
  if (liveA !== liveB) return liveA - liveB;
  if (n(a[1].ed) !== n(b[1].ed)) return n(b[1].ed) - n(a[1].ed);
  return a[0] < b[0] ? -1 : 1;
}

/** An id this layer will store a record under, in the one namespace it owns or
 *  the one the course owns — and nothing in between. */
function cardIdOk(id) {
  return id.startsWith('u.') ? CARD_ID.test(id) : COURSE_CARD_ID.test(id);
}

/** `u.` and hex. See CARD_ID: this becomes an object key, and it is written
 *  into a document another device will read. crypto.randomUUID() is undefined
 *  outside a secure context, which is why this counts its own bytes. */
function newCardId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return 'u.' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whatever a person typed, as far as it is a card side at all.
 *
 * Cut in code points, the rule web/lib/deck.js writes down for a deck's name:
 * an emoji is two code units, so cutting at CARD_LEN of those can land inside
 * one and leave its leading half behind. On screen that is a replacement
 * character; in the sync blob it is a lone surrogate, which the server's JSON
 * parser refuses — one side written slightly too long would stop the whole deck
 * syncing, with a message about Unicode that nobody can act on. */
function cardTextFrom(input) {
  const text = String(input == null ? '' : input)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return cutCodePoints(text, CARD_LEN);
}

/** A record this layer holds for a card, or null. Object.hasOwn, because an id
 *  like "constructor" passes the course's own id grammar and would otherwise
 *  come back off the prototype as something truthy that is not a record. */
function cardRecord(cardId) {
  return Object.hasOwn(cardLayer, cardId) ? cardLayer[cardId] : null;
}

/** The cards of your own this deck is holding, live ones only. */
function writtenCardCount() {
  return Object.entries(cardLayer)
    .filter(([id, rec]) => CARD_ID.test(id) && !!rec.front).length;
}

/** Every live record that is actually a card in this deck.
 *
 * An override is keyed by the shipped card's own id, and a course update can
 * take that card away — the built-in ids are a hash of the question, so
 * rewording a question mints a new id and retires the old one. What is left is
 * a record overriding nothing: it is in no list, Browse cannot draw it and no
 * screen can reach it to take it back. Counting it said "the 1 card you have
 * written or edited" about a card that does not exist, and held a live slot
 * against the ceiling this deck shares with its notes for ever. The record
 * stays where it is — the author may put the question back, and then the edit
 * is there again — but it is not one of the cards this deck holds. */
function liveCardCount() {
  return Object.entries(cardLayer)
    .filter(([id, rec]) => !!rec.front && (CARD_ID.test(id) || shippedById.has(id)))
    .length;
}

/** Everything you have written into this deck, against the one ceiling it all
 *  shares. A note and a card are the same thing to the blob that has to carry
 *  them, so they are the same thing to the number that says when it is full. */
function liveWrittenCount() {
  return liveNotes().length + liveCardCount();
}

/** Hold both documents to the ceiling they share, wherever they are both in
 *  hand: after a boot has read them, after a sync has merged them, after a
 *  restore has replaced one.
 *
 * Each sanitiser already caps its own block against the same two numbers, which
 * cannot change what survives here — the order over one kind is the joint order
 * with the other kind taken out — so this is what the two of them add up to
 * rather than a third opinion. Called rather than copied for the same reason
 * mergedNotes() calls into sync.js: two implementations of an eviction order
 * would make a round trip through Sync change what is on the device.
 *
 * Answers whether it took anything out of either block, because a ceiling that
 * only ever bit in memory would bite again on every boot — dropping the same
 * records and saying so again each time — so every caller has to write back
 * what it was handed. Either block, not only the cards: both documents are
 * held to the one number, so either of them can be the half that gives. */
function capWrittenBlocks() {
  // With sync.js missing there is no joint order to call, and the per-block
  // ceilings above still hold each half. Nothing is lost by leaving it: this
  // can only ever remove records, never keep more of them.
  if (!globalThis.DSSync || !DSSync.capWritten) return false;
  const capped = DSSync.capWritten(state.notes, cardLayer);
  const moved = Object.keys(capped.cards).length !== Object.keys(cardLayer).length
    || Object.keys(capped.notes).length !== Object.keys(state.notes).length;
  state.notes = capped.notes;
  cardLayer = capped.cards;
  return moved;
}

/** Two layers, kept together.
 *
 * The meeting mergedNotes() settles, on the other block. A restored backup and
 * a synced blob are the two places two layers meet, and both are the same
 * question: which record is the current one, and does a delete recorded on one
 * side survive the other side's copy of the card. Called rather than copied for
 * the reason written above mergedNotes() — a second implementation would be a
 * second answer to the tombstone question, and only one of them could be
 * right. */
function mergedCards(mine, theirs) {
  if (globalThis.DSSync && DSSync.mergeCards) return DSSync.mergeCards(mine, theirs);
  // With sync.js missing there is no pickWritten to call, and a restore is not
  // the moment to improvise one. Keep every record this device holds and take
  // the ids only the file has: nothing anybody can currently read goes away.
  return Object.assign({}, theirs, mine);
}

/** A short fingerprint of a card's official text, for `was`.
 *
 * A change detector and nothing else — it answers "is this still the card I
 * edited?" — so it is a plain 32-bit hash with the length beside it rather than
 * anything that needs crypto.subtle, which does not exist outside a secure
 * context and would make the boot path wait on a promise per card. */
function cardFingerprint(card) {
  const text = (card && typeof card.front === 'string' ? card.front : '')
    + '\u0000' + (card && typeof card.back === 'string' ? card.back : '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + '.' + text.length.toString(36);
}

/** Make any stored, restored or synced card layer safe to merge.
 *
 * The same discipline as sanitise(), for the same reasons and against the same
 * arrivals: a document written by an older build, one that spent time in a
 * database, one somebody edited by hand. Nothing is trusted, everything is
 * clamped, and a block that is nonsense becomes no cards rather than something
 * that throws on the boot path. */
function sanitiseCardLayer(block) {
  const records = {};
  if (!isPlainObject(block)) return records;
  const num = (value, lo, hi, dflt) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(hi, Math.max(lo, parsed)) : dflt;
  };
  const entries = [];
  for (const [id, raw] of Object.entries(block)) {
    if (!cardIdOk(id) || !isPlainObject(raw)) continue;
    const front = cardTextFrom(typeof raw.front === 'string' ? raw.front : '');
    const at = Math.round(num(raw.at, 0, 8.64e15, 0));
    // A missing edit stamp falls back to the written one rather than to zero,
    // which would lose every merge against a device holding the same card.
    const record = { at, ed: Math.round(num(raw.ed, 0, 8.64e15, at)), front, back: '' };
    if (front) {
      record.back = cardTextFrom(typeof raw.back === 'string' ? raw.back : '');
      if (CARD_ID.test(id)) {
        // A section that is not a section is not a reason to drop somebody's
        // card. cardsWithLayer() resolves an unplaceable one instead.
        record.section = typeof raw.section === 'string'
          && COURSE_CARD_ID.test(raw.section) ? raw.section : '';
      } else if (typeof raw.was === 'string') {
        record.was = raw.was.slice(0, 32);
      }
    } else if (raw.hidden === true) {
      record.hidden = true;
    }
    entries.push([id, record]);
  }
  // More entries than this build stores can only have come from somewhere else.
  // Both ceilings are read off one order, the same way and for the same reason
  // as the notes block above: whether a record survives depends only on the
  // records ahead of it, so a round trip through storage cannot change the set.
  entries.sort(cardEntryOrder);
  let kept = 0, live = 0;
  for (const [id, record] of entries) {
    if (kept >= WRITTEN_SLOTS) break;
    if (record.front) {
      if (live >= WRITTEN_LIVE) { cardsDropped++; continue; }
      live++;
    }
    records[id] = record;
    kept++;
  }
  return records;
}

/** Read the layer, and say whether the answer can be relied on.
 *
 * The return value is the whole point. `false` does not mean "no cards" — it
 * means the question could not be answered, which is the distinction
 * sweepOrphans states in munin.js and the one this feature cannot get wrong:
 * the boot sweep deletes review history for every card it cannot find, so a
 * document that would not open would take every written card's history with it,
 * silently, on the boot after the failure. No document at all IS an answer;
 * a document that will not parse, or whose block is not a block, is not. */
function cardLayerDocument(text) {
  let raw;
  try {
    raw = text === null ? {} : JSON.parse(text);
  } catch (e) {
    return { ok: false, cards: {} };
  }
  if (!isPlainObject(raw) || (raw.cards !== undefined && !isPlainObject(raw.cards))) {
    return { ok: false, cards: {} };
  }
  return { ok: true, cards: sanitiseCardLayer(raw.cards) };
}

function loadCardLayer() {
  let parsed;
  try {
    parsed = cardLayerDocument(localStorage.getItem(CARDS_KEY));
  } catch (e) {
    parsed = { ok: false, cards: {} };
  }
  if (!parsed.ok) {
    console.warn('cards unreadable, leaving them out of this boot');
    cardLayer = {};
    cardLayerLoaded = false;
    return false;
  }
  cardLayer = parsed.cards;
  cardLayerLoaded = true;
  return true;
}

/** Every write to the layer goes through here.
 *
 * The single-writer rule covers this document too. It is not the document the
 * study lease guards — that one is the review history — but the two are edited
 * from the same screens, and a card written from an idle tab would land in a
 * deck the studying tab is answering out of. refuseForeignWrite() has already
 * put that tab's durable review document back by the time this returns; re-
 * reading the layer here is the other half of the same move, so what the screen
 * redraws is what is actually on the device. */
function writeCardLayer(preserveIdleBranch = false) {
  if (refuseForeignWrite()) {
    loadCardLayer();
    return { ok: false, say: 'Another tab is studying this deck. Finish there before changing cards.' };
  }
  try {
    // commitCards() opts into the idle-tab union. Import, restore and eviction
    // writes do not: those deliberately replace or remove records, and merging
    // the old durable layer would bring them straight back.
    if (preserveIdleBranch) {
      const durable = cardLayerDocument(localStorage.getItem(CARDS_KEY));
      if (durable.ok) cardLayer = mergedCards(durable.cards, cardLayer);
      capWrittenBlocks();
    }
    localStorage.setItem(CARDS_KEY, JSON.stringify({ v: 1, cards: cardLayer }));
  } catch (e) {
    // Put the document that is actually on the device back in front of the
    // person. A deck showing a card that no storage anywhere holds is the worst
    // of the two outcomes: they would stop writing it down somewhere else.
    loadCardLayer();
    return {
      ok: false,
      say: 'The card could not be saved: the browser is out of space for this site. '
        + 'Removing a deck you no longer study will free it.',
    };
  }
  // Whatever that document held before this, the layer in memory is now what is
  // in it — including after a failed read, which is the only way out of one.
  cardLayerLoaded = true;
  return { ok: true, say: '' };
}

let courseMarkdownModule = null;
let courseRuntimeModule = null;
let courseExportModule = null;
const courseMarkdown = () =>
  (courseMarkdownModule ||= import('./lib/course-markdown.js'));
const courseRuntime = () =>
  (courseRuntimeModule ||= import('./lib/course-runtime.js'));
// The writer, and through it the reader that checks what it wrote. Asked for
// only when Progress is drawn: nobody studying a deck should be paying for a
// YAML emitter on the boot path.
const courseExport = () =>
  (courseExportModule ||= import('./lib/course-export.js'));

/** One stored side, as the sanitized HTML the rest of the app draws.
 *
 * A side that will not render is still something somebody wrote, so it comes
 * back as the characters they typed rather than as a blank card. The save path
 * refuses what does not render; this path is what happens to a document written
 * by a build whose subset was wider, and losing the words is not the answer. */
async function renderCardSide(source, path) {
  if (!source) return '';
  const { renderCourseMarkdown } = await courseMarkdown();
  const rendered = await renderCourseMarkdown(source, { path });
  if (rendered.html) return rendered.html;
  return '<p>' + escapeHtml(source).replace(/\n/g, '<br>') + '</p>';
}

/** The deck as it is after your cards: what the course ships, minus what you
 *  hid, with your edits over the top, plus what you wrote. */
async function cardsWithLayer(shipped, sectionIds) {
  const out = [];
  /* A deck whose document you wrote here rather than imported. Its own cards
   * are cards you wrote too — the first of them is what made the deck, because
   * a course with no cards is not a document this app will read — so they are
   * marked like the ones in the layer.
   *
   * This is the only place the two homes for a card of your own meet, and it
   * exists so that nothing downstream has to know about them: everything else
   * asks one question, which is whether you wrote this card, and gets one
   * answer. What still differs is what taking one out means — the card that
   * made the deck can be hidden, and the deck itself is what you remove. */
  const deckIsYours = !!(globalThis.COURSE && COURSE.own);
  for (const card of shipped) {
    const rec = cardRecord(card.cardId);
    if (!rec || !rec.front) {
      // No record, an emptied one — your edit taken back — or a hide.
      if (!(rec && rec.hidden)) {
        out.push(deckIsYours ? Object.assign({}, card, { _yours: true }) : card);
      }
      continue;
    }
    const front = await renderCardSide(rec.front, '$.cards[0].front');
    const back = await renderCardSide(rec.back, '$.cards[0].back');
    // Spread, not rebuilt: the shipped card's media, figure and tags are still
    // the card's. Changing the wording of a card must not take its picture off.
    const yours = Object.assign({}, card, { front, _yours: true, _edited: true, _was: rec.was || '' });
    if (back) yours.back = back; else delete yours.back;
    out.push(yours);
  }
  // Written order, oldest first, so the list a section draws does not
  // rearrange itself the day you correct a typo in the first card you wrote.
  const written = Object.entries(cardLayer)
    .filter(([id, rec]) => CARD_ID.test(id) && !!rec.front)
    .sort((a, b) => n(a[1].at) - n(b[1].at) || (a[0] < b[0] ? -1 : 1));
  for (const [id, rec] of written) {
    const front = await renderCardSide(rec.front, '$.cards[0].front');
    const back = await renderCardSide(rec.back, '$.cards[0].back');
    // A section this deck no longer declares is not a reason to lose a card:
    // it goes to a section synthesised for it, the same answer boot() reaches
    // for a deck that declares no groups. Dropping the card would take its
    // review history with it at the next sweep.
    const card = {
      cardId: id,
      sectionId: sectionIds.has(rec.section) ? rec.section : LOOSE_SECTION,
      front,
      _yours: true,
    };
    if (back) card.back = back;
    out.push(card);
  }
  return out;
}

/** Rebuild DECK, and every index over it, from the course plus the layer.
 *
 * Called on boot and again after every write: a card that has just been written
 * has to be in byId before anything draws the screen it appears on. */
async function applyCardLayer() {
  const sections = shippedCourse.sections.map((s) => Object.assign({}, s, { cardCount: 0 }));
  const sectionIds = new Set(sections.map((s) => s.sectionId));
  const groups = (shippedCourse.groups || []).map((g) =>
    Object.assign({}, g, { sectionIds: [...g.sectionIds], cardCount: 0 }));
  const cards = await cardsWithLayer(shippedCourse.cards, sectionIds);
  if (!sectionIds.has(LOOSE_SECTION)
      && cards.some((card) => card.sectionId === LOOSE_SECTION)) {
    sections.push({ sectionId: LOOSE_SECTION, title: 'Cards you wrote', cardCount: 0 });
    sectionIds.add(LOOSE_SECTION);
    // A section in no group is a section Browse never draws, so the synthetic
    // one brings a group of its own — untitled, like the fallback group below,
    // so it appears as tiles under no heading rather than as a second name for
    // the same thing.
    if (groups.length) {
      groups.push({ groupId: LOOSE_SECTION, title: '', sectionIds: [LOOSE_SECTION], cardCount: 0 });
    }
  }
  // Counts are derived here exactly as they are in the reader. A section that
  // gained a card you wrote, or lost one you hid, says so everywhere it is
  // counted — the tiles, the filter, the section rows on Home.
  const per = new Map();
  for (const card of cards) per.set(card.sectionId, (per.get(card.sectionId) || 0) + 1);
  for (const section of sections) section.cardCount = per.get(section.sectionId) || 0;
  // A section with nothing left in it is not a section. The course reader
  // refuses a declared section with no cards, and it is right: an empty tile
  // reading "0 cards" is a promise of something to read that opens on nothing.
  // Taking the last card out of a section takes the section, which is what the
  // sheet says before it lets you do it.
  const live = sections.filter((section) => section.cardCount > 0);
  for (const group of groups) {
    group.sectionIds = group.sectionIds.filter((id) => (per.get(id) || 0) > 0);
    group.cardCount = group.sectionIds.reduce((total, id) => total + (per.get(id) || 0), 0);
  }
  DECK = Object.assign({}, shippedCourse, {
    cards,
    sections: live,
    groups: groups.filter((group) => group.sectionIds.length > 0),
  });
  await indexRuntimeDeck();
}

/** The indexes every screen reads, rebuilt from DECK. */
async function indexRuntimeDeck() {
  byId = new Map(DECK.cards.map((c) => [c.cardId, c]));
  sectionOf = new Map(DECK.sections.map((s) => [s.sectionId, s]));
  // An older cards.json in the cache has no groups. The index falls back to one
  // unnamed group holding everything, which is the flat list of sections — worse
  // than the grouping, but not a blank Browse screen while the worker catches up.
  const gs = DECK.groups && DECK.groups.length
    ? DECK.groups
    : [{
        groupId: 'all',
        title: '',
        sectionIds: DECK.sections.map((s) => s.sectionId),
        cardCount: DECK.cards.length,
      }];
  groupOf = new Map(gs.map((g) => [g.groupId, g]));
  groupFor = new Map();
  for (const g of gs) {
    for (const sectionId of g.sectionIds) groupFor.set(sectionId, g.groupId);
  }
  await indexDeck();
}

/* Validation is not hand-written.
 *
 * The sides go through the same reader every course in this app goes through,
 * as a one-card document, and what comes back is both the verdict and the
 * diagnostics — message and correction — that the sheet puts in its status
 * line. web/lib/validate.js is a standing note about what happened the last
 * time a second hand-written validator existed in this repo. */
async function checkCard(input) {
  const front = cardTextFrom(input && input.front);
  const back = cardTextFrom(input && input.back);
  if (!front) return { ok: false, say: 'A card needs a question.', diagnostics: [] };
  const card = { cardId: 'card', front };
  if (back) card.back = back;
  const runtime = await courseRuntime();
  const result = await runtime.readCourseForRuntime({
    schemaVersion: 2, courseId: 'a-card-you-wrote', cards: [card],
  });
  const errors = result.diagnostics.filter((item) => item.severity === 'error');
  if (!result.course || errors.length) {
    const first = errors[0];
    return {
      ok: false,
      say: first ? `${first.message} ${first.correction}` : 'This card could not be read.',
      diagnostics: result.diagnostics,
    };
  }
  return { ok: true, front, back, diagnostics: result.diagnostics };
}

/** The section a new card goes in: the one asked for while it is still a
 *  section of this deck, and otherwise the deck's first. */
function sectionForInput(input) {
  const asked = input && typeof input.section === 'string' ? input.section : '';
  if (asked && sectionOf.has(asked)) return asked;
  return (DECK.sections[0] && DECK.sections[0].sectionId) || LOOSE_SECTION;
}

/** Every write ends here: store the document, rebuild the deck from it, redraw,
 *  and ask for the round trip that carries it to the other device.
 *
 * Redrawing after a refused write is not housekeeping — it is how an edit that
 * did not land leaves the screen, rather than sitting there looking saved.
 *
 * The sync is asked for here because nothing else asks. writeNow() schedules a
 * round after every write to the REVIEW document, and the cards are the other
 * document: a card fixed from Browse and then put down went nowhere until the
 * next grade, the next setting or the next session, which is not what "your
 * cards follow you between devices" says. The dock's Fix this card was covered
 * only by accident, because leaving a session writes review history. */
async function commitCards(id, say) {
  const wrote = writeCardLayer(true);
  await applyCardLayer();
  renderDeckChanged();
  // Never mid-session, for the reason writeNow() gives: adopting a merge would
  // swap the deck out from under the card on screen.
  if (wrote.ok && globalThis.DSSync && !session) DSSync.schedule(syncPayload);
  return { ok: wrote.ok, id, say: wrote.ok ? say : wrote.say, diagnostics: [] };
}

/** What a date buys you is not the same sentence about a syllabus as about a
 *  deck someone imported on the bus. Say the thing that is true of this deck —
 *  and re-say it, because the number moves the moment a card is written. */
function renderAskWhy() {
  const cram = $('#ask-why');
  if (!cram || !DECK) return;
  // And a deck of one card counts nothing at all: "how many of these 1 card a
  // day" is a sentence about a workload that does not exist yet. A deck you
  // wrote here starts at exactly one, so this is the state it opens in.
  cram.textContent = DECK.cards.length > 120
    // The deck's size is the line under the title and it is in the pacing note
    // below the button. Said a third time here it was an opener that pushed the
    // whole ask past the fold.
    ? 'A date sets your daily pace and stops scheduling past it.'
    : DECK.cards.length < 2
      ? 'A date paces the deck, however big it grows.'
      : `A date works out how many of these ${plural(DECK.cards.length, 'card')} a day you need.`;
}

/** The deck grew, shrank or changed a word. Everything counted off it moves.
 *
 * Home, Browse and Progress derive every number they print from DECK on each
 * draw — the counts, the pacing, the frieze, the forecast, the per-section
 * denominators the achievements are measured against — so re-drawing the screen
 * that is up is the whole of it. What does not is here: the search placeholder,
 * the exam pitch, the card on the study screen and the sheet itself. */
function renderDeckChanged() {
  if (!DECK) return;
  const search = $('#search');
  if (search) search.placeholder = `Search ${plural(DECK.cards.length, 'card')}…`;
  renderAskWhy();
  // Browse's index of section tiles is built once and kept, because it is
  // twenty-four buttons that only ever appear while nothing is narrowed. A card
  // written into a section moves the number printed on its tile, so the cached
  // copy has to go with it — otherwise the tile says 21 cards and opens on 22.
  const index = $('#browse-index');
  if (index) index.innerHTML = '';
  if (current === 'home') renderHome();
  if (current === 'browse') renderBrowse();
  if (current === 'stats') renderStats();
  renderStudyCardAgain();
  renderCardSheetIfOpen();
}

/** The card on screen is drawn out of DECK, and DECK has just been rebuilt.
 *
 * Before the answer is up, the whole card is re-drawn: it is the same card, so
 * showCard() is exactly right. After it, only the two sides are replaced —
 * showCard() would hide the answer somebody is in the middle of reading and
 * take the grade buttons away with it. */
function renderStudyCardAgain() {
  if (current !== 'study' || !session) return;
  const card = currentCard();
  if (!card) return;
  if (!session.revealed) { showCard(); return; }
  $('#card-q').innerHTML = card.front || '';
  hydrateMedia($('#card-q'));
  const answer = $('#card-a');
  if (hasBackContent(card) && typeof card.back === 'string') {
    answer.innerHTML = card.back;
    hydrateMedia(answer);
  } else {
    answer.replaceChildren();
  }
}

/* What a deck that syncs cannot take another word of.
 *
 * The ceilings above are counts, and they have to be: eviction has to be a
 * prefix of a total order or a three-device merge stops converging, which is
 * what sync.js says at length where they are defined. But a count cannot bound
 * bytes, and bytes are what the server measures — 200 records at their full
 * length describe four times the blob it will accept. syncOnce() refuses to
 * send one over the bound, which is right and is also far too late to find out:
 * the refusal lands on a screen nobody visits, it stops the review history
 * crossing along with the writing, and on the other device it names cards that
 * device cannot see. The bound is therefore asked here as well, where the card
 * is on the screen in front of somebody and shortening it is one edit.
 *
 * Only where this deck actually syncs. A deck that stays on this device has no
 * blob to overflow, and holding one to a server's limit would be a refusal with
 * nothing behind it. */
const OVER_BLOB = 'Your notes and cards in this deck are already as much as sync can carry, '
  + 'so this one would stop the whole deck reaching your other devices. Shorten it, or '
  + 'delete a note or a card you no longer need.';

function writingStillSyncs() {
  if (!globalThis.DSSync || !DSSync.blobBytes || !DSSync.status().on) return true;
  return DSSync.blobBytes(syncPayload()) <= DSSync.MAX_BYTES;
}

/** Write a card of your own into this deck. */
async function writeCard(input) {
  const checked = await checkCard(input);
  if (!checked.ok) return checked;
  if (liveWrittenCount() >= WRITTEN_LIVE) {
    return {
      ok: false,
      say: `This deck already holds ${WRITTEN_LIVE} notes and cards of your own. `
        + 'Delete one to write another.',
      diagnostics: [],
    };
  }
  const now = Date.now();
  const id = newCardId();
  cardLayer[id] = {
    at: now, ed: now, front: checked.front, back: checked.back, section: sectionForInput(input),
  };
  // Measured with the card in, because that is the blob that would be sent, and
  // taken straight back out if it would not go.
  if (!writingStillSyncs()) {
    delete cardLayer[id];
    return { ok: false, say: OVER_BLOB, diagnostics: [] };
  }
  return commitCards(id, 'Card written.');
}

/** Change a card: one of yours in place, or a course card as an override over
 *  the shipped one, which is why editing a course card is free to take back. */
async function editCard(cardId, input) {
  const record = cardRecord(cardId);
  const shipped = shippedById.get(cardId);
  const own = CARD_ID.test(cardId) && record && !!record.front;
  if (!own && !shipped) {
    return { ok: false, say: 'That card is not in this deck.', diagnostics: [] };
  }
  const checked = await checkCard(input);
  if (!checked.ok) return checked;
  if (!record && liveWrittenCount() >= WRITTEN_LIVE) {
    return {
      ok: false,
      say: `This deck already holds ${WRITTEN_LIVE} notes and cards of your own, and an `
        + 'edit is one of them. Take one back to make this one.',
      diagnostics: [],
    };
  }
  const now = Date.now();
  // Kept whole rather than field by field, so a refusal below puts back exactly
  // what was here — including a record that was not here at all.
  const before = record ? Object.assign({}, record) : null;
  if (own) {
    record.front = checked.front;
    record.back = checked.back;
    record.ed = now;
    if (input && typeof input.section === 'string') record.section = sectionForInput(input);
  } else {
    // `was` is stamped on every save, not only the first: it is the answer to
    // "is this still the card I edited?", and after this save it is.
    cardLayer[cardId] = {
      at: record && record.at ? record.at : now,
      ed: now,
      front: checked.front,
      back: checked.back,
      was: cardFingerprint(shipped),
    };
  }
  if (!writingStillSyncs()) {
    if (before) cardLayer[cardId] = before; else delete cardLayer[cardId];
    return { ok: false, say: OVER_BLOB, diagnostics: [] };
  }
  return commitCards(cardId, 'Card saved.');
}

/** Delete a card you wrote. Permanent, which is why the sheet asks first and
 *  says how many times it has been answered. */
async function deleteCard(cardId) {
  if (!CARD_ID.test(cardId)) {
    return {
      ok: false,
      say: 'The course ships this card, so it cannot be deleted. Hide it instead — '
        + 'hiding is free to undo.',
      diagnostics: [],
    };
  }
  const record = cardRecord(cardId);
  if (!record || !record.front) {
    return { ok: false, say: 'That card is not here any more.', diagnostics: [] };
  }
  // Emptied, not removed. The record is the evidence that the card was deleted
  // here; drop it and the next device that still has it hands it back.
  record.front = '';
  record.back = '';
  record.ed = Date.now();
  delete record.section;
  delete record.was;
  const done = await commitCards(cardId, 'Card deleted.');
  if (!done.ok) return done;
  // This device has now settled what this marker costs, which is what stops the
  // sweep saying another device did this. The server is still holding the review
  // record — mergeState takes the union of them and never removes one — so the
  // very next round hands it straight back, and the sweep that clears it again
  // would otherwise print "deleted on another device" to the person who pressed
  // the button, on the only device there is.
  settledDeletes.add(cardId);
  // The confirm names the answers that go with it; here is where they go. A
  // record left behind would be swept on the next device the marker reaches and
  // not on this one, which is two devices disagreeing about how much history a
  // deck holds — and it would be waiting to be adopted by a future card that
  // happened to take the same id.
  if (Object.hasOwn(state.recs, cardId)) {
    delete state.recs[cardId];
    // Now, not in 250ms. The two documents record one act between them, and a
    // tab that closed inside the debounce left the marker on disk with the
    // history still beside it — which the next boot reads as somebody else's
    // delete arriving.
    writeNow();
    renderDeckChanged();
  }
  return done;
}

/** Take a course card out of the deck. Reversible, because the shipped card is
 *  still shipped — this is a record saying you do not want it. */
async function hideCard(cardId) {
  if (CARD_ID.test(cardId)) return deleteCard(cardId);
  const shipped = shippedById.get(cardId);
  if (!shipped) return { ok: false, say: 'That card is not in this deck.', diagnostics: [] };
  const record = cardRecord(cardId);
  cardLayer[cardId] = {
    at: record && record.at ? record.at : Date.now(),
    ed: Date.now(),
    front: '',
    back: '',
    hidden: true,
  };
  return commitCards(cardId, 'Card hidden.');
}

/** Take your layer off a course card, whether it was an edit or a hide. */
async function revertCard(cardId) {
  if (CARD_ID.test(cardId)) {
    return {
      ok: false,
      say: 'You wrote this card, so there is no course card underneath it. '
        + 'Deleting it is how it goes.',
      diagnostics: [],
    };
  }
  if (!shippedById.has(cardId)) {
    return { ok: false, say: 'That card is not in this deck.', diagnostics: [] };
  }
  const record = cardRecord(cardId);
  if (!record) return { ok: true, id: cardId, say: '', diagnostics: [] };
  // An emptied record, not a removed one, for the same reason a deleted note is
  // emptied: a record that is simply gone is handed straight back by the next
  // device that still holds the edit.
  cardLayer[cardId] = { at: record.at || Date.now(), ed: Date.now(), front: '', back: '' };
  return commitCards(cardId, 'The card the course ships is back.');
}

/** Whether the deck's author has rewritten a card since you edited it.
 *
 * Without `was` there is no way to ask: your override would quietly pin you to
 * a card the author has since fixed, which is a bitter outcome for a feature
 * about fixing wrong cards. */
function authorRewroteCard(cardId) {
  const record = cardRecord(cardId);
  const shipped = shippedById.get(cardId);
  if (!record || !record.front || !record.was || !shipped) return false;
  return record.was !== cardFingerprint(shipped);
}

/** The card the course ships, whatever your layer says about it — for the
 *  "show the original" line, and for taking theirs over yours. */
function shippedCard(cardId) {
  return shippedById.get(cardId) || null;
}

/** Keep your version of a card the author has rewritten under you.
 *
 * Not an edit: not a word changes. What changes is the answer to "is this still
 * the card I edited?", which after this is yes — measured against the card as
 * the course ships it now, so the line offering the choice stops offering it.
 * The edit stamp moves with it, or a device that never saw the choice would win
 * the merge with the older record and put the question back. */
async function keepYourCard(cardId) {
  const record = cardRecord(cardId);
  const shipped = shippedById.get(cardId);
  if (!record || !record.front || !shipped) {
    return { ok: false, say: 'That card is not in this deck.', diagnostics: [] };
  }
  record.was = cardFingerprint(shipped);
  record.ed = Date.now();
  return commitCards(cardId, 'Yours stays.');
}

/** The course cards you have hidden, in the order the course ships them.
 *
 * Off the shipped deck rather than off the layer, because a hidden card is by
 * definition not in DECK.cards: hiding it is what took it out. */
function hiddenCards() {
  if (!shippedCourse) return [];
  return shippedCourse.cards.filter((card) => {
    const record = cardRecord(card.cardId);
    return !!(record && record.hidden);
  });
}

/** Review history for cards this deck does not have any more.
 *
 * DELETING IS ONLY EVER DONE FROM A LIST WE ACTUALLY HAVE, the rule sweepOrphans
 * states in munin.js, and this is the sharpest instance of it in the app: the
 * records are keyed by card id, so a boot where the cards document could not be
 * read — quota, corruption, a private window — would find every card somebody
 * wrote missing from byId and delete its history for ever, silently.
 *
 * A card you hid is not missing either. Its record is still here, so its
 * history stays, and un-hiding it is what the layer promises it is: free. That
 * is what the layer is asked, and all it is asked: a record for a card the
 * course has since dropped is not evidence the card exists, and holding the
 * history for it exempted the record from this sweep permanently.
 *
 * A card of your own that is in neither is a card the ceiling evicted — nothing
 * else can take one out of the layer without leaving a marker behind — so what
 * goes with it is counted, because a card leaving must never take its history
 * quietly. See sayWhatWentMissing(). */
function sweepUnknownRecords() {
  if (!cardLayerLoaded) return false;
  for (const id of Object.keys(state.recs)) {
    if (byId.has(id)) continue;
    const record = cardRecord(id);
    // A record about a card this deck knows about: a course card you hid, or
    // the marker a card of your own left behind when it was deleted, which the
    // sweep below this one is the only thing allowed to act on. A record about
    // a shipped card that is not shipped any more is neither.
    if (record && (CARD_ID.test(id) || shippedById.has(id))) continue;
    delete state.recs[id];
    if (CARD_ID.test(id)) historyEvicted++;
  }
  return true;
}

/** Review history for cards that were deleted somewhere else.
 *
 * A card you delete on your phone is a delete marker by the time it reaches
 * your laptop, and the card is then gone from both. The history of answering it
 * goes too — that is what the confirm on the phone said would happen — but it
 * must not go inside the merge. Records are keyed by card id, and the merge is
 * the one place that cannot tell "this card was deleted" from "the cards
 * document did not load" — the distinction sweepUnknownRecords() exists for. So
 * the merge never touches a record, and this does: local, bounded by the
 * records this deck actually holds, and counted so that the app can say it out
 * loud rather than let somebody find a number has fallen at the next boot.
 *
 * Only a card of your own, and only one whose record says deleted. A hidden
 * course card keeps its history, because un-hiding it is free and would be a
 * lie if the history had gone; a reverted override keeps it because the shipped
 * card is back and it is the same card.
 *
 * The sentence names another device, so it has to be true. A marker this device
 * has already settled its history against is not news: mergeState takes the
 * union of the records and never removes one, so the server's copy of a record
 * this device deleted comes straight back on the very next round — and told the
 * phone that had just asked the question that some other device had answered
 * it. Settling is what the first look at a marker does, whether or not there
 * was history under it, and deleteCard() settles its own on the way past. */
const settledDeletes = new Set();

function sweepDeletedCardHistory(handedBack) {
  if (!cardLayerLoaded) return 0;
  let gone = 0;
  for (const [id, record] of Object.entries(cardLayer)) {
    if (!CARD_ID.test(id) || record.front || record.hidden) continue;
    if (Object.hasOwn(state.recs, id)) {
      delete state.recs[id];
      // `handedBack` is a restore: somebody asked for this history back, so
      // what the markers take is a loss whether or not this device had already
      // settled the same card once. Everywhere else, a record that comes back
      // on its own is this device's own copy returning through the union, and
      // saying so again would be reporting one loss twice.
      if (handedBack || !settledDeletes.has(id)) gone++;
    }
    settledDeletes.add(id);
  }
  return gone;
}

// Cards whose review history a sweep took, unspoken. Counted rather than said
// on the spot for the same reason the drops are: the sweeps run on the boot
// path and in the middle of a sync round.
let historyDropped = 0;   // a card another device deleted
let historyEvicted = 0;   // a card of your own the shared ceiling could not keep
let historyPutBack = 0;   // history a restored file held for a card deleted here
// And the document itself refusing to open, which is not a loss but is the one
// state in which the cards are missing from every screen with nothing said.
let cardsUnreadable = false;
// And a write of it that storage refused, which is the same: the layer on the
// device is not what a merge just produced, and nothing else would say so.
let cardsNotWritten = '';

/* Everything a boot, a restore or a merge had to take, said once.
 *
 * Every place that holds this deck to WRITTEN_LIVE live records — the two
 * sanitisers here and the merge in sync.js — runs where there is nothing to say
 * it on: one before the app is drawn, the others several times inside a sync
 * round. They count instead, and this is the other half of that bargain and the
 * whole point of counting: a note and a card are the two things in these
 * documents nothing else can reproduce, so losing one silently is the failure
 * rather than the drop itself.
 *
 * One sentence, not three. Three calls in a row each wrote over the last on the
 * same element, and each counter is read and cleared where it is counted — so a
 * boot that dropped notes AND cards said only the cards, and the notes were
 * never mentioned on that boot or any boot after it.
 *
 * Sticky, because the sentence is the only record of any of this there will
 * ever be. Answers whether it spoke, because a caller with a cheerier line to
 * print has to know not to print it over the top. */
function sayWhatWentMissing() {
  const notes = notesDropped + ((globalThis.DSSync && DSSync.takeNoteDrops)
    ? DSSync.takeNoteDrops() : 0);
  const cards = cardsDropped + ((globalThis.DSSync && DSSync.takeCardDrops)
    ? DSSync.takeCardDrops() : 0);
  const evicted = historyEvicted;
  const deleted = historyDropped;
  const putBack = historyPutBack;
  const unreadable = cardsUnreadable;
  const refused = cardsNotWritten;
  notesDropped = 0;
  cardsDropped = 0;
  historyEvicted = 0;
  historyDropped = 0;
  historyPutBack = 0;
  cardsUnreadable = false;
  cardsNotWritten = '';

  const said = [];
  if (unreadable) {
    said.push('The cards you wrote into this deck could not be read, so they are not here. '
      + 'Nothing has been changed yet; writing or editing a card replaces what is stored.');
  }
  if (notes || cards) {
    const kinds = [];
    if (notes) kinds.push(plural(notes, 'note'));
    if (cards) kinds.push(plural(cards, 'card'));
    said.push(`This deck keeps ${WRITTEN_LIVE} notes and cards of your own together at most, `
      + `so ${listWords(kinds)} — the ones untouched for longest — could not be kept.`);
    // The ceiling exists to protect the review history beside it, so a ceiling
    // that took some of that history is the one thing it must not do quietly.
    if (evicted) {
      said.push(evicted === 1
        ? 'What you had answered of that card went with it.'
        : `What you had answered of ${evicted} of them went with them.`);
    }
  } else if (evicted) {
    // Nothing was dropped on this pass, so the eviction was an earlier one this
    // device is only now finding the loose history from.
    said.push(evicted === 1
      ? 'A card of your own this deck could not keep is gone, and its history went with it.'
      : `${evicted} cards of your own this deck could not keep are gone, and their history `
        + 'went with them.');
  }
  if (deleted) {
    said.push(deleted === 1
      ? 'A card you had answered was deleted on another device, so its history went with it.'
      : `${deleted} cards you had answered were deleted on another device, so their history `
        + 'went with them.');
  }
  // Not the same sentence: this device is where the deleting happened, and the
  // file is what tried to put the answering back.
  if (putBack) {
    said.push(putBack === 1
      ? 'A card in that backup is deleted on this device, so what you had answered of it '
        + 'did not come back.'
      : `${putBack} cards in that backup are deleted on this device, so what you had `
        + 'answered of them did not come back.');
  }
  // Last, and in the words the write itself produced: everything above is about
  // what a document lost, and this is about a document that is not there.
  if (refused) said.push(refused);
  if (!said.length) return false;
  toast(said.join(' '), true);
  return true;
}

/* ── the card sheet ── */

/* Two boxes, and a select only where the deck has more than one section.
 *
 * There is no preview and no mode switch, because the preview is the card. What
 * the small Markdown subset does is one muted line under the boxes, and what it
 * refuses is said after Save in the sheet's own status line, in the words the
 * parser already produced — the same diagnostics the importer prints, from the
 * same reader, because the validation here is a round trip through it rather
 * than a second opinion about what a card is.
 *
 * The modal contract is the notes panel's, cloned: markup outside #app, a
 * pushed history entry so Android Back closes one level, the background inert,
 * Tab contained, Escape, focus back to whatever opened it, and a re-render hook
 * for the moment another tab changes the deck underneath.
 */

/** One side of a card as Markdown that would produce it again.
 *
 * A card you have edited is stored as the Markdown you typed, so this is only
 * ever asked about a card nobody has touched: what the course shipped, as
 * sanitized HTML, with no Markdown behind it to hand back.
 *
 * Only the constructs the subset can write are converted. EVERYTHING ELSE IS
 * NAMED IN `lost` RATHER THAN DROPPED QUIETLY — an imported card carries its
 * picture as an <img> inside its own HTML, and a converter that stepped over
 * one would delete somebody's picture the moment they fixed a typo under it.
 * The sheet says so before the first such edit; see cardLostSay(). */
function cardSourceText(value) {
  // The characters that would otherwise come back as formatting. A word in
  // *asterisks* on a shipped card is a word in asterisks, not emphasis, and it
  // has to still be one after a round trip through this box.
  return String(value).replace(/[\\`*_[\]]/g, (ch) => '\\' + ch);
}

/** The same job for the markers that only mean something at the start of a
 *  line, applied to a line once there is one.
 *
 * Nothing inside a text node can see where a line begins, so the inline pass
 * above cannot do this: a card whose question is "3. Rule three of the
 * collision regulations" came back into the box unchanged, and Save — with not
 * a word altered — stored an ordered list, which the renderer draws as "1.".
 * "- 5 degrees of variation" lost its minus sign the same way, which on a
 * navigation deck is a wrong answer produced by saving a card nobody edited.
 * The ones the subset has no construct for are worse than wrong: "# of crew
 * aboard the yacht" was refused outright, with a message about Markdown to
 * somebody who has never typed any.
 *
 * Escaping the one character that starts the construct is enough to stop all of
 * them, and a backslash in the box is what this file already does to *, _ and
 * the rest. */
function cardSourceLine(line) {
  return line
    .replace(/^(\s*)(\d{1,9})([.)])/, '$1$2\\$3')
    .replace(/^(\s*)([-+>#])/, '$1\\$2');
}

/** A run of prose, line by line: a hard break inside one starts a new line, and
 *  a list marker after that break is a list just the same. */
const cardSourceBlock = (text) => text.split('\n').map(cardSourceLine).join('\n');

function htmlToCardSource(html) {
  const lost = new Set();
  const host = document.createElement('template');
  host.innerHTML = String(html == null ? '' : html);

  const inline = (node) => {
    let text = '';
    for (const child of node.childNodes) text += inlineOne(child);
    return text;
  };

  function inlineOne(child) {
    if (child.nodeType === 3) return cardSourceText(child.nodeValue);
    if (child.nodeType !== 1) return '';
    const tag = child.tagName.toLowerCase();
    // Two trailing spaces, which is a hard break. A bare newline is a soft one
    // and comes back out of the renderer as a space, so the line the author
    // broke would silently join up again.
    if (tag === 'br') return '  \n';
    if (tag === 'em' || tag === 'i') return '*' + inline(child) + '*';
    if (tag === 'strong' || tag === 'b') return '**' + inline(child) + '**';
    if (tag === 'a') {
      const href = child.getAttribute('href') || '';
      const label = inline(child);
      if (/^(https|mailto):/i.test(href)) {
        return label && label !== href ? `[${label}](${href})` : `<${href}>`;
      }
      // A destination the subset will not take. The words stay; the link does
      // not, and that is a loss worth naming.
      lost.add('link');
      return label;
    }
    if (tag === 'img' || tag === 'audio' || tag === 'video' || tag === 'source') {
      lost.add('media');
      return '';
    }
    // A <span> carries no shape of its own once the sanitiser has been over it,
    // so passing straight through one is not a loss — and calling it one would
    // put the warning over most of an imported deck.
    if (tag !== 'span') lost.add(tag);
    return inline(child);
  }

  /* Runs of inline content become one line; a block element ends the run it was
   * standing after. Without the run, `Word <b>bold</b> more` — an Anki card that
   * was never wrapped in a paragraph — came back as three paragraphs. */
  const out = [];
  let run = '';
  const flush = () => {
    const text = run.trim();
    if (text) out.push(cardSourceBlock(text));
    run = '';
  };
  for (const child of host.content.childNodes) {
    const tag = child.nodeType === 1 ? child.tagName.toLowerCase() : '';
    // A <div> is a paragraph here, not a loss. It is the wrapper every second
    // Anki card is built out of, and calling it lost would put the "this will be
    // simplified" warning over almost every imported card in the deck.
    if (tag === 'p' || tag === 'div') {
      flush();
      const text = inline(child).trim();
      if (text) out.push(cardSourceBlock(text));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      flush();
      const items = [];
      for (const li of child.children) {
        if (li.tagName.toLowerCase() !== 'li') { lost.add(li.tagName.toLowerCase()); continue; }
        // One line per item: a break inside one would end the list. The marker
        // this file writes goes on after the escaping, or it would escape it.
        const text = cardSourceLine(inline(li).trim().replace(/\s*\n\s*/g, ' '));
        if (text) items.push((tag === 'ul' ? '- ' : `${items.length + 1}. `) + text);
      }
      if (items.length) out.push(items.join('\n'));
      continue;
    }
    run += inlineOne(child);
  }
  flush();
  return { text: out.join('\n\n'), lost: [...lost] };
}

/** What the boxes could not hold, said before the first edit rather than found
 *  out from the result. */
function cardLostSay(lost) {
  if (!lost.length) return '';
  if (lost.includes('media')) {
    return 'This card keeps a picture inside its words, and these boxes hold text. '
      + 'Save and your words replace the card, without it.';
  }
  return 'Part of this card is written in markup these boxes cannot write, '
    + 'so saving simplifies that part.';
}

/* The sheet's own state: which card it is on, what opened it, and what the
 * first fill could not carry. Null while it is closed. */
let cardSheet = null;

function cardSays(line) {
  const el = $('#card-say');
  if (el) el.textContent = line || '';
}

function clearCardInvalid() {
  for (const field of [$('#card-front'), $('#card-back')]) {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  }
}

/** Which of the two boxes a diagnostic is about. */
function cardDiagnosticSide(item) {
  return /\.back\b/.test(String((item && item.path) || '')) ? 'Answer' : 'Question';
}

const cardErrors = (list) => (Array.isArray(list) ? list : [])
  .filter((item) => item && item.severity === 'error');

function markCardInvalid(result) {
  const sides = new Set(cardErrors(result && result.diagnostics).map(cardDiagnosticSide));
  if (!sides.size) sides.add('Question');
  const fields = [];
  if (sides.has('Question')) fields.push($('#card-front'));
  if (sides.has('Answer')) fields.push($('#card-back'));
  for (const field of fields) {
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', 'card-say');
  }
  if (fields[0]) fields[0].focus({ preventScroll: true });
}

/** The status line, in the parser's own message and correction — with the box
 *  named, which is the one thing the parser cannot know to say. */
function cardSayFor(result) {
  const errors = cardErrors(result && result.diagnostics);
  if (errors.length !== 1 || !result.say) return (result && result.say) || '';
  return `${cardDiagnosticSide(errors[0])} — ${result.say}`;
}

/** The rest of the diagnostics, in the shape the importer prints them.
 *
 * Only from the second one: a single error is already the whole of the status
 * line above, and printing it twice under itself is the sheet shouting. Where
 * there are several, each needs its own box, its own place in the text and its
 * own correction, and the status line has room for exactly one of them. */
function cardDiagnostics(list) {
  const host = $('#card-diags');
  if (!host) return;
  const errors = cardErrors(list).slice(0, 8);
  host.hidden = errors.length < 2;
  host.innerHTML = host.hidden ? '' : errors.map((item) => `<li>
      <code>${escapeHtml(item.code || 'error')}</code>
      <span>${escapeHtml(cardDiagnosticSide(item))} — ${escapeHtml(item.message || '')}</span>
      ${item.line ? `<small>line ${n(item.line)}, column ${n(item.column)}</small>` : ''}
      <small>${escapeHtml(item.correction || '')}</small></li>`).join('');
}

/** Whether this card is in the session that is open, which is the one thing
 *  that makes removing it unsafe: the queue holds ids, and an id that no longer
 *  resolves through byId ends the session at the moment it comes up. */
function cardInOpenSession(cardId) {
  return !!(session && session.queue.includes(cardId));
}

/** Why this card cannot leave the deck, or what it will cost if it does.
 *
 * Both structural cases are hard errors in the course reader — a course holds
 * at least one card, a declared section at least one — so they are refused here
 * rather than discovered as a deck that will not open next time. */
function cardRemovalCost(cardId) {
  if (cardInOpenSession(cardId)) {
    return { refuse: 'This card is in the session you have open. End the session first.' };
  }
  if (DECK.cards.length <= 1) {
    return {
      refuse: 'This is the only card in this deck. A deck needs at least one, so remove '
        + 'the whole deck from the courses screen instead.',
    };
  }
  const card = byId.get(cardId);
  const section = card && sectionOf.get(card.sectionId);
  if (section && section.cardCount <= 1) {
    return { warn: `This is the last card in ${section.title}, so the section goes with it.` };
  }
  return {};
}

/** The card the sheet is on, whichever half of the deck it came from. */
function sheetCard() {
  if (!cardSheet || !cardSheet.cardId) return null;
  return byId.get(cardSheet.cardId) || shippedCard(cardSheet.cardId);
}

/** Everything about the sheet that is read off state rather than typed into it.
 *
 * Never the two textareas. This also runs when another tab writes the layer
 * underneath, and taking somebody's half-written question away to replace it
 * with the stored one is the worst thing this function could do. */
function renderCardSheet() {
  if (!cardSheet) return;
  const editing = !!cardSheet.cardId;
  const yours = editing && CARD_ID.test(cardSheet.cardId);
  const record = editing ? cardRecord(cardSheet.cardId) : null;
  const gone = editing && !sheetCard();
  $('#card-sheet-h').textContent = editing ? 'Edit card' : 'New card';
  // One verb for one action. The trigger, the title and this button used to be
  // three names for the same object — you tapped "fix card", landed on "edit
  // card" and were offered "save card" — and a beat went on checking you had
  // pressed the right thing. New card / edit card, saved either way.
  $('#card-save').textContent = 'Save card';
  $('#card-save').disabled = gone;

  // The select is the deck's, and only where the deck has more than one section
  // to choose between. Never for a course card: an override replaces the words
  // on a shipped card and the shipped card is what says where it lives.
  const where = $('#card-where');
  const select = $('#card-section');
  const offer = DECK.sections.length > 1 && (!editing || yours);
  where.hidden = !offer;
  if (offer) {
    // The card's live section, not the one its record names: a card whose
    // section the course has since dropped is in the synthetic one, and that is
    // where it still is until somebody moves it.
    const live = editing ? byId.get(cardSheet.cardId) : null;
    const keep = select.value || (live && live.sectionId) || (record && record.section) || '';
    select.innerHTML = DECK.sections.map((section) =>
      `<option value="${escapeHtml(section.sectionId)}">${escapeHtml(section.title)}</option>`).join('');
    if (keep && sectionOf.has(keep)) select.value = keep;
    else select.value = sectionForInput({ section: cardSheet.section });
  }

  const warn = $('#card-warn');
  const say = gone
    ? 'This card is not in this deck any more. Another tab may have removed it.'
    : cardLostSay(cardSheet.lost || []);
  warn.hidden = !say;
  warn.textContent = say;

  const more = $('#card-more');
  if (!editing || gone) {
    more.hidden = true;
    more.innerHTML = '';
    return;
  }
  const takeAway = yours
    ? '<button class="link-btn danger-link" type="button" data-card-delete>Delete this card</button>'
    : '<button class="link-btn danger-link" type="button" data-card-hide>Hide this card</button>';
  // Only where there is a layer over a shipped card to take off. A card you
  // wrote has no course card underneath it, which is why deleting is the only
  // way it goes and why deleting is the one thing here behind a confirm.
  const revert = !yours && record && (record.front || record.hidden)
    ? '<button class="link-btn" type="button" data-card-revert>Show the original</button>'
    : '';
  more.innerHTML = takeAway + revert;
  more.hidden = false;
}

/** Re-draw the sheet when the deck under it was rebuilt by another tab or by a
 *  merge, rather than leaving controls for a card that is no longer there. */
function renderCardSheetIfOpen() {
  if (cardSheet) renderCardSheet();
}

function openCardSheet(opts) {
  const panel = $('#card-sheet');
  if (!panel.hidden) return;
  const options = opts || {};
  const cardId = typeof options.cardId === 'string' ? options.cardId : '';
  cardSheet = {
    cardId,
    section: typeof options.section === 'string' ? options.section : '',
    opener: options.opener || null,
    lost: [],
  };
  const record = cardId ? cardRecord(cardId) : null;
  const shipped = cardId ? shippedCard(cardId) : null;
  let front = '', back = '';
  if (record && record.front) {
    // Already yours: the Markdown you typed is what is stored, so it comes back
    // exactly as you left it.
    front = record.front;
    back = record.back || '';
  } else if (shipped) {
    // Nobody has touched this one, so there is no Markdown behind it. What
    // comes back is written from the shipped HTML, and what could not be
    // written is named on the way through.
    const q = htmlToCardSource(shipped.front);
    const a = htmlToCardSource(shipped.back);
    front = q.text;
    back = a.text;
    cardSheet.lost = [...new Set(q.lost.concat(a.lost))];
  }
  $('#card-front').value = front;
  $('#card-back').value = back;
  clearCardInvalid();
  $('#card-section').value = '';
  cardSays('');
  cardDiagnostics([]);
  renderCardSheet();
  panel.hidden = false;
  document.body.style.overflow = 'hidden';
  // The same containment the notes panel uses, for the same reason: aria-modal
  // says the rest of the page is not there, and only inert makes that true for
  // the Tab key. The sheet is a sibling of #app so it is not inerting itself.
  setBackgroundInert(true);
  $('#card-front').focus({ preventScroll: true });
  pushStop('card-sheet');
}

function closeCardSheet(fromHistory) {
  const panel = $('#card-sheet');
  if (panel.hidden) return;
  const opener = cardSheet && cardSheet.opener;
  panel.hidden = true;
  document.body.style.overflow = '';
  setBackgroundInert(false);
  cardSheet = null;
  $('#card-front').value = '';
  $('#card-back').value = '';
  clearCardInvalid();
  cardSays('');
  cardDiagnostics([]);
  // The control that opened this is often a button on a row the save has just
  // rebuilt or taken away. Focus would then drop to <body>, which is the far end
  // of the document from the list somebody is reading, so the screen's own
  // heading is the floor — the same place arriving by Tab lands.
  if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
  else focusScreen(current);
  if (!fromHistory && stops[stops.length - 1] === 'card-sheet') history.back();
}

/** Save, through the same reader every course in this app goes through.
 *
 * A new card leaves the sheet open with the boxes cleared, the way the notes
 * panel does: writing one card is usually writing three. An edit closes,
 * because you came here to fix the card you were looking at. */
let cardSaving = false;
async function saveCardSheet() {
  if (!cardSheet) return { ok: false };
  const button = $('#card-save');
  if (button.disabled || cardSaving) return { ok: false };
  const input = {
    front: $('#card-front').value,
    back: $('#card-back').value,
    section: $('#card-where').hidden ? '' : $('#card-section').value,
  };
  const editing = cardSheet.cardId;
  cardSaving = true;
  button.setAttribute('aria-disabled', 'true');
  clearCardInvalid();
  let result;
  try {
    result = editing ? await editCard(editing, input) : await writeCard(input);
  } catch (e) {
    console.error(e);
    result = { ok: false, say: 'This card could not be read.', diagnostics: [] };
  }
  // The sheet may have been closed while the reader was working, which is one
  // dynamic import and a parse away from instant on a cold cache.
  cardSaving = false;
  button.removeAttribute('aria-disabled');
  if (!cardSheet) return result;
  cardDiagnostics(result.diagnostics);
  cardSays(cardSayFor(result));
  if (!result.ok) {
    markCardInvalid(result);
    return result;
  }
  if (editing) {
    closeCardSheet(false);
    // Returning to the edit button made the advertised Space/Enter study
    // shortcut immediately activate that button and reopen this sheet. After a
    // successful in-session edit, return to the card content instead.
    if (current === 'study') $('#card-scroll').focus({ preventScroll: true });
    toast(result.say);
    return result;
  }
  $('#card-front').value = '';
  $('#card-back').value = '';
  renderCardSheet();
  $('#card-front').focus({ preventScroll: true });
  return result;
}

/** Take this card out of the deck: a delete for one of yours, a hide for one
 *  the course ships. Both go through the same refusals, and only the permanent
 *  one asks first. */
async function removeCardFromSheet() {
  if (!cardSheet || !cardSheet.cardId) return { ok: false };
  const cardId = cardSheet.cardId;
  const yours = CARD_ID.test(cardId);
  const cost = cardRemovalCost(cardId);
  if (cost.refuse) {
    cardSays(cost.refuse);
    return { ok: false, say: cost.refuse };
  }
  if (yours) {
    // Asked for, like every other permanent thing in this app, and the question
    // carries the number that makes it a decision: the review history goes too,
    // and nothing anywhere can put it back.
    const answered = n(state.recs[cardId] && state.recs[cardId].rp);
    const history = answered
      ? ` You have answered it ${plural(answered, 'time')}, and that history goes with it.`
      : '';
    const also = cost.warn ? `\n\n${cost.warn}` : '';
    if (!confirm(`Delete this card?\n\nThere is no undo.${history}${also}`)) {
      return { ok: false, say: '' };
    }
  } else if (cost.warn && !confirm(`Hide this card?\n\n${cost.warn}`)) {
    return { ok: false, say: '' };
  }
  const result = yours ? await deleteCard(cardId) : await hideCard(cardId);
  if (!result.ok) {
    cardSays(result.say);
    return result;
  }
  closeCardSheet(false);
  toast(yours ? result.say
    : 'Card hidden. Browse offers it back under the cards you hid.');
  return result;
}

/** Drop your layer off a course card. Free, and permanent for the words you
 *  wrote — which is the one thing worth asking about. */
async function revertCardFrom(cardId) {
  const record = cardRecord(cardId);
  if (record && record.front
      && !confirm('Show the original card?\n\nYour version of it goes, and there is no undo.')) {
    return { ok: false, say: '' };
  }
  const result = await revertCard(cardId);
  if (!result.ok) {
    if (cardSheet) cardSays(result.say);
    else toast(result.say);
    return result;
  }
  if (cardSheet) closeCardSheet(false);
  toast(result.say || 'The card the course ships is back.');
  return result;
}

/* ── study ── */

function startSession(sectionKey, opts) {
  if (!claimStudyLock()) {
    toast('Another tab is already studying this deck. Finish there before starting here.');
    return;
  }
  rollDay();
  session = buildSession(sectionKey, opts);
  undoStack = [];
  let extra = false;
  if (!session.queue.length) {
    // A section with nothing due: offer its unseen cards anyway, but say so —
    // otherwise the home screen reads "0 new today" and tapping a section
    // silently hands over twenty more, which looks like one of them is lying.
    const c = counts(sectionKey);
    // Unseen cards are only the answer while the reader is still taking new
    // ones: at zero a day, handing over twenty is the setting being overruled.
    session = buildSession(sectionKey,
      c.fresh > 0 && newBudget() > 0 ? { allNew: true } : { ahead: true });
    extra = session.queue.length > 0;
  }
  if (!session.queue.length) {
    releaseStudyLock();
    session = null;
    clearStudySession();
    toast(sectionKey ? 'Nothing to study in that section yet.' : 'Nothing to study right now.');
    return;
  }
  const startingClub = clubFacts();
  const startingContext = AchievementEngine.contextFromDeck({
    at: Date.now(),
    state,
    deck: DECK,
    course: COURSE,
    session,
  });
  session.initialBestClean = startingClub.personalBest;
  session.previousClubLastDay = startingClub.lastDay;
  session.initialKeptSections = startingContext.keptSectionKeys.slice();
  // Two different things get called extra here, and only one of them counts:
  // unseen cards are the deck being introduced early, cards pulled forward from
  // a later day are practice. Said before the first question rather than found
  // out afterwards from a due date that did not move.
  if (session.ahead) toast('Practice: these are not due yet, so nothing you press moves them.');
  else if (extra) toast('These are extra cards, on top of today’s plan.');
  settleDock(false);
  go('study');
  // "Keep going" from the summary starts a new session inside the same visit;
  // pushing a second stop would make leaving take two Back presses.
  if (stops[stops.length - 1] !== 'study') pushStop('study');
  showCard();
}

function leaveStudy(fromHistory) {
  $$('#done-reel video, #card-video video').forEach((v) => v.pause());
  flushAndReleaseStudyLock();
  clearStudySession();
  session = null;
  if (globalThis.DSSync) DSSync.schedule(syncPayload);
  if (current !== 'home') go('home');
  $('#study-all').focus({ preventScroll: true });
  if (!fromHistory && stops[stops.length - 1] === 'study') history.back();
  // A session started from Browse has that tab's stop underneath it, and the
  // screen it stands for is not on the screen any more. Home is the floor, so
  // it goes too: left there, the next Back press pops a tab nobody is looking
  // at and reads as a press the app swallowed.
  else if (fromHistory && stops[stops.length - 1] === 'tab') history.back();
}

function currentCard() {
  return session && session.queue.length ? byId.get(session.queue[0]) : null;
}

function showCard() {
  const card = currentCard();
  if (!card) return finish();
  const backed = hasBackContent(card);
  session.revealed = !backed;

  const sect = sectionOf.get(card.sectionId);
  $('#study-section').textContent = sect ? sect.title : card.sectionId;
  $('#study-left').textContent = `${session.done} done · ${session.queue.length} left`;
  const pct = session.total ? Math.round((session.done / (session.done + session.queue.length)) * 100) : 0;
  $('#session-bar').style.width = pct + '%';
  $('#session-bar-wrap').setAttribute('aria-valuenow', String(pct));

  // Only "new" earns a badge. "Young" versus "mature" is the scheduler's
  // business and reads as a difficulty rating the author set.
  const fresh = stateOf(card.cardId) === 'new';
  $('#card-chip').hidden = !fresh;
  $('#card-chip').textContent = 'new';
  const rec = state.recs[card.cardId];
  $('#leech-chip').hidden = !(rec && rec.lp >= LEECH_AT);

  // Card HTML is generated by the course build through content/mdc.py, which
  // allows b/i/u/br/sub/sup, lists, and safe links — nothing else.
  $('#card-q').innerHTML = card.front || '';
  hydrateMedia($('#card-q'));
  renderDescriptiveMediaInto($('#card-front-media'), card, 'front');

  const answer = $('#card-a');
  if (backed && typeof card.back === 'string') {
    answer.innerHTML = card.back;
    hydrateMedia(answer, false);
  } else {
    answer.replaceChildren();
  }
  const backMedia = $('#card-back-media');
  renderDescriptiveMediaInto(backMedia, card, 'back', false);

  renderCardFigure(card);

  const fig = $('#card-fig');
  const image = backImage(card);
  if (image) {
    const img = $('#card-img');
    if (image.width && image.height) {
      img.width = image.width;
      img.height = image.height;
    } else {
      img.removeAttribute('width');
      img.removeAttribute('height');
    }
    img.alt = `Diagram: ${stripTags(card.front)}`;
    // Offline with an uncached diagram, this used to be a broken-image icon
    // under a caption inviting you to tap it, and the lightbox opened empty.
    img.onerror = () => {
      fig.hidden = true;
      $('#fig-missing').hidden = false;
    };
    img.onload = () => { $('#fig-missing').hidden = true; };
    img.src = courseMediaUrl(image);
    $('#fig-btn').setAttribute('aria-label', `Enlarge the diagram: ${stripTags(card.front)}`);
    fig.hidden = false;
    $('#fig-missing').hidden = true;
  } else {
    fig.hidden = true;
    $('#fig-missing').hidden = true;
    $('#card-img').removeAttribute('src');
  }

  $('#answer-wrap').hidden = true;
  // A player left running would keep talking over the next question.
  $$('#card-video video').forEach((v) => v.pause());
  $('#card-video').hidden = true;
  $('#card-video').innerHTML = '';
  $('#reveal-btn').hidden = !backed;
  $('#grade-row').hidden = backed;
  $('#grade-ask').classList.add('away');
  $('#card-scroll').classList.remove('shown');
  $('#undo-btn').disabled = undoStack.length === 0;
  $('#card-scroll').scrollTop = 0;
  // Deal the new card in. Same element every time, so the animation only
  // replays if the class is dropped and the layout is flushed in between.
  const qa = $('.qa');
  qa.classList.remove('in');
  void qa.offsetWidth;
  qa.classList.add('in');
  if (backed) {
    $('#keyhint').textContent = 'Space/Enter reveals · 1–4 grades · U undoes';
    $('#reveal-btn').focus({ preventScroll: true });
  } else {
    prepareGradeControls(card);
    $('#grade-ask').textContent = session.ahead
      ? 'No answer to reveal. Rate your confidence; practice does not move the schedule.'
      : 'No answer to reveal. Rate your confidence with Again, Hard, Good, or Easy; keys 1–4 also grade.';
    $('#grade-ask').classList.remove('away');
    $('#keyhint').textContent = 'Space/Enter grades Good · 1–4 grades · U undoes';
    $('.grade[data-g="3"]').focus({ preventScroll: true });
  }
  persistStudySession();
  // On a short landscape phone the header and dock can leave only a sliver of
  // card space. Start that space on the question, not on a clipped "new" chip.
  requestAnimationFrame(() => {
    if (!session || current !== 'study') return;
    const sc = $('#card-scroll');
    const box = sc.getBoundingClientRect();
    const q = $('#card-q').getBoundingClientRect();
    const visible = Math.max(0,
      Math.min(box.bottom, q.bottom) - Math.max(box.top, q.top));
    if (visible < Math.min(28, q.height)) sc.scrollTop += q.top - box.top;
  });
}

/** Bring the answer on screen, which revealing it used to leave to luck.
 *
 * Nothing scrolled: on a phone held sideways not one pixel of the answer was
 * visible after "show answer", and on a long card — the ordinary shape of an
 * imported note — it was the whole answer, at every size. Scrolled by the
 * smaller of the two moves that would do it, so a short answer sitting just
 * under its question rises only as far as it has to and keeps the question in
 * view, while a long one comes up to the top of the card region. */
function showAnswerRegion() {
  const sc = $('#card-scroll');
  const box = sc.getBoundingClientRect();
  const ans = $('#answer-wrap').getBoundingClientRect();
  const move = Math.min(ans.top - box.top, ans.bottom - box.bottom);
  if (move > 0) sc.scrollTop += move;
}

/* The reveal button and the four grades are the same rectangle in the dock, one
 * after the other, and the second tap of a double-tap landed on whatever had
 * replaced what was tapped: tap-tap on "show answer" graded the card *good*
 * with the answer never read, and tap-tap on a grade opened the next card's
 * answer before its question had been. Whatever arrives in that rectangle is
 * deaf for a beat. Pointers only — 1-4, Space and Enter are different keys in
 * different places and cannot be pressed by mistake for one another. */
const DOCK_SETTLE = 450;
let settleTimer = null;
/** Deaf for a beat — or, with `false`, plainly awake. A session opening is not
 *  a transition inside the dock, and a beat left running by the last card it
 *  showed must not eat the first tap of the new one. */
function settleDock(on) {
  const d = $('#dock');
  clearTimeout(settleTimer);
  if (on === false) { d.classList.remove('settling'); return; }
  d.classList.add('settling');
  settleTimer = setTimeout(() => d.classList.remove('settling'), DOCK_SETTLE);
}

function prepareGradeControls(card) {
  const rec = state.recs[card.cardId];
  session.ivls = {};
  for (let g = 1; g <= 4; g++) {
    const d = scheduled(rec, g);
    session.ivls[g] = d;
    // "(max)" explains why two buttons can show the same number: the exam date
    // is holding both down, not a bug.
    const capped = d > 0 && d === ceiling() && daysToExam() !== null;
    const label = d === 0 ? 'soon' : fmtDays(d) + (capped ? ' max' : '');
    // Practising promises nothing, so it prints nothing: these dates are the
    // ones the card would get on a day it was actually due, and it is not.
    $('#iv' + g).textContent = session.ahead ? '' : label;
    const btn = $(`.grade[data-g="${g}"]`);
    btn.setAttribute('aria-label', session.ahead
      ? `${['', 'Again', 'Hard', 'Good', 'Easy'][g]} — practice, so this does not change when the card comes back`
      : `${['', 'Again', 'Hard', 'Good', 'Easy'][g]} — see it again ${d === 0 ? 'later in this session' : 'in ' + label}`);
  }
}

function reveal() {
  if (!session || session.revealed) return;
  const card = currentCard();
  if (!card) return;
  if (!hasBackContent(card)) return;
  session.revealed = true;
  $('#answer-wrap').hidden = false;
  $('#reveal-btn').hidden = true;
  $('#grade-row').hidden = false;
  $('#grade-ask').classList.remove('away');
  $('#card-scroll').classList.add('shown');
  if (typeof card.back === 'string') hydrateMedia($('#card-a'));
  hydrateDescriptiveMedia($('#card-back-media'));
  renderCardVideo(card);
  // The drawing is set going here rather than in renderCardFigure, because the
  // figure lives inside #answer-wrap and that is hidden until this moment: an
  // element nobody is rendering cannot be measured and does not animate. It is
  // also simply the better place — the drawing draws itself as the answer
  // arrives, which is when you are looking at it.
  drawFigureOn($('#figure-plate'));
  showAnswerRegion();
  // The reveal button was the focused element and has just been hidden, which
  // drops focus to <body>. Put it on the answer so it is read out and so Tab
  // continues from the right place.
  const answerFocus = typeof card.back === 'string' && card.back.trim()
    ? $('#card-a')
    : $('#answer-wrap').querySelector(
      'button:not([hidden]), audio[controls], video[controls], [tabindex]:not([tabindex="-1"])',
    ) || $('#card-a');
  if (answerFocus) answerFocus.focus({ preventScroll: true });
  // One line, both ways round: a practice session and an ordinary one can
  // follow each other inside a single visit, and this is static markup.
  $('#grade-ask').textContent = session.ahead
    ? 'Practice — the schedule does not move' : 'Did you get it right?';
  // Rolled once, here: these are the intervals the buttons promise *and* the
  // ones the card gets, so answer() hands the pressed one back to grade().
  prepareGradeControls(card);
  settleDock();
  persistStudySession();
}

function answer(g) {
  if (!session || !session.revealed) return;
  if (saveBlocked) {
    toast('Progress is not saving — export a backup from Settings before answering more.', true);
    return;
  }
  if (!ownsStudyLock()) {
    loseStudyLock();
    return;
  }
  touchStudyLock();
  // A session can stay open across midnight. Daily counters and the streak
  // must roll before this answer is snapshotted and attributed.
  rollDay();
  const id = session.queue[0];
  if (!id) return;
  undoStack.push({
    // What a grade touches, and nothing else. This used to be
    // JSON.stringify(state) — every record in the deck, serialised on the tap
    // that grades a card and kept twenty-five deep: 2 MB and 13 ms a time on an
    // imported 20,000-card deck, on the app's most-used interaction.
    id,
    rec: state.recs[id] ? Object.assign({}, state.recs[id]) : null,
    st: {
      newDone: state.newDone, revDone: state.revDone,
      revTotal: state.revTotal, revGood: state.revGood,
      answers: state.answers, bestClean: state.bestClean,
      streak: state.streak, lastDay: state.lastDay,
      // Copies, not references: noteAnswered() writes into both, and the day
      // history is pruned in place once it is long enough.
      days: Object.assign({}, state.days),
      ach: Object.assign({}, state.ach),
    },
    queue: session.queue.slice(),
    s: {
      done: session.done, again: session.again, good: session.good,
      clean: session.clean, maxClean: session.maxClean,
      sectionKeys: session.sectionKeys.slice(),
      newAchievements: session.newAchievements.slice(),
      missed: session.missed.slice(),
      reel: session.reel.slice(),
      reelCards: session.reelCards.slice(),
    },
  });
  if (undoStack.length > 25) undoStack.shift();

  // Again and Hard are the app's own evidence of what you have not learned —
  // exactly the cards worth two minutes of video at the end.
  if (g <= 2) {
    if (!session.reelCards.includes(id)) session.reelCards.push(id);
    addReelClips(id);
  }
  const outcome = grade(id, g, session.ivls && session.ivls[g], session.ahead);
  // A clean run is consecutive cards without an Again, inside one session.
  if (g === 1) {
    if (!session.missed.includes(id)) session.missed.push(id);
    session.again++;
    session.clean = 0;
  } else {
    session.good++;
    session.clean = n(session.clean) + 1;
    session.maxClean = Math.max(n(session.maxClean), session.clean);
    if (!session.ahead) state.bestClean = Math.max(n(state.bestClean), session.maxClean);
  }
  const answeredCard = byId.get(id);
  if (answeredCard && !session.sectionKeys.includes(answeredCard.sectionId)) {
    session.sectionKeys.push(answeredCard.sectionId);
  }

  session.queue.shift();
  if (outcome === 'stay') {
    const gap = g === 1 ? 4 : 8;
    const at = Math.min(session.queue.length, gap);
    session.queue.splice(at, 0, id);
  } else {
    session.done++;
  }
  const sess = session;
  showCard();
  // The reveal button is back in the rectangle the grades just vacated.
  settleDock();
  // After the next card is on screen, so the unlock lands on top of the new
  // question rather than the one just answered. Never on a practice round: an
  // unlock is a record of something you did, and nothing here was recorded —
  // it would also be the one thing a practice round wrote to disk.
  if (!sess.ahead) checkAchievements(sess);
}

function undo() {
  const u = undoStack.pop();
  if (!u) return;
  const retracted = Object.keys(state.ach)
    .filter((id) => !Object.prototype.hasOwnProperty.call(u.st.ach, id));
  if (u.rec) state.recs[u.id] = u.rec; else delete state.recs[u.id];
  Object.assign(state, u.st);
  session.queue = u.queue;
  Object.assign(session, u.s);
  retractUnlocks(retracted);
  save();
  showCard();
  toast('Undone');
}

function renderDoneMoment(moment) {
  lastDoneMoment = moment && moment.shareable ? moment : null;
  const card = $('#done-moment');
  card.hidden = !lastDoneMoment;
  $('#done-share-status').textContent = '';
  if (!lastDoneMoment) return;
  $('#done-moment-art').innerHTML = doodle(lastDoneMoment.art || 'tower');
  $('#done-moment-label').textContent = lastDoneMoment.family === 'club-streak'
    ? 'club streak' : lastDoneMoment.family === 'memories-kept'
      ? 'memories kept' : lastDoneMoment.family === 'personal-best'
        ? 'personal best' : 'worth sharing';
  $('#done-moment-title').textContent = lastDoneMoment.title;
  $('#done-moment-copy').textContent = lastDoneMoment.description;
}

function finish() {
  const acc = session.done
    ? Math.round(((session.done - session.missed.length) / session.done) * 100) : 0;
  $('#done-stats').innerHTML = `
    <div><b>${session.done}</b><span>cards</span></div>
    <div><b>${acc}%</b><span>first try</span></div>
    <div><b>${session.startedNew}</b><span>new</span></div>
    <div><b>${clubFacts().clubStreak}</b><span>club streak</span></div>`;

  const c = counts(null);
  const revRoom = Math.max(0, state.settings.maxRev - state.revDone);
  const newRoom = Math.max(0, newBudget() - state.newDone);
  const left = Math.min(c.due, revRoom) + c.learning + Math.min(c.fresh, newRoom);

  $('#done-title').textContent = session.section
    ? scopeName(session.section) || 'Section done'
    : 'Session finished';
  // A practice round ends by saying what it said at the start, because this is
  // the screen that would otherwise read as a day's work banked.
  $('#done-line').textContent = session.ahead
    ? 'That was practice. The deck is where you left it.'
    : left > 0
      ? `${left} more card${left === 1 ? '' : 's'} are ready across the deck.`
      : nextDueLine();
  $('#done-more').hidden = left === 0;

  // The section's own drawing with four pen-strokes flying off it, instead
  // of a tick — whatever that course draws for the thing just finished.
  const sk = session.section || '';
  const badge = SECTION_ART[sk] || GROUP_ART[sk.slice(2)] || COURSE.fallback;
  $('#done-tick').innerHTML = doodle(badge)
    + [[-30, -20], [30, -20], [-22, 18], [22, 18]]
      .map(([dx, dy], i) => `<i class="spark" style="--dx:${dx}px;--dy:${dy}px;animation-delay:${(i * 0.07).toFixed(2)}s"></i>`)
      .join('');

  lastReelCards = session.reelCards.slice();
  renderReel(session.reel.slice(0, 5));
  let hero = null;
  if (!session.ahead) {
    checkAchievements(session);
    const at = Date.now();
    const context = achievementContext(session, at);
    const before = new Set(session.initialKeptSections || []);
    const newlyKeptSections = (context.keptSectionKeys || [])
      .filter((key) => !before.has(key))
      .map((key) => {
        const section = sectionOf.get(key);
        return {
          key,
          title: section && section.title,
          art: SECTION_ART[key] || COURSE.fallback,
        };
      });
    const repeatable = AchievementEngine.sessionMoments({
      at,
      course: COURSE,
      // `context` is already normalised, so it carries previousPersonalBest: 0;
      // only the canonical key can override it — the previousBestClean alias
      // loses the `??` race against that stamped zero.
      context: Object.assign({}, context, {
        previousPersonalBest: session.initialBestClean,
        newlyKeptSections,
      }),
    });
    const hasExactSection = repeatable.some((moment) => moment.id.startsWith('section-kept:'));
    const candidates = (session.newAchievements || [])
      .filter((moment) => !(hasExactSection && moment.id === 'section-kept'))
      .concat(repeatable);
    hero = AchievementEngine.bestMoment(candidates);
  }
  renderDoneMoment(hero);
  // The lease is the hand-off boundary between whole-document writers. Commit
  // the final answer before another tab is allowed to start from storage.
  flushAndReleaseStudyLock();
  clearStudySession();
  session = null;
  if (globalThis.DSSync) DSSync.schedule(syncPayload);
  go('done');
  $('#done-home').focus({ preventScroll: true });
}

/* The reel is built from the cards you graded Again or Hard in the session
 * just finished — the material you have just proved you do not know. */
function reelClips() {
  return (lastReel || []).map((c) => VIDEOS.clips[c]).filter(Boolean);
}
let lastReel = [];
let lastReelCards = [];

function addReelClips(id) {
  if (!session) return;
  for (const clip of VIDEOS.cards[id] || []) {
    if (!session.reel.includes(clip)) session.reel.push(clip);
  }
}

function clipsForReelCards(ids) {
  const clips = [];
  for (const id of ids) {
    for (const clip of VIDEOS.cards[id] || []) {
      if (!clips.includes(clip)) clips.push(clip);
    }
  }
  return clips;
}

function renderReel(ids) {
  lastReel = ids;
  const wrap = $('#done-reel');
  const clips = reelClips();
  wrap.hidden = !clips.length;
  if (!clips.length) return;
  const secs = clips.reduce((t, c) => t + n(c.d), 0);
  $('#reel-h').textContent = clips.length === 1
    ? `A clip on one you found hard — ${fmtClock(secs)}`
    : `${clips.length} clips on the ones you found hard — ${fmtClock(secs)}`;
  $('#reel-strip').innerHTML = `<div class="vrow">${clips.map((c) => thumbHtml(c)).join('')}</div>`;
}

function nextDueLine() {
  const now = Date.now();
  let soonest = Infinity;
  for (const c of DECK.cards) {
    const r = state.recs[c.cardId];
    if (r && r.st === 'r' && r.due > now) soonest = Math.min(soonest, r.due);
  }
  if (soonest === Infinity) return 'Nothing else is scheduled. You can start new cards whenever you like.';
  const days = Math.max(0, Math.round((startOfDay(soonest) - startOfDay(now)) / DAY));
  if (days <= 0) return 'More cards come back later today.';
  return days === 1
    ? 'Nothing is due until tomorrow. You can start new cards now if you want to.'
    : `Nothing is due for ${days} days. You can start new cards now if you want to.`;
}

function fmtDays(d) {
  if (d < 1) return 'today';
  if (d === 1) return '1 day';
  if (d < 30) return d + ' days';
  const m = d / 30;
  if (d < 365) return (m < 2 ? '1 month' : Math.round(m) + ' months');
  const y = d / 365;
  return y < 2 ? '1 year' : Math.round(y) + ' years';
}

/* ── browse ── */

const BROWSE_FIRST = 40;
const BROWSE_PAGE = 60;
let browseLimit = BROWSE_FIRST;
const LEECH_FILTER = '★leech';
/* A whole group is a browsing scope in its own right — "the 95 cards about the
 * rules of the road" is a real thing to want to read. It shares the one filter
 * control with the sections, so it needs a prefix that a section key can never
 * collide with: `pilotage` is a section and `g:landfall` is the group holding
 * it. Anything not prefixed, and not the leech sentinel, is a section. */
const GROUP_AT = 'g:';
const isGroup = (v) => v.slice(0, 2) === GROUP_AT;
let browseHits = [];        // the whole result set, best matches first
let browseTerms = [];       // what the rendered rows were marked against
let browseCountSaid = '';   // last thing written to the status line
let deckWords = new Set();  // every word the deck uses, for the plural rule

/** Card text reduced to the words a search can match: no tags, no entities, no
 *  punctuation. Without this, "br" matched 236 cards through their own <br>
 *  tags, "45 degrees" matched nothing because the deck writes 45&deg;, and
 *  "man-overboard" found one card where "man overboard" finds ten. */
function searchable(html) {
  return plainText(html).toLowerCase()
    // The deck writes 45&deg;, so a student typing "45 degrees" found nothing.
    // DEGREE_ALT keeps the highlighter in step with this.
    .replace(/°/g, ' degrees ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Card text as prose. stripTags drops a tag without leaving anything behind,
 *  which is right for "145&deg;T" and wrong for a list written with <br>: the
 *  snippet came out reading "the heads, gas and galley;how to send a VHF
 *  distress alert". A line break is a space. */
function plainText(html) {
  return stripTags(String(html).replace(/<br\s*\/?>/gi, ' ')).replace(/\s+/g, ' ').trim();
}

/** Index the deck once, at load. stripTags goes through the DOM, so doing this
 *  per keystroke would be three innerHTML writes per card — 1,611 of them for
 *  every letter typed. */
async function indexDeck() {
  deckWords = new Set();
  for (let i = 0; i < DECK.cards.length; i++) {
    const c = DECK.cards[i];
    // Padded with spaces so a whole-word test is a plain includes().
    c._searchFront = ' ' + searchable(c.front || '') + ' ';
    c._searchBack = ' ' + searchable(c.back || '') + ' ';
    c._searchAll = c._searchFront + c._searchBack;
    c._plainBack = plainText(c.back || ''); // for the snippet, punctuation and all
    for (const w of c._searchAll.split(' ')) if (w) deckWords.add(w);
    // Search preparation is linear but HTML-to-text work is not cheap. Let the
    // boot drawing and browser input breathe on very large imported decks.
    if (i && i % 500 === 0) await new Promise((r) => setTimeout(r, 0));
  }
}

/* The one word the index rewrites, so the highlighter can find on screen what
   the index matched. Without it a search for "degrees" returned cards written
   145°T with nothing marked and no reason showing. */
const DEGREE_ALT = { degrees: '°', degree: '°' };

/** A typed word, plus the singular the user probably also meant: the deck says
 *  "anchor" 49 times and "anchors" once, so searching the plural found one card
 *  while the singular found all 49. The other direction already worked.
 *
 *  Only when the deck actually uses that singular as a word of its own. Cutting
 *  the s off anything ending in one was a menace: "less" became "les" and
 *  reached angles, cables, shackles and miles; "mass" became "mas" and reached
 *  masthead and yachtmaster; and the highlighter then marked "cab-les". The
 *  deck's own vocabulary is the dictionary — it knows "anchor" and has never
 *  heard of "les". */
function queryTerms(q) {
  return searchable(q).split(' ').filter(Boolean).map((t) => {
    const cut = t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t;
    return { t, s: deckWords.has(cut) ? cut : t, alt: DEGREE_ALT[t] || '' };
  });
}
const hasTerm = (hay, w) => hay.includes(w.t) || (w.s !== w.t && hay.includes(w.s));
const hasWord = (hay, w) =>
  hay.includes(' ' + w.t + ' ') || (w.s !== w.t && hay.includes(' ' + w.s + ' '));

/** Best first. Deck order is not relevance: searching "tide" used to put
 *  fourteen cards whose answers mention tides above the first card that is
 *  actually about one. */
function rankOf(c, terms) {
  if (terms.every((w) => hasWord(c._searchFront, w))) return 0; // the question says it
  if (terms.every((w) => hasTerm(c._searchFront, w))) return 1; // the question contains it
  if (terms.every((w) => hasWord(c._searchAll, w))) return 2;   // the answer says it
  return 3;
}

/** The clause of an answer that made this card a hit. The list shows questions
 *  only, so without this two thirds of results have no visible reason to be
 *  there — searching "buoy" returns "What makes a cruising yacht stable?" and
 *  the app looks broken. */
function snippet(text, terms, len = 130) {
  const low = text.toLowerCase();
  let at = -1;
  for (const w of terms) {
    for (const [needle, whole] of needlesOf(w)) {
      const i = findNeedle(low, needle, whole);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
  }
  // Nothing of the query is in this text: better to say nothing than to quote
  // an opening sentence and imply it is the reason.
  if (at < 0) return '';
  let start = Math.max(0, at - 45);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp > -1 && sp < at) start = sp + 1;
  }
  let end = Math.min(text.length, start + len);
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > start) end = sp;
  }
  return (start > 0 ? '…' : '') + text.slice(start, end).trim()
    + (end < text.length ? '…' : '');
}

/** Every form of a term that could be on screen, with whether it only counts as
 *  a whole word. The index normalises what it stores, so the highlighter has to
 *  know what that normalisation was written as. */
function needlesOf(w) {
  const list = [[w.t, false]];
  if (w.alt) list.push([w.alt, false]);
  if (w.s !== w.t) list.push([w.s, false]);
  return list;
}
const wordish = (ch) => !!ch && /[a-z0-9]/.test(ch);
function findNeedle(low, needle, whole, from = 0) {
  for (let i = low.indexOf(needle, from); i >= 0; i = low.indexOf(needle, i + 1)) {
    if (!whole) return i;
    if (!wordish(low[i - 1]) && !wordish(low[i + needle.length])) return i;
  }
  return -1;
}

/** Wrap matches in <mark>, walking the text nodes rather than the HTML: the
 *  questions carry their own markup, and a term that landed inside a tag name
 *  or an attribute would otherwise tear it apart. Returns how many it made, so
 *  a row can tell whether it has yet explained itself. */
function markTerms(root, terms) {
  if (!terms.length || !root) return 0;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  let made = 0;
  for (const node of nodes) {
    const text = node.nodeValue;
    const low = text.toLowerCase();
    const spans = [];
    for (const w of terms) {
      for (const [needle, whole] of needlesOf(w)) {
        for (let i = findNeedle(low, needle, whole); i >= 0;
             i = findNeedle(low, needle, whole, i + needle.length)) {
          spans.push([i, i + needle.length]);
        }
      }
    }
    if (!spans.length) continue;
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [a, b] of merged) {
      if (a > pos) frag.appendChild(document.createTextNode(text.slice(pos, a)));
      const m = document.createElement('mark');
      m.textContent = text.slice(a, b);
      frag.appendChild(m);
      made++;
      pos = b;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }
  return made;
}

function scopeName(sk) {
  if (sk === LEECH_FILTER) return 'the cards that keep slipping';
  if (isGroup(sk)) {
    const g = groupOf.get(sk.slice(2));
    return g ? g.title : sk;
  }
  const s = sectionOf.get(sk);
  return s ? s.title : sk;
}

/** The sections a scope covers, deck order. Empty for anything that is not a
 *  group, which is what tells the index apart from the list. */
function scopeSections(sk) {
  if (!sk || !isGroup(sk)) return [];
  const g = groupOf.get(sk.slice(2));
  return g ? g.sectionIds : [];
}

/** Which cards a scope key holds: '' is the whole deck, `terms` is one section,
 *  `g:rules` is the four sections of a theme. Browse and the session builder
 *  both go through this so they cannot disagree — a button offering to study
 *  the 95 cards of a theme and then handing over 35 is the bug this prevents. */
function scopeTest(key) {
  const inside = new Set(scopeSections(key));
  if (inside.size) return (c) => inside.has(c.sectionId);
  return (c) => !key || c.sectionId === key;
}

/** The count on screen, and the same sentence spoken once you stop typing.
 *
 *  A live region reads out every write, and the 140ms search debounce still
 *  lets one through per keystroke: typing "anchor" announced five sentences,
 *  four of them already stale. The eye wants the number immediately; the ear
 *  wants the last one only. */
let sayTimer = null;
function sayCount(text) {
  if (text === browseCountSaid) return;
  browseCountSaid = text;
  $('#browse-count').textContent = text;
  clearTimeout(sayTimer);
  sayTimer = setTimeout(() => { $('#browse-say').textContent = text; }, 700);
}

/** What this row offers to do to its card, and what it has to say about it
 *  first.
 *
 * Edit is on every row, because §4b is "you can fix a card from wherever you hit
 * it" and this is the list of every card there is. Taking a card out is not
 * here: that lives in the sheet, so there is one confirm, one refusal and one
 * place that knows a session is open.
 *
 * The line above the buttons is the layer speaking. A card the author has
 * rewritten since you edited it is the one case with a choice in it, and the
 * choice is offered here rather than resolved silently either way. */
function browseCardActs(card) {
  // Off the card rather than off its id: a card of your own carries a reserved
  // id, and so does an edit of a course card, but the cards in a deck you wrote
  // here are in that deck's own document and carry ordinary ones. Whether you
  // wrote it is a fact about the card, and cardsWithLayer() is where it is
  // settled for both.
  const yours = card._yours === true;
  let notice = '';
  if (authorRewroteCard(card.cardId)) {
    notice = `<span class="b-mine b-moved">The author rewrote this card after you edited it.</span>
      <button class="link-btn" type="button" data-card-keep
        aria-label="Keep your version of this card">Keep yours</button>
      <button class="link-btn" type="button" data-card-revert
        aria-label="Take the author's version of this card">Take theirs</button>`;
  } else if (card._edited === true) {
    notice = `<span class="b-mine">Edited by you.</span>
      <button class="link-btn" type="button" data-card-revert
        aria-label="Show the original of this card">Show the original</button>`;
  } else if (yours) {
    notice = '<span class="b-mine">Written by you.</span>';
  }
  // `bare` is the row with nothing to say for itself, which is nearly all of
  // them: Edit alone goes in the row's right gutter beside the chevron rather
  // than on a line of its own. A row carrying a notice keeps its line.
  return `<div class="b-acts${notice ? '' : ' bare'}">${notice}
    <button class="link-btn" type="button" data-card-edit
      aria-label="Edit this card">Edit</button></div>`;
}

function browseRow(hit, terms, withSection) {
  const c = hit.c;
  const sect = sectionOf.get(c.sectionId);
  const backed = hasBackContent(c);
  const hasFrontMedia = mediaForSide(c, 'front').length > 0;
  const image = backImage(c);
  const promptText = stripTags(c.front || 'this card');
  const hasFig = !image && c.figure && FIGURES && FIGURES[c.figure.figureId];
  const li = document.createElement('li');
  li.dataset.card = c.cardId;
  li.dataset.sect = c.sectionId;
  const prompt = `<span class="b-head"><span class="b-where" hidden></span>`
    + `<span class="b-q"></span><span class="b-why" hidden></span></span>`;
  const acts = browseCardActs(c);
  // Where the card lives, but only where the row is not already standing under
  // the answer: with a section chosen the dropdown, the breadcrumb and the page
  // title all say it, and with a run of rows grouped in deck order the run's own
  // heading says it — so opening a card printed its section a fourth time. What
  // it has always been worth saying is the second half, how the card is going.
  const placed = withSection || $('#sect-filter').value;
  const where = placed ? '' : `${escapeHtml(sect ? sect.title : c.sectionId)} · `;
  const answer = `<div class="browse-ans"><span class="b-text">${c.back || ''}</span>
      ${image ? `<button class="plate b-plate" aria-label="Enlarge the diagram: ${escAttr(promptText)}"><img src="${escAttr(courseMediaUrl(image))}" alt="Diagram: ${escapeHtml(promptText)}" loading="lazy"${image.width && image.height ? ` width="${n(image.width)}" height="${n(image.height)}"` : ''}></button><span class="b-zoom">${ENLARGE_HINT}</span>` : ''}
      ${hasFig ? `<button class="plate b-fig" aria-label="Enlarge the drawing: ${escAttr(promptText)}">${figureSVG(c)}</button><span class="b-zoom">${ENLARGE_HINT}</span>` : ''}
      <div class="b-back-media"></div>
      <span class="b-sect">${where}${STATE_WORDS[stateOf(c.cardId)]}</span>
      </div>`;
  /* The layer's own line and Edit go on the row, never inside the answer.
   *
   * A row whose answer is a disclosure is closed by default — Browse opens as
   * an index of sections — so everything inside it needed the specific card's
   * answer opened to be seen at all. That put "the author rewrote this card
   * after you edited it", and the choice between keeping yours and taking
   * theirs, behind a tap nobody had a reason to make: the person went on
   * studying a stale override of a card the author had since fixed, which is
   * the one outcome `was` exists to prevent. Edit was behind the same tap,
   * against §4b's "you can fix a card from wherever you hit it". */
  if (!backed) {
    li.innerHTML = `<article class="browse-static" tabindex="-1">${prompt}
      <div class="b-front-media"></div>
      <span class="b-sect">${escapeHtml(sect ? sect.title : c.sectionId)} · ${STATE_WORDS[stateOf(c.cardId)]}</span>
      ${acts}
    </article>`;
  } else if (hasFrontMedia) {
    li.innerHTML = `<div class="browse-prompt">${prompt}</div>
      <div class="b-front-media"></div>
      <details><summary class="b-answer-toggle">Show answer</summary>${answer}</details>
      ${acts}`;
  } else {
    li.innerHTML = `<details><summary>${prompt}</summary>${answer}</details>
      ${acts}`;
  }
  const q = li.querySelector('.b-q');
  q.innerHTML = c.front || '';
  hydrateMedia(q);
  renderDescriptiveMediaInto(li.querySelector('.b-front-media'), c, 'front');
  const answerRoot = li.querySelector('.browse-ans');
  if (answerRoot) {
    hydrateMedia(answerRoot, false);
    renderDescriptiveMediaInto(li.querySelector('.b-back-media'), c, 'back', false);
  }
  // Whether the question ended up showing the match decides whether the row
  // owes an explanation — not which tier it was ranked in. The two disagree
  // wherever the index normalised something the screen still spells its own
  // way, and it is exactly those rows that look like a bug.
  const shown = markTerms(q, terms);
  // Only the prose: the figure's own labels are markup from the build, and
  // walking into the SVG to highlight a word inside a drawing is not the offer.
  markTerms(li.querySelector('.b-text'), terms);
  if (backed && terms.length && !shown) {
    const why = li.querySelector('.b-why');
    const text = snippet(c._plainBack, terms);
    if (text) {
      why.textContent = text;
      markTerms(why, terms);
      why.hidden = false;
    }
  }
  if (withSection && sect) {
    const where = li.querySelector('.b-where');
    where.textContent = sect.title;
    where.hidden = false;
  }
  if (image) li.querySelector('.b-plate').addEventListener('click', () => openLightbox(c));
  if (hasFig) {
    const holder = li.querySelector('.b-fig');
    litFigure(holder, c);
    // No drawFigureOn() here: this row is still detached, and a closed
    // <details> is display:none once it is not. Both are unrendered, and an
    // unrendered element cannot be measured. The row sets its drawing going
    // when it opens instead — see the `toggle` listener on #browse-list.
    holder.addEventListener('click', () => openLightbox(c));
  }
  return li;
}

/** Rows `from` onwards, appended. Rebuilding the whole list to show the next
 *  sixty closed every answer you had open and dropped you back at the top. */
function appendRows(from) {
  const list = $('#browse-list');
  // The section is named on the first row of each run of them, so it reads as a
  // heading. On every row it was the same eleven words down the whole screen.
  // Only in deck order: results are sorted by relevance, so consecutive rows
  // rarely share a section and the "heading" would be back on two rows in three.
  // A whole theme is four sections of deck order, so it needs them most of all.
  const scope = $('#sect-filter').value;
  const grouped = !browseTerms.length && (!scope || isGroup(scope));
  let prev = list.lastElementChild ? list.lastElementChild.dataset.sect : '';
  const frag = document.createDocumentFragment();
  for (const hit of browseHits.slice(from, browseLimit)) {
    frag.appendChild(browseRow(hit, browseTerms, grouped && hit.c.sectionId !== prev));
    prev = hit.c.sectionId;
  }
  const firstNew = frag.firstChild;
  list.appendChild(frag);
  const left = Math.max(0, browseHits.length - browseLimit);
  const more = $('#browse-more');
  more.hidden = !left;
  if (left) more.textContent = `Show more (${left} left)`;
  syncOpenLabel();
  return firstNew;
}

/** What the button will do next, read off the rows rather than remembered:
 *  paging sixty closed rows in under a "Close them again" label made it open a
 *  hundred, and opening one answer by hand left it lying the other way. */
function syncOpenLabel() {
  const rows = $$('#browse-list details');
  const allOpen = rows.length > 0 && rows.every((d) => d.open);
  $('#browse-open').textContent = allOpen ? 'Close them again' : 'Open every answer';
}

/** Where "up" goes from a scope, or null where there is no up: the index itself,
 *  the leech list, and a search all have nothing above them. A section goes up
 *  to its own theme rather than to the index — the reason you are reading about
 *  sound signals is usually the reason you want lights and shapes next. */
function upFrom(sk) {
  if (!sk || sk === LEECH_FILTER) return null;
  if (isGroup(sk)) return { to: '' };
  const g = groupFor.get(sk);
  return g && groupOf.get(g) && groupOf.get(g).title ? { to: GROUP_AT + g } : { to: '' };
}

/* The deck writes its sections as "05 IRPCS — rules of the road". On a tile the
 * number wants to be a small tag of its own rather than two characters of the
 * name, and a tile is too narrow to spend them twice. */
const SECT_NO = /^(\d+)\s+(.*)$/;

/** The index: every section as a tile, under the theme it belongs to.
 *
 * Rebuilt from scratch each time rather than diffed. It is 24 buttons and it is
 * only ever built while nothing is filtered or searched, so it is not on the
 * path of anything that has to feel fast. */
function renderBrowseIndex() {
  const host = $('#browse-index');
  host.innerHTML = '';
  const frag = document.createDocumentFragment();
  // The same fold Home uses, over the same seven themes: twenty-four tiles in
  // one column is the wall this screen exists to save you from, and the app has
  // one folding idiom or none. The first theme stands open, because a screen of
  // seven shut doors and nothing else shows you nothing.
  let first = true;
  for (const g of groupOf.values()) {
    const sec = document.createElement('section');
    sec.className = 'bgroup';
    const named = !!g.title;
    const open = first;
    const listId = `browse-group-${g.groupId}`;
    sec.innerHTML = (named ? `<div class="bgroup-h">
        <button class="bgroup-toggle" type="button" aria-expanded="${open}"
          aria-controls="${escapeHtml(listId)}">
          ${doodle(GROUP_ART[g.groupId] || COURSE.fallback, 'bgroup-art')}
          <span class="bgroup-t">${escapeHtml(g.title)}</span>
        </button>
        <button class="bgroup-all" data-scope="${escapeHtml(GROUP_AT + g.groupId)}"
          aria-label="Read all ${plural(g.cardCount, 'card')} in ${escAttr(g.title)}">${
  plural(g.cardCount, 'card')} →</button>
      </div>
      <ul class="btiles" id="${escapeHtml(listId)}"${open ? '' : ' hidden'}></ul>`
      : '<ul class="btiles"></ul>');
    if (named) first = false;
    const ul = sec.querySelector('.btiles');
    for (const sectionId of g.sectionIds) {
      const s = sectionOf.get(sectionId);
      if (!s) continue;
      const m = SECT_NO.exec(s.title);
      const li = document.createElement('li');
      li.innerHTML = `<button class="btile" data-scope="${escapeHtml(sectionId)}"
          aria-label="${escAttr(s.title)}, ${plural(s.cardCount, 'card')}. ${
  s.cardCount === 1 ? 'Read it' : 'Read them'}.">
        ${sectionMark(sectionId, 'btile-art')}
        ${m ? `<span class="btile-no">${escapeHtml(m[1])}</span>` : ''}
        <span class="btile-name">${escapeHtml(m ? m[2] : s.title)}</span>
        <span class="btile-n">${plural(s.cardCount, 'card')}</span>
      </button>`;
      ul.appendChild(li);
    }
    frag.appendChild(sec);
  }
  host.appendChild(frag);
  hydrateSectionArtwork(host);
}

function renderBrowse() {
  const sel = $('#sect-filter');
  const lc = leeches().length;
  // Kept while it is the current filter even once the count reaches zero:
  // dropping the option under a live selection silently reverted the view to
  // all 537 cards with nothing on screen to say why.
  const wantLeech = lc > 0 || sel.value === LEECH_FILTER;
  // The section count is in the shape too: hiding the last card in a section
  // takes the section, and an option for a section that is not there any more
  // filters to an empty list with nothing on screen to explain it.
  const groupCounts = [...groupOf.values()]
    .map((group) => `${group.groupId}:${n(group.cardCount)}`).join(',');
  const shape = `${lc}/${wantLeech}/${DECK.sections.length}/${groupCounts}`;
  // Rebuilt only when that changes, so the open dropdown does not reset itself
  // while you are choosing from it.
  if (sel.dataset.leeches !== shape) {
    sel.dataset.leeches = shape;
    const keep = sel.value;
    // Grouped, in the same seven themes the index below is built from, with the
    // whole theme offered above its sections. A flat run of twenty-four options
    // asked you to know which section a question lives in before it could help.
    const opt = (v, label) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`;
    sel.innerHTML = '<option value="">All sections</option>' +
      (wantLeech ? `<option value="${LEECH_FILTER}">★ Keeps slipping (${n(lc)})</option>` : '') +
      [...groupOf.values()].map((g) =>
        `<optgroup label="${escapeHtml(g.title || 'Sections')}">`
        + (g.title
          ? opt(GROUP_AT + g.groupId, `All of ${g.title} (${n(g.cardCount)})`) : '')
        + g.sectionIds.map((id) => opt(id, (sectionOf.get(id) || {}).title || id)).join('')
        + '</optgroup>').join('');
    sel.value = keep;
  }
  const raw = $('#search').value.trim();
  const sk = sel.value;
  const terms = queryTerms(raw);
  // Nothing narrowed means the index, not the deck poured out in one column.
  // The list is the answer to a question; the index is what you read when you
  // do not have one yet.
  const index = !sk && !terms.length;
  const test = scopeTest(sk);
  const inScope = (c) => {
    if (sk === LEECH_FILTER) {
      const r = state.recs[c.cardId];
      return !!r && r.lp >= LEECH_AT;
    }
    return test(c);
  };

  let scope = 0;
  const hits = [];
  for (const c of DECK.cards) {
    if (!inScope(c)) continue;
    scope++;
    if (!terms.length) { hits.push({ c, r: 0 }); continue; }
    if (!terms.every((w) => hasTerm(c._searchAll, w))) continue;
    hits.push({ c, r: rankOf(c, terms) });
  }
  hits.sort((a, b) => a.r - b.r);   // stable, so deck order survives inside a tier
  browseHits = hits;
  browseTerms = terms;

  const all = DECK.cards.length;
  $('#search').placeholder = sk
    ? `Search ${plural(scope, 'card')}…` : `Search ${plural(all, 'card')}…`;

  // Say what was actually searched. "4 of 537" while a 21-card section is
  // selected reads like the search swept the deck and nearly nothing matched.
  let count;
  if (!hits.length) {
    count = terms.length
      ? `Nothing matches “${raw}”${sk ? ` in ${scopeName(sk)}` : ''}.`
      : (sk === LEECH_FILTER
        ? 'No cards are slipping yet.'
        : `No cards in ${scopeName(sk)}.`);
  } else if (terms.length && sk) {
    count = `${n(hits.length)} of the ${plural(scope, 'card')} in ${scopeName(sk)}`;
  } else if (terms.length) {
    count = `${n(hits.length)} of ${plural(all, 'card')}`;
  } else if (sk) {
    // Not "34 cards in 01 Boat and nautical terms": the select directly above
    // is already showing the section's name, at full size.
    count = plural(scope, 'card');
  } else {
    // Nothing narrowed: the index is on screen, so the honest count is of the
    // things you can actually see and press, not of the cards behind them.
    count = `${plural(all, 'card')} in ${plural(DECK.sections.length, 'section')}`;
  }
  // "showing 40" is about a paged list. On the index every section is on screen,
  // and saying otherwise sent people looking for a Show more button that is not
  // there and was never needed.
  if (!index && hits.length > BROWSE_FIRST) {
    count += ` · showing ${n(Math.min(browseLimit, hits.length))}`;
  }
  sayCount(count);
  $('#browse-count').classList.toggle('nothing', !hits.length);

  // Only the case neither control can do for itself. A typed query is cleared
  // by the field's own ✕; a section by the dropdown's own "All sections"; and
  // "← All sections" is the way out of a theme. Both at once is the one state
  // where clearing either leaves you looking at a narrowed deck and wondering
  // why, so it keeps a button — and says both things it will undo.
  const clear = $('#browse-clear');
  clear.hidden = !(sk && terms.length);

  // A search that finds nothing here may still find something in the deck.
  const wide = $('#browse-wide');
  const elsewhere = (!hits.length && terms.length && sk)
    ? DECK.cards.filter((c) => terms.every((w) => hasTerm(c._searchAll, w))).length : 0;
  wide.hidden = !elsewhere;
  if (elsewhere) {
    wide.textContent = `Search all ${n(all)} cards instead — ${n(elsewhere)} match${elsewhere === 1 ? '' : 'es'}`;
  }

  // Filtering to a section is usually an attempt to work through it. The name
  // is not repeated on it: the dropdown two lines above is already showing it,
  // and spelled out the label wrapped this line to four rows on a phone.
  const study = $('#browse-study');
  const studiable = sk && sk !== LEECH_FILTER && !terms.length && hits.length;
  study.hidden = !studiable;
  if (studiable) study.textContent = isGroup(sk) ? 'Study this theme →' : 'Study this section →';

  // Up one level, which is not the same offer as Clear filter: from a section
  // you almost always want its neighbours in the same theme, not all 537 cards.
  const up = upFrom(sk);
  const back = $('#browse-back');
  back.hidden = !up;
  if (up) {
    back.textContent = '← ' + (up.to ? scopeName(up.to) : 'All sections');
    back.dataset.to = up.to;
  }

  renderHiddenCards();

  // Reading position survives a re-render: this also runs when a sync lands or
  // another tab writes, and having the answer you were reading snap shut
  // underneath you is worse than being slightly out of date.
  const body = $('#s-browse .body');
  const wasAt = body ? body.scrollTop : 0;
  const open = new Set();
  for (const el of $$('#browse-list li details[open]')) open.add(el.parentElement.dataset.card);

  const list = $('#browse-list');
  list.innerHTML = '';
  const host = $('#browse-index');
  host.hidden = !index;
  list.hidden = index;
  $('#browse-empty').hidden = index || !!hits.length;
  if (index) {
    if (!host.firstChild) renderBrowseIndex();
    $('#browse-more').hidden = true;
    $('#browse-open').hidden = true;
    if (body) body.scrollTop = Math.min(wasAt, body.scrollHeight);
    return;
  }
  // Only once something is narrowed, and only when at least one row has an
  // answer. Front-only rows are deliberately not empty disclosures.
  const revealable = hits.some((hit) => hasBackContent(hit.c));
  $('#browse-open').hidden = !(revealable && (sk || terms.length));
  syncOpenLabel();
  if (!hits.length) {
    const nothing = $('#browse-empty');
    if (!nothing.firstChild) nothing.innerHTML = doodle(COURSE.fallback, 'browse-empty-art');
    $('#browse-more').hidden = true;
    return;
  }
  browseLimit = Math.max(BROWSE_FIRST, Math.min(browseLimit, hits.length));
  appendRows(0);
  for (const li of $$('#browse-list li')) {
    const details = li.querySelector('details');
    if (details && open.has(li.dataset.card)) details.open = true;
  }
  if (body) body.scrollTop = Math.min(wasAt, body.scrollHeight);
}

/* Cards you hid, and the way to change your mind.
 *
 * A hidden card is not in DECK.cards — hiding it is exactly what took it out —
 * so it is in none of the lists above and there would be nowhere to undo it
 * from. Its own list, off until you ask for it, is that place. Off by default
 * because a card you hid is a card you decided not to see.
 *
 * The list is the whole deck's, deliberately: a card hidden out of section 01
 * has to be reachable from wherever you are, or hiding stops being free. What
 * that costs is that it can end up sitting above a list of something else, so
 * it closes whenever what is on screen changes — a search, a section, or
 * leaving Browse. It was module state that survived all three, and came back
 * open over a search it had nothing to do with. */
let showingHidden = false;

function closeHiddenCards() {
  if (!showingHidden) return;
  showingHidden = false;
  renderHiddenCards();
}

function renderHiddenCards() {
  const button = $('#browse-hidden');
  const list = $('#hidden-list');
  if (!button || !list) return;
  const hidden = hiddenCards();
  button.hidden = hidden.length === 0;
  if (!hidden.length) showingHidden = false;
  button.textContent = showingHidden
    ? 'Close the cards you hid'
    : `Cards you hid (${n(hidden.length)})`;
  button.setAttribute('aria-expanded', showingHidden ? 'true' : 'false');
  list.hidden = !showingHidden || !hidden.length;
  if (list.hidden) { list.innerHTML = ''; return; }
  list.innerHTML = hidden.map((card) => `<li data-card="${escAttr(card.cardId)}">
      <article class="browse-static">
        <span class="b-head"><span class="b-q"></span></span>
        <div class="b-acts"><span class="b-mine">Hidden by you.</span>
          <button class="link-btn" type="button" data-card-revert
            aria-label="Bring this card back into the deck">Bring it back</button></div>
      </article>
    </li>`).join('');
  // The question is the course's own sanitized HTML, so it is set as markup
  // exactly as a row in the list above sets it — and through the same media
  // hydration, or an imported card's picture is a broken image here.
  const rows = list.querySelectorAll('li');
  hidden.forEach((card, i) => {
    const q = rows[i] && rows[i].querySelector('.b-q');
    if (!q) return;
    q.innerHTML = card.front || '';
    hydrateMedia(q);
  });
}

/* ── stats ── */

/** Say what a backup would actually contain, so "export" is not a leap of faith. */
function renderBackupState() {
  const el = $('#backup-state');
  if (!el) return;
  if (saveBlocked) {
    el.textContent = 'Progress is not saving on this device. Export a backup now; no more cards will be graded until storage works again.';
    return;
  }
  const withHistory = Object.keys(state.recs).length;
  // Everything in the file, whether or not this line used to mention it. A deck
  // someone has written about but not yet studied had a backup worth taking
  // while this said there was nothing to take, and a deck someone has written
  // cards into is the same case with more at stake: for a deck of your own the
  // file is the only copy those cards will ever have. What the export holds is
  // the whole of what this sentence is for.
  const notes = liveNotes().length;
  // Every live record in the layer, not only the cards with no shipped card
  // under them. A deck whose whole history with this person is five cards of it
  // they fixed has a file worth taking, and counting the written ones alone
  // said there was nothing here to back up while the file held all five.
  const written = liveCardCount();
  const also = [];
  if (notes) also.push(`your ${plural(notes, 'note')}`);
  if (written) also.push(`the ${plural(written, 'card')} you have written or edited`);
  also.push('your settings');
  if (withHistory) {
    el.textContent = `A backup right now would hold ${withHistory} of ${DECK.cards.length} cards, `
      + `${state.streak} day${state.streak === 1 ? '' : 's'} of streak, ${listWords(also)}.`;
    return;
  }
  el.textContent = notes || written
    ? `No cards studied yet — a backup right now would hold ${listWords(also)}.`
    : 'Nothing to back up yet — study some cards first.';
}

/* ── the deck file ── */

/* A course file written on the device, out of this deck.
 *
 * The other half of a promise the card release made and could not keep: cards
 * somebody writes live in one browser profile and in the backup file, and the
 * backup is stamped for one deck on one device and refused by any other. This
 * is the file that goes anywhere, and it is the format the app already reads,
 * so what comes out is checked by the thing that will have to take it back.
 *
 * Nothing here writes. The export reads COURSE.deck and cardLayer, both already
 * in memory, and touches neither — so there is no lease to take, no writeNow()
 * to flush, and exporting during an open session is allowed. It must also never
 * re-read the layer first: loadCardLayer() mid-session replaces cardLayer
 * without the applyCardLayer() that keeps DECK in step, which is the one thing
 * the storage listener already refuses to do while a session is open. The file
 * is what this tab is showing, which is the only thing it can honestly be.
 */

/** Which of the two files this deck can produce — the answer to a question
 *  about the stored document and the format it is in, neither of which moves
 *  while the deck is open. Worked out once; the counts on the line below it are
 *  counted on every draw, because those do move. */
let deckFile = null;
let deckFileBroken = false;
// One file at a time, and the button's own label while it is written. No
// spinner and no bar: a bar with nothing behind it is worse than a word, and
// the only deck big enough to need one is the Anki import, which never takes
// the whole-deck path.
let deckExporting = false;

async function readyDeckFile() {
  if (deckFile || deckFileBroken) return deckFile;
  try {
    const { deckFileShape } = await courseExport();
    deckFile = deckFileShape({
      sourceFormat: RUNTIME_SOURCE_FORMAT,
      stored: (globalThis.COURSE && COURSE.deck) || null,
      own: !!(globalThis.COURSE && COURSE.own),
    });
  } catch (e) {
    console.error(e);
    deckFileBroken = true;
  }
  return deckFile;
}

/** The assets that keep a deck from going out whole, in the words for what they
 *  actually are. A deck of bird calls carries recordings, not pictures. */
function assetWords(assets) {
  const said = [];
  if (assets.pictures) said.push(plural(assets.pictures, 'picture'));
  if (assets.sounds) said.push(plural(assets.sounds, 'sound file'));
  if (assets.clips) said.push(plural(assets.clips, 'clip'));
  return listWords(said);
}

/** Whose work this deck is, where its own document says so.
 *
 * A whole-deck export of a course somebody else wrote carries their `authors`
 * and `license` through untouched, and the line above the button names them:
 * handing on another person's course is exactly the moment to say whose it is.
 * Where the document claims neither, this says nothing rather than inventing
 * something. */
function deckFileAttribution(stored) {
  const names = (Array.isArray(stored && stored.authors) ? stored.authors : [])
    .map((author) => (author && typeof author.name === 'string' ? author.name : ''))
    .filter(Boolean);
  const licence = stored && isPlainObject(stored.license)
    ? (typeof stored.license.identifier === 'string' ? stored.license.identifier
      : typeof stored.license.name === 'string' ? stored.license.name : '')
    : '';
  if (names.length && licence) {
    return ` This deck is ${listWords(names)}’s work, under ${licence}. `
      + 'The file carries that with it.';
  }
  if (names.length) {
    return ` This deck is ${listWords(names)}’s work. The file carries that with it.`;
  }
  if (licence) return ` This deck is under ${licence}. The file carries that with it.`;
  return '';
}

/** What a file made right now would and would not hold, one sentence per case,
 *  with the reason before the consequence.
 *
 * Every number is derived on the spot off the same functions the rest of the
 * screen counts with, so this line moves the moment a card is written — like
 * every other derived number in the app. */
function deckFileSays() {
  /* THIS ANSWER FIRST, whatever the deck is.
   *
   * With the cards document unread, every count below is a count of nothing —
   * writtenCardCount(), liveCardCount() and hiddenCards() all read the layer —
   * so this line would tell somebody who has written fourteen cards that they
   * have written none, and then send them to Browse, where the first card
   * written replaces the document that would not open. It is the same refusal
   * the button gives, said before the button rather than after it. */
  if (!cardLayerLoaded) {
    return 'The cards you wrote into this deck could not be read, so a file made now '
      + 'would be missing them, and none will be written.';
  }
  const written = writtenCardCount();
  const overridden = liveCardCount() - written;
  const hidden = hiddenCards().length;
  const yours = written + overridden;
  const stored = (globalThis.COURSE && COURSE.deck) || null;

  if (deckFile.kind === 'layer') {
    if (!yours) {
      return 'You have not written or changed a card in this deck yet, so there is '
        + 'nothing of yours to put in a file. Browse is where you write one.';
    }
    const holds = [];
    if (written) holds.push(`the ${plural(written, 'card')} you wrote`);
    if (overridden) {
      holds.push(deckFile.why === 'built-in'
        ? `the ${overridden} of this course’s that you changed`
        : `the ${plural(overridden, 'card')} you changed`);
    }
    const opening = `A file now would hold ${listWords(holds)}.`;
    if (deckFile.why === 'built-in') {
      const named = (globalThis.COURSE && COURSE.short) || DECK.title;
      return `${opening} ${named}’s own cards are its author’s work, so they stay here.`;
    }
    if (deckFile.why === 'anki') {
      return `${opening} The rest came out of an Anki file and keep club keeps it as it `
        + 'was drawn rather than as it was written, so it cannot be written back out. '
        + 'The .apkg you imported is still that copy.';
    }
    const carrier = deckFile.assets.onCards ? 'The deck’s own cards carry' : 'The deck carries';
    return `${opening} ${carrier} ${assetWords(deckFile.assets)}, `
      + 'and a course file written here is text only.';
  }

  const total = plural(DECK.cards.length, 'card');
  // A hide is not in the file — a course file has no way to say "not this card"
  // — so the cards that were hidden are simply absent, and a line claiming the
  // deck came out whole would be counting cards that are not in it.
  const without = hidden
    ? ` The ${plural(hidden, 'card')} you hid ${hidden === 1 ? 'is' : 'are'} not in it.`
    : '';
  if (deckFile.own) {
    return `A file now would hold all ${total} in this deck.${without} It is the only file `
      + 'that does: a backup holds what you have answered and what you have written, '
      + 'never the deck.';
  }
  const attribution = deckFileAttribution(stored);
  if (!yours && !hidden) {
    return `A file now would hold all ${total} in this deck, exactly as they came in.`
      + attribution;
  }
  // What the fork is guarding is whatever this file has of yours in it, and a
  // file with cards taken out of it has one thing: the taking out.
  const mine = yours
    ? `: the deck’s own, and the ${plural(yours, 'card')} you have written or edited.`
    : '.';
  const risk = yours ? 'take yours with it' : 'put back what you took out';
  return `A file now would hold all ${total} in this deck${mine}${without} It goes out under `
    + 'a name and a course ID of its own, so that an update from the deck’s author can '
    + `never replace it and ${risk}.${attribution}`;
}

function renderDeckFileState() {
  const el = $('#deck-file-state');
  const btn = $('#deck-export-btn');
  if (!el || !btn || !DECK) return;
  if (deckFileBroken) {
    el.textContent = 'keep club could not load the part of itself that writes deck files. '
      + 'Reloading the app is what fixes that.';
    btn.hidden = true;
    return;
  }
  if (!deckFile) { readyDeckFile().then(renderDeckFileState); return; }
  el.textContent = deckFileSays();
  // Never disabled, for the reason "Write a card" is never hidden: a control
  // that is not there cannot say why, and the refusal it would give names the
  // way out.
  if (!deckExporting) {
    btn.textContent = deckFile.kind === 'whole'
      ? 'Export this deck' : 'Export the cards you wrote';
  }
  btn.hidden = false;
}

/* ── sync ── */

function agoText(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return hrs === 1 ? 'an hour ago' : `${hrs} hours ago`;
  return `${Math.round(hrs / 24)} days ago`;
}

/** What this device puts on the wire.
 *
 * Two documents, two blocks, one blob. The cards are assembled here and never
 * into `state` itself: that object is written to storage exactly as it stands,
 * and a `cards` key inside it would land in the document that must not hold one
 * — see MUNIN.cardsKey for why the two are apart in the first place.
 *
 * A deck of your own never reaches this function: DSSync.init() is told such a
 * course is unsupported, so enabled() is false and nothing schedules a round.
 * That is the whole of "a deck you write stays on this device", and the Sync
 * screen says it in words. */
function syncPayload() {
  return Object.assign({}, state, { cards: cardLayer });
}

/** What comes back off the wire, before anything is believed.
 *
 * The blob has been through a network and a database since we wrote it, so it
 * arrives through the same front door as a restored backup file — both of its
 * blocks. sanitise() builds a fresh object out of the keys it knows and would
 * drop a cards block handed to it, which on this path would mean the other
 * device's cards never arrived at all. */
function sanitiseSynced(raw) {
  const clean = sanitise(raw);
  clean.cards = sanitiseCardLayer(isPlainObject(raw) ? raw.cards : null);
  return clean;
}

// The adoption a merge started, resolving to whether it already said what the
// round cost. Rebuilding the deck around a card that arrived is asynchronous, so
// a caller with something to print has to wait for it — and then has to know
// whether the sentence it was going to print has already been said better.
let adopting = Promise.resolve(false);

/** Take a state the server merged for us.
 *
 * Silent when nothing changed, which is also what stops this looping: adopting
 * writes, writing schedules another sync, and that sync would adopt again. The
 * second round produces the same state, so it stops here instead. */
function adoptSynced(merged) {
  adopting = adoptMerged(merged)
    .then((said) => !!said)
    .catch((e) => { console.error(e); return false; });
}

async function adoptMerged(merged) {
  if (!DECK || session) return;
  // Both documents move together or neither does, so the lease is asked once,
  // here, rather than by each write in turn. Refused halfway is the bad shape:
  // writeNow() puts the review document back and says so, and writeCardLayer()
  // would then say the same sentence again over a sweep that had already
  // counted a card's history against a state which never landed. Nothing is
  // lost by waiting — the server is still holding the merge, and the round
  // after the other tab stops studying takes it.
  if (refuseForeignWrite()) return;
  if (DSSync.stable(merged) === DSSync.stable(syncPayload())) return;
  state = sanitise(merged);
  // A merge that carried no cards block is not a merge saying there are none:
  // an older sync.js, or a course this build has never uploaded cards for,
  // both look like this, and leaving the layer alone is the only answer that
  // cannot delete a card nobody asked to delete.
  const theirs = isPlainObject(merged && merged.cards)
    ? sanitiseCardLayer(merged.cards)
    : null;
  if (theirs) cardLayer = theirs;
  // Two blocks that have never met before, held to the ceiling they share.
  const capped = capWrittenBlocks();
  // Not sweepUnknownRecords(): the deck has not been rebuilt around the cards
  // that just arrived, so byId is still the old deck and every card in the
  // merge would look like a card that does not exist. What a delete marker
  // costs is settled below, once, by the sweep that can say so.
  historyDropped += sweepDeletedCardHistory();
  // Adopting is not a local settings change. Without this the write below
  // re-stamps the block with this device's clock, and a device that merely
  // received someone else's settings would outrank them at the next merge.
  settingsShape = JSON.stringify(Object.assign({}, state.settings, { at: 0 }));
  rollDay();
  writeNow();
  // `capped` as well as `theirs`: a ceiling that bit only in memory would leave
  // the deck on screen holding cards the layer no longer does, and bite again
  // on the next boot.
  const layerMoved = !!theirs || capped;
  // The answer, not the call. A layer write that storage refused puts the
  // document that IS on the device back into memory and says why — and nothing
  // was reading it, so a round that could not keep the other device's cards
  // reported itself as a plain success.
  const layerWrite = layerMoved ? writeCardLayer() : { ok: true, say: '' };
  applyTheme();
  applyFontSize();
  if (layerMoved) {
    // The deck itself may have changed, so every number derived off it moves,
    // which is the whole of renderDeckChanged().
    await applyCardLayer();
    renderDeckChanged();
  } else {
    if (current === 'home') renderHome();
    if (current === 'stats') renderStats();
    if (current === 'browse') renderBrowse();
  }
  renderNotesIfOpen();
  // Said here rather than only where a button asked for a sync, because most
  // syncs are not asked for: writeNow() schedules one five seconds after a
  // session ends, and a card whose history that round quietly took would
  // otherwise be a number nobody could account for a week later.
  // Into the one sentence rather than over the top of it: a round that dropped
  // somebody's writing AND could not store the result owes both halves.
  if (!layerWrite.ok) cardsNotWritten = layerWrite.say;
  return sayWhatWentMissing();
}

let syncBusy = false;

/** Push whatever is on this device and take back whatever the merge produced.
 *  Quiet when it runs by itself, spoken when a button asked for it.
 *
 *  Returns the promise so a caller can wait for the round trip. Nothing in the
 *  app does — every trigger is fire-and-forget — but a test that cannot tell
 *  "finished" from "not started" is a test that passes on a stale screen. */
function runSync(loud) {
  if (!globalThis.DSSync || !DSSync.enabled()) return Promise.resolve();
  writeNow();
  // Nothing has been said about this round yet, whatever the last one cost.
  adopting = Promise.resolve(false);
  // A function, not a value: a queued sync must read the state as it is when
  // its turn comes, and adoptSynced replaces the object wholesale.
  return DSSync.sync(syncPayload)
    // Whatever the merge started has to finish first: the cards it brought are
    // put into the deck asynchronously, and the sentences below are about what
    // that cost.
    .then((merged) => adopting.then((said) => {
      // What the adoption did not reach. A merge that changed nothing on this
      // device can still have dropped what the other device sent, and that
      // round adopts nothing and so says nothing on its own.
      const cost = sayWhatWentMissing() || said;
      // And no "Synced." over the top of it: a round trip that had to drop
      // somebody's writing is not a successful sync with a footnote, and the
      // sentence about what it cost is the one that has to be left on screen.
      if (loud && merged !== undefined && !cost) toast('Synced.');
    }))
    .catch((e) => { if (loud) toast(`Could not sync: ${e.message || 'no connection'}.`); });
}

function renderSyncState() {
  const line = $('#sync-state'), keyEl = $('#sync-key'), acts = $('#sync-actions');
  if (!line || !globalThis.DSSync) return;
  const s = DSSync.status();

  if (s.available === false) {
    // The backup file below this line holds the review history, the notes and
    // the cards layer — never the deck. Saying it moves one would be the app
    // offering a way out that does not exist, on the screen somebody reads
    // before deciding they can remove the deck.
    line.textContent = 'Built-in courses can sync your progress, your notes and the cards '
      + 'you write. A deck you import or write stays on this device: the backup file below '
      + 'holds what you have answered and the cards you wrote, and no file holds the deck.';
    keyEl.hidden = true;
    acts.innerHTML = '';
    return;
  }

  if (!s.on) {
    line.textContent = 'Sync is off. Your progress is on this device only.';
    keyEl.hidden = true;
    acts.innerHTML = '<button class="ghost" data-sync="new">Turn on sync</button>'
      + '<button class="ghost" data-sync="join">Use a key from another device</button>';
    return;
  }

  line.textContent = syncBusy ? 'Syncing…'
    // "It will try again" is true of a failure that is about the network and
    // false of one that is about this deck: a blob over the server's bound
    // produces the same answer every time, so the promise read as "wait" when
    // the message beside it had just said what to do.
    : s.err ? `Last sync did not finish: ${s.err}.${s.errYours ? '' : ' It will try again.'}`
    : s.at ? `Synced ${agoText(s.at)}. Type this key into your other device.`
    : 'Sync is on, but nothing has reached the server yet.';
  keyEl.hidden = false;
  keyEl.textContent = DSSync.formatKey(s.key);
  // No "sync now": it happens on open, on coming back to the app, and after
  // every session. A button offering to do what already happened is a button
  // that suggests it might not have.
  acts.innerHTML = '<button class="ghost" data-sync="copy">Copy key</button>'
    + '<button class="ghost" data-sync="off">Turn off sync</button>';
}

function renderClubMoments() {
  const now = Date.now();
  const club = clubFacts();
  membershipMoment = AchievementEngine.buildMembershipMoment({
    at: now,
    answers: club.answers,
    solidCards: club.solidCards,
    clubStreak: club.clubStreak,
    courseCount: club.courseCount,
  });
  const membership = $('#membership-card');
  membership.hidden = !membershipMoment.eligible;
  if (membershipMoment.eligible) {
    $('#membership-art').innerHTML = doodle('tower');
    $('#membership-copy').textContent = membershipMoment.description;
    $('#membership-stats').innerHTML = `
      <span><b>${club.clubStreak}</b> day streak</span>
      <span><b>${club.solidCards}</b> solid</span>
      <span><b>${club.answers}</b> answers</span>`;
  }

  monthlyMoment = AchievementEngine.buildMonthlyRecap({
    at: now,
    days: club.days,
    solidCards: club.solidCards,
    courseCount: club.courseCount,
    clubStreak: club.clubStreak,
  });
  const month = $('#month-card');
  month.hidden = !monthlyMoment.eligible;
  if (monthlyMoment.eligible) {
    $('#month-title').textContent = monthlyMoment.title;
    $('#month-copy').textContent = monthlyMoment.description;
    $('#month-art').innerHTML = doodle('tower');
  }
}

function renderNotifications() {
  const card = $('#notifications-card');
  if (!globalThis.KeepNotifications) {
    card.hidden = true;
    return;
  }
  const status = KeepNotifications.status();
  card.hidden = !status.supported;
  if (!status.supported) return;
  const button = $('#notifications-btn');
  const note = $('#notifications-note');
  button.disabled = false;
  if (status.permission === 'denied') {
    note.textContent = 'Notifications are blocked for this site. You can allow them in your browser settings.';
    button.textContent = 'Notifications blocked';
    button.disabled = true;
  } else if (status.enabled) {
    // What it does, and nothing about what it does not. The second sentence
    // here spent a line of a settings sheet apologising for a feature that has
    // never been offered, in words ("a push service") that only mean something
    // to whoever would have had to build it.
    note.textContent = 'Milestones can appear when keep club is in the background.';
    button.textContent = 'Turn off milestone notifications';
  } else {
    note.textContent = 'Allow milestone notifications when keep club is in the background.';
    button.textContent = 'Enable milestone notifications';
  }
}

function renderStats() {
  rollDay();
  const club = clubFacts();
  const buckets = { new: 0, learning: 0, young: 0, mature: 0 };
  for (const c of DECK.cards) buckets[stateOf(c.cardId)]++;
  const acc = state.revTotal ? Math.round((state.revGood / state.revTotal) * 100) : null;

  $('#stats-sub').textContent = `${countStudiedToday()} answers today`;
  // Four, not six. The two that went were the accuracy and the total behind it:
  // on a fresh account one of them read "n/a — not enough data yet", which is a
  // tile whose whole content is an apology, and the other said 0 about the same
  // thing from the other side. Both are the line under the tiles, and only once
  // the deck has handed a card back. Club streak stays first.
  const tiles = [
    [club.clubStreak, 'club streak <small>— across every course</small>'],
    [buckets.mature, 'solid <small>— still there in three weeks</small>'],
    [buckets.young + buckets.learning, 'seen, not solid yet'],
    [buckets.new, 'not started'],
  ];
  $('#stat-tiles').innerHTML = tiles
    .map(([value, say]) => `<div class="tile"><b>${value}</b><span>${say}</span></div>`)
    .join('');
  const repeat = $('#repeat-line');
  repeat.hidden = acc === null;
  repeat.textContent = acc === null ? ''
    : `You have got ${acc}% of ${plural(state.revTotal, 'repeat card')} right.`;

  // forecast
  const now = Date.now();
  const bins = new Array(7).fill(0);
  for (const c of DECK.cards) {
    const r = state.recs[c.cardId];
    if (!r || r.st !== 'r') continue;
    const d = Math.round((startOfDay(r.due) - startOfDay(now)) / DAY);
    if (d <= 0) bins[0]++;
    else if (d < 7) bins[d]++;
  }
  const peak = Math.max(1, ...bins);
  const names = ['Today', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 1; i < 7; i++) {
    names[i] = new Date(addCalendarDays(now, i))
      .toLocaleDateString('en-GB', { weekday: 'short' });
  }
  // Seven stubs of nothing under a dotted axis is a chart with no reading in
  // it, and on a fresh account that is what it always is. Same element, same
  // role="img", same computed label — one sentence instead of the drawing.
  const anyDue = bins.some(Boolean);
  $('#forecast').classList.toggle('none', !anyDue);
  $('#forecast').innerHTML = !anyDue
    ? 'Nothing is scheduled yet. Cards come back once you have answered them.'
    : bins.map((n, i) => `
    <div class="fc-col">
      <span class="fc-n">${n || ''}</span>
      <span class="fc-bar ${n ? '' : 'empty'}" style="height:${n ? Math.max(6, (n / peak) * 68) : 3}px"></span>
      <span class="fc-d">${names[i]}</span>
    </div>`).join('');
  $('#forecast').setAttribute('aria-label',
    'Cards due: ' + bins.map((n, i) => `${names[i]} ${n}`).join(', '));

  // One pass for the whole deck rather than one per section: this used to walk
  // all 537 cards twenty-four times over to fill twenty-four bars.
  const bySect = new Map(DECK.sections.map((s) =>
    [s.sectionId, { new: 0, learning: 0, young: 0, mature: 0 }]));
  for (const c of DECK.cards) {
    const b = bySect.get(c.sectionId);
    if (b) b[stateOf(c.cardId)]++;
  }
  $('#mastery').innerHTML = byGroup().map(([g, inside]) => {
    const rows = inside.map((s) => {
      const b = bySect.get(s.sectionId);
      const p = (x) => (x / s.cardCount) * 100;
      return `<li>
      <span>${escapeHtml(s.title)}</span>
      <span class="m-n">${b.mature} solid · ${b.young + b.learning} seen · ${s.cardCount} total</span>
      <span class="m-bar" role="img" aria-label="${b.mature} known well, ${b.young} bedding in, ${b.learning} learning, ${b.new} not started">
        <i class="m-mature" style="width:${p(b.mature)}%"></i>
        <i class="m-young" style="width:${p(b.young)}%"></i>
        <i class="m-learn" style="width:${p(b.learning)}%"></i>
      </span></li>`;
    }).join('');
    // The theme's own share of solid cards, which is the number you would
    // otherwise be adding up off four bars by eye.
    const tot = inside.reduce((t, s) => t + s.cardCount, 0);
    const solid = inside.reduce((t, s) => t + bySect.get(s.sectionId).mature, 0);
    return (g.title ? `<h3 class="h-part"><span>${escapeHtml(g.title)}</span>`
      + `<span class="h-part-n">${Math.round((solid / tot) * 100)}% solid</span></h3>` : '')
      + `<ul class="mastery">${rows}</ul>`;
  }).join('');

  renderClubMoments();
  renderAch();
  // The setup sheet is a different room now, but it is still drawn from this
  // deck's own numbers — the build line counts these cards, the exam hint is
  // worked out over them — so a visit to Progress refreshes it too. Doing it
  // here as well as in openSetup() costs a handful of writes to elements
  // nobody is looking at, and buys the guarantee that what the sheet says is
  // never older than the last time the deck under it changed.
  renderSetup();
}

/* Everything inside the setup sheet, drawn from the state under it.
 *
 * Called from openSetup(), because the sheet opens from all three tabs and two
 * of them never render Progress at all — and from renderStats(), because these
 * are still the deck's own numbers and Progress is where the deck's numbers
 * are re-counted. Re-asked rather than done once at boot: on a first load the
 * service worker registration is still being made when the app finishes
 * starting, and the answers install/offline give depend on it. */
function renderSetup() {
  // First, because the theme is the one setting in here that something else can
  // change while the sheet is shut. The picker carries its own toggle, and the
  // glyph followed it home while the word beside it did not: a plainly dark app
  // whose Theme row read "light" and whose label offered to switch you to the
  // colour you were already in. The row is re-read from the theme, not from
  // whatever it was showing the last time it was opened.
  applyTheme();
  $('#set-new').value = state.settings.newPerDay;
  $('#set-max').value = state.settings.maxRev;
  $('#set-shuffle').checked = state.settings.shuffle;
  $('#exam-row').hidden = !EXAM_ON;
  $('#set-exam').value = state.settings.examDate || '';
  const d = daysToExam();
  // Nothing at all when there is no date. The line that used to stand here was
  // the exam ask from Home said again in other words, on a control whose own
  // label already says what it is for.
  // Not the date: the control ten pixels to the right of this line is the date,
  // and printing it here as well left one fact stated twice in two formats in
  // the row whose job is to hold it once. What the label says is what the
  // control cannot — what setting it does to the spacing.
  $('#exam-hint').textContent = d === null ? ''
    : d < 0 ? 'That date has passed. Clear it to go back to normal spacing.'
      : `No card will be left longer than ${fmtDays(ceiling())} between reviews.`;
  const auto = newBudget();
  $('#new-hint').textContent = auto > state.settings.newPerDay
    ? `Raised to ${auto} a day to get through the deck before your exam.`
    : '';
  // The count is a fact about the deck; the fingerprint is a sha shown to
  // somebody revising for an exam. It stays where support can still ask for it.
  const build = $('#build-line');
  build.textContent = `${plural(DECK.cards.length, 'card')} in this deck.`;
  build.title = `Deck build ${DECK.buildFingerprint || 'unknown'}`;
  applyFontSize();
  renderOrientationSetting();
  renderOffline();
  renderInstall();
  renderNotifications();
  renderBackupState();
  renderDeckFileState();
  renderSyncState();
}

/* This setting belongs to the shell and this browser, not to `state.settings`:
 * changing it must never stamp, sync or back up the deck under the sheet. */
function renderOrientationSetting() {
  const input = $('#set-auto-rotate');
  const hint = $('#orientation-hint');
  if (!input || !hint || !globalThis.MuninOrientation) return;
  const status = MuninOrientation.status();
  input.checked = status.autoRotate;
  // Locking needs the API and an installed/fullscreen context. Clearing a
  // saved lock does not: leave an unchecked control usable in an ordinary tab
  // so nobody is trapped in a choice they made in the installed app.
  input.disabled = !status.storageAvailable || (status.autoRotate
    && (!status.supported || !status.inLockContext));
  input.setAttribute('aria-busy', status.pending ? 'true' : 'false');

  if (status.pending) {
    hint.textContent = 'Changing the screen rotation…';
  } else if (status.error === 'storage') {
    hint.textContent = 'Could not remember this choice on this device.';
  } else if (status.target && !status.supported) {
    hint.textContent = 'A screen lock is saved. Turn this on to clear it; this browser cannot apply it.';
  } else if (status.target && !status.inLockContext) {
    hint.textContent = 'Saved for the installed app. Turn this on to clear it here.';
  } else if (!status.supported) {
    hint.textContent = 'Use this device’s rotation lock — this browser cannot control it.';
  } else if (!status.inLockContext) {
    hint.textContent = 'Available when keep club is installed or open full screen.';
  } else if (status.error) {
    hint.textContent = 'Could not change the rotation. The screen may still rotate.';
  } else if (status.target) {
    hint.textContent = `Locked in ${status.target.startsWith('portrait') ? 'portrait' : 'landscape'}.`;
  } else {
    hint.textContent = 'Turn this off to keep the screen in its current direction.';
  }
}
globalThis.renderOrientationSetting = renderOrientationSetting;

/** Re-draw the sheet when the state under it was replaced by another tab, a
 *  merge or a restore, rather than leaving settings that are no longer set. */
function renderSetupIfOpen() {
  if (!$('#setup').hidden) renderSetup();
}

/* The dialog contract, copied from the card sheet: role, aria-modal, an inert
 * background, Tab contained, Escape, a history entry, and focus handed back to
 * whichever of the three headers opened it. */
let setupOpener = null;

function openSetup(opener) {
  const panel = $('#setup');
  if (!panel.hidden) return;
  setupOpener = opener || null;
  renderSetup();
  panel.hidden = false;
  document.body.style.overflow = 'hidden';
  // The sheet is a sibling of #app so it is not inerting itself.
  setBackgroundInert(true);
  // The first thing in the sheet rather than its ✕: opening settings lands you
  // on the group that is open, which is also what says the sheet has groups.
  $('#setup-display').focus({ preventScroll: true });
  pushStop('setup');
}

function closeSetup(fromHistory) {
  const panel = $('#setup');
  if (panel.hidden) return;
  panel.hidden = true;
  document.body.style.overflow = '';
  setBackgroundInert(false);
  if (setupOpener && setupOpener.isConnected && setupOpener.focus) {
    setupOpener.focus({ preventScroll: true });
  } else focusScreen(current);
  setupOpener = null;
  if (!fromHistory && stops[stops.length - 1] === 'setup') history.back();
}

/* ─────────────────────────── lightbox ─────────────────────────── */

// `fit` is the scale at which the whole thing is on screen — 1 for anything
// that already fits, less than 1 for anything that does not. It is the floor
// for every zoom here, because a picture you cannot see all of is not the
// bottom of the range.
const lb = { scale: 1, fit: 1, tx: 0, ty: 0, base: null, pointers: new Map(), lastTap: 0, pinch: null, opener: null, node: null };

function openLightbox(card, mediaItem, resolvedUrl) {
  const img = $('#lb-img');
  const figBox = $('#lb-fig');
  const image = mediaItem || backImage(card);
  const isFig = !image && card.figure && FIGURES && FIGURES[card.figure.figureId];
  lb.opener = document.activeElement;
  img.hidden = !!isFig;
  figBox.hidden = !isFig;
  lb.node = isFig ? figBox : img;
  // Every diagram opens where it was left, not where the last one was left.
  // The transform stays on the node after a close, and fit() below measures the
  // node with getBoundingClientRect() — so the zoom and pan of whatever you were
  // last looking at were baked into the measurement of the next thing you
  // opened, and it arrived as a postage stamp parked off the right-hand edge.
  lb.scale = 1; lb.fit = 1; lb.tx = 0; lb.ty = 0;
  img.style.transform = '';
  figBox.style.transform = '';
  $('#lb-stage').dataset.kind = isFig ? 'fig' : 'img';
  if (isFig) {
    img.removeAttribute('src');
    figBox.innerHTML = figureSVG(card);
    litFigure(figBox, card);
    // Deliberately no drawFigureOn(): the enlarged figure is the one you were
    // already looking at, and re-drawing it here means watching the same
    // drawing arrive twice — the second time while you are trying to zoom it.
  } else {
    figBox.innerHTML = '';
    img.src = resolvedUrl || courseMediaUrl(image);
    img.alt = image.alternativeText || `Diagram: ${stripTags(card.front || '')}`;
  }
  $('#lb-title').textContent = stripTags(card.front || image?.alternativeText || 'Image').slice(0, 90);
  $('#lightbox').hidden = false;
  document.body.style.overflow = 'hidden';
  // aria-modal alone does not stop Tab walking into the page behind the
  // overlay; inert does, and it is what the attribute is claiming.
  // The skip link is a sibling of #app, so inerting #app alone leaves it
  // tabbable behind the overlay — and activating it fires a fragment
  // navigation, which pops a history entry the app was relying on.
  setBackgroundInert(true);
  const openedNode = lb.node;
  const fit = () => {
    // Image loading and requestAnimationFrame both outlive a quick close. A
    // stale callback must not measure the cleared node—or a newer diagram.
    if ($('#lightbox').hidden || lb.node !== openedNode || !openedNode) return;
    lb.base = lb.node.getBoundingClientRect();
    const stage = $('#lb-stage').getBoundingClientRect();
    lb.base = { x: lb.base.x - stage.x, y: lb.base.y - stage.y, w: lb.base.width, h: lb.base.height };
    // These diagrams are dense line art. Fitting one into a phone screen makes the
    // labels unreadable, so open at a scale that gives the drawing room to be read
    // and let the reader pan, rather than opening at a useless "fits perfectly".
    // A figure is drawn to be read at card size, so it opens to fit and zooms
    // from there; a diagram is a dense reference page and opens already big.
    const natural = isFig
      ? Number(FIGURES[card.figure.figureId].vb.split(/\s+/)[2]) || lb.base.w
      : img.naturalWidth / 2;
    // Fitting means both axes. Sized on width alone, a tall figure opened half
    // a screen below the stage on a phone held sideways — and the fit control,
    // which only knew about zooming out from a scale of 1, zoomed further in.
    lb.fit = Math.min(1, stage.width / Math.max(1, lb.base.w),
      stage.height / Math.max(1, lb.base.h));
    const wanted = isFig ? lb.base.w * lb.fit : Math.min(1000, natural);
    lb.scale = clamp(wanted / Math.max(1, lb.base.w), lb.fit, 4);
    // Open at the top-left corner, not the middle: every diagram puts its title
    // and first panel there, so that is where reading starts.
    lb.tx = -lb.base.x;
    lb.ty = -lb.base.y;
    clampPan();
    apply();
  };
  if (isFig || img.complete) requestAnimationFrame(fit);
  else img.onload = () => requestAnimationFrame(fit);
  $('#lb-close').focus({ preventScroll: true });
  pushStop('lightbox');
}

function closeLightbox(fromHistory) {
  if ($('#lightbox').hidden) return;
  $('#lightbox').hidden = true;
  document.body.style.overflow = '';
  setBackgroundInert(false);
  $('#lb-img').onload = null;
  $('#lb-img').removeAttribute('src');
  $('#lb-fig').innerHTML = '';
  lb.node = null;
  if (lb.opener && lb.opener.focus) lb.opener.focus({ preventScroll: true });
  if (!fromHistory && stops[stops.length - 1] === 'lightbox') history.back();
}

/* The phone's Back gesture is the most-used control on Android and it must not
 * throw you out of the app just because a diagram is open. Each modal-ish state
 * pushes a history entry; popstate unwinds exactly one level. Closing from
 * inside the app calls history.back() and lets the same handler do the work,
 * so there is one code path however you leave. */
const stops = [];
function pushStop(name) {
  stops.push(name);
  history.pushState({ stop: name }, '');
}
/* A reload mid-session leaves the entries this pushed behind: the page comes
 * back sitting on top of one with `stops` empty. The press that pops it then
 * found nothing recorded and nothing open and did nothing at all — the app
 * eating a Back press for a state it no longer has. */
let strays = !!(history.state && history.state.stop);
addEventListener('popstate', () => {
  // The shell's picker/importer own their history entries. Their listeners
  // were added after this one, so the dialog is still present while this
  // callback runs; leave this Back press for the top modal to consume.
  if (document.querySelector('.imp, .shelf.on[role="dialog"]')) return;
  const top = stops.pop();
  if (top === 'lightbox') return closeLightbox(true);
  if (top === 'notes') return closeNotes(true);
  if (top === 'card-sheet') return closeCardSheet(true);
  if (top === 'setup') return closeSetup(true);
  if (top === 'ach-sheet') return closeAchSheet(true);
  if (top === 'study') return leaveStudy(true);
  // A tab is one press above the course's home screen, however many tabs you
  // walked through to get to this one.
  if (top === 'tab') return go('home', true);
  // No stop recorded. A reload leaves the pushed history entries behind while
  // `stops` starts empty, and a fragment link fires popstate of its own. Unwind
  // whatever is actually open rather than doing nothing, which reads as a Back
  // press that the app swallowed.
  if (!$('#lightbox').hidden) return closeLightbox(true);
  if (!$('#notes').hidden) return closeNotes(true);
  if (!$('#card-sheet').hidden) return closeCardSheet(true);
  if (!$('#setup').hidden) return closeSetup(true);
  if (!$('#ach-sheet').hidden) return closeAchSheet(true);
  if (current === 'study' || current === 'done') return leaveStudy(true);
  // Nothing of ours is open, so this was one of those leftovers. Step past it —
  // and past any others under it, which `history.state` names — so that one
  // press still means one thing.
  if (strays) {
    strays = !!(history.state && history.state.stop);
    history.back();
  }
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* Tab, contained inside one dialog. aria-modal says the rest of the page is not
 * there; inert makes that true for the Tab key on the way out of the dialog,
 * and this is what makes it true on the way round the end of it. Hidden and
 * zero-box elements are left out: a control in a closed branch of the sheet is
 * not a stop, and landing on one is a Tab that appears to do nothing. */
function containTab(box, e) {
  // `summary` is in the list because a dialog may be built out of folded
  // groups, and a group you cannot Tab onto is a group the keyboard cannot
  // open. The two sheets that have no summaries are unaffected.
  const focusable = Array.from(box.querySelectorAll(
    'button:not([disabled]), a[href], textarea:not([disabled]), summary,'
      + ' select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => {
    if (el.hidden || !el.getClientRects().length) return false;
    // A closed <details> is not "no box" — the browser reports rectangles for
    // everything inside it and refuses to focus any of it. Left in, the last
    // control in the last folded group is the one the wrap-around waits for,
    // which is a wrap-around that never happens and a Tab that walks out of
    // the dialog. The way into a folded group is its own summary.
    const folded = el.closest('details:not([open])');
    return !folded || (el.tagName === 'SUMMARY' && el.parentElement === folded);
  });
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  const inside = box.contains(document.activeElement);
  if (e.shiftKey && (document.activeElement === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

function setBackgroundInert(on) {
  $('#app').inert = on;
  const skip = document.querySelector('.skip');
  if (skip) skip.inert = on;
  const shelf = document.querySelector('.shelf-btn');
  if (shelf) shelf.inert = on;
}

function apply() {
  if (lb.node) lb.node.style.transform = `translate(${lb.tx}px,${lb.ty}px) scale(${lb.scale})`;
  // The hint has to follow the zoom, or it tells you to double-tap to fit while
  // you are already looking at the whole diagram.
  const zoomed = lb.scale > lb.fit * 1.05;
  $('#lb-hint').textContent = zoomed
    ? 'Drag to pan · double-tap to fit the whole diagram · pinch to zoom'
    : 'Double-tap or pinch to zoom in · drag to pan';
  $('#lb-title').dataset.zoom = zoomed ? 'in' : 'fit';
  // Here rather than in the fit button's own handler, which only ran after the
  // first press: a figure opens fitted, and until you pressed it the control
  // offered to fit something that was already fitted.
  $('#lb-fit').setAttribute('aria-label', zoomed ? 'Fit the whole diagram on screen' : 'Zoom in');
}

function clampPan() {
  if (!lb.base) return;
  const st = $('#lb-stage').getBoundingClientRect();
  const w = lb.base.w * lb.scale, h = lb.base.h * lb.scale;
  if (w <= st.width) lb.tx = (st.width - w) / 2 - lb.base.x;
  else lb.tx = clamp(lb.tx, st.width - (lb.base.x + w), -lb.base.x);
  if (h <= st.height) lb.ty = (st.height - h) / 2 - lb.base.y;
  else lb.ty = clamp(lb.ty, st.height - (lb.base.y + h), -lb.base.y);
}

function zoomAt(cx, cy, next) {
  const st = $('#lb-stage').getBoundingClientRect();
  const px = cx - st.x, py = cy - st.y;
  const k = next / lb.scale;
  lb.tx = px - k * (px - lb.tx);
  lb.ty = py - k * (py - lb.ty);
  lb.scale = next;
  clampPan();
  apply();
}

function initLightbox() {
  const stage = $('#lb-stage');

  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (lb.pointers.size === 2) {
      const [a, b] = Array.from(lb.pointers.values());
      lb.pinch = { d: dist(a, b), s: lb.scale };
    }
  });

  stage.addEventListener('pointermove', (e) => {
    const p = lb.pointers.get(e.pointerId);
    if (!p) return;
    const prev = { x: p.x, y: p.y };
    p.x = e.clientX; p.y = e.clientY;
    if (lb.pointers.size === 2 && lb.pinch) {
      const [a, b] = Array.from(lb.pointers.values());
      const d = dist(a, b);
      const next = clamp(lb.pinch.s * (d / lb.pinch.d), lb.fit, 6);
      zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, next);
    } else if (lb.pointers.size === 1) {
      lb.tx += e.clientX - prev.x;
      lb.ty += e.clientY - prev.y;
      clampPan();
      apply();
    }
  });

  const up = (e) => {
    lb.pointers.delete(e.pointerId);
    if (lb.pointers.size < 2) lb.pinch = null;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  stage.addEventListener('click', (e) => {
    const now = Date.now();
    if (now - lb.lastTap < 320) {
      const next = lb.scale > lb.fit * 1.2 ? lb.fit : 2.6;
      zoomAt(e.clientX, e.clientY, next);
      lb.lastTap = 0;
    } else {
      lb.lastTap = now;
    }
  });

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, clamp(lb.scale * (e.deltaY < 0 ? 1.15 : 0.87), lb.fit, 6));
  }, { passive: false });

  $('#lb-close').addEventListener('click', () => closeLightbox());
  // A visible control at the top, where the eye starts. The hint at the bottom
  // of the screen was read too late: a diagram that opens zoomed and cropped
  // looks broken until you know it is deliberate.
  $('#lb-fit').addEventListener('click', () => {
    const st = $('#lb-stage').getBoundingClientRect();
    // `lb.fit`, not 1: fitting a figure that is taller than the stage means
    // going below 1, and this used to hand it 2.6 — twice as far off screen as
    // it already was, from the control that offered to fit it.
    zoomAt(st.x + st.width / 2, st.y + st.height / 2,
      lb.scale > lb.fit * 1.05 ? lb.fit : 2.6);
  });
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ─────────────────────────── misc ─────────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Card text for places that take plain text — image alt, the lightbox title.
 * The browser owns the entity table: a hand-rolled list of five replacements
 * left "145&deg;T" being read out to screen-reader users as written. */
const decoder = document.createElement('textarea');
function stripTags(s) {
  decoder.innerHTML = String(s).replace(/<[^>]*>/g, '');
  return decoder.value;
}

/** Resolve imported media only when its card is actually rendered. Imported
 * decks keep `munin-media:<index>` placeholders in their HTML; turning every
 * Blob into an object URL during boot made peak memory scale with the entire
 * media library. */
function hydrateMedia(root, load = true) {
  if (!root || typeof COURSE.mediaUrl !== 'function') return;
  for (const el of root.querySelectorAll('[src^="munin-media:"], [data-munin-media]')) {
    const raw = el.getAttribute('src');
    const m = /^munin-media:(\d+)$/.exec(raw || '');
    const index = m ? Number(m[1]) : Number(el.dataset.muninMedia);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    el.dataset.muninMedia = String(index);
    el.removeAttribute('src');
    if (!load || el.dataset.muninLoaded === '1') continue;
    el.dataset.muninLoaded = '1';
    COURSE.mediaUrl(index).then((url) => {
      if (!url) { delete el.dataset.muninLoaded; return; }
      if (!el.isConnected || el.dataset.muninMedia !== String(index)) return;
      el.src = url;
      if (el.tagName === 'AUDIO' || el.tagName === 'VIDEO') el.load();
    }).catch(() => { delete el.dataset.muninLoaded; });
  }
}

function hydrateSectionArtwork(root) {
  if (!root || typeof COURSE.resolveMediaSource !== 'function') return;
  for (const image of root.querySelectorAll('img[data-course-section-art]')) {
    const source = image.dataset.courseSectionArt;
    if (!source || image.dataset.courseSectionArtLoaded === '1') continue;
    image.dataset.courseSectionArtLoaded = '1';
    COURSE.resolveMediaSource(source).then((url) => {
      if (!url || !image.isConnected || image.dataset.courseSectionArt !== source) {
        delete image.dataset.courseSectionArtLoaded;
        return;
      }
      const fallback = image.parentElement?.querySelector('.doodle');
      image.addEventListener('load', () => {
        if (!image.isConnected) return;
        image.hidden = false;
        if (fallback) fallback.hidden = true;
      }, { once: true });
      image.src = url;
    }).catch(() => { delete image.dataset.courseSectionArtLoaded; });
  }
}

function resetSectionArtwork() {
  for (const image of document.querySelectorAll('img[data-course-section-art]')) {
    image.removeAttribute('src');
    image.hidden = true;
    delete image.dataset.courseSectionArtLoaded;
    const fallback = image.parentElement?.querySelector('.doodle');
    if (fallback) fallback.hidden = false;
  }
}

addEventListener('muninmediareset', () => {
  // Imported blob URLs are generation-scoped. A BFCache restore keeps this
  // document but needs fresh URLs for the visible question, revealed answer,
  // and any Browse answers the reader left open.
  hydrateMedia($('#card-q'), !!session);
  const card = currentCard();
  if (session?.revealed && hasBackContent(card) && typeof card.back === 'string') {
    hydrateMedia($('#card-a'));
  }
  if (COURSE_MEDIA) {
    COURSE_MEDIA.resetCourseMedia();
    hydrateDescriptiveMedia($('#card-front-media'));
    if (session?.revealed) hydrateDescriptiveMedia($('#card-back-media'));
  }
  for (const row of $$('#browse-list li')) {
    hydrateDescriptiveMedia(row.querySelector('.b-front-media'));
    const details = row.querySelector('details');
    if (details?.open) {
      hydrateMedia(row);
      hydrateDescriptiveMedia(row.querySelector('.b-back-media'));
    }
  }
  resetSectionArtwork();
  hydrateSectionArtwork($('#section-list'));
  hydrateSectionArtwork($('#browse-index'));
});

let toastTimer = null;
function toast(msg, sticky = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('away');
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { t.classList.add('away'); }, 3400);
}

/** Is this a date a person could have meant, or a year still being typed? */
function plausibleExam(v) {
  return validExamDate(v);
}

/* The same window, told to the native picker, so its own arrows and its
 * validation agree with what the app will accept. */
function boundExamInputs() {
  for (const el of [$('#home-exam'), $('#set-exam')]) {
    el.min = EXAM_MIN_YEAR + '-01-01';
    el.max = EXAM_MAX_YEAR + '-12-31';
  }
}

/* The theme is Munin's, shared by the shelf and every course (see munin.js).
 * A course cannot hold its own — you would change colour by changing deck. */
function applyTheme() {
  MuninTheme.apply();
  // What it says, not what was chosen: light is light whether you picked it or
  // simply never picked anything, and the button offers the other one either way.
  const showing = MuninTheme.showing();
  $('#theme-btn').title = `Colour theme: ${showing}`;
  // In the sheet the drawing has room for its own name beside it, so the
  // control says which colour you are in as well as drawing it. The label the
  // button is read out under says what pressing it does.
  $('#theme-name').textContent = showing;
  $('#theme-btn').setAttribute('aria-label',
    `Colour theme: ${showing}. Switch to ${showing === 'dark' ? 'light' : 'dark'}.`);
}

/* Text size, unlike the theme, IS the course's — it rides in the review
 * document so Sync carries it to your other device with the rest of the block.
 * The shelf paints before any of that is read and stays at the default; the
 * attribute is only ever written here, and entering or leaving a course is a
 * reload, so no course's size can survive onto the shelf behind it.
 *
 * Called beside applyTheme() everywhere, and for the same reason: both are
 * chrome that has to agree with a state document this app did not necessarily
 * write — a merge, another tab's write, a restored backup, an erase.
 *
 * At boot it runs immediately after load(), while #app is still hidden behind
 * the loading screen, so the first frame anyone sees is already at their size.
 * Setting it any later is a flash of 15px type on a phone that asked for 19. */
function applyFontSize() {
  document.documentElement.setAttribute('data-font', state.settings.fontSize);
  // The five buttons are marked from the same value the attribute is written
  // from, here rather than in the sheet's own render, so the control is
  // standing on the right step whoever changed it — this tab, another tab, a
  // merge, a restored backup — and before the sheet has ever been opened.
  for (const b of $$('#set-font button')) {
    const on = b.dataset.fontStep === state.settings.fontSize;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

/* ─────────────────────────── wiring ─────────────────────────── */

function wire() {
  $$('#nav button').forEach((b) => b.addEventListener('click', () => goTab(b.dataset.go)));

  $('#study-all').addEventListener('click', (e) => {
    startSession(null, e.currentTarget.dataset.mode === 'ahead' ? { ahead: true } : {});
  });
  $('#reveal-btn').addEventListener('click', reveal);
  // Tapping the card itself is the gesture people expect from every other
  // flashcard app. Ignore it if they were selecting text to copy.
  $('#card-scroll').addEventListener('click', (e) => {
    if (session && session.revealed) return;
    if (e.target.closest('button, a')) return;
    const sel = getSelection();
    if (sel && String(sel).length > 2) return;
    reveal();
  });
  $$('.grade').forEach((b) => b.addEventListener('click', () => answer(+b.dataset.g)));
  $('#undo-btn').addEventListener('click', undo);
  $('#study-back').addEventListener('click', () => leaveStudy(false));
  $('#end-btn').addEventListener('click', () => leaveStudy(false));
  $('#fig-btn').addEventListener('click', () => {
    const c = currentCard();
    if (backImage(c)) openLightbox(c);
  });
  $('#figure-plate').addEventListener('click', () => {
    const c = currentCard();
    if (c && c.figure) openLightbox(c);
  });
  boundExamInputs();
  wireVideo('#card-video');
  wireVideo('#done-reel');
  $('#unlock').addEventListener('click', dismissUnlock);
  $('#done-home').addEventListener('click', () => leaveStudy(false));
  $('#done-more').addEventListener('click', () => startSession(null, {}));
  $('#done-share').addEventListener('click', (e) =>
    shareMoment(lastDoneMoment, e.currentTarget, $('#done-share-status')));
  $('#membership-share').addEventListener('click', (e) =>
    shareMoment(membershipMoment, e.currentTarget, $('#membership-share-status')));
  $('#month-share').addEventListener('click', (e) =>
    shareMoment(monthlyMoment, e.currentTarget, $('#month-share-status')));
  $('#ach-list').addEventListener('click', (e) => {
    const row = e.target.closest('#ach-list > li.earned');
    if (!row) return;
    celebrateRow(row);
    const tap = e.target.closest('.ach-tap');
    if (tap.dataset.momentId) {
      openAchSheet(progressMoments.get(tap.dataset.momentId), tap);
      return;
    }
    const id = tap.dataset.achId;
    const record = AchievementEngine.record({
      id,
      at: visibleUnlocks()[id],
      context: achievementContext(null),
      course: COURSE,
    });
    openAchSheet(record, tap);
  });
  $('#ach-sheet-close').addEventListener('click', () => closeAchSheet(false));
  $('#ach-sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeAchSheet(false);
  });
  $('#notifications-btn').addEventListener('click', async () => {
    const status = KeepNotifications.status();
    if (status.enabled) KeepNotifications.disable();
    else await KeepNotifications.enable();
    renderNotifications();
  });

  $('#set-auto-rotate').addEventListener('change', async (event) => {
    const input = event.currentTarget;
    // Keep the native control focusable while lock() settles. A second change
    // during that short window is redrawn to the in-flight request rather than
    // starting a competing platform operation.
    if (MuninOrientation.pending) {
      renderOrientationSetting();
      return;
    }
    const autoRotate = input.checked;
    const changed = await MuninOrientation.setAutoRotate(autoRotate);
    renderOrientationSetting();
    if (!changed) {
      toast(autoRotate
        ? 'Could not turn auto-rotation back on in this browser.'
        : 'Could not lock the screen in its current direction.');
    }
  });

  $('#theme-btn').addEventListener('click', () => {
    MuninTheme.cycle();
    applyTheme();
  });

  // One control, drawn into all three headers, so there is no tab from which
  // the theme or the text size cannot be reached.
  $$('.setup-btn').forEach((b) =>
    b.addEventListener('click', (e) => openSetup(e.currentTarget)));
  // The exam banner is rebuilt on every render, so its own way into the sheet
  // is delegated rather than wired to a button that will not be there long.
  $('#exam-banner').addEventListener('click', (e) => {
    const link = e.target.closest('[data-open-setup]');
    if (link) openSetup(link);
  });
  $('#setup-close').addEventListener('click', () => closeSetup(false));
  // Off the sheet closes it, the same test the card sheet uses: this click
  // landed on the backdrop, rather than this click did not land inside it.
  $('#setup').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeSetup(false);
  });

  $('#notes-open').addEventListener('click', (e) => openNotes(e.currentTarget));
  $('#notes-close').addEventListener('click', () => closeNotes(false));
  // Off the card closes it, the way the course picker does — and the test is
  // "this click landed on the backdrop", not "this click did not land inside
  // the card". They are the same sentence until a handler further down redraws
  // the list: Edit and Delete both replace the row they are in, and the click
  // then finishes bubbling from a node with no parent, whose closest('.notes-
  // card') is honestly null. Pressing Edit shut the whole panel.
  $('#notes').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeNotes(false);
  });
  $('#notes-write').addEventListener('submit', (e) => {
    // A <form> so that the phone keyboard offers a submit key and Enter on a
    // desktop does the obvious thing. Nothing here is going anywhere over HTTP.
    e.preventDefault();
    const box = $('#notes-text');
    const done = noteEditing ? editNote(noteEditing, box.value) : addNote(box.value);
    if (!done) return;
    noteEditing = null;
    box.value = '';
    renderNotes();
    box.focus({ preventScroll: true });
  });
  $('#notes-text').addEventListener('input', () => {
    clearNoteInvalid();
    noteSays('');
  });
  $('#notes-cancel').addEventListener('click', cancelNoteEdit);
  // Delegated: the list is re-drawn on every change, and per-row listeners
  // would be re-attached each time to elements that are already gone.
  $('#notes-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-note]');
    if (!row) return;
    const id = row.dataset.note;
    if (e.target.closest('[data-note-edit]')) {
      startNoteEdit(id);
      return;
    }
    if (!e.target.closest('[data-note-delete]')) return;
    // Asked for, like every other destructive thing in this app: there is no
    // undo behind it, and the words were somebody's to write.
    if (!confirm('Delete this note?\n\nThere is no undo, and deleting it here deletes it on your other devices too.')) return;
    // Editing the note that is being deleted leaves the box holding words with
    // nothing to save them to.
    if (noteEditing === id) cancelNoteEdit();
    deleteNote(id);
    $('#notes-text').focus({ preventScroll: true });
  });

  $('#card-close').addEventListener('click', () => closeCardSheet(false));
  $('#card-cancel').addEventListener('click', () => closeCardSheet(false));
  // Off the sheet closes it, and the test is "this click landed on the
  // backdrop" rather than "this click did not land inside the card": Save
  // redraws the sheet under the press, and the click then finishes bubbling
  // from a node whose closest('.sheet-card') is honestly null.
  $('#card-sheet').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeCardSheet(false);
  });
  // A <form> so the phone keyboard offers a submit key and Enter does the
  // obvious thing on a desktop. Nothing here goes anywhere over HTTP.
  $('#card-form').addEventListener('submit', (e) => {
    e.preventDefault();
    saveCardSheet().catch(console.error);
  });
  for (const field of [$('#card-front'), $('#card-back')]) {
    field.addEventListener('input', () => {
      field.removeAttribute('aria-invalid');
      field.removeAttribute('aria-describedby');
      if (!$('#card-front').hasAttribute('aria-invalid')
          && !$('#card-back').hasAttribute('aria-invalid')) {
        cardSays('');
        cardDiagnostics([]);
      }
    });
  }
  // Delegated: this row is rebuilt whenever the sheet re-renders, and per-button
  // listeners would be re-attached each time to elements that are already gone.
  $('#card-more').addEventListener('click', (e) => {
    if (!cardSheet) return;
    if (e.target.closest('[data-card-delete], [data-card-hide]')) {
      removeCardFromSheet().catch(console.error);
      return;
    }
    if (e.target.closest('[data-card-revert]')) revertCardFrom(cardSheet.cardId).catch(console.error);
  });
  $('#browse-write').addEventListener('click', (e) => {
    const scope = $('#sect-filter').value;
    const group = isGroup(scope) ? groupOf.get(scope.slice(GROUP_AT.length)) : null;
    openCardSheet({
      opener: e.currentTarget,
      section: group && group.sectionIds.length ? group.sectionIds[0] : scope,
    });
  });
  $('#browse-hidden').addEventListener('click', () => {
    showingHidden = !showingHidden;
    renderHiddenCards();
  });
  $('#fix-btn').addEventListener('click', (e) => {
    const card = currentCard();
    if (!card) return;
    openCardSheet({ cardId: card.cardId, opener: e.currentTarget });
  });
  /* Where focus goes once one of these has rebuilt the list under it.
   *
   * Every one of them replaces the row the button was on, so the button is gone
   * by the time the browser looks for it and focus drops to <body> — the far
   * end of the document from the list somebody is reading. The same floor
   * closeCardSheet() reaches for: this row's own Edit if the row survived,
   * then the control that opened the hidden list, then the screen's heading. */
  const focusAfterRowAct = (cardId) => {
    const again = $(`#browse-list li[data-card="${CSS.escape(cardId)}"] [data-card-edit]`);
    if (again) { again.focus({ preventScroll: true }); return; }
    const hiddenBtn = $('#browse-hidden');
    if (hiddenBtn && !hiddenBtn.hidden) { hiddenBtn.focus({ preventScroll: true }); return; }
    focusScreen(current);
  };

  // One listener for every row, in both lists, because both are rebuilt whole.
  const cardRowActs = (e) => {
    const row = e.target.closest('li[data-card]');
    if (!row) return;
    const cardId = row.dataset.card;
    if (e.target.closest('[data-card-edit]')) {
      openCardSheet({ cardId, opener: e.target.closest('button') });
      return;
    }
    if (e.target.closest('[data-card-keep]')) {
      keepYourCard(cardId).then((result) => {
        if (result.say) toast(result.say);
        // Only where the list was actually rebuilt. A confirm somebody said no
        // to leaves the row alone, and moving focus off the button they were
        // on would be this function causing the thing it exists to prevent.
        if (result.ok) focusAfterRowAct(cardId);
      }).catch(console.error);
      return;
    }
    if (e.target.closest('[data-card-revert]')) {
      revertCardFrom(cardId)
        .then((result) => { if (result && result.ok) focusAfterRowAct(cardId); })
        .catch(console.error);
    }
  };
  $('#browse-list').addEventListener('click', cardRowActs);
  $('#hidden-list').addEventListener('click', cardRowActs);

  /* A changed result set is a different list, so it starts at the top. Without
     this, narrowing a search while scrolled 1,200px down leaves you in the
     middle of results you have not seen, with the new count off screen. */
  const searchAgain = () => {
    browseLimit = BROWSE_FIRST;
    // The cards you hid belong to the deck, not to what is narrowed, so a list
    // left open across a change of scope sat above a count describing something
    // else entirely — a section-01 card on top of "26 cards in 12 Tides".
    closeHiddenCards();
    renderBrowse();
    const body = $('#s-browse .body');
    if (body) body.scrollTop = 0;
  };
  /* Moving between the index, a theme and a section. The filter control is
     still where the scope lives, so a tile and the dropdown cannot disagree
     about what is on screen. */
  const goScope = (v) => {
    $('#sect-filter').value = v;
    searchAgain();
    // The tile that was pressed is now inside a hidden element, and a browser
    // answers that by dropping focus on <body> — the far end of the document
    // from the list it just opened. The heading is where arriving by tab lands
    // too, so it is the one place that is right for both.
    const h = $('#s-browse h1');
    if (h) h.focus({ preventScroll: true });
  };
  let searchTimer = null;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchAgain, 140);
  });
  // enterkeyhint says "search", so Enter has to do something: run what is typed
  // now rather than in 140ms, and put the phone keyboard away.
  $('#search').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(searchTimer);
    searchAgain();
    // Only where blurring buys something. On a desktop it costs: focus would
    // land on <body>, which is the far end of the document from here.
    if (matchMedia('(pointer: coarse)').matches) e.target.blur();
  });
  $('#sect-filter').addEventListener('change', searchAgain);
  $('#browse-clear').addEventListener('click', () => {
    $('#search').value = '';
    $('#sect-filter').value = '';
    searchAgain();
    $('#search').focus();
  });
  $('#browse-wide').addEventListener('click', () => {
    $('#sect-filter').value = '';
    searchAgain();
    $('#search').focus();
  });
  $('#browse-study').addEventListener('click', () => {
    const sk = $('#sect-filter').value;
    if (sk && sk !== LEECH_FILTER) startSession(sk, {});
  });
  $('#browse-back').addEventListener('click', (e) => {
    goScope(e.currentTarget.dataset.to || '');
  });
  // One listener for twenty-four tiles and seven headings. Delegated because the
  // index is rebuilt wholesale, and a listener per button would have to be too.
  $('#browse-index').addEventListener('click', (e) => {
    const toggle = e.target.closest('.bgroup-toggle');
    if (toggle) {
      const list = document.getElementById(toggle.getAttribute('aria-controls'));
      if (!list) return;
      const open = list.hidden;
      list.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      return;
    }
    const b = e.target.closest('[data-scope]');
    if (!b) return;
    // The theme's own "N cards →" sits inside the summary, so pressing it would
    // fold the theme shut on the way out — and folding it is not what it says
    // it does. The tiles are outside the summary and this costs them nothing.
    e.preventDefault();
    goScope(b.dataset.scope);
  });
  $('#browse-open').addEventListener('click', () => {
    const rows = $$('#browse-list details');
    const opening = !rows.every((d) => d.open);
    rows.forEach((d) => { d.open = opening; });
    syncOpenLabel();
  });
  // `toggle` does not bubble, so this listens on the way down. Opening one
  // answer by hand has to be able to change what the button offers.
  $('#browse-list').addEventListener('toggle', syncOpenLabel, true);
  // A row's drawing is set going when the row opens, which is the first moment
  // it is on screen and so the first moment its opacities can be read. It runs
  // again on every open: the drawing appears each time, and drawing itself is
  // what appearing looks like here.
  $('#browse-list').addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.open) return;
    hydrateMedia(d);
    hydrateDescriptiveMedia(d);
    const fig = d.querySelector('.b-fig');
    if (fig) drawFigureOn(fig);
  }, true);
  $('#browse-more').addEventListener('click', () => {
    const from = browseLimit;
    browseLimit += BROWSE_PAGE;
    const firstNew = appendRows(from);
    // The button that was under your thumb has moved sixty rows down. Put the
    // first row it produced at the top and stand on it, which is also what a
    // screen reader needs — the appended rows are announced by nothing.
    if (firstNew) {
      firstNew.scrollIntoView({ block: 'start' });
      const target = firstNew.querySelector('summary, .browse-static');
      if (target) target.focus({ preventScroll: true });
    }
    sayCount(browseCountSaid.replace(/ · showing \d+$/, '')
      + ` · showing ${n(Math.min(browseLimit, browseHits.length))}`);
  });

  // Unfolds the log for as long as the tab is up. Not remembered: the fold is
  // about the first thing you see, and the next visit is a first thing again.
  $('#ach-more').addEventListener('click', (e) => {
    $('#ach-list').classList.remove('folded');
    e.currentTarget.hidden = true;
  });

  $('#set-new').addEventListener('change', (e) => {
    state.settings.newPerDay = clamp(parseInt(e.target.value, 10) || 0, 0, 200);
    e.target.value = state.settings.newPerDay;
    if (save() && current === 'home') renderHome();
  });
  $('#set-max').addEventListener('change', (e) => {
    state.settings.maxRev = clamp(parseInt(e.target.value, 10) || 10, 10, 999);
    e.target.value = state.settings.maxRev;
    if (save() && current === 'home') renderHome();
  });
  $('#set-shuffle').addEventListener('change', (e) => {
    state.settings.shuffle = e.target.checked;
    save();
  });
  // Delegated across the five steps rather than one listener each: they are one
  // control with five positions, and the group is what the app names.
  $('#set-font').addEventListener('click', (e) => {
    const step = e.target.closest('[data-font-step]');
    if (!step) return;
    // Applied before the save, not after it: the save is debounced and the
    // refusal path can send it back, and either way this is a control whose
    // whole point is that you see the answer in the same breath as the change.
    // A value no button could have produced still goes through the same list
    // the sanitiser uses — nothing writes an attribute unchecked.
    const want = FONT_SIZES.includes(step.dataset.fontStep) ? step.dataset.fontStep : FONT_DEFAULT;
    state.settings.fontSize = want;
    applyFontSize();
    save();
  });
  const setExamDate = (value) => {
    // Half-typed years arrive here as 0002-08-12. Ignore them: the change event
    // fires again with the real year a keystroke later.
    if (value && !plausibleExam(value)) return false;
    state.settings.examDate = value || '';
    if (value) state.settings.examSkipped = false;
    // Existing cards may already be scheduled past the new date; pull them in.
    // Only for a date in the future: a typo like 2025 instead of 2026 would
    // otherwise rewrite every card to a one-day interval, and clearing the date
    // afterwards cannot undo it.
    const cap = ceiling();
    const d = daysToExam();
    let moved = 0;
    if (d !== null && d >= 0) {
      for (const r of Object.values(state.recs)) {
        if (r.st === 'r' && r.ivl > cap) {
          r.ivl = cap;
          r.due = Math.min(r.due, addCalendarDays(Date.now(), cap));
          moved++;
        }
      }
    }
    const wrote = writeNow();
    $('#set-exam').value = state.settings.examDate;
    $('#home-exam').value = state.settings.examDate;
    $('#home-exam-parsed').textContent = value ? longDate(value) : '';
    if (current === 'stats') renderStats(); else renderHome();
    if (moved && wrote) toast(`${moved} cards moved earlier so you see them before your exam.`);
    return wrote;
  };
  $('#set-exam').addEventListener('change', (e) => setExamDate(e.target.value));
  $('#home-exam').addEventListener('change', (e) => {
    if (setExamDate(e.target.value) && e.target.value) {
      toast('Set. The daily number now fits your date.');
    }
  });
  // Leaving the field with a half-typed year in it would show a date the app is
  // not using. Put the stored one back.
  for (const el of [$('#home-exam'), $('#set-exam')]) {
    el.addEventListener('blur', () => {
      if (el.value && !plausibleExam(el.value)) el.value = state.settings.examDate || '';
    });
  }
  $('#skip-exam').addEventListener('click', () => {
    state.settings.examSkipped = true;
    if (save()) {
      renderHome();
      toast('You can add a date later in Settings.');
    }
  });
  $('#leech-row').addEventListener('click', () => {
    // The query first, so the render inside go() is not forty rows of whatever
    // was last searched — but the filter only after it, because go() renders,
    // and rendering is what puts the ★ option in the list to be chosen.
    $('#search').value = '';
    goTab('browse');
    $('#sect-filter').value = LEECH_FILTER;
    renderBrowse();
  });

  /* Sync. Delegated rather than bound per button: the row is rebuilt on every
     status change, and listeners attached to the old buttons would pile up. */
  $('#sync-actions').addEventListener('click', (e) => {
    const act = e.target.closest('[data-sync]');
    if (!act) return;
    const what = act.dataset.sync;

    if (what === 'new') {
      if (!DSSync.turnOn()) {
        toast('Sync could not be turned on because device storage is blocked.', true);
        return;
      }
      $('#sync-join').hidden = true;
      renderSyncState();
      runSync();
      return;
    }
    if (what === 'join') {
      const box = $('#sync-join');
      box.hidden = false;
      box.value = '';
      box.placeholder = 'Type the key from your other device';
      box.focus();
      return;
    }
    if (what === 'copy') {
      const key = DSSync.formatKey(DSSync.status().key);
      // Clipboard access is refused on plain http and inside some in-app
      // browsers, and the key is on screen anyway — say so rather than fail mute.
      (navigator.clipboard ? navigator.clipboard.writeText(key) : Promise.reject())
        .then(() => toast('Key copied.'))
        .catch(() => toast('Could not copy — read the key off the screen instead.'));
      return;
    }
    if (what === 'off') {
      if (!confirm('Turn off sync on this device?\n\nProgress stays here, and stays on the server for your other devices. Keep the key if you might turn it back on.')) return;
      if (!DSSync.turnOff()) {
        toast('Sync could not be turned off because device storage is blocked.', true);
        return;
      }
      $('#sync-join').hidden = true;
      renderSyncState();
      toast('Sync is off on this device.');
    }
  });

  $('#sync-join').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.hidden = true; return; }
    if (e.key !== 'Enter') return;
    const key = DSSync.normaliseKey(e.target.value);
    if (!key) {
      toast(`That is not a sync key — they are ${DSSync.KEY_CHARS} letters and digits.`);
      return;
    }
    if (!confirm('Join the deck this key belongs to?\n\nThe progress on this device and the progress on that one are merged into a single deck — nothing is thrown away.')) return;
    if (!DSSync.turnOn(key)) {
      toast('Sync could not be turned on because device storage is blocked.', true);
      return;
    }
    e.target.hidden = true;
    renderSyncState();
    runSync(true);
  });

  $('#export-btn').addEventListener('click', () => {
    writeNow();
    // The whole layer, because the whole layer is what goes in the file: an
    // edit over a course card is as much somebody's writing as a card of their
    // own, and neither has any other copy on this device.
    const written = liveCardCount();
    // The file is stamped so restore can tell a real backup from any other
    // JSON, and so a human opening it can see what it is and how old it is.
    // `cardsWritten` counts only the cards that exist because somebody typed
    // them — the header is read by a person in a text editor, and "how many
    // cards in here were written by hand" is the question they have.
    //
    // Both documents go, the way a sync sends both: what this deck holds is a
    // review history and a layer of cards beside it, and a file with only the
    // first in it is not a backup of what somebody has done with this deck. It
    // matters most where Sync never runs — a deck you imported or wrote never
    // syncs at all, so this file is the only copy its layer will ever have.
    //
    // What does NOT go is the deck: its own cards live in the database, keyed
    // by an id minted on this device, and restore refuses a file stamped for
    // any other. No screen may offer this file as the way to move a deck.
    //
    // The layer is assigned after `state` rather than into the header, because
    // `state` is spread over the header: a `cards` key that ever appeared on
    // that object — which sanitise() exists to make sure it does not — would
    // silently win over the layer this line is putting in.
    const payload = Object.assign({
      app: EXPORT_APP,
      format: EXPORT_FORMAT,
      exportedAt: new Date(Date.now()).toISOString(),
      deckBuild: DECK.buildFingerprint,
      cardsWithHistory: Object.keys(state.recs).length,
      cardsWritten: writtenCardCount(),
    }, state, { cards: cardLayer });
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${COURSE.id}-progress-${state.day}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    // The same accounting as the line above the button, and for the same
    // reason: any one of the three can be the only thing in the file, and
    // saying "0 cards" — or "nothing but settings" — about a file holding the
    // only copy of somebody's cards reads as a failure to export them.
    const notes = liveNotes().length;
    const held = [];
    if (payload.cardsWithHistory) {
      held.push(`${plural(payload.cardsWithHistory, 'card')} of history`);
    }
    if (notes) held.push(plural(notes, 'note'));
    if (written) held.push(`${plural(written, 'card')} you have written or edited`);
    toast(held.length
      ? `Exported ${listWords(held)}.`
      : 'Exported your settings — there is nothing else in this deck yet.');
    renderBackupState();
  });

  $('#deck-export-btn').addEventListener('click', async () => {
    const btn = $('#deck-export-btn');
    if (deckExporting || !deckFile) return;

    /* THIS REFUSAL FIRST, whatever else is wrong.
     *
     * With the layer unreadable, liveCardCount() is 0 and every count below is
     * a count of nothing — so a file written over it comes out short and looks
     * like proof there was nothing there, and the refusal that would otherwise
     * fire would tell somebody who has written fourteen cards that they have
     * written none. */
    if (!cardLayerLoaded) {
      toast('The cards you wrote into this deck could not be read, so a file made now '
        + 'would be missing them. Nothing was exported.', true);
      return;
    }
    if (deckFile.kind === 'layer' && liveCardCount() === 0) {
      toast('You have not written or changed a card in this deck, so a file of your '
        + 'cards would be empty. Browse is where you write one.');
      return;
    }
    // share.js's guard rather than a try/catch around the click: some in-app
    // browsers have no createObjectURL at all, and there is no point writing a
    // file this page cannot hand over.
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      toast('This browser will not let keep club hand you a file. Some in-app browsers '
        + 'block downloads; opening keep club in your own browser will work.', true);
      return;
    }

    const label = btn.textContent;
    // Disabling the button a keyboard is on drops focus onto the body, and
    // enabling it again does not put it back: the next Tab would restart at the
    // top of the document, one press after the control it was on.
    const held = document.activeElement === btn;
    deckExporting = true;
    btn.disabled = true;
    btn.textContent = 'Writing the file…';
    let written;
    try {
      const { writeCourseFile } = await courseExport();
      written = await writeCourseFile({
        kind: deckFile.kind,
        stored: (globalThis.COURSE && COURSE.deck) || null,
        shipped: shippedCourse,
        layer: cardLayer,
        own: deckFile.own,
        now: new Date(),
      });
    } catch (e) {
      console.error(e);
      written = { ok: false, say: '' };
    }
    deckExporting = false;
    btn.disabled = false;
    btn.textContent = label;
    if (held && document.activeElement === document.body) btn.focus();

    if (!written.ok) {
      // The reader's own words, in the shape the card sheet and the importer
      // both print. Reaching this is a bug in the exporter and not something
      // the person did, which is exactly why it is a sentence rather than a
      // thrown error: an app that stops has told them nothing.
      toast('keep club could not write a course file from this deck, so nothing was '
        + `downloaded.${written.say ? ' ' + written.say : ''}`, true);
      return;
    }

    // The backup's own mechanics, twenty lines above: Blob, anchor, download,
    // click, and the URL revoked after four seconds rather than at once, or a
    // download that has not started yet loses the file it was going to fetch.
    const blob = new Blob([written.text], { type: 'text/yaml;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = written.fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);

    const yours = written.counts.written + written.counts.overridden;
    const said = written.kind === 'whole'
      ? `Exported all ${plural(written.counts.cards, 'card')} in this deck${
        yours ? `, including the ${written.counts.overridden
          ? `${plural(yours, 'card')} you have written or edited`
          : `${plural(yours, 'card')} you wrote`}` : ''}, as ${written.fileName}.`
      : `Exported the ${plural(yours, 'card')} you have written or edited, `
        + `as ${written.fileName}.`;
    // Not a refusal, and it is downloaded either way: withholding somebody's
    // own words over a limit of ours is not on. Sticky, because it is the one
    // sentence that says why the file they just made will not open here.
    if (written.overLimit) {
      toast(`${said} That file is ${(written.bytes / 1e6).toFixed(1)} MB. keep club will `
        + 'not read a course file over 5 MB back in, so it will open in a text editor '
        + 'but not in this app.', true);
      return;
    }
    toast(said);
  });

  $('#import-btn').addEventListener('click', () => {
    if (globalThis.DSSync && DSSync.enabled()) {
      toast('Copy your Sync key and turn Sync off before restoring an exact backup.', true);
      return;
    }
    $('#import-file').click();
  });
  $('#import-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';                       // so re-picking the same file fires again
    if (!f) return;
    let s;
    try {
      s = JSON.parse(await f.text());
    } catch (err) {
      toast('That file is not readable as JSON.');
      return;
    }
    if (!isPlainObject(s) || !isPlainObject(s.recs)) {
      toast('That is not a backup of this course — it has no review history in it.');
      return;
    }
    if (s.app && s.app !== EXPORT_APP) {
      toast(`That backup is from ${String(s.app).slice(0, 30)}, not this deck.`);
      return;
    }

    // Both counters are taken before the file is read and put back on every way
    // out below. The sanitisers count what they had to drop so that a screen
    // can say it later, and a file somebody looked at and declined must not
    // leave a number behind for the next toast to report as a loss that
    // happened.
    const droppedBefore = { notes: notesDropped, cards: cardsDropped };
    const putDropsBack = () => {
      notesDropped = droppedBefore.notes;
      cardsDropped = droppedBefore.cards;
    };
    const incoming = sanitise(s);
    // Through the same front door the synced blob goes through: the cards block
    // is the other half of the file, sanitise() drops it on purpose, and the
    // count below has to be the count that would actually land rather than
    // whatever the file claims.
    const theirCards = sanitiseCardLayer(isPlainObject(s) ? s.cards : null);
    const ids = Object.keys(incoming.recs);
    const known = ids.filter((id) => byId.has(id));
    const theirNotes = Object.values(incoming.notes).filter((note) => note.text).length;
    const theirWritten = Object.values(theirCards).filter((rec) => !!rec.front).length;
    // A file can be worth restoring for its notes alone, or for its cards
    // alone. Somebody who has written about a deck on another device and
    // studied it there hardly at all has a backup with no card ids to
    // recognise, and refusing on that count was the app declining to restore
    // the only thing in the file it had — and a deck of your own, which never
    // syncs, can hold nothing but the cards you wrote into it. A file with none
    // of the three is still refused: that one really is somebody else's.
    if (!known.length && !theirNotes && !theirWritten) {
      putDropsBack();
      toast('Nothing in that file belongs to this deck — no cards of its own, no notes, '
        + 'and no cards written into it. Nothing restored.');
      return;
    }

    const mine = Object.keys(state.recs).length;
    const myNotes = liveNotes().length;
    const myCards = liveCardCount();
    const when = s.exportedAt ? ` from ${longDate(String(s.exportedAt).slice(0, 10))}` : '';
    const lost = ids.length - known.length;
    const head = known.length
      ? `Restore ${plural(known.length, 'card')} of history${when}?`
      : `Restore the notes in this backup${when}? It holds no card history for this deck.`;
    const warn = mine
      ? `\n\nThis ${known.length ? 'replaces' : 'erases'} the ${mine} cards of history already on this device.`
      : '';
    // What happens to the notes is said out loud, because it is not what the
    // rest of the sentence implies: everything else in this document is being
    // replaced, and these are not.
    let noteLine = '';
    if (myNotes && theirNotes) {
      noteLine = `\n\nNotes are merged, not replaced: your ${plural(myNotes, 'note')} here`
        + ` and the ${plural(theirNotes, 'note')} in the file are all kept.`;
    } else if (myNotes) {
      noteLine = `\n\nYour ${plural(myNotes, 'note')} on this deck`
        + ` ${myNotes === 1 ? 'is' : 'are'} kept — the file has none.`;
    } else if (theirNotes) {
      noteLine = `\n\nThe ${plural(theirNotes, 'note')} in the file`
        + ` ${theirNotes === 1 ? 'is' : 'are'} added to this deck.`;
    }
    // And the same for the cards, for the same reason. A card somebody wrote is
    // the one thing in this file nothing else can reproduce, so a sentence that
    // left them out while offering to replace the deck's history would be the
    // sentence they read before losing them.
    let cardLine = '';
    if (myCards && theirWritten) {
      cardLine = '\n\nYour own cards are merged too: the '
        + `${plural(myCards, 'card')} you have written or edited here and the `
        + `${plural(theirWritten, 'card')} in the file are all kept.`;
    } else if (myCards) {
      cardLine = `\n\nThe ${plural(myCards, 'card')} you have written or edited in this deck`
        + ` ${myCards === 1 ? 'is' : 'are'} kept — the file has none.`;
    } else if (theirWritten) {
      cardLine = `\n\nThe ${plural(theirWritten, 'card')} written or edited in the file`
        + ` ${theirWritten === 1 ? 'is' : 'are'} added to this deck.`;
    }
    if (!confirm(head + warn + noteLine + cardLine)) {
      putDropsBack();
      return;
    }

    // Settled before the document is replaced, out of the state that is about
    // to be overwritten. Restore replaces review history — that is what the
    // sentence above offers, and all of what it offers. Notes are not review
    // history: a backup exported before this app had notes carries no `notes`
    // key at all, so handing the file's document over whole answered "put my
    // reviews back" by deleting every word the person had written since. The
    // two sets meet under the same tombstone algebra a sync uses rather than a
    // second one invented here, so a note deleted on either side stays deleted.
    const notes = mergedNotes(state.notes, incoming.notes);
    // The cards are the other document and never travelled inside this one, so
    // there is nothing here to replace them with even if replacing were the
    // offer. They meet the same way, under the same algebra.
    const cards = mergedCards(cardLayer, theirCards);
    try {
      publishStateReset();
    } catch (e) {
      putDropsBack();
      toast('The backup could not be restored because device storage is blocked.', true);
      return;
    }
    state = incoming;
    state.notes = notes;
    cardLayer = cards;
    // Four sets met, two apiece. The ceiling all of them share is the one thing
    // about that meeting the file cannot know, so it is applied here rather
    // than discovered at the next sync.
    capWrittenBlocks();
    // Before anything is counted or swept: the cards from the file are not in
    // the deck until this rebuilds it, and a sweep that ran first would read
    // every one of them as a card that does not exist and delete the history
    // this restore had just put back.
    await applyCardLayer();
    // Drop history for cards that are no longer in the deck here rather than at
    // the next boot, so the number in the message is the truth.
    sweepUnknownRecords();
    // And the history of a card the file records as deleted, which is the one
    // thing the merge above deliberately will not do — see
    // sweepDeletedCardHistory(). Said out loud below rather than found later.
    historyPutBack += sweepDeletedCardHistory(true);
    rollDay();
    if (!writeNow()) return;
    // After the review document, not before: writeCardLayer() re-reads what is
    // durable when it cannot write, and refuseForeignWrite() inside it would
    // re-read a review document that publishStateReset() has just removed.
    // Past writeNow() the lease is known free, so the only way this fails is
    // room, and the deck on screen is rebuilt from whatever it put back.
    const layer = writeCardLayer();
    if (!layer.ok) await applyCardLayer();
    applyTheme();
    applyFontSize();
    // The deck itself may have grown or lost a card, so every number derived
    // off it moves with it — the search placeholder, the browse counts, the
    // section tiles.
    renderDeckChanged();
    renderNotesRow();
    const nowNotes = liveNotes().length;
    const said = known.length
      ? (lost
        ? `Restored ${known.length} cards. ${lost} were from an older deck and were dropped.`
        : `Restored ${plural(known.length, 'card')} of history.`)
      : 'Restored the backup — it held no card history for this deck.';
    const nowCards = liveCardCount();
    const also = [];
    if (nowNotes) also.push(plural(nowNotes, 'note'));
    if (nowCards) also.push(`${plural(nowCards, 'card')} you have written or edited`);
    toast(said + (also.length ? ` ${listWords(also)} on this deck.` : ''));
    // A restore is one of the two ways two sets of writing can meet, so it is
    // one of the two places the ceiling can bite — and the ceiling is shared,
    // so what it bit may have been a card rather than a note.
    sayWhatWentMissing();
    if (!layer.ok) {
      // Last, because it is the costliest sentence on this path: the history
      // landed and the layer did not, so something the restore was asked for
      // did not happen at all. The importer's words for a full browser, because
      // it is the same browser and the same way out of it.
      toast('The history in that backup was restored, but the cards in it were not: '
        + 'the browser is out of space for this site. Removing a deck you no longer '
        + 'study will free it.', true);
    }
  });

  // beforeinstallprompt and appinstalled are listened for in munin.js instead:
  // by the time wire() runs a course has been picked and the deck fetched, and
  // the event has long since come and gone.
  $('#install-btn').addEventListener('click', async () => {
    $('#install-card').hidden = true;
    await MuninInstall.prompt();
  });

  $('#prefetch-btn').addEventListener('click', async () => {
    const btn = $('#prefetch-btn');
    if (!('serviceWorker' in navigator)) {
      toast('This browser cannot store the diagrams offline.');
      return;
    }
    // workerReg(), not `serviceWorker.ready`: with nothing registered — a
    // private window, a failed registration, a browser that refused — `ready`
    // never settles at all, so this handler stopped here for ever and the
    // button did nothing, said nothing, and stayed enabled.
    const reg = await workerReg();
    if (!reg) {
      // And say so where the offer was made, not only in a toast that leaves.
      renderOffline();
      toast('This browser has not stored the app, so there is nowhere to save them.');
      return;
    }
    if (!reg.active) {
      toast('Offline storage is still starting up — try again in a moment.');
      return;
    }
    // Only what is missing, so the count that runs is the count the button
    // offered — the whole list would have "Save the remaining 7" counting to 24.
    const urls = diagramUrls();
    const have = await savedDiagrams(urls);
    const todo = urls.filter((u) => !have.has(u));
    if (!todo.length) {
      renderOffline();
      return;
    }
    btn.disabled = true;
    btn.textContent = `Saving 0 of ${todo.length}…`;
    prefetchRequest = (crypto.randomUUID && crypto.randomUUID())
      || Date.now().toString(36) + Math.random().toString(36).slice(2);
    reg.active.postMessage({ type: 'prefetch', urls: todo, requestId: prefetchRequest });
  });
  // Registered once, not inside the click handler — a listener added per click
  // stacks up and every future completion fires all of them.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (ev) => {
      const d = ev.data;
      if (!d || (d.type !== 'prefetching' && d.type !== 'prefetched')) return;
      if (!prefetchRequest || d.requestId !== prefetchRequest) return;
      const btn = $('#prefetch-btn');
      if (d.type === 'prefetching') {
        btn.textContent = `Saving ${d.done} of ${d.total}…`;
        return;
      }
      btn.disabled = false;
      prefetchRequest = '';
      // What happened is said once, here; what is stored is re-counted from the
      // caches. The button used to hold the result, so it sat reading "All
      // diagrams saved offline ✓" and still invited a press, and a run that
      // saved nothing printed "0 of 24 saved" after counting up to 24.
      if (!d.failed) {
        toast(`${plural(d.total, 'diagram')} saved on this device.`);
      } else {
        const why = d.unreachable
          ? 'the app could not reach the server. Try again once you have a signal.'
          : 'the server answered, but not with them. Try again later.';
        const which = d.failed < d.total
          ? `${plural(d.failed, 'diagram')} could not be downloaded`
          : d.total === 1 ? 'The diagram could not be downloaded'
            : `None of the ${d.total} diagrams could be downloaded`;
        toast(`${which}: ${why}`, true);
      }
      renderOffline();
    });
  }

  $('#reset-btn').addEventListener('click', () => {
    if (globalThis.DSSync && DSSync.enabled()) {
      toast('Copy your Sync key and turn Sync off before erasing this device, or the shared copy would return.', true);
      return;
    }
    const keptNotes = liveNotes().length;
    // The cards you wrote are in a document this button does not touch at all
    // — publishStateReset() removes the review history and nothing else — so
    // they survive whatever this sentence says. Which is exactly why it has to
    // say it: a person about to erase a deck cannot be left guessing whether
    // the cards they wrote into it are review history.
    const keptCards = liveCardCount();
    const kept = [];
    if (keptNotes) kept.push(`your ${plural(keptNotes, 'note')}`);
    if (keptCards) kept.push(`the ${plural(keptCards, 'card')} you have written or edited`);
    // Sentence case at the front of a sentence: the list begins "your…" or
    // "the…", and both sentences below open with it.
    const keptSays = kept.length
      ? listWords(kept).charAt(0).toUpperCase() + listWords(kept).slice(1)
      : '';
    // One thing, not one kind of thing: "your 1 note are kept" was what
    // counting the kinds produced, and it was what the old sentence said.
    const keptIs = keptNotes + keptCards === 1 ? 'is' : 'are';
    if (!confirm('Erase all review history on this device? Export a backup first if you might want it back.'
      + (kept.length ? `\n\n${keptSays} on this deck ${keptIs} kept.` : ''))) return;
    // The notes come across to the fresh state on purpose. This button offers
    // to erase review history, and it says so in the sentence above; taking
    // somebody's writing with it would be destroying a thing nobody was asked
    // about. Removing the deck itself is the way to remove its notes and its
    // cards, and that one takes both documents with it.
    const notes = state.notes;
    try {
      publishStateReset();
    } catch (e) {
      toast('Progress could not be erased because device storage is blocked.', true);
      return;
    }
    state = Object.assign(freshState(), { notes });
    if (!writeNow()) return;
    applyTheme();
    applyFontSize();
    renderStats();
    toast(kept.length
      ? `Progress erased. ${keptSays} ${keptIs} still here.`
      : 'Progress erased.');
  });

  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test((e.target.tagName || ''))
      || e.target.isContentEditable;
    if (e.repeat && !typing
        && (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape'
          || /^[1-4uU]$/.test(e.key))) {
      e.preventDefault();
      return;
    }
    if (!$('#lightbox').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); }
      if (e.key === 'Tab') {
        const box = $('#lightbox');
        const focusable = Array.from(box.querySelectorAll(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )).filter((el) => !el.hidden);
        if (focusable.length) {
          const first = focusable[0], last = focusable[focusable.length - 1];
          if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey
              && (document.activeElement === last || !box.contains(document.activeElement))) {
            e.preventDefault();
            first.focus();
          }
        }
      }
      if (e.key === '+' || e.key === '=') zoomAt(innerWidth / 2, innerHeight / 2, clamp(lb.scale * 1.25, lb.fit, 6));
      if (e.key === '-') zoomAt(innerWidth / 2, innerHeight / 2, clamp(lb.scale / 1.25, lb.fit, 6));
      return;
    }
    /* The notes panel, contained the same way and for the same reason. Escape
       closes the panel rather than cancelling an edit in progress: it is the
       one key every dialog in the app answers to, and Cancel is on screen. */
    if (!$('#notes').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeNotes(false); return; }
      if (e.key === 'Tab') containTab($('#notes'), e);
      return;
    }
    /* The card sheet, the same dialog contract again. Escape closes the sheet
       rather than cancelling a field: it is the one key every dialog in this app
       answers to, and Cancel is on screen beside Save. */
    if (!$('#card-sheet').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeCardSheet(false); return; }
      if (e.key === 'Tab') containTab($('#card-sheet'), e);
      return;
    }
    /* The setup sheet, the same dialog contract once more. */
    if (!$('#setup').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeSetup(false); return; }
      if (e.key === 'Tab') containTab($('#setup'), e);
      return;
    }
    /* The achievement sheet, the same dialog contract once more. */
    if (!$('#ach-sheet').hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeAchSheet(false); return; }
      if (e.key === 'Tab') containTab($('#ach-sheet'), e);
      return;
    }
    if (typing) return;
    if (current !== 'study') return;
    // A control that has focus gets its own key. This guard exempted form
    // fields and nothing else, so Space or Enter on the *again* button was
    // taken by the document and recorded as good — the button's own click never
    // fired — and end session, undo, the back arrow, the diagram, the clips and
    // the skip link were all swallowed the same way. `tabindex="-1"` is not a
    // control: the answer takes focus so that it is read out, and Space there
    // is still the shortcut the dock advertises.
    const control = e.target.closest
      && e.target.closest('button, a[href], summary, audio[controls], video[controls],'
        + ' [tabindex]:not([tabindex="-1"])');
    if (control && (e.key === ' ' || e.key === 'Enter')) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!session.revealed) reveal();
      else answer(3);
    } else if (e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      if (session.revealed) answer(+e.key);
    } else if (e.key === 'u' || e.key === 'U') {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      leaveStudy(false);
    }
  });

  initLightbox();
}

/* What this deck is, and is not.
 *
 * The words are the course's — course.json's `notice`, with Munin's own plain
 * line as the default. An almanac and an up-to-date chart are one course's
 * caveat; printing them under an imported deck of German verbs is nonsense,
 * and that is exactly what the engine used to do, because the sentence was
 * markup in index.html. The video credit joins it when there is one. */
function renderNotice() {
  const el = $('#notice');
  if (!el) return;
  el.textContent = str(COURSE.notice, MUNIN.theme.notice);
  const c = COURSE.credit || {};
  const name = str(c.name, '');
  if (!name) return;
  el.append(' Video clips by ');
  // http(s) or nothing. rel="noopener" already makes a javascript: URL here
  // inert, but a credit line is a link to a person's work, and "the browser
  // happens to defuse it" is not the reason it is safe.
  const href = str(c.href, '');
  if (/^https?:\/\//i.test(href)) {
    const a = document.createElement('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = name;
    el.append(a);
  } else {
    el.append(name);
  }
  el.append(', used with a link back to each original.');
}

/** The worker's registration, or null — and it settles either way.
 *
 * `navigator.serviceWorker.ready` does not: with nothing registered it never
 * resolves at all, so everything waiting on it waited for ever. */
function workerReg() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.getRegistration().then((r) => r || null).catch(() => null);
}

/* The save in flight, if there is one. Module scope because renderOffline()
 * is the thing that must not tread on it. */
let prefetchRequest = '';

/* Offline, said in this deck's numbers — and in this browser's.
 *
 * How many diagrams there are, and whether there are any, is a fact about the
 * course. "The 24 diagrams are about 2 MB" was markup, so it was printed over
 * a three-picture deck and over imported decks with no diagrams at all, above
 * a button that then downloaded nothing. Whether any of it is stored at all is
 * a fact about the browser, and was assumed. */
/** Which of this deck's diagrams are stored AND still an image.
 *
 * Validity, not presence: a captive-portal page cached under an image URL
 * counts as missing here, so the save that follows fetches it again rather
 * than reporting the deck complete over a stored sign-in form. */
async function savedDiagrams(urls) {
  const stored = async (u) => {
    try {
      const hit = await caches.match(u);
      if (!hit || !hit.ok) return null;
      const got = (hit.headers.get('content-type') || '').split(';')[0].trim();
      // Some static servers say nothing at all, which the worker also accepts.
      return !got || /^image\//.test(got) ? u : null;
    } catch (e) { return null; }   // storage blocked: nothing is stored
  };
  return new Set((await Promise.all(urls.map(stored))).filter(Boolean));
}

/** Every diagram this deck ships, as absolute URLs. */
function diagramUrls() {
  return Array.from(new Set(offlineImages().map(
    (item) => new URL(courseMediaUrl(item), location.href).href)));
}

function renderOffline() {
  const card = $('#offline-card');
  if (!card) return;
  const items = offlineImages();
  const shots = new Set(items.map((item) => item.source));
  if (!shots.size) {
    // An imported deck keeps its pictures in the database with its cards;
    // there is nothing to fetch and nothing to say.
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const total = shots.size;
  const many = total > 1;
  const urls = diagramUrls();
  // True before the browser has answered and true again once it says it holds
  // none of them, so both states say it rather than inventing a second line.
  const meetLine = `The ${total} diagram${many ? 's are' : ' is'} saved as you meet `
    + `${many ? 'them' : 'it'} — pull ${many ? 'them all' : 'it'} down now if you `
    + `are heading somewhere without signal.`;
  // The line says what is stored; the button offers what is left to store.
  // They used to be one control, so a finished save left "All diagrams saved
  // offline ✓" printed on a button that was still asking to be pressed.
  const say = (worker, saved) => {
    // A save already running owns this section. Redrawing the sheet — which a
    // merge from another tab does on its own — used to reset the count to the
    // offer while the worker was still downloading behind it.
    if (prefetchRequest) return;
    const note = $('#offline-note');
    const btn = $('#prefetch-btn');
    if (saved === null) {
      // Nothing to offer until the browser says what it already holds.
      note.textContent = meetLine;
      btn.hidden = true;
      return;
    }
    if (!worker) {
      // A browser that has stored nothing — a private window, a refused or
      // failed registration — was told the cards already worked offline.
      note.textContent = `This browser has not stored the app, so the cards and the `
        + `${many ? 'diagrams' : 'diagram'} need a signal. Open it once more with one — `
        + `a private window will never keep it. Your progress is on the device either way.`;
      btn.hidden = false;
      btn.disabled = true;
      btn.textContent = 'Nothing to save into yet';
      return;
    }
    const left = total - saved;
    if (!left) {
      note.textContent = many
        ? `All ${total} diagrams are saved on this device.`
        : 'The diagram is saved on this device.';
      btn.hidden = true;
      return;
    }
    note.textContent = saved
      ? `${saved} of the ${total} diagrams are saved on this device — pull the rest `
        + `down now if you are heading somewhere without signal.`
      : meetLine;
    btn.hidden = false;
    btn.disabled = false;
    btn.textContent = saved
      ? `Save the remaining ${plural(left, 'diagram')}`
      : many ? 'Save all diagrams offline' : 'Save the diagram offline';
  };
  // The deck's own count can be said at once; what this browser has stored is
  // a promise, and the button waits for it rather than guessing.
  say(true, null);
  workerReg()
    .then((reg) => (reg ? savedDiagrams(urls) : null))
    .then((have) => say(!!have, have ? have.size : 0));
}

/** Whatever went wrong, said on the loading screen the course is already
 *  drawing. Text, not markup: a deck's own words end up in here. */
function bootSays(line) {
  const el = $('#boot-line');
  if (el) el.textContent = line;
  else $('#boot').textContent = line;
}

/** …and the way off it.
 *
 * The loading screen is opaque, covers the window and ranks above the `courses`
 * pill, so a deck that would not load or would not validate was the end of the
 * app: the screen never came down, the stored course still pointed at the
 * broken one, and a reload landed straight back on it — with the other course,
 * which opens perfectly well, unreachable. */
function bootEscape() {
  const btn = $('#boot-back');
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener('click', () => {
    // Forget the broken course, or the shelf sends you back into it.
    try { localStorage.removeItem(MUNIN.lastKey); } catch (e) { /* storage blocked */ }
    // Without the query too: `?course=` is the other way back into this screen.
    location.replace(location.pathname);
  });
  btn.focus({ preventScroll: true });
}

/* ─────────────────────────── boot ─────────────────────────── */

/** Read every shipped/imported format through the composed public boundary.
 * The rest of the app sees only the descriptive, sanitized runtime model. */
async function readRuntimeCourse(input) {
  const [runtime, media] = await Promise.all([
    import('./lib/course-runtime.js'),
    import('./lib/course-media.js'),
  ]);
  COURSE_MEDIA = media;
  const result = await runtime.readCourseForRuntime(input, { courseId: COURSE.id });
  RUNTIME_SOURCE_FORMAT = result.sourceFormat;
  return result;
}

async function boot() {
  load();
  applyTheme();
  applyFontSize();
  let rawCourse;
  try {
    // An imported deck has no cards.json to fetch: it came out of a .apkg and
    // lives in the browser's own database, so the shell hands it over directly.
    if (COURSE.deck) rawCourse = COURSE.deck;
    else {
      const res = await fetch(COURSE.base + 'cards.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      rawCourse = await res.json();
    }
  } catch (e) {
    // The line, not the whole screen: the scene the course drew is what
    // says which deck this is, and replacing it with a paragraph loses that
    // at the one moment it is doing something useful.
    bootSays('Could not load the deck. Reload the page, or check you are online '
      + 'for the first visit.');
    bootEscape();
    return;
  }

  /* Normalize and render safe course text before assigning the shared runtime
   * object. No consumer below this point can observe compact input or authored
   * CommonMark. */
  try {
    const result = await readRuntimeCourse(rawCourse);
    if (!result.course) {
      console.error('course:', result.diagnostics);
      const first = result.diagnostics.find((item) => item.severity === 'error');
      bootSays('This deck could not be read. '
        + (first ? first.message : 'Its format is not supported.'));
      bootEscape();
      return;
    }
    shippedCourse = result.course;
    shippedById = new Map(shippedCourse.cards.map((c) => [c.cardId, c]));
  } catch (e) {
    console.error(e);
    bootSays('This deck could not be read. Its course reader did not load.');
    bootEscape();
    return;
  }

  // Your own cards go on before anything is counted or indexed, because from
  // here down the deck is the deck: the card count in the copy below, byId, the
  // sections, the search index and the sweep are all built off the one list.
  const layerRead = loadCardLayer();
  // The first moment both documents are in hand, and so the first moment the
  // ceiling they share can be applied to them together — and written back where
  // it bit, both documents.
  //
  // Whatever the joint pass takes, AND whatever each block's own sanitiser
  // already took on the way in: a ceiling that held in memory alone drops the
  // same records on the next boot and says so again each time, for ever. It did
  // exactly that for a cards document over the ceiling on its own — the
  // sanitiser had already brought the block down to 200, so the joint pass
  // found nothing left to take, answered "nothing moved", and nobody wrote the
  // shorter document back over the longer one.
  const capped = capWrittenBlocks();
  if (capped || cardsDropped || notesDropped) {
    writeCardLayer();
    // This is an eviction, not an ordinary idle-tab edit. Re-merging the
    // durable pre-eviction document would immediately resurrect what the
    // shared ceiling just removed.
    save(false);
  }
  await applyCardLayer();

  renderAskWhy();
  // Drop history for cards that no longer exist — but only when the layer that
  // says which cards exist could actually be read. See sweepUnknownRecords().
  const sweptUnknown = sweepUnknownRecords();
  // And the history of a card another device deleted, which the marker for it
  // is still holding here. Written back straight away: a sweep that is only
  // ever in memory says the same sentence again on every boot.
  const swept = sweepDeletedCardHistory();
  if (swept) historyDropped += swept;
  if (swept || (sweptUnknown && historyEvicted)) save(false);

  // A cards document that would not open is not an empty one, and the sweeps
  // above know that. What nothing did was say it: every card somebody had
  // written was simply absent from Browse, and the obvious thing to do about
  // that — write it again — is the one act that replaces the document with a
  // new one holding only the card just typed. Counted rather than said here,
  // like every other loss on this path, so that one sentence carries all of it.
  if (!layerRead) cardsUnreadable = true;

  // Optional, and deliberately not awaited with the deck: no video map, or a
  // stale one, must never stop the cards loading.
  // An imported deck brings no clips and no drawings; asking for them would be
  // two guaranteed 404s on every boot.
  // Asked for only where there is one to ask for: a course with no clips got a
  // red 404 in the console on every single boot. A course that ships video says
  // so — with `video: true`, or with the credit that clips are used under.
  const hasVideo = COURSE.video === true || !!(COURSE.credit && COURSE.credit.name);
  if (!COURSE.deck && hasVideo) fetch(COURSE.base + 'videos.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      if (v && v.clips && v.cards) {
        VIDEOS = v;
        for (const id of session?.reelCards || []) addReelClips(id);
        // The optional map can be slower than the whole short session. Keep
        // enough identity after finish() to fill the Done recap when it lands.
        if (!session && current === 'done' && lastReelCards.length) {
          renderReel(clipsForReelCards(lastReelCards).slice(0, 5));
        }
        const c = currentCard();
        if (c && session?.revealed) renderCardVideo(c);
      }
    })
    .catch(() => {});

  // Same deal for the figures: a card with a missing drawing is a card with
  // no drawing, never a card that fails to appear.
  if (!COURSE.deck) fetch(COURSE.base + 'figures.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((f) => { if (f) { FIGURES = f; const c = currentCard(); if (c) renderCardFigure(c); } })
    .catch(() => {});

  $('#search').placeholder = `Search ${plural(DECK.cards.length, 'card')}…`;
  renderNotice();
  renderOffline();
  wire();
  // The app goes up behind the loading screen, and the screen comes down over
  // a page that is already finished: MuninBoot.dismiss() fades, and a fade
  // reveals whatever is behind it. Hiding first showed a blank frame.
  $('#app').hidden = false;
  if (!restoreStudySession()) go('home');
  // Not awaited: everything below is setup with nothing to show for it, and it
  // may as well happen behind the splash rather than after it. The failure
  // paths above return before this line, so a deck that could not be read
  // keeps the screen — and its explanation — up.
  MuninBoot.dismiss().catch(console.error);
  // The document this deck opened on has already been through the sanitiser,
  // and if it was carrying more notes than this build keeps, that is the first
  // moment there is anywhere to say so.
  sayWhatWentMissing();

  if (globalThis.DSSync) {
    DSSync.init({
      app: COURSE.id,
      // A deck you wrote or imported has a local- id and does not sync: its
      // cards and media live in a database and are unbounded, which is a
      // different problem from carrying a layer of edits. Everything about the
      // cards layer's sync path hangs off this one line being false there.
      supported: !/^local-[a-z0-9]+$/.test(COURSE.id),
      sanitise: sanitiseSynced,
      onMerged: adoptSynced,
      onStatus: (s) => {
        syncBusy = !!s.busy;
        if (current === 'stats') renderSyncState();
      },
    });
    // Opening the app is the moment the other device's session is most likely
    // to be waiting, so pull before anything is studied on top of it.
    if (DSSync.enabled()) runSync();
  }

}

boot();
