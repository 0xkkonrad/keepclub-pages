/* The receipt, on its own.
 *
 * Two screens show it: the importer, before you decide, and Progress, whenever
 * you want to remember what came in. That second one is the reason this is a
 * module of its own — pulling it out of import.js would drag the zip reader,
 * the SQLite reader and a zstd decoder into the boot of every imported deck,
 * to render a list of numbers that is already stored.
 */

export const CSS = `
  /* Both insets, like every other surface pinned to the top of the screen:
     without the top one the title and the ✕ sit under a notch's status bar. */
  .imp { position: fixed; inset: 0; z-index: 95; overflow-y: auto;
    background: var(--bg); color: var(--text);
    padding: calc(24px + env(safe-area-inset-top)) 20px
    calc(28px + env(safe-area-inset-bottom)); }
  .imp-inner { max-width: 460px; margin: 0 auto; }
  .imp-top { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .imp-top h2 { font-size: 1.05rem; font-weight: 500; margin: 0; text-transform: lowercase; }
  .imp-top .dood { width: 30px; height: 30px; color: var(--accent); }
  .imp-x { margin-left: auto; background: none; border: 0; color: var(--muted);
    font: inherit; font-size: 1.2rem; cursor: pointer; min-width: var(--tap);
    min-height: var(--tap); }
  /* While the deck is being written there is nothing to call off — see keep()
     in import.js. A control that cannot do anything should not look as if it can. */
  .imp-x:disabled { opacity: .35; cursor: default; }
  .imp-drop { border: var(--bw) dashed var(--stroke); border-radius: var(--r);
    background: var(--surface); padding: 34px 20px; text-align: center; }
  .imp-drop.over { border-color: var(--accent); color: var(--accent); }
  .imp-drop b { display: block; font-weight: 500; text-transform: lowercase; }
  .imp-drop p { margin: 6px 0 0; color: var(--muted); font-size: .82rem; }
  .imp-file { margin-top: 16px; min-height: var(--tap); width: 100%; padding: 12px;
    background: var(--accent); color: var(--accent-ink); font: inherit; font-size: .9rem;
    text-transform: lowercase; cursor: pointer; border: var(--bw) solid var(--stroke);
    border-radius: var(--r-sm); box-shadow: var(--sh-sm); }
  .imp-file small { display: block; margin-top: 3px; font-size: .74rem; opacity: .8; }
  .imp-how { margin-top: 22px; color: var(--muted); font-size: .78rem; line-height: 1.6; }
  .imp-how b { color: var(--text); font-weight: 500; }
  .imp-work { text-align: center; padding: 40px 0; }
  .imp-work .dood { width: 46px; height: 46px; color: var(--accent);
    animation: hop 2.2s ease-in-out infinite; }
  .imp-work p { color: var(--muted); font-size: .86rem; margin: 14px 0 0; }
  .imp-bar { height: 6px; margin: 16px auto 0; max-width: 240px; background: var(--surface);
    border: var(--bw) solid var(--stroke); border-radius: 99px; overflow: hidden; }
  .imp-bar i { display: block; height: 100%; width: 0; background: var(--accent); }
  /* A deck name is capped at build time, but it is still somebody else's
     text and it is still a heading: three lines of it, and a word with no
     spaces in it breaks rather than pushing the sheet sideways. */
  .imp-h { font-size: 1.15rem; font-weight: 500; margin: 0 0 2px;
    overflow-wrap: anywhere; overflow: hidden; display: -webkit-box;
    -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; }
  .imp-sub { color: var(--muted); font-size: .84rem; margin: 0 0 20px; }
  .imp-book { border: var(--bw) solid var(--stroke); border-radius: var(--r);
    background: var(--surface); box-shadow: var(--sh); padding: 4px 16px 14px; margin-bottom: 16px; }
  .imp-book h3 { font-size: .78rem; font-weight: 500; text-transform: lowercase;
    letter-spacing: .04em; color: var(--muted); margin: 14px 0 8px; }
  .imp-book ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
  .imp-book li { display: flex; gap: 12px; align-items: baseline; font-size: .88rem; }
  .imp-book li b { font-weight: 500; font-variant-numeric: tabular-nums; min-width: 3.2em;
    text-align: right; flex: none; }
  .imp-book li span { color: var(--muted); }
  .imp-book li.said { color: var(--muted); font-size: .82rem; }
  .imp-book li.said b { visibility: hidden; }
  .imp-eg { display: block; color: var(--muted); font-size: .76rem; font-style: italic; }
  .imp-acts { display: grid; gap: 10px; margin-top: 20px; }
  .imp-acts button { min-height: var(--tap); font: inherit; font-size: .92rem;
    text-transform: lowercase; cursor: pointer; border: var(--bw) solid var(--stroke);
    border-radius: var(--r-sm); box-shadow: var(--sh-sm);
    background: var(--surface); color: var(--text); }
  .imp-acts .go { background: var(--accent); color: var(--accent-ink); }
  .imp-err { border: var(--bw) solid var(--stroke); border-left-width: 6px;
    border-left-color: var(--g1, #c0392b); border-radius: var(--r); background: var(--surface);
    padding: 16px; }
  .imp-err b { display: block; font-weight: 500; margin-bottom: 4px; }
  .imp-err p { margin: 0; color: var(--muted); font-size: .84rem; }`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Number(v).toLocaleString('en-GB');
