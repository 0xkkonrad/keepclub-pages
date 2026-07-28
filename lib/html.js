/* Everything on an imported card is HTML written by a stranger.
 *
 * Munin puts card text into innerHTML — that is how Day Skipper's bold and line
 * breaks work — so an .apkg downloaded from a forum is a script tag away from
 * reading every deck on the device. The import is the one place to deal with
 * that: clean once, store clean, and the rest of the app never has to know.
 *
 * The safety here is not the allow-lists, which are only judgement. It is that
 * nothing is passed through: the input is parsed into tokens and the output is
 * written from scratch, with text escaped. Anything this parser fails to
 * understand comes out as visible text rather than as markup — the failure mode
 * is an ugly card, not a compromised one.
 */

/** Kept, with their contents. */
const KEEP = new Set([
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small',
  'sub', 'sup', 'br', 'hr', 'p', 'div', 'span', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'img', 'audio', 'code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'figure', 'figcaption', 'abbr', 'time',
  // The furigana filter writes these. Without them the reading is glued onto
  // the word it annotates — worse than leaving 漢字[かんじ] alone.
  'ruby', 'rt', 'rp',
]);

/** Dropped along with everything inside them. */
const BURN = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'template', 'noscript', 'noembed', 'svg', 'math', 'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'title', 'head',
]);

/* Nothing closes these — and the list has to be COMPLETE, not just the void
 * tags we keep. `<meta>` is on the burn list, and treating it as an element
 * with content means burning everything after it: one `<meta charset>` at the
 * top of a field silently deleted the entire card, and the receipt then
 * reported the question as empty. That is the failure this module exists to
 * prevent, committed by this module. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'frame', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Per tag, the only attributes that survive. */
const ATTRS = {
  img: ['src', 'alt', 'width', 'height'],
  audio: ['src', 'controls'],
  a: ['href'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  time: ['datetime'],
  abbr: ['title'],
};

// The only classes worth keeping: the ones Munin's own stylesheet styles.
// Everything else refers to a stylesheet that was dropped with the note type.
const CLASSES = new Set(['cloze', 'hint']);

const NAMED = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Escape text, but leave entities that are already entities alone. */
export function escapeText(s) {
  const parts = [];
  let at = 0;
  for (const m of s.matchAll(NAMED)) {
    parts.push(esc(s.slice(at, m.index)), m[0]);
    at = m.index + m[0].length;
  }
  parts.push(esc(s.slice(at)));
  return parts.join('');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

/* href is the only place a URL from the file is allowed to reach the page.
 * Media has already been turned into munin-media: references by this point, so
 * anything else claiming to be a scheme is either useless offline or hostile. */
function safeHref(v) {
  // Browsers ignore control characters and zero-width marks inside a URL, so
  // "java\tscript:" would run. Strip them before deciding what the scheme is.
  const t = v.replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202f\ufeff]/g, '');
  if (/^(https?:|mailto:|tel:)/i.test(t)) return t;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return null;   // javascript:, data:, file:…
  return null;                                        // relative links point nowhere
}

function safeSrc(v) {
  // Only our own placeholder, written by importMedia below. Everything else —
  // including https: — would be a card that needs the network to be read.
  return /^munin-media:\d+$/.test(v.trim()) ? v.trim() : null;
}

/** A tiny HTML tokenizer: text, comments, open tags, close tags. */
function* tokens(src) {
  let at = 0;
  while (at < src.length) {
    const lt = src.indexOf('<', at);
    if (lt < 0) { yield { t: 'text', v: src.slice(at) }; return; }
    if (lt > at) yield { t: 'text', v: src.slice(at, lt) };

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      at = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<!', lt) || src.startsWith('<?', lt)) {
      const end = src.indexOf('>', lt);
      at = end < 0 ? src.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt));
    if (!m) {                       // a bare `<` in prose, e.g. "a < b"
      yield { t: 'text', v: '<' };
      at = lt + 1;
      continue;
    }
    let p = lt + m[0].length;
    const attrs = [];
    // Attributes, up to the closing bracket. A quoted value may contain '>'.
    while (p < src.length) {
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] === '>') { p++; break; }
      if (src.startsWith('/>', p)) { p += 2; break; }
      const am = /^([^\s=\/>]+)\s*(=\s*)?/.exec(src.slice(p));
      if (!am) { p++; continue; }
      p += am[0].length;
      let val = '';
      if (am[2]) {
        const q = src[p];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, p + 1);
          val = src.slice(p + 1, end < 0 ? src.length : end);
          p = end < 0 ? src.length : end + 1;
        } else {
          const vm = /^[^\s>]*/.exec(src.slice(p));
          val = vm[0];
          p += vm[0].length;
        }
      }
      attrs.push([am[1].toLowerCase(), val]);
    }
    yield { t: m[1] ? 'close' : 'open', name: m[2].toLowerCase(), attrs };
    at = p;
  }
}

/** Decode the entities we are willing to understand — for plain-text output. */
const ENTS = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(NAMED, (whole, body) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : whole;
    }
    return ENTS[body.toLowerCase()] ?? whole;
  });
}

/**
 * Clean HTML for storage.
 * @returns {{html: string, media: number[]}} the media indices it actually uses
 */
