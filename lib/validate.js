/* What a deck has to be.
 *
 * Cards are the course's half of the seam, and until this file existed the
 * shape of them was only written down twice, in two languages, and agreed by
 * nobody: the python that builds Day Skipper and Competent Crew emits it, and
 * lib/deck.js re-derives it from an Anki collection. Nothing checked either.
 * A shape change upstream showed up on somebody's phone as a blank Browse
 * screen or a card with no section.
 *
 * So: one description, run by app.js at boot, by the importer over what it
 * just built, and by the separation gate over every cards.json in the repo.
 *
 * `format` is the version of this shape. It is optional and absent means 1 —
 * the decks that shipped before it existed are format 1 by definition.
 */

export const DECK_FORMAT = 1;

const isStr = (v) => typeof v === 'string' && v.length > 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {unknown} deck
 * @returns {{ok: boolean, errors: string[], format: number}}
 */
export function validateDeck(deck) {
  const errors = [];
  const fail = (m) => { if (errors.length < 20) errors.push(m); };

  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) {
    return { ok: false, errors: ['the deck is not an object'], format: 0 };
  }
  const format = deck.format === undefined ? DECK_FORMAT : deck.format;
  if (format !== DECK_FORMAT) {
    // Said, not stringified: this is the one description everything else leans
    // on, and a validator that throws on a hostile value is a validator that
    // takes the caller down with it. JSON.stringify throws on a cycle.
    fail(`deck format ${typeof deck.format === 'number' || typeof deck.format === 'string'
      ? JSON.stringify(deck.format) : typeof deck.format} — this build reads format ${DECK_FORMAT}`);
  }

  if (!Array.isArray(deck.sections) || !deck.sections.length) fail('no sections');
  if (!Array.isArray(deck.cards) || !deck.cards.length) fail('no cards');
  if (errors.length) return { ok: false, errors, format };

  const sectionKeys = new Set();
  for (const s of deck.sections) {
    if (!s || typeof s !== 'object') { fail('a section is not an object'); continue; }
    if (!isStr(s.k)) { fail('a section has no key'); continue; }
    if (sectionKeys.has(s.k)) fail(`two sections share the key "${s.k}"`);
    sectionKeys.add(s.k);
    if (!isStr(s.t)) fail(`section "${s.k}" has no title`);
    // n is what the "seen every card in one section" test counts against; a
    // wrong one silently makes that unreachable rather than visibly broken.
    if (!isNum(s.n)) fail(`section "${s.k}" does not say how many cards it has`);
  }

  const ids = new Set();
  const perSection = new Map();
  let counted = 0;
  for (const c of deck.cards) {
    if (!c || typeof c !== 'object') { fail('a card is not an object'); continue; }
    if (!isStr(c.i)) { fail('a card has no id'); continue; }
    // Every scheduling record in localStorage is keyed by this id. Two cards
    // sharing one means one of them is unreachable and the other is graded
    // twice, which is not a thing anyone would work out from the symptoms.
    if (ids.has(c.i)) fail(`two cards share the id "${c.i}"`);
    ids.add(c.i);
    if (!isStr(c.q)) fail(`card "${c.i}" has no question`);
    if (!isStr(c.a)) fail(`card "${c.i}" has no answer`);
    if (!isStr(c.s)) fail(`card "${c.i}" is in no section`);
    else if (!sectionKeys.has(c.s)) fail(`card "${c.i}" is in section "${c.s}", which does not exist`);
    else perSection.set(c.s, (perSection.get(c.s) || 0) + 1);
    counted++;
  }
  if (!counted) fail('every card in the deck was unreadable');

  /* And `n` against the cards that are actually there. Checking only that it
   * was a number is what the comment above claimed to prevent and did not: a
   * section saying 0 renders "NaN% solid" on Progress, gives infinite bar
   * widths, and makes "seen every card in one section" either unreachable or
   * true on the first answer. */
  for (const s of deck.sections) {
    if (!isStr(s.k) || !isNum(s.n)) continue;
    const real = perSection.get(s.k) || 0;
    // Zero agrees with zero, so an empty section passed this and was exactly
    // the state described above. An empty section is not a section.
    if (!real) fail(`section "${s.k}" has no cards in it`);
    else if (s.n !== real) fail(`section "${s.k}" says it has ${s.n} cards and has ${real}`);
  }

  if (deck.groups !== undefined) {
    if (!Array.isArray(deck.groups)) fail('groups is not a list');
    else {
      const grouped = new Set();
      for (const g of deck.groups) {
        if (!g || typeof g !== 'object' || !isStr(g.k)) { fail('a group has no key'); continue; }
        if (!Array.isArray(g.s)) { fail(`group "${g.k}" lists no sections`); continue; }
        let held = 0;
        for (const k of g.s) {
          if (!sectionKeys.has(k)) fail(`group "${g.k}" holds section "${k}", which does not exist`);
          if (grouped.has(k)) fail(`section "${k}" is in two groups`);
          grouped.add(k);
          held += perSection.get(k) || 0;
        }
        if (isNum(g.n) && g.n !== held) fail(`group "${g.k}" says it has ${g.n} cards and has ${held}`);
      }
      // Browse only ever reaches a section through its group, so a partial
      // grouping hides the sections it left out. All of them or none.
      if (deck.groups.length && grouped.size !== sectionKeys.size) {
        fail(`${sectionKeys.size - grouped.size} of ${sectionKeys.size} sections are in no group`);
      }
    }
  }

  return { ok: !errors.length, errors, format };
}
