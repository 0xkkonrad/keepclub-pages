/* Drop it, get a receipt.
 *
 * The decision behind this screen (import, #6 in project.md) is that the thing
 * people lose in Anki's importer is not the cards — it is the *knowledge of
 * what happened to them*. "39 notes imported" is not an account. So the import
 * ends in a plain reckoning: what landed, what did not, and what changed on the
 * way. Nothing here is a progress bar with a checkmark at the end.
 *
 * Loaded on demand: the parsers are a good chunk of code and nobody who is
 * studying their own deck should be paying for them on every boot.
 */

import { readApkg, ApkgError, MAX_PACKAGE_BYTES } from './lib/anki.js';
import { buildDeck, RAVENS } from './lib/deck.js';
import { readCourseForRuntime } from './lib/course-runtime.js';
import { readCourseFile } from './lib/course-package.js';
import {
  normalizeLegacyCourse,
  projectDescriptiveCourseToLegacy,
} from './lib/legacy-course.js';
import * as store from './lib/store.js';
import { receiptHtml, nothingHtml, ensureCss, doodle } from './lib/receipt.js';

class Cancelled extends Error {}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Number(v).toLocaleString('en-GB');
const isKeepFile = (name) => /\.keep(?:\.yml)?$/i.test(String(name || ''));
const cardIdentity = (card) => card?.cardId;
const PUBLIC_THEME_FIELDS = [
  'accentColor', 'accentColorDark', 'accentInkColor', 'accentInkColorDark',
  'paperColor', 'paperColorDark', 'shelfArtwork', 'sectionArtwork',
  'loadingArtwork', 'loadingText', 'loadingAnimation',
];

/* The authored document is retained separately for round trips. Shell chrome
 * needs only a small, inert view of the fields the public validator already
 * accepted: never copy an arbitrary theme object into the IndexedDB record
 * that munin.js later turns into CSS and DOM. */
function presentationOf(course) {
  const theme = {};
  for (const field of PUBLIC_THEME_FIELDS) {
    if (Object.hasOwn(course.theme, field)) theme[field] = course.theme[field];
  }
  return {
    shortTitle: course.shortTitle,
    ...(course.tagline === undefined ? {} : { tagline: course.tagline }),
    theme,
  };
}

function keepReceipt(result) {
  const course = result.course;
  const mediaCounts = { images: 0, audio: 0, video: 0, bytes: 0 };
  for (const item of result.media) {
    if (item.mediaType === 'image') mediaCounts.images++;
    else if (item.mediaType === 'audio') mediaCounts.audio++;
    else if (item.mediaType === 'video') mediaCounts.video++;
    mediaCounts.bytes += item.bytes.length;
  }
  return {
    type: 'keep',
    title: course.title || course.courseId,
    courseId: course.courseId,
    sourceKind: result.sourceKind,
    read: { cards: course.cards.length },
    made: {
      cards: course.cards.length,
      sections: course.sections.length,
      groups: course.groups.length,
    },
    frontOnly: course.cards.filter((card) =>
      !card.back && !(card.media || []).some((item) => item.side === 'back')).length,
    media: mediaCounts,
    warnings: result.diagnostics.filter((item) => item.severity === 'warning'),
  };
}

/* How many cards a person has written into a deck, or edited in it.
 *
 * The receipt's promise about progress reads as a promise about everything of
 * theirs in the deck, and the cards they wrote are the part of it that no file
 * being imported can put back. So the count is taken before the replace button
 * is drawn, and the receipt says what happens to them.
 *
 * Read straight off the layer's document rather than through app.js: this
 * screen runs over the shelf, where no deck is open and app.js may not be
 * loaded at all. A document that will not parse counts as none, which is not a
 * guess — a cards document the app cannot read contributes no cards to the
 * deck either, so nought is exactly what the person is looking at. */
function writtenInto(id) {
  try {
    const raw = localStorage.getItem(globalThis.MUNIN.cardsKey(id));
    const cards = raw === null ? null : JSON.parse(raw).cards;
    if (!cards || typeof cards !== 'object') return 0;
    return Object.values(cards)
      .filter((rec) => !!rec && typeof rec === 'object' && !!rec.front).length;
  } catch (e) {
    return 0;
  }
}

/* ── a deck of your own ───────────────────────────────────────────────────── */

