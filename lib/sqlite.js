/* A read-only SQLite reader, big enough for an Anki collection and no bigger.
 *
 * The alternative is sql.js — a megabyte of WebAssembly to run SELECT
 * statements we do not need. Every query the importer makes is "give me every
 * row of this table", which is a b-tree walk, and the file format is stable and
 * published. So we walk it.
 *
 * What is here: table b-trees, index b-trees (that is how WITHOUT ROWID tables
 * are stored, and half of Anki's modern schema is one), overflow pages, and the
 * record format. What is not: writing, indexes used as indexes, WAL, and
 * anything to do with queries. A file that needs those is not an export.
 *
 * Format reference: https://www.sqlite.org/fileformat2.html
 */

const MAGIC = 'SQLite format 3\0';

export class SqliteError extends Error {}

const utf8 = new TextDecoder();

/* Rows come out as objects. Integers come out as Number, which holds every id
 * Anki has ever minted (they are millisecond timestamps), and falls back to
 * BigInt rather than quietly losing digits if a file ever disagrees. */
function int(dv, at, len) {
  if (len === 8) {
    const v = dv.getBigInt64(at, false);
    return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v;
  }
  let v = dv.getInt8(at);                       // sign lives in the first byte
  for (let i = 1; i < len; i++) v = v * 256 + dv.getUint8(at + i);
  return v;
}

/** SQLite's varint: seven bits a byte, big-endian, nine bytes at the outside.
 *
 *  The ninth byte is the exception — it contributes all eight of its bits, and
 *  the whole thing is then a signed 64-bit value. Stopping a byte early (which
 *  this did) returns exactly twice the right number for any eight-byte varint
 *  and leaves the cursor one byte short for a nine, which desynchronises every
 *  field after it. Anki never mints an id big enough to reach either, so it
 *  would have sat here being wrong about nothing until it wasn't. */
function varint(b, at) {
  let n = 0;
  while (n < 8 && (b[at + n] & 0x80)) n++;
  n++;                                   // the terminating byte, or the ninth
  for (let i = 0; i < n; i++) {
    if (b[at + i] === undefined) throw new SqliteError('truncated varint');
  }
  // Seven bytes is 49 bits, which a double holds exactly. Eight is 56, which it
  // does not: an eight-byte rowid came back two apart from itself.
  if (n <= 7) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 128 + (b[at + i] & 0x7f);
    return [v, at + n];
  }
  let big = 0n;
  for (let i = 0; i < Math.min(n, 8); i++) big = big * 128n + BigInt(b[at + i] & 0x7f);
  if (n === 9) big = big * 256n + BigInt(b[at + 8]);
  big = BigInt.asIntN(64, big);
  const fits = big >= -9007199254740991n && big <= 9007199254740991n;
  return [fits ? Number(big) : big, at + n];
}

/* Column names, and which one is the rowid in disguise.
 *
 * `id integer primary key` is not stored in the record at all: it is an alias
 * for the row's key, and the record holds NULL in its place. Miss that and
 * every note in the collection comes back with id null. */