const plural = (v, one, many) => `${n(v)} ${v === 1 ? one : many || one + 's'}`;

function size(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1048576;
  return mb >= 1 ? `${mb.toFixed(mb >= 10 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function doodle(name) {
  const d = (globalThis.MUNIN_DOODLE || {})[name] || (globalThis.MUNIN_DOODLE || {}).perch || '';
  return `<svg class="dood" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}

/* ── the receipt ──────────────────────────────────────────────────────────
 * Three headings, in the order a person asks the questions: what have I got,
 * what did I not get, and what is different now. */

/* The numbered column is cards and only cards, so that the three sections of
 * this document add up: what was in the file, what was kept, what was dropped.
 * Anything that is not a card count goes in an unnumbered line under it. */
function landed(r) {
  const li = [];
  li.push(`<li><b>${n(r.read.cards)}</b><span>${r.read.cards === 1 ? 'card' : 'cards'
  } in the package, on ${plural(r.read.notes, 'note')}</span></li>`);
  li.push(`<li><b>${n(r.made.cards)}</b><span>kept</span></li>`);
  if (r.kinds.length > 1) {
    const say = r.kinds.slice(0, 5).map((k) => `${n(k.n)} ${k.name}`).join(', ');
    li.push(`<li class="said"><b></b><span>made from ${plural(r.kinds.length, 'kind')} of note: ${esc(say)}</span></li>`);
  }
  li.push(`<li class="said"><b></b><span>filed under ${plural(r.made.sections, 'section')} — your ${
    r.read.decks === 1 ? 'one anki deck' : `${n(r.read.decks)} anki decks`}</span></li>`);
  const m = r.media;
  if (m.images || m.sounds) {
    const bits = [];
    if (m.images) bits.push(plural(m.images, 'picture'));
    if (m.sounds) bits.push(plural(m.sounds, 'sound'));
    li.push(`<li class="said"><b></b><span>with ${bits.join(' and ')}${
      m.bytes ? `, ${size(m.bytes)}` : ''}</span></li>`);
  }
  return li.join('');
}

function lost(r) {
  const li = [];
  for (const s of r.skipped) {
    li.push(`<li><b>${n(s.count)}</b><span>${s.count === 1 ? 'card' : 'cards'} dropped: ${esc(s.why)}${
      s.examples.length ? `<span class="imp-eg">${esc(s.examples[0])}…</span>` : ''}</span></li>`);
  }
  if (r.media.missingCount) {
    li.push(`<li class="said"><b></b><span>${plural(r.media.missingCount, 'picture or sound', 'pictures or sounds')
    } the package does not contain<span class="imp-eg">${esc(r.media.missing.slice(0, 3).join(', '))}</span></span></li>`);
  }
  if (r.media.damaged?.length) {
    li.push(`<li class="said"><b></b><span>${plural(r.media.damaged.length, 'file')
    } keep club cannot show — damaged, or a kind of picture that can carry code<span class="imp-eg">${
      esc(r.media.damaged.slice(0, 3).join(', '))}</span></span></li>`);
  }
  if (r.video) {
    li.push(`<li class="said"><b></b><span>${plural(r.video, 'card')} had a video on ${
      r.video === 1 ? 'it' : 'them'}: keep club does not play video, so it stayed in the package</span></li>`);
  }
  if (r.unknownFields.length) {
    li.push(`<li><b></b><span>templates asked for fields that are not there: ${
      esc(r.unknownFields.join(', '))}</span></li>`);
  }
  return li.join('');
}