/* A course with no cards is not a document this app will read: the reader
 * refuses one outright (web/lib/course.js:903-908), and it is right to — an
 * empty deck is a tile that opens on nothing. So a deck of your own cannot
 * exist before its first card does, and it is created BY that card. Nothing
 * reaches the database until Save, which is what makes a sheet closed halfway
 * leave no tile behind.
 *
 * The deck's own card lives in the deck's own document, the same place a
 * course's cards live. Every card after it is the layer app.js already keeps
 * over any deck (MUNIN.cardsKey), so the app has one model either way: this
 * document is what the deck ships, and your layer goes over the top of it.
 */

const DECK_NAME_LEN = 120;

/* Control characters out, ends trimmed, length capped: the same discipline
 * app.js applies to a card side, because this text is going to the same
 * places. */
const typed = (value, limit) => String(value == null ? '' : value)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  .trim()
  .slice(0, limit);

/* Whatever is in a box, held to that box's own maxlength.
 *
 * The number is not written here. The two card boxes are a clone of the card
 * sheet's, whose cap is app.js's CARD_LEN written once into index.html, and a
 * second copy of it in this file is a second copy to drift — this screen would
 * go on taking two thousand characters the day the sheet stopped. The reader
 * would take a longer side than either, but a first card that could not
 * survive its own first edit is not a first card worth writing. */
const typedIn = (input) => typed(input.value, input.maxLength > 0 ? input.maxLength : Infinity);

/* The shape a course's own card ids have: ten lowercase hex characters, which
 * is what the RYA courses' build script produces and what the id grammar
 * accepts (web/lib/course.js:9).
 *
 * Deliberately NOT the reserved `u.` prefix the cards layer owns. Both course
 * readers refuse a shipped course that uses one, and this card is shipped —
 * by the deck it is making. Random rather than a hash of the question, because
 * ids are opaque by contract and two cards with the same words are two cards. */