function parseCreate(raw) {
  // Comments come off first, before anything counts a bracket: a block comment
  // in Anki's own DDL contains an unmatched "(" and the search for the closing
  // bracket of the column list never terminated.
  const sql = strip(raw);
  const open = sql.indexOf('(');
  if (open < 0) throw new SqliteError('unreadable table definition');
  let depth = 0, end = -1;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') { depth--; if (!depth) { end = i; break; } }
  }
  if (end < 0) throw new SqliteError('unreadable table definition');
  const body = sql.slice(open + 1, end);

  // Split on commas that are not inside brackets or quotes.
  const parts = [];
  let cur = '', d = 0, quote = '';
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '(') d++;
    if (ch === ')') d--;
    if (ch === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);

  /* A constraint, not a column — and the distinction is the shape, not the
   * first word. Anki's own config table opens `KEY text NOT NULL PRIMARY KEY`,
   * and treating any part beginning with a keyword as a constraint deleted that
   * column and shifted every value in the row up by one. */
  const CONSTRAINT = /^(constraint\s|primary\s+key\s*\(|unique\s*\(|check\s*\(|foreign\s+key\s*\()/i;
  const columns = [];
  let pk = null;
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (CONSTRAINT.test(part)) {
      // A table-level PRIMARY KEY (a, b) — which is what a WITHOUT ROWID table
      // is keyed by, and therefore the order its records are stored in.
      const m = /primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (m) {
        pk = m[1].split(',').map((s) => unquote(s.trim()
          .replace(/\s+collate\s+\S+/i, '').replace(/\s+(asc|desc)$/i, '').trim()));
      }
      continue;
    }
    const m = /^("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[^\s]+)/.exec(part);
    if (!m) continue;
    const nm = unquote(m[1]);
    const rest = part.slice(m[1].length);
    // Only `INTEGER PRIMARY KEY` is an alias for the rowid. `k text primary
    // key` is an ordinary column that happens to be the key — which still
    // decides the storage order of a WITHOUT ROWID table.
    const inlinePk = /\bprimary\s+key\b/i.test(rest);
    const rowid = inlinePk && /\binteger\b/i.test(rest);
    if (inlinePk && !pk) pk = [nm];
    columns.push({ name: nm, rowid, def: defaultOf(rest) });
  }
  return { columns, pk, withoutRowid: /\bwithout\s+rowid\b/i.test(sql.slice(end)) };
}

/* Comments, out. Anki's notes table carries a two-line `--` comment between
 * `flds` and `sfld` explaining why sfld is typed integer, and that comment
 * contains a comma: split on it naively and the table gains two columns called
 * "--" and "because", after which sfld, csum, flags and data all name the value
 * of their neighbour. Every real Anki collection has this. */
function strip(sql) {
  let out = '', quote = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      out += '\n';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close < 0) break;
      i = close + 1;
      out += ' ';
      continue;
    }
    out += c;
  }
  return out;
}

/* A column added by ALTER TABLE is simply absent from every row written before
 * it, and the spec says those rows read as the column's DEFAULT — not as NULL.
 * Half a table reading right is the worst way to be wrong. */
function defaultOf(rest) {
  const m = /\bdefault\s+(-?\d+\.?\d*|'(?:[^']|'')*'|null|true|false)/i.exec(rest);
  if (!m) return null;
  const v = m[1];
  if (/^null$/i.test(v)) return null;
  if (/^true$/i.test(v)) return 1;
  if (/^false$/i.test(v)) return 0;
  if (v[0] === "'") return v.slice(1, -1).replaceAll("''", "'");
  return Number(v);
}

function unquote(s) {
  const q = s[0];
  if ((q === '"' || q === '`') && s.length > 1 && s.endsWith(q)) {
    return s.slice(1, -1).replaceAll(q + q, q);
  }
  if (q === '[' && s.endsWith(']')) return s.slice(1, -1);
  return s;
}