function changed(r) {
  const li = [];
  li.push('<li class="said"><b></b><span>scheduling does not come across — every card starts new</span></li>');
  if (r.suspended) {
    li.push(`<li class="said"><b></b><span>${plural(r.suspended, 'card')} suspended in Anki: keep club studies ${
      r.suspended === 1 ? 'it' : 'them'} like the rest</span></li>`);
  }
  if (r.duplicates) {
    li.push(`<li class="said"><b></b><span>${plural(r.duplicates, 'card')} identical to another — kept, not merged</span></li>`);
  }
  if (r.links) {
    li.push(`<li class="said"><b></b><span>${plural(r.links, 'card')} link out to the web — opening one tells that site you are studying this deck</span></li>`);
  }
  if (r.latex) {
    li.push(`<li class="said"><b></b><span>${plural(r.latex, 'note')} written in LaTeX: the source shows, not the equation</span></li>`);
  }
  li.push('<li class="said"><b></b><span>the deck’s own fonts and colours are dropped; keep club uses its own</span></li>');
  return li.join('');
}

/** The account itself, without the decision attached to it. */
export function book(r) {
  return `<div class="imp-book">
      <h3>what landed</h3><ul>${landed(r)}</ul>
      ${lost(r) ? `<h3>what didn’t</h3><ul>${lost(r)}</ul>` : ''}
      <h3>what is different now</h3><ul>${changed(r)}</ul>
    </div>`;
}

/* Nothing landed — and this used to be the one import that got no account at
 * all, in favour of a fixed sentence saying every card came out empty. For a
 * package with no cards in it that was simply untrue, and for one whose cards
 * really did come out empty the receipt already knew so and did not say. Same
 * reckoning as any other import, minus the two headings that would be
 * describing a deck that does not exist. */
export function nothingHtml(r) {
  const why = r.read.cards
    ? `${plural(r.read.cards, 'card')} in it, on ${plural(r.read.notes, 'note')} — and not one of them came out with anything on it.`
    : r.read.notes
      ? `it holds ${plural(r.read.notes, 'note')} and not one card. Anki makes the cards from a note type; if this is a shared deck, the note type that made them is not in the file.`
      : 'there are no notes and no cards in it — the export came out empty.';
  const li = lost(r);
  return `<h2 class="imp-h" tabindex="-1">nothing to study in that package</h2>
    <p class="imp-sub">${why}</p>
    ${li ? `<div class="imp-book"><h3>what didn’t</h3><ul>${li}</ul></div>` : ''}
    <div class="imp-acts">
      <button type="button" class="go" data-again>try another file</button>
    </div>`;
}

export function receiptHtml(r, existing) {
  return `<h2 class="imp-h" tabindex="-1">${esc(r.title)}</h2>
    <p class="imp-sub">read from ${r.modern ? 'a current' : 'a legacy'} anki export</p>
    ${book(r)}
    ${existing ? `<p class="imp-sub">you already have a deck called ${esc(existing.title)}, imported ${
      new Date(existing.created).toLocaleDateString('en-GB')}. ${existing.sameDeck
    ? 'It is this same deck, so replacing it keeps what you have answered.'
    : 'Its cards are different ones, so replacing it starts them over.'}</p>` : ''}
    <div class="imp-acts">
      ${existing
    ? `<button type="button" class="go" data-keep="replace">${existing.sameDeck
      ? 'replace it, keeping my progress' : 'replace it and start over'}</button>
         <button type="button" data-keep="new">keep both</button>`
    : '<button type="button" class="go" data-keep="new">start studying</button>'}
      <button type="button" data-cancel>throw it away</button>
    </div>`;
}


/** Put the receipt's styles on the page once, wherever it is being shown. */
export function ensureCss() {
  if (document.getElementById('imp-css')) return;
  const s = document.createElement('style');
  s.id = 'imp-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}