function newCardId() {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* The one-card course, validated the way every other course in this app is.
 *
 * Validation is not hand-written here, any more than it is in the card sheet:
 * the document goes through the same reader every course goes through, and
 * what comes back is both the verdict and the diagnostics — message and
 * correction — that the screen prints. Through the runtime reader rather than
 * the plain one, because a side the Markdown parser will not take is exactly
 * the kind of thing worth hearing about now rather than at the first boot of a
 * deck that will not open.
 *
 * The document handed back is the one that was written, not the one the reader
 * produced: the .keep path stores the parsed source for the same reason, and
 * boot owns the one render pass. Storing the reader's output would put its
 * rendered HTML on disk to be rendered as Markdown a second time — and its
 * derived fields back through a validator that has never heard of them. */
async function readOwnCourse(id, title, front, back) {
  const written = {
    schemaVersion: 2,
    courseId: id,
    title,
    cards: [Object.assign({ cardId: newCardId(), front }, back ? { back } : {})],
  };
  const read = await readCourseForRuntime(written);
  return { written, course: read.course, diagnostics: read.diagnostics };
}

/* ── the screen ───────────────────────────────────────────────────────────── */

export function openImporter() {
  ensureCss();

  const el = document.createElement('div');
  el.className = 'imp';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Import a deck');
  el.innerHTML = `<div class="imp-inner">
    <div class="imp-top">${doodle('carry')}<h2>your own deck</h2>
      <button type="button" class="imp-x" aria-label="Close">✕</button></div>
    <div class="imp-body"></div>
  </div>`;
  document.body.appendChild(el);
  const body = el.querySelector('.imp-body');

  /* The screen underneath is fully covered, so it should also be out of reach:
   * without this, two Tabs from the importer land on the shelf behind it. Only
   * what this sheet made inert is given back — the courses overlay inerts the
   * page in its turn, and an importer opened from inside it used to hand the
   * shelf back to the Tab key on the way out, which is this very bug one layer
   * up. Naming #app and .shelf also missed anything else on the page. */
  const under = [...document.body.children].filter((n) => n !== el && !n.inert);
  // And on the way out, focus goes back to the tile that opened it rather than
  // to the top of the document.
  const opener = document.activeElement && document.activeElement !== document.body
    ? document.activeElement : document.querySelector('[data-byo]');
  for (const u of under) u.inert = true;
  /* Taken in the capture phase and stopped there. The courses overlay listens
   * for Escape on the window as well, and it registered first, so one press
   * closed both layers at once — the importer and the panel that opened it —
   * putting the person two screens back from where they were. Whatever is on
   * top takes the key. */
  const historyToken = Date.now().toString(36) + Math.random().toString(36).slice(2);
  // Textareas and selects are named because this sheet now has some: writing a
  // deck's first card is two boxes, and a containment that did not know about
  // them wrapped the Tab key straight past what somebody is typing into.
  const focusable = () => [...el.querySelectorAll(
    'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]),'
      + ' textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )].filter((node) => !node.hidden && !node.inert && node.getClientRects().length);
  const modalKeys = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) close();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = focusable();
    if (!stops.length) {
      // Saving is intentionally non-dismissible: the close button is disabled
      // and the receipt controls have gone away. Keep the keyboard inside the
      // dialog on its live status instead of letting Tab fall through to BODY
      // (and then browser chrome) while the IndexedDB transaction is running.
      e.preventDefault();
      (el.querySelector('.imp-work') || el).focus();
      return;
    }
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
    if (history.state?.muninImporter === historyToken) return;
    close(true);
  };
  history.pushState(Object.assign({}, history.state, { muninImporter: historyToken }), '');
  addEventListener('popstate', pop);
  addEventListener('keydown', modalKeys, true);

  /* Everything up to "putting it away…" can be called off; that cannot. The
   * write is already going and the reload after it is not something close()
   * can reach, so a sheet that vanished on Escape and then reloaded itself
   * into the deck seconds later was telling the person the opposite of what
   * had happened. The escape is refused for the second it takes instead. */
  let saving = false;
  // The deck this screen made, once it has. Only ever set after the database
  // transaction has committed.
  let madeId = '';
  const x = el.querySelector('.imp-x');

  const close = (fromHistory) => {
    if (saving) return;
    if (!fromHistory && history.state?.muninImporter === historyToken) {
      history.back();
      return;
    }
    removeEventListener('keydown', modalKeys, true); // the phase is part of the identity
    removeEventListener('popstate', pop);
    for (const u of under) u.inert = false;
    el.remove();
    if (opener && opener.isConnected) opener.focus();
    /* A deck made on this screen is not on the shelf underneath it: that list
     * was drawn before the deck existed, and leaving it out is the app telling
     * somebody the deck they just wrote is not there. So the way out of this
     * one screen is a reload onto the picker — the entry says which of the two
     * things the bare address means, which is how the shell already tells a
     * Back press out of a course from a cold open. Every other way out of this
     * sheet is a navigation into a deck, which is why nothing else needs it. */
    if (!madeId) return;
    try {
      history.replaceState(Object.assign({}, history.state, { munin: 'shelf' }), '');
    } catch (e) {
      // A history that will not take a state is not a reason to stay on a
      // screen that is already gone. The reload still happens; it may resume
      // the last course instead, where the new deck is one tap away.
      console.warn('the picker could not be marked as where this reload lands', e);
    }
    location.reload();
  };
  x.addEventListener('click', () => close(false));
  x.focus();

  // Dragging a file needs something to drag with. On a phone the dashed
  // rectangle is decoration in front of the only control that works.
  const draggable = matchMedia('(hover: hover) and (pointer: fine)').matches;

  function pick(moveFocus = false) {
    body.innerHTML = `
      ${draggable ? `<div class="imp-drop" id="imp-drop">
        <b>drop a course here</b>
        <p>.keep.yml, .keep or .apkg · stays on this device</p>
      </div>` : ''}
      <button type="button" class="imp-file" id="imp-file">choose a course file${
  draggable ? '' : '<small>your cards stay on this device</small>'}</button>
      <input type="file" accept=".keep.yml,.keep,.apkg,.colpkg,application/zip,text/yaml" hidden id="imp-input">
      <button type="button" class="imp-mine" id="imp-mine">write your own cards<small>a deck of
        your own, made by its first card</small></button>
      <p class="imp-how"><b>keep club courses:</b> choose a text-only <b>.keep.yml</b> or a
        <b>.keep</b> package with its media. <a href="./docs/#quick-start">See the format.</a><br><br>
        <b>from anki:</b> <b>File → Export</b>, choose <b>Anki Deck Package</b>. Scheduling
        does not come across; every card starts new.</p>`;
    const input = body.querySelector('#imp-input');
    input.addEventListener('change', () => { if (input.files[0]) go(input.files[0]); });
    for (const opener of body.querySelectorAll('.imp-file, .imp-drop')) {
      opener.addEventListener('click', () => input.click());
    }
    body.querySelector('#imp-mine').addEventListener('click', () => own());

    if (moveFocus) body.querySelector('#imp-file').focus();
    const zone = body.querySelector('.imp-drop');
    if (!zone) return;
    for (const ev of ['dragenter', 'dragover']) {
      zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
    }
    for (const ev of ['dragleave', 'drop']) {
      zone.addEventListener(ev, () => zone.classList.remove('over'));
    }
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      const f = e.dataTransfer?.files?.[0];
      if (f) go(f);
    });
  }

  /* The card editor's own two boxes, cloned rather than written again here.
   *
   * The labels, the 2,000-character cap, the placeholder for a card you grade
   * yourself and the line naming what Markdown does are one definition, in
   * index.html, and a second copy of them in this file is a second copy to keep
   * in step — the sheet would gain a sentence and this screen would quietly
   * stop saying it. The node itself cannot be borrowed: the shelf opens over a
   * course whose app.js is loaded and still listening to that sheet, and two
   * screens driving one form is how a Cancel here closes something over there.
   * So this takes a copy, renames every id in it, and drops the three parts
   * that belong to a card that already exists. */
  function cardBoxes() {
    const source = document.querySelector('#card-sheet .sheet-card');
    if (!source) return null;
    const sheet = source.cloneNode(true);
    sheet.className = 'imp-own';
    // The bar is this screen's own heading; the warning is about markup on a
    // card the course shipped, and nothing has shipped anything yet; and there
    // is no card to take away before there is a card. The section select goes
    // because a course of one card has one section and nothing to choose.
    for (const part of ['.sheet-bar', '#card-warn', '#card-more', '#card-where']) {
      sheet.querySelector(part)?.remove();
    }
    for (const node of sheet.querySelectorAll('[id]')) node.id = 'byo-' + node.id;
    for (const label of sheet.querySelectorAll('label[for]')) {
      label.htmlFor = 'byo-' + label.htmlFor;
    }
    return sheet;
  }

  const ownSays = (line) => {
    const status = body.querySelector('#byo-card-say');
    if (status) status.textContent = line || '';
  };

  /** Which of the three boxes a diagnostic is about — the one thing the reader
   *  cannot know to say, because it is validating a course and not a form. */
  function boxOf(item) {
    const path = String((item && item.path) || '');
    if (/\.back\b/.test(path)) return 'Answer';
    if (/\.front\b/.test(path)) return 'Question';
    if (/\.title\b/.test(path)) return 'Name';
    return '';
  }

  /* The rest of the reader's own words, in the shape the sheet prints them and
   * for the same reason: one error is already the whole of the status line
   * above, and printing it twice under itself is the screen shouting. */
  function ownDiagnostics(list) {
    const host = body.querySelector('#byo-card-diags');
    if (!host) return;
    const errors = (Array.isArray(list) ? list : [])
      .filter((item) => item && item.severity === 'error').slice(0, 8);
    host.hidden = errors.length < 2;
    host.innerHTML = host.hidden ? '' : errors.map((item) => {
      const box = boxOf(item);
      return `<li><code>${esc(item.code || 'error')}</code>
        <span>${box ? esc(box) + ' — ' : ''}${esc(item.message || '')}</span>
        <small>${esc(item.correction || '')}</small></li>`;
    }).join('');
  }

  function own() {
    const sheet = cardBoxes();
    if (!sheet) {
      fail('the card editor is not on this page',
        'keep club is part-way through an update. Reload the page and try again.');
      return;
    }
    /* Said before the boxes rather than found out later, and said exactly: the
       backup file in a deck's settings holds what you have answered and
       the cards you add to the deck, and no file anywhere holds the deck
       itself. Offering it as the way to move one would be this screen making a
       promise the app does not keep — and the promise somebody would rely on
       just before removing the deck. */
    body.innerHTML = `<p class="imp-sub">A deck is made by its first card, so this asks for
      both. A deck you write stays on this device: it does not sync, and no backup file holds
      the deck itself, so what you write here is written nowhere else.</p>`;
    body.appendChild(sheet);
    const form = body.querySelector('#byo-card-form');
    // Above the two boxes, because the deck is the thing being made and the
    // card is the first thing in it.
    form.insertAdjacentHTML('afterbegin',
      `<label class="sheet-label" for="byo-deck-name">What is this deck called?</label>
       <input type="text" id="byo-deck-name" maxlength="${DECK_NAME_LEN}"
         autocomplete="off" spellcheck="false">`);
    body.querySelector('#byo-card-save').textContent = 'write the first card';
    body.querySelector('#byo-card-cancel').textContent = 'back';
    body.querySelector('#byo-card-cancel').addEventListener('click', () => pick(true));
    form.addEventListener('submit', (e) => { e.preventDefault(); create(); });
    // Nothing on this screen is reached by accident — it is entered by a press
    // — so the caret starts in the first box rather than nowhere.
    body.querySelector('#byo-deck-name').focus();
  }

  /* Nothing has been written until this succeeds, and a name or a question the
   * reader will not take stops it before it starts — which is what makes
   * closing this screen halfway leave no tile behind. */
  async function create() {
    const save = body.querySelector('#byo-card-save');
    if (!save || save.disabled) return;
    const title = typedIn(body.querySelector('#byo-deck-name'));
    const front = typedIn(body.querySelector('#byo-card-front'));
    const back = typedIn(body.querySelector('#byo-card-back'));
    ownDiagnostics([]);
    if (!title) {
      ownSays('A deck needs a name.');
      body.querySelector('#byo-deck-name').focus();
      return;
    }
    if (!front) {
      ownSays('A card needs a question.');
      body.querySelector('#byo-card-front').focus();
      return;
    }

    save.disabled = true;
    ownSays('Writing the deck…');
    let id = newId();
    try {
      // Date.now() alone collided when two tabs finished together, and the
      // second put simply overwrote the first deck.
      const taken = new Set((await store.list()).map((d) => d.id));
      while (taken.has(id)) id = newId();
    } catch (e) {
      console.error(e);
      save.disabled = false;
      ownSays('This browser will not let keep club store anything: private windows and some '
        + 'managed browsers block the local database keep club keeps decks in.');
      return;
    }

    let read;
    try {
      read = await readOwnCourse(id, title, front, back);
    } catch (e) {
      console.error(e);
      save.disabled = false;
      ownSays('This card could not be read.');
      return;
    }
    if (!read.course) {
      save.disabled = false;
      const errors = read.diagnostics.filter((item) => item.severity === 'error');
      const first = errors[0];
      const box = first ? boxOf(first) : '';
      ownSays(first
        ? `${box ? box + ' — ' : ''}${first.message} ${first.correction}`
        : 'This card could not be read.');
      ownDiagnostics(read.diagnostics);
      return;
    }

    saving = true;
    x.disabled = true;
    /* THE EMPTY MEDIA LIST BELOW IS SAFE HERE AND ONLY HERE. store.put() clears
     * a deck's whole media range before it writes anything, so handing it [] for
     * a deck that already holds pictures deletes every one of them. This id was
     * minted a moment ago and checked against every deck in the database, so the
     * range being cleared is empty by construction — the creation path is media
     * safe because there is nothing there yet, not because it is careful. ANY
     * FUTURE SAVE PATH INTO AN EXISTING DECK MUST CARRY THAT DECK'S MEDIA
     * THROUGH THIS CALL, or fixing the wording of one card takes the pictures
     * off the other four hundred. */
    try {
      await store.put({
        id,
        title,
        /* No sourceCourseId. That field is what makes a later file say "this is
         * the same course again, keep your progress", and no file is an update
         * to a deck somebody wrote here — the only way one can reach it is by
         * carrying the same name, which is the start-over path and says so
         * before the button. */
        importFormat: 'own',
        created: Date.now(),
        updated: Date.now(),
        cards: read.course.cards.length,
        ids: read.course.cards.map(cardIdentity),
        art: RAVENS[Math.abs(hash(title)) % RAVENS.length],
        sectionArt: {},
        groupArt: {},
        mediaIndexBySource: {},
        // The Markdown as it was typed, the way the .keep path stores it: boot
        // owns the one render pass.
        deck: read.written,
      }, []);
    } catch (e) {
      console.error(e);
      // Nothing is in flight any more, so the sheet can be left again — and the
      // words are still in the boxes, which is the point of failing here.
      saving = false;
      x.disabled = false;
      save.disabled = false;
      ownSays(/quota|space/i.test(e?.name + e?.message)
        ? 'There is no room for this deck: the browser is out of space for this site. '
          + 'Removing a deck you no longer study will free it.'
        : `The deck could not be saved: ${e?.message || String(e)}`);
      return;
    }
    saving = false;
    x.disabled = false;
    madeId = id;
    made(id, title);
  }

  /* What just happened, and the one thing worth knowing next.
   *
   * The importer's other paths go straight into the deck, because a file you
   * have read a receipt for is a deck you have already decided about. A deck of
   * one card is not: the next thing a person does is write the second card, and
   * this is the only screen there is to say where that lives. */
  function made(id, title) {
    body.innerHTML = `<h2 class="imp-h" tabindex="-1">${esc(title)}</h2>
      <p class="imp-sub">one card, written to this device</p>
      <div class="imp-book">
        <h3>what happens now</h3><ul>
          <!-- No <b> anywhere but the empty leading one: .imp-book li.said b is
               hidden, which is what keeps the numbered column lined up, and an
               emphasised word inside one of these lines would simply not be
               there. -->
          <li class="said"><b></b><span>Browse is where you write the next card, and every
            card after it — “Write a card” is at the top of the list</span></li>
          <li class="said"><b></b><span>a deck you wrote does not sync, and this device is
            the only place it exists — Settings → export a backup keeps what you have
            answered and the cards you add next, not the deck</span></li>
          <li class="said"><b></b><span>removing it from the courses screen takes the deck,
            what you have answered and every card in it</span></li>
        </ul>
      </div>
      <div class="imp-acts">
        <button type="button" class="go" data-open>start studying</button>
        <button type="button" data-shelf>back to your decks</button>
      </div>`;
    body.querySelector('.imp-h').focus();
    body.querySelector('[data-open]').addEventListener('click', () => enter(id));
    body.querySelector('[data-shelf]').addEventListener('click', () => close(false));
  }

  // A page-wide drop target: aiming at a dashed rectangle with a file in hand
  // is a small indignity, and the whole screen is unambiguous.
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f && body.querySelector('#imp-input')) go(f);
  });

  function working(line) {
    body.innerHTML = `<div class="imp-work" role="status" aria-live="polite" tabindex="-1">${doodle('perch')}
      <p id="imp-say">${esc(line)}</p>
      <div class="imp-bar"><i id="imp-bar"></i></div></div>`;
    body.querySelector('.imp-work').focus();
  }

  function fail(message, detail) {
    body.innerHTML = `<div class="imp-err" role="alert" tabindex="-1"><b>${esc(message)}</b><p>${esc(detail || '')}</p></div>
      <div class="imp-acts"><button type="button" class="go" data-again>try another file</button></div>`;
    body.querySelector('.imp-err').focus();
    body.querySelector('[data-again]').addEventListener('click', () => pick(true));
  }

  function failDiagnostics(result) {
    const errors = result.diagnostics.filter((item) => item.severity === 'error').slice(0, 8);
    const reference = result.sourceFormat === 'legacy-v1'
      ? './docs/reference/errors/#legacy-compatibility'
      : './docs/reference/errors/';
    body.innerHTML = `<div class="imp-err" role="alert" tabindex="-1"><b>this course needs a fix</b>
      <p>Nothing was saved. Correct the source, then try it again.</p>
      <ol class="imp-diags">${errors.map((item) => `<li><code>${esc(item.code)}</code>
        <span>${esc(item.message)}</span>
        ${item.line ? `<small>line ${n(item.line)}, column ${n(item.column)}</small>` : ''}
      <small>${esc(item.correction)}</small></li>`).join('')}</ol></div>
      <div class="imp-acts"><button type="button" class="go" data-again>try another file</button>
      <a class="imp-docs" href="${reference}">open the error reference</a></div>`;
    body.querySelector('.imp-err').focus();
    body.querySelector('[data-again]').addEventListener('click', () => pick(true));
  }

  async function go(file) {
    working('reading the package…');
    const say = body.querySelector('#imp-say');
    const bar = body.querySelector('#imp-bar');
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    await frame();

    let built;
    try {
      if (isKeepFile(file.name)) {
        /* Give the reader the File itself. It can reject an oversized YAML or
         * archive from File.size before arrayBuffer() reserves that memory. */
        const result = await readCourseFile(file, { fileName: file.name });
        if (!result.course) {
          failDiagnostics(result);
          return;
        }
        built = {
          kind: 'keep',
          title: result.course.title || result.course.courseId,
          sourceCourseId: result.course.courseId,
          course: result.runtimeCourse,
          // Keep authored CommonMark on disk. Boot owns the one render pass;
          // persisting its HTML preview would make a later boot render it as
          // Markdown a second time.
          deck: result.authoredCourse,
          media: result.media,
          mediaIndexBySource: result.mediaIndexBySource,
          receipt: keepReceipt(result),
          presentation: presentationOf(result.course),
          sectionArt: {},
          groupArt: {},
        };
      } else {
        if (file.size > MAX_PACKAGE_BYTES) {
          throw new ApkgError(`that package is too large for this device (${n(file.size)} bytes).`);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const col = await readApkg(bytes);
        const legacy = await buildDeck(col, {
          fileName: file.name,
          // Closing the sheet mid-build should stop the build, not leave it
          // grinding through twenty thousand cards for a screen that is gone.
          yield: () => (el.isConnected ? frame() : Promise.reject(new Cancelled())),
          onProgress(done, total, stage) {
            say.textContent = total > 1 ? `${stage} — ${n(done)} of ${n(total)}` : stage + '…';
            bar.style.width = total ? `${Math.round((done / total) * 100)}%` : '0';
          },
        });
        // Preserve the account-style "nothing landed" receipt before the
        // permanent adapter (correctly) rejects an empty course.
        if (!legacy.deck.cards.length) {
          body.innerHTML = nothingHtml(legacy.receipt);
          body.querySelector('.imp-h').focus();
          body.querySelector('[data-again]').addEventListener('click', () => pick(true));
          return;
        }
        /* Anki HTML is already rendered and sanitized, so it must retain the
         * permanent format-1 content marker in storage. The inverse projection
         * lives at the same compatibility boundary as its reader; buildDeck
         * and this importer otherwise use descriptive course fields only. */
        const storageDeck = projectDescriptiveCourseToLegacy(legacy.deck);
        const sourceCourseId =
          `anki-${(hash(JSON.stringify(storageDeck.cards)) >>> 0).toString(36)}`;
        const normalized = normalizeLegacyCourse(storageDeck, { courseId: sourceCourseId });
        if (!normalized.course) {
          failDiagnostics(normalized);
          return;
        }
        built = {
          ...legacy,
          kind: 'anki',
          title: legacy.deck.title,
          sourceCourseId,
          course: normalized.course,
          // Existing Anki HTML has safe constructs outside public CommonMark
          // (ruby, audio placeholders, sub/sup). Keep its proven format-1
          // artifact on disk so the permanent adapter retains the
          // sanitized-HTML representation marker on every read.
          deck: storageDeck,
          mediaIndexBySource: {},
        };
      }
    } catch (e) {
      if (e instanceof Cancelled) return;
      console.error(e);
      if (e instanceof ApkgError) fail('that file could not be read', e.message);
      else if (e && /quota|storage/i.test(e.name + e.message)) {
        fail('there is no room for this deck', 'the browser is out of space for this site.');
      } else fail('something went wrong reading that deck', e?.message || String(e));
      return;
    }

    // Reading the database can fail too — a locked-down or private browser
    // refuses to open it. This used to sit outside the catch above, so the
    // screen simply stopped, mid-progress, saying nothing.
    let existing = null;
    try {
      existing = match(await store.list(), built);
    } catch (e) {
      console.error(e);
      fail('this browser will not let keep club store anything',
        'private windows and some managed browsers block the local database keep club keeps decks in.');
      return;
    }
    // What the person has written into the deck this file would replace. Read
    // here rather than inside the receipt, which renders and does not go
    // looking: the count is a fact about the device, and the receipt's job is
    // to say it.
    if (existing) existing.written = writtenInto(existing.id);
    body.innerHTML = receiptHtml(built.receipt, existing);
    body.querySelector('.imp-h').focus();
    body.querySelector('[data-cancel]').addEventListener('click', () => close(false));
    for (const b of body.querySelectorAll('[data-keep]')) {
      b.addEventListener('click', () => keep(built, b.dataset.keep === 'replace' ? existing : null));
    }
  }

  /* Two decks can reduce to the same title and share not one card — a
   * different export of a different subject called "Sailing". Offering to keep
   * your progress there is a promise the app cannot keep: app.js drops every
   * record whose card id is not in the deck, so the first boot after such a
   * replace silently wipes the lot. Match on the cards, and say which it is. */
  function match(decks, built) {
    const mine = new Set(built.course.cards.map(cardIdentity).filter(Boolean));
    /* Never a deck somebody wrote here. Both rulings about replacing are about
     * a deck a file could be another copy of: the same deck again keeps the
     * layer, a different deck under the same name takes it and starts over. A
     * deck of your own carries no sourceCourseId — no file is an update to one
     * — so it could only ever land on the second, which deletes the deck's own
     * document along with the layer. That document is the cards themselves, and
     * nothing puts it back: the backup file is per-course and holds the history,
     * the notes and the layer, never the deck. A file that merely shares its
     * name is a different deck, and a different deck is a second row.
     */
    decks = decks.filter((deck) => deck.importFormat !== 'own');
    const identified = decks.filter((deck) =>
      deck.sourceCourseId && deck.sourceCourseId === built.sourceCourseId);
    if (identified.length) {
      const current = identified[0];
      const old = new Set(current.ids || []);
      const unchanged = [...mine].filter((id) => old.has(id)).length;
      return {
        ...current,
        sameDeck: true,
        updateDelta: {
          unchanged,
          added: mine.size - unchanged,
          removed: old.size - unchanged,
        },
      };
    }
    const same = decks.filter((d) => d.title === built.title);
    if (!same.length) return null;
    /* Public identity is explicit. A different courseId remains a different
     * course even if a creator reused a title and some card IDs; the overlap
     * heuristic below exists only for Anki exports whose source ID is derived
     * from a changing set of imported cards. */
    if (built.kind === 'keep') return { ...same[0], sameDeck: false };
    for (const d of same) {
      const overlap = (d.ids || []).filter((i) => mine.has(i)).length;
      if (overlap && overlap >= Math.min(d.cards, mine.size) / 2) {
        return {
          ...d,
          sameDeck: true,
          updateDelta: {
            unchanged: overlap,
            added: mine.size - overlap,
            removed: Math.max(0, (d.ids || []).length - overlap),
          },
        };
      }
    }
    return { ...same[0], sameDeck: false };
  }

  async function keep(built, replacing) {
    saving = true;
    x.disabled = true;
    working('putting it away…');
    let id = replacing ? replacing.id : newId();
    if (!replacing) {
      // Date.now() alone collided when two tabs finished together, and the
      // second put simply overwrote the first deck.
      try {
        const taken = new Set((await store.list()).map((d) => d.id));
        while (taken.has(id)) id = newId();
      } catch { /* the put below reports a database that will not open */ }
    }
    try {
      await store.put({
        id,
        title: built.title,
        sourceCourseId: built.sourceCourseId,
        importFormat: built.kind,
        created: replacing ? replacing.created : Date.now(),
        updated: Date.now(),
        cards: built.course.cards.length,
        // Kept so a later import can tell "the same deck again" from "another
        // deck with the same name" without loading every card.
        ids: built.course.cards.map(cardIdentity),
        art: RAVENS[Math.abs(hash(built.title)) % RAVENS.length],
        sectionArt: built.sectionArt,
        groupArt: built.groupArt,
        mediaIndexBySource: built.mediaIndexBySource,
        receipt: built.receipt,
        ...(built.presentation ? { presentation: built.presentation } : {}),
        deck: built.deck,
      }, built.media);
    } catch (e) {
      console.error(e);
      // Nothing is in flight any more, so the sheet can be left again.
      saving = false;
      x.disabled = false;
      fail('the deck could not be saved',
        /quota|space/i.test(e?.name + e?.message)
          ? 'the browser is out of space for this site. Removing a deck you no longer study will free it.'
          : e?.message || String(e));
      return;
    }
    if (replacing && replacing.sameDeck === false) {
      // The database transaction has committed the replacement. Only now is it
      // safe to honour "start over": clearing first would lose progress if the
      // replacement write rolled back.
      try {
        localStorage.setItem(globalThis.MUNIN.resetKey(id),
          Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
        localStorage.removeItem(globalThis.MUNIN.stateKey(id));
        // The layer goes with the history, and only here. Its records are keyed
        // by the OLD deck's card ids, so what would be left of it over a deck of
        // different cards is edits that override nothing and cards written into
        // a deck that is not on this device any more. The same replace onto the
        // same deck keeps both, which is the whole point of an override
        // surviving a course update. The line above the button says which of
        // the two this one is before it is pressed.
        localStorage.removeItem(globalThis.MUNIN.cardsKey(id));
        globalThis.MUNIN.abandonState?.(id);
      } catch (e) {
        saving = false;
        x.disabled = false;
        fail('the deck was replaced, but its old progress could not be cleared',
          'device storage is blocked. Reload, then use Settings → erase all progress before studying it.'
          + (replacing.written
            ? ' The cards you wrote into the old deck are still on this device too, to keep or to delete.'
            : ''));
        return;
      }
    }
    enter(id);
  }

  // The deck you just imported, or just wrote, is the one you meant to study.
  // Go through the shell so Back lands on the picker, while retaining the
  // deep-link fallback for an older shell or a blocked resume-pointer write.
  function enter(id) {
    try {
      if (typeof globalThis.MUNIN.enter === 'function') {
        globalThis.MUNIN.enter(id);
      } else {
        localStorage.setItem(globalThis.MUNIN.lastKey, id);
        location.reload();
      }
    } catch (e) {
      // The deck itself is safely committed. Open it through the one-shot deep
      // link so a failed convenience pointer cannot freeze this sheet and
      // tempt a duplicate import.
      location.assign('./?course=' + encodeURIComponent(id));
    }
  }

  pick();
}

const newId = () => 'local-' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}