export class Db {
  constructor(bytes) {
    if (bytes.length < 100) throw new SqliteError('not a SQLite database');
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC.charCodeAt(i)) throw new SqliteError('not a SQLite database');
    }
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ps = this.dv.getUint16(16, false);
    this.pageSize = ps === 1 ? 65536 : ps;      // 1 is how 65536 fits in two bytes
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1))) {
      throw new SqliteError('impossible page size');
    }
    this.usable = this.pageSize - bytes[20];
    if (this.usable < 480) throw new SqliteError('impossible reserved space');
    const enc = this.dv.getUint32(56, false);
    this.decoder = enc === 2 ? new TextDecoder('utf-16le')
      : enc === 3 ? new TextDecoder('utf-16be') : utf8;
    this.pageCount = Math.floor(bytes.length / this.pageSize);
    this.schema = this.#readSchema();
  }

  page(n) {
    if (n < 1 || n > this.pageCount) throw new SqliteError(`page ${n} is past the end of the file`);
    return this.bytes.subarray((n - 1) * this.pageSize, (n - 1) * this.pageSize + this.usable);
  }

  #readSchema() {
    const tables = new Map();
    // sqlite_master is always rooted at page 1 and always has these columns.
    const master = { root: 1, columns: [
      { name: 'type' }, { name: 'name' }, { name: 'tbl_name' },
      { name: 'rootpage' }, { name: 'sql' }] };
    for (const row of this.#scan(master, false)) {
      if (row.type !== 'table' || !row.sql) continue;
      if (String(row.name).startsWith('sqlite_')) continue;
      let def;
      try { def = parseCreate(String(row.sql)); } catch { continue; }
      tables.set(String(row.name).toLowerCase(), {
        name: String(row.name),
        root: Number(row.rootpage),
        sql: String(row.sql),
        ...def,
      });
    }
    return tables;
  }

  get tableNames() { return [...this.schema.values()].map((t) => t.name); }

  /* SQLite matches table names without regard to case, and so must this: Anki
   * 2.1.41 to 2.1.49 created the note-type tables as FIELDS and TEMPLATES, and
   * there is no migration that renames them, so a collection upgraded under
   * those versions carries the capitals for ever. Matching exactly made every
   * such deck unreadable. */
  #find(name) { return this.schema.get(String(name).toLowerCase()); }
  has(name) { return !!this.#find(name); }

  columnsOf(name) {
    const t = this.#find(name);
    if (!t) throw new SqliteError(`no table named ${name}`);
    return t.columns.map((c) => c.name);
  }

  /** Every row of a table, one at a time — a big collection should not have to
   *  fit in memory twice. */
  *each(name) {
    const t = this.#find(name);
    if (!t) throw new SqliteError(`no table named ${name}`);
    // A WITHOUT ROWID table stores its primary key columns first, whatever
    // order they were declared in, and the rest after.
    let order = t.columns;
    if (t.withoutRowid && t.pk) {
      const first = t.pk.map((k) => t.columns.find((c) => c.name === k)).filter(Boolean);
      order = first.concat(t.columns.filter((c) => !first.includes(c)));
    }
    if (order === t.columns) {
      yield* this.#scan({ root: t.root, columns: order }, t.withoutRowid);
      return;
    }
    // Read in storage order, hand back in the order the table was declared in:
    // callers wrote `create table pairs (a, b, ...)` and should get that.
    for (const row of this.#scan({ root: t.root, columns: order }, t.withoutRowid)) {
      const o = {};
      for (const c of t.columns) o[c.name] = row[c.name];
      yield o;
    }
  }

  rows(name) { return [...this.each(name)]; }

  *#scan(table, index) {
    const seen = new Set();
    yield* this.#walk(table.root, table, index, seen, 0);
  }

  *#walk(pageNo, table, index, seen, depth) {
    // A damaged file can point a page at itself; without this the importer
    // hangs instead of reporting a bad deck.
    if (seen.has(pageNo)) throw new SqliteError('the database structure loops');
    if (depth > 64) throw new SqliteError('the database is nested too deeply');
    seen.add(pageNo);

    const page = this.page(pageNo);
    const off = pageNo === 1 ? 100 : 0;
    const type = page[off];
    const dv = new DataView(page.buffer, page.byteOffset, page.byteLength);
    const n = dv.getUint16(off + 3, false);
    const interior = type === 0x02 || type === 0x05;
    const headerLen = interior ? 12 : 8;
    if (type !== 0x02 && type !== 0x05 && type !== 0x0a && type !== 0x0d) {
      throw new SqliteError(`page ${pageNo} is not a b-tree page`);
    }

    const cells = [];
    for (let i = 0; i < n; i++) {
      const at = dv.getUint16(off + headerLen + i * 2, false);
      if (at < off + headerLen || at >= page.length) throw new SqliteError('a cell points outside its page');
      cells.push(at);
    }

    for (const at of cells) {
      if (type === 0x0d) {                       // leaf of a table
        const [size, a1] = varint(page, at);
        const [rowid, a2] = varint(page, a1);
        yield this.#record(this.#payload(page, a2, Number(size), false), table.columns, rowid);
      } else if (type === 0x05) {                // interior of a table: keys only
        yield* this.#walk(dv.getUint32(at, false), table, index, seen, depth + 1);
      } else if (type === 0x0a) {                // leaf of an index
        const [size, a1] = varint(page, at);
        yield this.#record(this.#payload(page, a1, Number(size), true), table.columns, null);
      } else {                                   // interior of an index
        const child = dv.getUint32(at, false);
        const [size, a1] = varint(page, at + 4);
        // An index's interior cells are rows in their own right, not copies of
        // anything below them. Skip these and a WITHOUT ROWID table quietly
        // loses one row per page boundary.
        yield* this.#walk(child, table, index, seen, depth + 1);
        yield this.#record(this.#payload(page, a1, Number(size), true), table.columns, null);
      }
    }
    if (interior) {
      yield* this.#walk(dv.getUint32(off + 8, false), table, index, seen, depth + 1);
    }
  }

  /** The cell's payload, following the overflow chain when it does not fit.
   *
   *  A table leaf keeps up to usable-35 bytes in the page; an index keeps far
   *  less, because an index page has to hold enough keys to stay a tree. Using
   *  the table limit on an index page reads the overflow pointer as content and
   *  the payload runs off the end — which is how WITHOUT ROWID tables with any
   *  sizeable column fail. */
  #payload(page, at, size, index) {
    const max = index ? Math.floor((this.usable - 12) * 64 / 255) - 23 : this.usable - 35;
    if (size <= max) {
      const end = at + size;
      if (end > page.length) throw new SqliteError('a cell runs past its page');
      return page.subarray(at, end);
    }
    const min = Math.floor((this.usable - 12) * 32 / 255) - 23;
    const k = min + ((size - min) % (this.usable - 4));
    const local = k <= max ? k : min;
    const out = new Uint8Array(size);
    if (at + local + 4 > page.length) throw new SqliteError('a cell runs past its page');
    out.set(page.subarray(at, at + local), 0);

    let filled = local;
    let next = new DataView(page.buffer, page.byteOffset, page.byteLength).getUint32(at + local, false);
    const seen = new Set();
    while (filled < size) {
      if (!next || seen.has(next)) throw new SqliteError('the overflow chain is broken');
      seen.add(next);
      const p = this.page(next);
      const take = Math.min(this.usable - 4, size - filled);
      out.set(p.subarray(4, 4 + take), filled);
      filled += take;
      next = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, false);
    }
    return out;
  }

  /** The record format: a header of serial types, then the values. */
  #record(payload, columns, rowid) {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    let [headerLen, at] = varint(payload, 0);
    headerLen = Number(headerLen);
    const types = [];
    while (at < headerLen) {
      const [t, next] = varint(payload, at);
      types.push(Number(t));
      at = next;
    }
    let body = headerLen;
    const row = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const t = types[i];
      let v = null;
      if (t === undefined) v = col.def ?? null;
      else if (t === 0 || t === 10 || t === 11) v = null;
      else if (t >= 1 && t <= 4) { v = int(dv, body, t); body += t; }
      else if (t === 5) { v = int(dv, body, 6); body += 6; }
      else if (t === 6) { v = int(dv, body, 8); body += 8; }
      else if (t === 7) { v = dv.getFloat64(body, false); body += 8; }
      else if (t === 8) v = 0;
      else if (t === 9) v = 1;
      else {
        const len = (t - 12 - (t % 2)) / 2;
        if (body + len > payload.length) throw new SqliteError('a record runs past its payload');
        const raw = payload.subarray(body, body + len);
        v = (t % 2) ? this.decoder.decode(raw) : raw.slice();
        body += len;
      }
      // The integer primary key is stored as NULL and means the row's key.
      row[col.name] = (col.rowid && v === null && rowid !== null) ? rowid : v;
    }
    return row;
  }
}

export function openDb(bytes) { return new Db(bytes); }
