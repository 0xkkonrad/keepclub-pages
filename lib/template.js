/* Anki's card templates, rendered.
 *
 * A note is a row of fields; a card is that row put through a template. Munin's
 * cards are a question and an answer, so the import has to actually run these
 * templates rather than guess that field 1 is the front. Most decks use
 * "{{Front}}" and "{{FrontSide}}<hr id=answer>{{Back}}" and would survive the
 * guess; the interesting half of the shared-deck library would not.
 *
 * Supported: field replacement, {{#Field}}/{{^Field}} conditionals, FrontSide,
 * the special fields, cloze deletions, and the filters that change what a card
 * says. Filters that are an interaction rather than content — type-in-the-answer
 * and text-to-speech — render as nothing, which is what they contribute to a
 * card you are reading.
 */

import { toText } from './html.js';

const TAG = /\{\{([^{}]*)\}\}/g;

/** Break a format into literals and tags, once. */
function parse(fmt) {
  const parts = [];
  let at = 0;
  for (const m of String(fmt ?? '').matchAll(TAG)) {
    if (m.index > at) parts.push({ t: 'lit', v: fmt.slice(at, m.index) });
    const body = m[1].trim();
    if (body.startsWith('#')) parts.push({ t: 'if', key: body.slice(1).trim(), neg: false });
    else if (body.startsWith('^')) parts.push({ t: 'if', key: body.slice(1).trim(), neg: true });
    else if (body.startsWith('/')) parts.push({ t: 'end', key: body.slice(1).trim() });
    else if (body === '!' || body.startsWith('!')) { /* a comment tag */ }
    else parts.push({ t: 'sub', body });
    at = m.index + m[0].length;
  }
  if (at < fmt.length) parts.push({ t: 'lit', v: fmt.slice(at) });
  return parts;
}

/** "text:hint:Front" — filters first, the field name last. */
function split(body) {
  const bits = body.split(':');
  return { field: bits.pop().trim(), filters: bits.map((f) => f.trim().toLowerCase()) };
}

/** Valid cloze spans in one forward pass. A lazy global regex restarted its
 * search from every unterminated `{{c1::` prefix, making malformed fields
 * quadratic. */
function* clozes(text) {
  const source = String(text ?? '');
  let search = 0;
  for (;;) {
    const start = source.indexOf('{{c', search);
    if (start < 0) return;
    let at = start + 3;
    const digits = at;
    while (at < source.length && source.charCodeAt(at) >= 48 && source.charCodeAt(at) <= 57) at++;
    if (at === digits || source.slice(at, at + 2) !== '::') {
      search = start + 3;
      continue;
    }
    const bodyAt = at + 2;
    const end = source.indexOf('}}', bodyAt);
    if (end < 0) return;
    yield {
      start, end: end + 2,
      n: Number(source.slice(digits, at)),
      body: source.slice(bodyAt, end),
    };
    search = end + 2;
  }
}

const hasCloze = (text) => !clozes(text).next().done;

/** The question side blanks one ordinal and shows the rest. */
export function cloze(text, ord, answer) {
  const source = String(text ?? '');
  let out = '', at = 0;
  for (const span of clozes(source)) {
    out += source.slice(at, span.start);
    const [content, hint] = splitHint(span.body);
    out += span.n !== ord + 1 ? content
      : answer
        ? `<span class="cloze">${content}</span>`
        : `<span class="cloze">[${hint || '...'}]</span>`;
    at = span.end;
  }
  return out + source.slice(at);
}

function splitHint(body) {
  const at = body.indexOf('::');
  return at < 0 ? [body, ''] : [body.slice(0, at), body.slice(at + 2)];
}

/** Which cloze numbers a note actually uses — Anki makes one card per number. */
export function clozeOrds(text) {
  const out = new Set();
  for (const span of clozes(text)) {
    if (span.n >= 1) out.add(span.n - 1);
  }
  return out;
}

/* Japanese decks write readings as 漢字[かんじ]. Three filters read that: as
 * ruby, as the reading alone, or as the characters alone. Core 2k/6k is the
 * most downloaded deck there is, so this is not an exotic case. */
// Bounded on purpose: unbounded, `+` followed by a `[` that never comes makes
// this quadratic, and one 40 KB field took a second on its own. A furigana
// base is a word.
const FURIGANA = /([^\s>\[\]]{1,64})\[([^\]]{0,64})\]/g;
const furigana = (s) => s.replace(FURIGANA, (w, base, read) => `<ruby>${base}<rt>${read}</rt></ruby>`);
const kana = (s) => s.replace(FURIGANA, (w, base, read) => read);
const kanji = (s) => s.replace(FURIGANA, (w, base) => base);

function applyFilters(value, filters, ctx, isCloze) {
  let v = value;
  // Anki applies filters right to left, the field name being on the right.
  for (const f of [...filters].reverse()) {
    if (f === 'text') v = toText(v);
    else if (f === 'furigana') v = furigana(v);
    else if (f === 'kana') v = kana(v);
    else if (f === 'kanji') v = kanji(v);
    else if (f === 'cloze' || f === 'cloze-only') v = cloze(v, ctx.ord, ctx.answer);
    else if (f === 'hint') v = v && `<span class="hint">${v}</span>`;
    else if (f === 'type' || f.startsWith('tts')) v = '';
    else if (f === 'nc') v = v;                       // no-cloze, Anki 23.10
    else ctx.unknownFilters?.add(f);
  }
  // A cloze notetype whose template forgot the filter still has to blank its
  // deletions, or every card shows every answer.
  if (isCloze && !filters.includes('cloze') && hasCloze(v)) {
    v = cloze(v, ctx.ord, ctx.answer);
  }
  return v;
}

function value(name, ctx) {
  if (name === 'FrontSide') return ctx.frontSide ?? '';
  if (name === 'Tags') return ctx.tags ?? '';
  if (name === 'Type') return ctx.notetype ?? '';
  if (name === 'Deck') return ctx.deck ?? '';
  if (name === 'Subdeck') return (ctx.deck ?? '').split('::').pop();
  if (name === 'Card') return ctx.template ?? '';
  if (name === 'CardFlag') return '';
  if (Object.hasOwn(ctx.fields, name)) return ctx.fields[name];
  ctx.unknownFields?.add(name);
  return null;
}

/**
 * @param {string} fmt   qfmt or afmt
 * @param {object} ctx   { fields, tags, deck, notetype, template, ord, answer,
 *                         isCloze, frontSide, unknownFields, unknownFilters }
 */
export function render(fmt, ctx) {
  const parts = parse(fmt);
  const out = [];
  // Conditionals nest, and a template in the wild is not guaranteed to close
  // them in order; a stack of "am I printing" survives both.
  const stack = [];
  let printing = true;

  for (const p of parts) {
    if (p.t === 'if') {
      const v = value(p.key, ctx);
      // Anki treats a field as present if it has any content once markup and
      // cloze wrappers are off — an empty <br> is not content.
      const filled = !!toText(v === null ? '' : String(v)).trim()
        || /<(img|audio)\b/i.test(String(v ?? ''));
      stack.push(printing);
      printing = printing && (p.neg ? !filled : filled);
      continue;
    }
    if (p.t === 'end') {
      printing = stack.length ? stack.pop() : true;
      continue;
    }
    if (!printing) continue;
    if (p.t === 'lit') { out.push(p.v); continue; }

    const { field, filters } = split(p.body);
    const v = value(field, ctx);
    if (v === null) continue;                 // unknown field: nothing, not "{{X}}"
    out.push(applyFilters(String(v), filters, ctx, ctx.isCloze && field !== 'FrontSide'));
  }
  return out.join('');
}