export function clean(src) {
  const out = [];
  const open = [];        // tags we emitted and still owe a close
  const media = new Set();
  let burning = 0;        // depth inside a dropped subtree
  let burnTag = null;

  for (const tk of tokens(String(src ?? ''))) {
    if (burning) {
      if (tk.t === 'open' && tk.name === burnTag && !VOID.has(tk.name)) burning++;
      else if (tk.t === 'close' && tk.name === burnTag) { burning--; if (!burning) burnTag = null; }
      continue;
    }
    if (tk.t === 'text') { out.push(escapeText(tk.v)); continue; }

    if (tk.t === 'open') {
      if (BURN.has(tk.name)) {
        if (!VOID.has(tk.name)) { burning = 1; burnTag = tk.name; }
        continue;
      }
      if (!KEEP.has(tk.name)) continue;    // unknown tag: keep what is inside it
      const allowed = ATTRS[tk.name] || [];
      const bits = [];
      let drop = false;
      for (const [k, v] of tk.attrs) {
        // Anki marks the active blank with class="cloze", and the hint filter
        // writes class="hint"; both mean something on Munin's cards too.
        if (k === 'class') {
          const keep = v.split(/\s+/).filter((c) => CLASSES.has(c));
          if (keep.length) bits.push(`class="${keep.join(' ')}"`);
          continue;
        }
        if (!allowed.includes(k)) continue;
        if (k === 'href') {
          const h = safeHref(v);
          if (h) bits.push(`href="${escAttr(h)}" rel="noopener noreferrer" target="_blank"`);
          continue;
        }
        if (k === 'src') {
          const s = safeSrc(v);
          if (!s) { drop = true; break; }   // an image we cannot serve is not an image
          media.add(Number(s.slice('munin-media:'.length)));
          bits.push(`src="${s}"`);
          continue;
        }
        if (k === 'width' || k === 'height') {
          if (/^\d{1,5}$/.test(v.trim())) bits.push(`${k}="${v.trim()}"`);
          continue;
        }
        if (k === 'colspan' || k === 'rowspan') {
          if (/^\d{1,3}$/.test(v.trim())) bits.push(`${k}="${v.trim()}"`);
          continue;
        }
        if (k === 'controls') { bits.push('controls'); continue; }
        bits.push(`${k}="${escAttr(v)}"`);
      }
      if (drop) continue;
      if (tk.name === 'img') bits.push('loading="lazy"');
      out.push(`<${tk.name}${bits.length ? ' ' + bits.join(' ') : ''}>`);
      if (!VOID.has(tk.name)) open.push(tk.name);
      continue;
    }

    // close
    if (VOID.has(tk.name) || !KEEP.has(tk.name)) continue;
    const at = open.lastIndexOf(tk.name);
    if (at < 0) continue;                      // a close with no open: ignore
    // Close everything it implicitly closed, so the output is always balanced.
    for (let i = open.length - 1; i >= at; i--) out.push(`</${open[i]}>`);
    open.length = at;
  }
  for (let i = open.length - 1; i >= 0; i--) out.push(`</${open[i]}>`);

  return { html: out.join('').trim(), media: [...media] };
}

/** What a card says, with the markup taken off — for sorting and searching.
 *
 *  Written as one pass over the string rather than four regex replaces. The
 *  replaces were quadratic: a lazy `[\s\S]*?` looking for a `</script>` that
 *  never arrives re-scans the whole field from every `<script`, which a note
 *  with a hundred kilobytes of them turned into three-quarters of a second per
 *  card. This runs on raw field text, so the input is a stranger's. */
export function toText(src) {
  const s = String(src ?? '');
  const out = [];
  let at = 0;
  while (at < s.length) {
    const lt = s.indexOf('<', at);
    if (lt < 0) { out.push(s.slice(at)); break; }
    out.push(s.slice(at, lt));
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)?/.exec(s.slice(lt, lt + 32));
    const name = (m && m[2] || '').toLowerCase();
    const end = tagEnd(s, lt);
    if (end < 0) { at = s.length; break; }        // an unclosed tag ends the text
    // script and style hold code, not words. Skip to the close, or to the end.
    if (!m[1] && (name === 'script' || name === 'style')) {
      const close = s.toLowerCase().indexOf('</' + name, end);
      at = close < 0 ? s.length : tagEnd(s, close) + 1 || s.length;
      out.push(' ');
      continue;
    }
    if (BREAKS.has(name)) out.push(' ');
    at = end + 1;
  }
  return decodeEntities(out.join('')).replace(/\s+/g, ' ').trim();
}

const BREAKS = new Set(['br', 'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'table', 'td', 'th', 'hr']);

/** Where a tag ends — respecting quotes, so alt=">" is not the end of it. */
export function tagEnd(s, from) {
  let quote = '';
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i;
  }
  return -1;
}

/** Is there anything on this side of the card at all?
 *
 *  A picture or a sound counts as content — but only one with something behind
 *  it. clean() throws away a src it cannot serve, so an <img> whose file was
 *  never in the package, or an <audio> written round a <source>, comes out as
 *  an empty pair of tags: markup that renders as nothing. Counting that as a
 *  question kept a blank card and told the receipt nothing was lost. */
export function isEmpty(html) {
  return !toText(html) && !/<(?:img|audio)\b[^>]*\ssrc="munin-media:/i.test(String(html ?? ''));
}
