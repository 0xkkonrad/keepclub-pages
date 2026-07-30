/* Where an imported deck lives.
 *
 * IndexedDB, not localStorage: a deck is cards plus its pictures and sound, and
 * localStorage is a few megabytes of strings on a good day. Two stores — one row
 * per deck, one row per media file — so opening a deck does not drag its media
 * along, and a deck with 400 pictures deletes in one transaction.
 *
 * Study state stays exactly where it was: localStorage under
 * munin/<course>/state/v1, written by app.js, with the cards somebody wrote
 * into the deck in a sibling document beside it. put() touches neither, which
 * is what makes re-importing a deck over itself keep your progress and your
 * cards; remove() takes both, because a deck that is gone leaves nothing for
 * either of them to be about.
 */

const DB = 'munin';
const VERSION = 1;
const DECKS = 'decks';      // one small row per deck: what the shelf needs
const CARDS = 'cards';      // the deck itself, fetched only when it is opened
const MEDIA = 'media';

let open = null;

function db() {
  if (open) return open;
  open = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(DECKS)) d.createObjectStore(DECKS, { keyPath: 'id' });
      // The cards live apart from the deck's description on purpose: drawing
      // the shelf should not deserialise twenty thousand cards per tile.
      if (!d.objectStoreNames.contains(CARDS)) d.createObjectStore(CARDS);
      // Keyed by [deck, index] so a deck's media is one contiguous range.
      if (!d.objectStoreNames.contains(MEDIA)) d.createObjectStore(MEDIA);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('the browser would not open its database'));
    // Private windows in some browsers open the database and then refuse to
    // write; blocking is the other way it fails, and both should say so.
    r.onblocked = () => rej(new Error('another keep club tab is upgrading the database'));
  });
  return open;
}

function done(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('the write was rolled back'));
  });
}

const wrap = (req) => new Promise((res, rej) => {
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});

/** Every imported deck, newest first — descriptions only, no cards, no media. */
export async function list() {
  const d = await db();
  const rows = await wrap(d.transaction(DECKS).objectStore(DECKS).getAll());
  return rows.sort((a, b) => b.created - a.created);
}

/** A deck's description only — no cards, no media. */
export async function meta(id) {
  const d = await db();
  return wrap(d.transaction(DECKS).objectStore(DECKS).get(id));
}

/** The whole thing, for opening it. */
export async function get(id) {
  const d = await db();
  const tx = d.transaction([DECKS, CARDS]);
  const rec = await wrap(tx.objectStore(DECKS).get(id));
  if (!rec) return null;
  rec.deck = await wrap(tx.objectStore(CARDS).get(id));
  return rec.deck ? rec : null;
}

/**
 * Store a deck and its media in one transaction: a half-written deck would
 * open with pictures missing and no way to tell why.
 */
export async function put(record, media) {
  const d = await db();
  const tx = d.transaction([DECKS, CARDS, MEDIA], 'readwrite');
  try {
    const ms = tx.objectStore(MEDIA);
    // Replacing a deck: clear what the old one had first, or its media lingers
    // for as long as the browser does.
    ms.delete(IDBKeyRange.bound([record.id], [record.id, []]));
    for (const m of media) {
      ms.put({
        source: m.source,
        mediaType: m.mediaType,
        blob: new Blob([m.bytes], { type: m.mimeType || mime(m.source) }),
      }, [record.id, m.storageIndex]);
    }
    const { deck, ...card } = record;
    tx.objectStore(CARDS).put(deck, record.id);
    tx.objectStore(DECKS).put(card);
  } catch (error) {
    /* A bad key or a Blob allocation can throw synchronously after the media
     * range delete was queued. IndexedDB does not abort a transaction merely
     * because caller code threw, so explicitly roll the whole replacement
     * back before surfacing the failure. */
    try { tx.abort(); } catch { /* it may already have aborted */ }
    throw error;
  }
  await done(tx);
}

export async function remove(id) {
  const d = await db();
  const tx = d.transaction([DECKS, CARDS, MEDIA], 'readwrite');
  tx.objectStore(MEDIA).delete(IDBKeyRange.bound([id], [id, []]));
  tx.objectStore(CARDS).delete(id);
  tx.objectStore(DECKS).delete(id);
  await done(tx);
  // The deck is gone; its study history and the cards somebody wrote into it
  // have nothing left to describe. Two documents because they are two keys —
  // the review history and the layer beside it — and removing the deck is the
  // one thing that takes both: erasing progress deliberately keeps the cards,
  // and says so. The keys are asked for rather than spelled out; they used to
  // be written by hand here, in app.js and in the shell's orphan sweep, which
  // is three places to change and two to forget.
  let historyCleared = true;
  try {
    // Notify every open copy before removing the document. A tab still
    // studying this deck must not recreate its now-orphaned state on pagehide.
    if (globalThis.MUNIN.resetKey) {
      localStorage.setItem(globalThis.MUNIN.resetKey(id),
        Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    }
    localStorage.removeItem(globalThis.MUNIN.stateKey(id));
    // Guarded like resetKey above: this module is imported by a shell that may
    // be a deploy behind the one that first wrote a cards document, and a
    // missing template would throw here and leave the history uncleared too.
    if (globalThis.MUNIN.cardsKey) {
      localStorage.removeItem(globalThis.MUNIN.cardsKey(id));
    }
  } catch (e) {
    historyCleared = false;
    console.warn('deck removed, but what it left in local storage could not be cleared', e);
  }
  return { historyCleared };
}

/** One media Blob, fetched only when a rendered card refers to it. */
export async function mediaBlob(id, index) {
  const d = await db();
  const value = await wrap(d.transaction(MEDIA).objectStore(MEDIA).get([id, index]));
  return value?.blob || null;
}

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', opus: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4',
};

/* A Blob with no type is served as application/octet-stream, and an <img>
 * pointed at one shows nothing. The extension is all we have to go on — except
 * for SVG, which is a script container and stays out of an imported deck. */
function mime(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  if (ext === 'svg') return 'text/plain';
  return TYPES[ext] || 'application/octet-stream';
}

/** How much room the imported decks take, for the shelf to be honest about. */
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
