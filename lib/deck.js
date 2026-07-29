/* An Anki collection, turned into a keep club deck and an account of what happened.
 *
 * The account is the point. Anki's own importer tells you "39 notes imported"
 * and leaves you to discover months later that a note type it did not
 * understand quietly produced nothing — so everything this file drops, it
 * counts, with a reason a person can act on.
 *
 * Decks become sections, because that is what keep club browses by, and the deck
 * names' common prefix becomes the deck's own name: an export of
 * "Japanese::Core::Stage 1" and "…::Stage 2" is a deck called Japanese · Core
 * with two sections, not two decks whose names both start with the same
 * eighteen characters.
 */

import { render, clozeOrds } from './template.js';
import { clean, toText, isEmpty, tagEnd } from './html.js';
import { DECK_FORMAT } from './validate.js';

const FRONT = '\u0001munin-front-side\u0001';
const FRONT_RE = new RegExp(FRONT + '\\s*(<hr[^>]*>)?', 'g');

/* What a dropped card looked like, for the receipt. The rendered text still
 * carries the front-side sentinel and whatever control characters the deck
 * used as separators; a person reading their own receipt should see their own
 * words, not keep club's plumbing. */
function sample(html) {
  return toText(String(html).replaceAll(FRONT, ' ')).replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* keep club's own drawings, for a deck that brings none: an imported deck's
 * sections are labelled from this set. Exported because import.js needs the
 * same list to pick a deck's tile, and the two copies of it drifting apart
 * would mean a deck whose shelf tile is not one of its own section drawings.
 * The separation gate checks it against doodles-munin.js, which is where the
 * drawings themselves live. */
export const RAVENS = ['perch', 'peek', 'flap', 'carry', 'roost', 'hoard', 'puff',
  'strut', 'quill', 'bow', 'prints', 'nest', 'worm', 'shell'];

const LATEX = /\[latex\]|\[\$\$?\]|\\begin\{|\\\(/i;

/** Short, stable, and legal in a URL fragment. */
function slug(s, taken) {
  let base = String(s).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28);
  if (!base) base = 'section';
  let k = base, i = 2;
  while (taken.has(k)) k = `${base}-${i++}`;
  taken.add(k);
  return k;
}

/* A deck's name is a heading and a shelf row, not a document. Anki will happily
 * export one twelve thousand characters long, and stored whole it made the
 * receipt heading ten thousand pixels tall and pushed the shelf's own controls
 * — "+ your own deck", the other decks, the ✕ — seventeen screens down, with no
 * cure but to find that ✕ and delete the deck. Hierarchical names of a few
 * hundred characters are ordinary; this is where they stop. Counted in code
 * points, so the cut never lands inside one. */
const TITLE_MAX = 120;
function cap(s) {
  const t = String(s).trim();
  const chars = [...t];
  if (chars.length <= TITLE_MAX) return t;
  return chars.slice(0, TITLE_MAX - 1).join('').trimEnd() + '…';
}

function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** How much of the deck names every deck shares. */
function commonPrefix(paths) {
  if (!paths.length) return [];
  const first = paths[0];
  let n = 0;
  while (n < first.length) {
    const part = first[n];
    if (!paths.every((p) => p.length > n + 1 && p[n] === part)) break;
    n++;
  }
  return first.slice(0, n);
}

/* Anki keeps media as <img src=…> in the field text and audio as a [sound:…]
 * marker. Both become numbered references that mean nothing outside this deck,
 * so a card can never reach for the network and a stored deck is self-contained.
 *
 * <video> and <source> used to be on this list, and the omission is now the
 * decision: html.js keeps neither, so no card can ever show one. Rewriting them
 * anyway unpacked the file, stored it, and billed it to the receipt as a picture
 * that landed — five megabytes of video charged to a deck that displays none of
 * it, on the one screen whose whole job is to be honest about what happened.
 * Munin studies flashcards; a video it cannot play is better admitted than
 * carried. It gets a line of its own below instead. */
const MEDIA_TAG = /<(?:img|audio)\b/gi;
const OTHER_MEDIA = /<(?:video|source)\b/i;
const SRC_ATTR = /\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i;
/* No length bound on the name. The bound was 300 characters, and a marker over
 * it simply did not match: not rewritten, not counted as missing, and left on
 * the card as the literal text "[sound:bbbb…bbbb.mp3]" under a receipt saying
 * nothing was lost. What the bound was really guarding — a stray "[sound:" in
 * prose putting a paragraph on the receipt as a filename — is guarded where it
 * belongs, in `index` below, which is what writes that line. */
const SOUND = /\[sound:([^\]]+)\]/gi;

/* Media can never reach the network — every reference is rewritten to a number.
 * A link the deck's author wrote is different: it is content, and stripping it
 * would lose a card's source. It is also the one thing on an imported card that
 * can tell a stranger you are studying their deck, so it gets a line on the
 * receipt rather than a silent decision in either direction. */
const LINK = /<a\s[^>]{0,2000}href="https?:/i;

/* Walk the media tags one at a time instead of matching them with a single
 * expression. That expression was `[^>]*?\bsrc=`, which is quadratic — every
 * `<img` with no `>` after it re-scanned the rest of the field, and one note
 * holding 200,000 of them froze the tab for 43 seconds. It was also wrong about
 * `<img alt=">" src=…>`, where the `>` it stopped at is inside a quoted value:
 * the src was never rewritten, so a `munin-media:` reference written by hand
 * reached the sanitiser intact and the receipt undercounted the pictures.
 * Both are the same fix — find the end of the tag properly, then look inside. */
function eachMediaTag(html, fn) {
  MEDIA_TAG.lastIndex = 0;
  const out = [];
  let at = 0, m;
  while ((m = MEDIA_TAG.exec(html))) {
    const end = tagEnd(html, m.index);
    if (end < 0) break;                        // an unterminated tag is not a tag
    out.push(html.slice(at, m.index), fn(html.slice(m.index, end + 1)));
    at = end + 1;
    MEDIA_TAG.lastIndex = at;
  }
  return out.length ? out.join('') + html.slice(at) : html;
}

function mediaRewriter(col, acc) {
  const index = (raw) => {
    const name = raw.replace(/^["']|["']$/g, '').trim();
    // decodeURIComponent throws on a bare per-cent sign, and this list used to
    // be built before the first candidate was even tried — so one picture
    // called "100%.png" refused the entire package.
    let decoded = name;
    try { decoded = decodeURIComponent(name.replace(/\+/g, '%20')); } catch { /* not encoded */ }
    for (const cand of [name, decoded]) {
      if (acc.byName.has(cand)) return acc.byName.get(cand);
      if (col.media.has(cand)) {
        const i = acc.list.length;
        acc.list.push(cand);
        acc.byName.set(cand, i);
        return i;
      }
    }
    // What goes on the receipt is read by a person, so it is a name-sized thing
    // whatever the file said. A `[sound:` opened in prose can hand this a whole
    // paragraph.
    acc.missing.add(name.length > 90 ? name.slice(0, 90) + '…' : name);
    return null;
  };
  // src attributes first: the audio element written for a [sound:…] marker has
  // a src of its own, and a second pass over it would look up "munin-media:3"
  // as though it were a filename and throw the element away.
  return (html) => eachMediaTag(String(html ?? ''), (tag) => tag.replace(SRC_ATTR, (whole, val) => {
    const i = index(val);
    if (i === null) return 'src=""';      // the sanitiser drops a src it cannot serve
    acc.images.add(i);
    return `src="munin-media:${i}"`;
  })).replace(SOUND, (whole, name) => {
    const i = index(name);
    if (i === null) return '';
    acc.sounds.add(i);
    return `<audio controls src="munin-media:${i}"></audio>`;
  });
}

/**
 * @param {object} col        from readApkg
 * @param {object} [opts]     { onProgress(done, total, stage) }
 * @returns {Promise<{deck: object, receipt: object, media: Array}>}
 */
export async function buildDeck(col, opts = {}) {
  const say = opts.onProgress || (() => {});

  const notes = new Map();
  for (const n of col.notes()) {
    notes.set(Number(n.id), {
      flds: String(n.flds ?? '').split('\x1f'),
      mid: Number(n.mid),
      tags: String(n.tags ?? '').trim(),
    });
  }
  say(0, 1, 'reading the cards');

  const rows = [];
  for (const c of col.cards()) rows.push(c);

  const acc = { list: [], byName: new Map(), missing: new Set(), images: new Set(), sounds: new Set() };
  const rewrite = mediaRewriter(col, acc);
  const unknownFields = new Set(), unknownFilters = new Set();

  const skipped = new Map();
  const drop = (why, example) => {
    const e = skipped.get(why) || { why, count: 0, examples: [] };
    e.count++;
    if (example && e.examples.length < 3) e.examples.push(example.slice(0, 70));
    skipped.set(why, e);
  };

  const byDeck = new Map();       // deck name → cards
  /* What each card would contribute to the receipt, kept beside the card rather
   * than added up on the spot. The media pass below can still drop a card, and
   * a tally taken before that describes cards that are not in the deck: "2
   * kept" two lines above "made from 2 kinds of note: 4 Basic, 1 Hinted", and a
   * promise to study a suspended card that nothing will ever show. */
  const tally = new Map();        // card id → what it counts towards
  let latex = 0;
  const seen = new Set();
  const ids = new Set();

  let done = 0;
  for (const row of rows) {
    if (++done % 500 === 0) {
      say(done, rows.length, 'building cards');
      // A fifty-thousand-card deck is a second of straight-line work, and a
      // progress line that only paints when it is over is not a progress line.
      if (opts.yield) await opts.yield();
    }
    const note = notes.get(Number(row.nid));
    if (!note) { drop('their note is not in the file', ''); continue; }
    const nt = col.notetypes.get(note.mid);
    if (!nt) { drop('their note type is missing from the file', ''); continue; }

    const ord = Number(row.ord ?? 0);
    // A cloze note type has one template and one card per deletion; everything
    // else has one template per card.
    const tmpl = nt.cloze ? (nt.templates[0] || null)
      : (nt.templates.find((t) => t.ord === ord) || null);
    if (!tmpl) { drop('the template that made them is missing', nt.name); continue; }

    const deckId = Number(row.odid) || Number(row.did);
    const deckName = col.decks.get(deckId) || 'Imported';

    const fields = {};
    nt.fields.forEach((name, i) => { fields[name] = rewrite(note.flds[i] ?? ''); });
    if (nt.fields.length && note.flds.some((f) => LATEX.test(f))) latex++;

    const ctx = {
      fields,
      tags: note.tags,
      notetype: nt.name,
      deck: deckName,
      template: tmpl.name,
      ord,
      isCloze: nt.cloze,
      answer: false,
      unknownFields,
      unknownFilters,
    };
    const rawQ = render(tmpl.qfmt, ctx);
    const rawA = render(tmpl.afmt, { ...ctx, answer: true, frontSide: FRONT });

    const q = clean(rawQ).html;
    let a = clean(rawA.replace(FRONT_RE, '')).html;
    // An answer that was only "{{FrontSide}}" is not an empty answer; it is a
    // card whose answer is its front, and Anki shows exactly that.
    if (isEmpty(a)) a = clean(rawA.replaceAll(FRONT, rawQ)).html;

    // A cloze card is a card because something is hidden. An ordinal with no
    // matching deletion — or a cloze note type with no {{c1::}} at all — renders
    // the whole text on both sides: a card that asks you its own answer. Anki
    // does not make one, and neither should we.
    if (nt.cloze && !q.includes('class="cloze"')) {
      drop('nothing was blanked out on them', sample(rawQ));
      continue;
    }
    if (!nt.fields.length) { drop('their note type has no fields', nt.name); continue; }
    if (isEmpty(q)) { drop('their question side came out empty', sample(rawA)); continue; }
    if (isEmpty(a)) { drop('their answer side came out empty', sample(rawQ)); continue; }

    // A NUL cannot appear in cleaned HTML, so it is a separator that no card
    // can fake: without one, "ab"+"c" and "a"+"bc" are the same duplicate.
    const key = q + '\u0000' + a;
    const duplicate = seen.has(key);
    seen.add(key);

    // Not Number(): two ids either side of 2^53 collapse onto the same value,
    // and app.js keys its whole session by this — one card became unreachable
    // and its twin was graded twice.
    let id = (typeof row.id === 'bigint' ? row.id : BigInt(Math.trunc(Number(row.id) || 0)))
      .toString(36);
    while (ids.has(id)) id += '-';       // a file with duplicate rows still counts twice
    ids.add(id);
    tally.set(id, {
      kind: nt.name,
      cloze: nt.cloze,
      suspended: Number(row.queue) === -1,
      duplicate,
      link: LINK.test(q) || LINK.test(a),
      // Counted off the rendered field, before clean() throws the element away.
      video: OTHER_MEDIA.test(rawQ) || OTHER_MEDIA.test(rawA),
    });
    const card = { i: id, q, a };
    if (!byDeck.has(deckName)) byDeck.set(deckName, []);
    byDeck.get(deckName).push(card);
  }

  /* ── the media that survived ── */
  say(0, acc.list.length, 'unpacking media');
  const media = [];
  const damaged = [];
  const lost = new Set();
  for (let i = 0; i < acc.list.length; i++) {
    if (i % 20 === 0) {
      say(i, acc.list.length, 'unpacking media');
      /* And hand the screen back, the way the card loop does. In a legacy
       * export every member is deflated, so `zip.read` awaits a real
       * DecompressionStream and this loop painted by accident. In a current one
       * the members are stored and zstd-decoded in line, so `mediaBytes` never
       * suspends: two thousand pictures resolved two thousand settled promises
       * as microtasks and froze the tab for fourteen seconds, at a hundred per
       * cent, on a screen still saying "building cards". Nothing could be
       * cancelled either, which is the part that is not just cosmetic. */
      if (opts.yield) await opts.yield();
    }
    const name = acc.list[i];
    let bytes = null;
    try {
      bytes = await col.mediaBytes(name);
    } catch (e) {
      // Half a downloaded package is still a deck. One unreadable picture used
      // to throw out every card in the file with it.
      damaged.push(name);
    }
    // SVG is a script container; store.js refuses to serve it as an image, so
    // counting it as a picture that landed would be a lie on the receipt.
    if (bytes && /\.svgz?$/i.test(name)) { damaged.push(name); bytes = null; }
    if (!bytes) {
      if (!damaged.includes(name)) acc.missing.add(name);
      lost.add(i);
      continue;
    }
    media.push({ i, name, kind: acc.sounds.has(i) ? 'snd' : 'img', bytes });
  }
  /* A reference with no file behind it would render as a broken image for
   * ever. This happens BEFORE the sections are built, because a card can lose
   * its last content here: a front that was nothing but a picture, when that
   * picture is an SVG (which Munin will not serve) or did not survive the
   * zip, is left with no question at all. Such a card used to be kept, blank
   * — and once app.js started checking the shape of a deck at boot, one of
   * them refused the entire import. It is a dropped card like any other, and
   * it goes on the receipt with a reason instead. */
  if (lost.size) {
    const dead = new RegExp(`<(?:img|audio)[^>]*munin-media:(?:${[...lost].join('|')})"[^>]*>`, 'g');
    for (const [name, list] of byDeck) {
      const kept = [];
      for (const c of list) {
        c.q = c.q.replace(dead, '');
        c.a = c.a.replace(dead, '');
        if (isEmpty(c.q) || isEmpty(c.a)) {
          drop('the picture was the whole card, and it could not be read',
            sample(c.q) || sample(c.a));
          continue;
        }
        kept.push(c);
      }
      if (kept.length) byDeck.set(name, kept);
      else byDeck.delete(name);       // a deck of nothing but those is no deck
    }
    for (const i of lost) { acc.images.delete(i); acc.sounds.delete(i); }
  }
  const mediaBytes = media.reduce((n, m) => n + m.bytes.length, 0);

  /* Nothing can be dropped after this point, so this is where the receipt's
   * counts are taken — over the cards that are actually in the deck. */
  const kinds = new Map();        // note type name → cards made
  let suspended = 0, cloze = 0, duplicates = 0, links = 0, video = 0;
  for (const list of byDeck.values()) {
    for (const c of list) {
      const t = tally.get(c.i);
      if (!t) continue;
      kinds.set(t.kind, (kinds.get(t.kind) || 0) + 1);
      if (t.cloze) cloze++;
      if (t.suspended) suspended++;
      if (t.duplicate) duplicates++;
      if (t.link) links++;
      if (t.video) video++;
    }
  }

  /* ── sections, from the deck names ── */
  const names = [...byDeck.keys()].sort((a, b) => a.localeCompare(b));
  const paths = names.map((n) => n.split('::'));
  const prefix = names.length > 1 ? commonPrefix(paths) : paths[0]?.slice(0, -1) || [];
  /* With one deck, or several under one parent, the deck names say what this is.
   * With several unrelated top-level decks they do not, and taking the first one
   * alphabetically named a whole-library export "Chemistry". The file's own name
   * is the thing the person recognises. */
  const fromNames = (prefix.length ? prefix : (names.length === 1 ? paths[0] : [])).join(' · ');
  /* Plain text, not HTML. This was clean(…).html, so a deck called "Kanji &
   * Kana" was stored as "Kanji &amp; Kana" and then escaped again by every one
   * of the four places that render it — the tab title, the shelf tile and the
   * receipt heading all read "Kanji &amp;amp; Kana", beside a section list that
   * had it right. The title is text at every use site; escaping belongs there. */
  const title = cap(toText(fromNames).replace(/^[\s·]+|[\s·]+$/g, '')
    || String(opts.fileName || '').replace(/\.(apkg|colpkg|zip)$/i, '').trim()
    || 'Imported deck');

  const taken = new Set();
  const sections = [], cards = [];
  const groupOf = new Map();
  names.forEach((name, i) => {
    const rest = name.split('::').slice(prefix.length);
    const label = (rest.length ? rest : [name.split('::').pop()]).join(' · ');
    const k = slug(label || name, taken);
    const list = byDeck.get(name);
    sections.push({ k, t: cap(label || name), n: list.length, o: i + 1 });
    for (const c of list) cards.push({ ...c, s: k });
    if (rest.length > 1) groupOf.set(k, rest[0]);
  });

  /* A group per shared first level — but Browse only ever shows sections
   * through their group, so a partial grouping would hide the sections it left
   * out. Group all of them or none of them, and one group holding everything is
   * the section list with an extra tap, so that counts as none. */
  const groups = [];
  const gTaken = new Set();
  const byGroup = new Map();
  for (const [k, g] of groupOf) {
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(k);
  }
  if (byGroup.size > 1 && groupOf.size === sections.length) {
    for (const [name, ks] of byGroup) {
      groups.push({
        k: slug(name, gTaken),
        t: cap(name),
        s: ks,
        n: ks.reduce((sum, k) => sum + sections.find((s) => s.k === k).n, 0),
      });
    }
  }

  const sectionArt = {};
  sections.forEach((s, i) => { sectionArt[s.k] = RAVENS[i % RAVENS.length]; });
  const groupArt = {};
  groups.forEach((g, i) => { groupArt[g.k] = RAVENS[(i + 3) % RAVENS.length]; });


  const deck = {
    // Which description of a deck this is. A stored deck outlives the build
    // that made it, so it says so itself rather than being assumed.
    format: DECK_FORMAT,
    name: title,
    sections,
    groups,
    cards,
    build: hash(cards.map((c) => c.i).join(',') + title),
  };

  const receipt = {
    title,
    schema: col.schema,
    modern: col.member.endsWith('b') || col.schema >= 18,
    read: { decks: names.length, notes: notes.size, cards: rows.length },
    made: { cards: cards.length, sections: sections.length, groups: groups.length },
    kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
    cloze,
    suspended,
    duplicates,
    latex,
    links,
    video,
    media: {
      images: acc.images.size,
      sounds: acc.sounds.size,
      bytes: mediaBytes,
      missing: [...acc.missing].slice(0, 20),
      missingCount: acc.missing.size,
      damaged,
    },
    skipped: [...skipped.values()].sort((a, b) => b.count - a.count),
    unknownFields: [...unknownFields].slice(0, 10),
    unknownFilters: [...unknownFilters].slice(0, 10),
  };

  return { deck, receipt, media, sectionArt, groupArt };
}
