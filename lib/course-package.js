/*
 * Public course-file boundary.
 *
 * A plain `.keep.yml` is the text-only form. A `.keep` file is a ZIP with one
 * root `course.keep.yml` and every local asset it declares. This module owns
 * archive safety and byte/media truth; YAML, course semantics and Markdown
 * remain delegated to their one canonical readers.
 */

import { COURSE_YAML_LIMITS, parseCourseYaml } from './course-yaml.js';
import { readCourse } from './course.js';
import { readCourseForRuntime } from './course-runtime.js';
import { readZip, ZipError } from './unzip.js';

export const COURSE_PACKAGE_LIMITS = Object.freeze({
  compressedBytes: 250 * 1024 * 1024,
  expandedBytes: 500 * 1024 * 1024,
  manifestBytes: COURSE_YAML_LIMITS.inputBytes,
  files: 2500,
  expansionRatio: 100,
  imageBytes: 25 * 1024 * 1024,
  audioBytes: 50 * 1024 * 1024,
  videoBytes: 200 * 1024 * 1024,
  captionBytes: 25 * 1024 * 1024,
});

const MANIFEST = 'course.keep.yml';
const DOCS = 'https://docs.keepclub.app/reference/errors/';
const MAX_DIAGNOSTICS = 100;
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const EXTENSIONS = Object.freeze({
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']),
  audio: new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac']),
  video: new Set(['mp4', 'webm']),
  caption: new Set(['vtt']),
});

function diagnostic(code, severity, path, message, correction) {
  return {
    code,
    severity,
    path,
    message,
    correction,
    docsUrl: `${DOCS}#${code.replace(/[._]/g, '-')}`,
  };
}

function collector(seed = []) {
  const diagnostics = seed.slice(0, MAX_DIAGNOSTICS);
  let errorsTruncated = seed.slice(MAX_DIAGNOSTICS)
    .some((entry) => entry.severity === 'error');
  if (errorsTruncated && !diagnostics.some((entry) => entry.code === 'document.too_many_errors')) {
    diagnostics.push(diagnostic(
      'document.too_many_errors',
      'error',
      '',
      'More than 100 validation errors exist.',
      'Fix the reported set, then validate the course again.',
    ));
  }
  const add = (item) => {
    if (diagnostics.some((entry) => entry.code === 'document.too_many_errors')) return;
    if (diagnostics.length < MAX_DIAGNOSTICS) {
      diagnostics.push(item);
      return;
    }
    if (item.severity === 'warning' || errorsTruncated) return;
    errorsTruncated = true;
    diagnostics.push(diagnostic(
      'document.too_many_errors',
      'error',
      '',
      'More than 100 validation errors exist.',
      'Fix the reported set, then validate the course again.',
    ));
  };
  return {
    diagnostics,
    error: (code, path, message, correction) =>
      add(diagnostic(code, 'error', path, message, correction)),
    warning: (code, path, message, correction) =>
      add(diagnostic(code, 'warning', path, message, correction)),
  };
}

async function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (typeof input === 'string') return new TextEncoder().encode(input);
  throw new TypeError('course input must be text, a Blob, an ArrayBuffer, or a typed array');
}

function extension(path) {
  const name = String(path).split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function asciiFold(path) {
  return String(path).replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * Return the normalized package path or null. Equality with NFC is required:
 * silently changing the spelling here would make receipts disagree with the
 * creator's manifest and can collide on another filesystem.
 */
export function normalizeCourseAssetPath(value) {
  if (typeof value !== 'string' || !value.length) return null;
  let normalized;
  try { normalized = value.normalize('NFC'); } catch { return null; }
  if (normalized !== value || [...normalized].length > 240
      || normalized.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(normalized)
      || normalized.includes('\\') || /[\u0000-\u001f\u007f]/.test(normalized)
      || normalized.includes('//')) return null;
  const pieces = normalized.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..')) return null;
  return normalized;
}

function allAssetReferences(course) {
  const references = new Map();
  const add = (source, expectedType, path, declaredMimeType) => {
    if (typeof source !== 'string') return;
    const safe = normalizeCourseAssetPath(source);
    const key = safe ? asciiFold(safe) : source;
    const existing = references.get(key);
    if (existing) {
      existing.sources.add(source);
      existing.paths.push(path);
      existing.expectedTypes.add(expectedType);
      if (declaredMimeType) existing.declaredMimeTypes.add(declaredMimeType.toLowerCase());
    } else {
      references.set(key, {
        source,
        sources: new Set([source]),
        expectedTypes: new Set([expectedType]),
        declaredMimeTypes: new Set(declaredMimeType ? [declaredMimeType.toLowerCase()] : []),
        paths: [path],
      });
    }
  };
  for (let cardIndex = 0; cardIndex < (course.cards || []).length; cardIndex++) {
    const card = course.cards[cardIndex];
    for (let mediaIndex = 0; mediaIndex < (card.media || []).length; mediaIndex++) {
      const media = card.media[mediaIndex];
      const base = `$.cards[${cardIndex}].media[${mediaIndex}]`;
      add(media.source, media.mediaType, `${base}.source`, media.mimeType);
      if (media.posterImage !== undefined) add(media.posterImage, 'image', `${base}.posterImage`);
      for (let trackIndex = 0; trackIndex < (media.captionTracks || []).length; trackIndex++) {
        add(media.captionTracks[trackIndex]?.source, 'caption',
          `${base}.captionTracks[${trackIndex}].source`);
      }
    }
  }
  for (const field of ['shelfArtwork', 'sectionArtwork', 'loadingArtwork']) {
    if (course.theme?.[field] !== undefined) {
      add(course.theme[field], 'image', `$.theme.${field}`);
    }
  }
  return references;
}

function starts(bytes, values, offset = 0) {
  return values.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes, start, length) {
  let value = '';
  for (let index = start; index < start + length && index < bytes.length; index++) {
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

/**
 * Establish a container from bytes. This intentionally identifies containers,
 * not codecs; browser `canPlayType` remains a preview/runtime capability gate.
 */
export function sniffCourseAsset(bytes) {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mediaType: 'image', mimeType: 'image/png', extension: 'png' };
  }
  if (starts(bytes, [0xff, 0xd8, 0xff])) {
    return { mediaType: 'image', mimeType: 'image/jpeg', extension: 'jpg' };
  }
  const head6 = ascii(bytes, 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return { mediaType: 'image', mimeType: 'image/gif', extension: 'gif' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return { mediaType: 'image', mimeType: 'image/webp', extension: 'webp' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return { mediaType: 'audio', mimeType: 'audio/wav', extension: 'wav' };
  }
  if (ascii(bytes, 0, 4) === 'OggS') {
    return { mediaType: 'audio', mimeType: 'audio/ogg', extension: 'ogg' };
  }
  if (ascii(bytes, 0, 3) === 'ID3'
      || (bytes.length >= 3 && bytes[0] === 0xff
        && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x06) !== 0)) {
    return { mediaType: 'audio', mimeType: 'audio/mpeg', extension: 'mp3' };
  }
  if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
    return { mediaType: 'audio', mimeType: 'audio/aac', extension: 'aac' };
  }
  if (starts(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mediaType: 'video', mimeType: 'video/webm', extension: 'webm' };
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4).toLowerCase();
    if (brand === 'm4a ' || brand === 'm4b ' || brand === 'mp42' || brand === 'isom') {
      /* `isom`/`mp42` can carry audio-only or video. The manifest declaration
       * resolves that ambiguity; the generic container MIME stays truthful. */
      return {
        mediaType: 'iso-media',
        mimeType: brand.startsWith('m4') ? 'audio/mp4' : 'video/mp4',
        extension: brand.startsWith('m4') ? 'm4a' : 'mp4',
      };
    }
    if (brand === 'avif' || brand === 'avis') {
      return { mediaType: 'unsupported-image', mimeType: 'image/avif', extension: 'avif' };
    }
    return { mediaType: 'iso-media', mimeType: 'video/mp4', extension: 'mp4' };
  }
  try {
    const text = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 256)));
    if (/^\uFEFF?WEBVTT(?:[ \t\r\n]|$)/.test(text)) {
      return { mediaType: 'caption', mimeType: 'text/vtt', extension: 'vtt' };
    }
    if (/<svg(?:\s|>)/i.test(text)) {
      return { mediaType: 'unsupported-image', mimeType: 'image/svg+xml', extension: 'svg' };
    }
  } catch { /* binary data is expected here */ }
  return null;
}

function typeMatches(sniffed, expected) {
  if (!sniffed) return false;
  if (sniffed.mediaType === expected) return true;
  return sniffed.mediaType === 'iso-media' && (expected === 'audio' || expected === 'video');
}

function fileLimit(expectedType) {
  if (expectedType === 'image') return COURSE_PACKAGE_LIMITS.imageBytes;
  if (expectedType === 'audio') return COURSE_PACKAGE_LIMITS.audioBytes;
  if (expectedType === 'video') return COURSE_PACKAGE_LIMITS.videoBytes;
  return COURSE_PACKAGE_LIMITS.captionBytes;
}

function matchingExtension(path, expectedType) {
  return EXTENSIONS[expectedType]?.has(extension(path)) || false;
}

function extensionMatchesBytes(path, sniffed, expectedType) {
  const ext = extension(path);
  if (sniffed.extension === 'jpg') return ext === 'jpg' || ext === 'jpeg';
  if (sniffed.extension === 'ogg') return ['ogg', 'oga', 'opus'].includes(ext);
  if (sniffed.extension === 'm4a') return expectedType === 'audio'
    && ['m4a', 'aac'].includes(ext);
  if (sniffed.extension === 'mp4') return expectedType === 'video' && ext === 'mp4';
  return ext === sniffed.extension;
}

function packageStructure(zip, archiveBytes, out) {
  if (archiveBytes > COURSE_PACKAGE_LIMITS.compressedBytes) {
    out.error('package.too_large', '$',
      'The .keep archive is larger than 250 MiB.',
      'Reduce or split its bundled media.');
  }
  const directory = zip.directory;
  if (directory.length > COURSE_PACKAGE_LIMITS.files) {
    out.error('package.too_many_files', '$',
      `The archive contains ${directory.length} files; the limit is 2,500.`,
      'Remove unused files or split the course.');
  }
  let expanded = 0;
  let compressed = 0;
  const folded = new Map();
  for (let index = 0; index < directory.length; index++) {
    const entry = directory[index];
    const path = `$.package[${index}]`;
    const safe = normalizeCourseAssetPath(entry.name);
    if (!safe) {
      out.error('package.unsafe_path', path,
        `Archive member "${entry.name}" is not a safe normalized relative path.`,
        'Rebuild the archive with NFC relative paths and no traversal or backslashes.');
    } else {
      const key = asciiFold(safe);
      if (folded.has(key)) {
        out.error('package.duplicate_path', path,
          `Archive paths "${folded.get(key)}" and "${entry.name}" collide on common filesystems.`,
          'Rename one file and update every reference.');
      } else {
        folded.set(key, entry.name);
      }
    }
    if (!Number.isSafeInteger(entry.size) || !Number.isSafeInteger(entry.compressedSize)
        || entry.size < 0 || entry.compressedSize < 0) {
      out.error('package.too_large', path,
        'An archive member declares an impossible size.',
        'Rebuild the archive with a standards-compliant ZIP tool.');
      continue;
    }
    if ((entry.flags & 0x1) || ![0, 8].includes(entry.method)
        || entry.localMethod !== entry.method) {
      out.error('package.unsupported_feature', path,
        `Archive member "${entry.name}" uses encryption or an unsupported compression method.`,
        'Rebuild it as an unencrypted ZIP using stored or deflate compression.');
    }
    expanded += entry.size;
    compressed += entry.compressedSize;
    if (entry.size > 0
        && (entry.compressedSize === 0
          || entry.size > entry.compressedSize * COURSE_PACKAGE_LIMITS.expansionRatio)) {
      out.error('package.expansion_ratio', path,
        `Archive member "${entry.name}" expands by more than 100:1.`,
        'Recompress ordinary source files without dangerous expansion ratios.');
    }
  }
  for (const duplicate of zip.duplicates) {
    out.error('package.duplicate_path', '$.package',
      `The ZIP directory repeats "${duplicate}".`,
      'Keep exactly one archive entry at each path.');
  }
  if (expanded > COURSE_PACKAGE_LIMITS.expandedBytes) {
    out.error('package.too_large', '$',
      'The archive expands beyond 500 MiB.',
      'Reduce or split its bundled media.');
  }
  if (expanded > 0 && (compressed === 0
      || expanded > compressed * COURSE_PACKAGE_LIMITS.expansionRatio)) {
    out.error('package.expansion_ratio', '$',
      'The archive expands by more than 100:1 overall.',
      'Rebuild the package without dangerous compression ratios.');
  }
}

async function validateAssets(course, zip, out) {
  const references = allAssetReferences(course);
  const byFoldedPath = new Map();
  const entryByName = new Map();
  for (const entry of zip?.directory || []) entryByName.set(entry.name, entry);
  for (const name of zip?.names || []) {
    const safe = normalizeCourseAssetPath(name);
    if (safe) byFoldedPath.set(asciiFold(safe), name);
  }
  const media = [];
  const mediaIndexBySource = {};
  let storageIndex = 0;

  for (const reference of references.values()) {
    const path = reference.paths[0];
    const safe = normalizeCourseAssetPath(reference.source);
    if (!safe) {
      out.error('media.invalid_path', path,
        `"${reference.source}" is not a safe normalized package path.`,
        'Use one NFC relative path with no URL, root, traversal, empty component, or backslash.');
      continue;
    }
    if (reference.expectedTypes.size !== 1) {
      out.error('media.type_mismatch', path,
        `"${safe}" is declared as more than one media type.`,
        'Use different asset paths for different declared media types.');
      continue;
    }
    const expectedType = [...reference.expectedTypes][0];
    const actualName = byFoldedPath.get(asciiFold(safe));
    if (!zip || !actualName) {
      out.error('media.missing', path,
        `The package does not contain declared asset "${safe}".`,
        zip
          ? 'Add the file at that exact path or remove the reference.'
          : 'Bundle media in a .keep archive; plain .keep.yml imports are text-only.');
      continue;
    }
    const declaredSize = entryByName.get(actualName)?.size;
    if (Number.isSafeInteger(declaredSize) && declaredSize > fileLimit(expectedType)) {
      out.error('media.too_large', path,
        `Asset "${safe}" exceeds the ${expectedType} file-size limit.`,
        'Compress, transcode, split, or remove the asset.');
      continue;
    }
    let bytes;
    try {
      bytes = await zip.read(actualName);
    } catch (error) {
      out.error(error instanceof ZipError && /expand/i.test(error.message)
        ? 'package.expansion_ratio' : 'media.missing', path,
      `Asset "${safe}" could not be read safely.`,
      'Rebuild the archive and include an intact supported file.');
      continue;
    }
    if (bytes.length > fileLimit(expectedType)) {
      out.error('media.too_large', path,
        `Asset "${safe}" exceeds the ${expectedType} file-size limit.`,
        'Compress, transcode, split, or remove the asset.');
      continue;
    }
    const sniffed = sniffCourseAsset(bytes);
    if (!sniffed || sniffed.mediaType.startsWith('unsupported')) {
      out.error('media.unsupported', path,
        `Asset "${safe}" is not a safely supported media container.`,
        sniffed?.mimeType === 'image/svg+xml'
          ? 'Use PNG, JPEG, WebP, or GIF until a sanitized SVG pipeline is available.'
          : 'Transcode it to a documented browser-safe format.');
      continue;
    }
    const sniffedMime = sniffed.mediaType === 'iso-media'
      ? (expectedType === 'audio' ? 'audio/mp4' : 'video/mp4')
      : sniffed.mimeType;
    if (!typeMatches(sniffed, expectedType)
        || !matchingExtension(safe, expectedType)
        || !extensionMatchesBytes(safe, sniffed, expectedType)
        || reference.declaredMimeTypes.size > 1
        || (reference.declaredMimeTypes.size === 1
          && !reference.declaredMimeTypes.has(sniffedMime))) {
      out.error('media.type_mismatch', path,
        `Asset "${safe}" does not agree across its bytes, extension, and declared type.`,
        'Correct the mediaType/source or replace the file with the declared format.');
      continue;
    }
    const warningThreshold = fileLimit(expectedType) / 2;
    if (bytes.length > warningThreshold) {
      const sizeMiB = (bytes.length / (1024 * 1024)).toFixed(1);
      out.warning('media.large_file', path,
        `Asset "${safe}" is ${sizeMiB} MiB and uses more than half of its allowed file size.`,
        'Compress or transcode it to reduce install and offline-storage use.');
    }
    for (const source of reference.sources) mediaIndexBySource[source] = storageIndex;
    media.push({
      storageIndex,
      source: safe,
      mediaType: expectedType,
      mimeType: sniffedMime,
      bytes,
    });
    storageIndex++;
  }

  if (zip) {
    const declared = new Set([MANIFEST,
      ...[...references.values()].flatMap((reference) => [...reference.sources])
        .map((value) => normalizeCourseAssetPath(value))
        .filter(Boolean)].map(asciiFold));
    for (const name of zip.names) {
      const safe = normalizeCourseAssetPath(name);
      if (!safe || !declared.has(asciiFold(safe))) {
        out.warning('media.unreferenced_asset', '$.package',
          `Archive member "${name}" is not declared by this course.`,
          'Remove it or reference it from a card or theme field.');
      }
    }
  }
  return { media, mediaIndexBySource };
}

function resultWithFailure(out, sourceKind) {
  return {
    course: null,
    authoredCourse: null,
    runtimeCourse: null,
    diagnostics: out.diagnostics,
    sourceFormat: 'course-v2',
    contentRepresentation: 'sanitized-html',
    sourceKind,
    media: [],
    mediaIndexBySource: {},
  };
}

/**
 * Parse, validate and prepare one creator-authored course file.
 *
 * @param {string|Blob|ArrayBuffer|ArrayBufferView} input
 * @param {{fileName?: string}} [options]
 */
export async function readCourseFile(input, options = {}) {
  const fileName = String(options.fileName || (
    typeof File !== 'undefined' && input instanceof File ? input.name : MANIFEST
  ));
  const lower = fileName.toLowerCase();
  const sourceKind = lower.endsWith('.keep') ? 'keep-package'
    : lower.endsWith('.keep.yml') ? 'keep-yaml' : 'unknown';
  const out = collector();
  if (sourceKind === 'unknown') {
    out.error('document.unsupported_file_type', '$',
      'This is not a .keep.yml course or a .keep package.',
      'Choose a canonical course.keep.yml file, a .keep package, or an Anki .apkg.');
    return resultWithFailure(out, sourceKind);
  }

  let zip = null;
  let yaml = input;
  if (sourceKind === 'keep-package') {
    if (typeof Blob !== 'undefined' && input instanceof Blob
        && input.size > COURSE_PACKAGE_LIMITS.compressedBytes) {
      out.error('package.too_large', '$',
        'The .keep archive is larger than 250 MiB.',
        'Reduce or split its bundled media.');
      return resultWithFailure(out, sourceKind);
    }
    let bytes;
    try {
      bytes = await bytesOf(input);
    } catch {
      out.error('document.invalid_yaml', '$',
        'The selected course file could not be read.',
        'Choose an intact UTF-8 .keep.yml file or .keep archive.');
      return resultWithFailure(out, sourceKind);
    }
    if (bytes.length > COURSE_PACKAGE_LIMITS.compressedBytes) {
      out.error('package.too_large', '$',
        'The .keep archive is larger than 250 MiB.',
        'Reduce or split its bundled media.');
      return resultWithFailure(out, sourceKind);
    }
    try {
      zip = readZip(bytes);
    } catch (error) {
      out.error('document.invalid_yaml', '$',
        error instanceof ZipError ? `The .keep archive is invalid: ${error.message}.`
          : 'The .keep archive is invalid.',
        'Rebuild it as a ZIP with one root course.keep.yml.');
      return resultWithFailure(out, sourceKind);
    }
    packageStructure(zip, bytes.length, out);
    if (!zip.has(MANIFEST)) {
      out.error('package.root_manifest_missing', '$',
        'The archive has no root course.keep.yml.',
        'Put exactly one course.keep.yml at the root of the .keep ZIP.');
    }
    if (out.diagnostics.some((item) => item.severity === 'error')) {
      return resultWithFailure(out, sourceKind);
    }
    const manifestEntry = zip.directory.find((entry) => entry.name === MANIFEST);
    if (manifestEntry?.size > COURSE_PACKAGE_LIMITS.manifestBytes) {
      out.error('limit.input_bytes', '$',
        'course.keep.yml is larger than 5 MiB.',
        'Split the course or reduce its text before importing it.');
      return resultWithFailure(out, sourceKind);
    }
    try {
      yaml = await zip.read(MANIFEST);
    } catch {
      out.error('package.root_manifest_missing', '$',
        'The root course.keep.yml could not be read.',
        'Rebuild the archive with an intact root manifest.');
      return resultWithFailure(out, sourceKind);
    }
  }

  const parsed = await parseCourseYaml(yaml);
  for (const item of parsed.diagnostics) out.diagnostics.push(item);
  if (!parsed.value || parsed.diagnostics.some((item) => item.severity === 'error')) {
    return resultWithFailure(out, sourceKind);
  }

  const authored = readCourse(parsed.value);
  const runtime = await readCourseForRuntime(parsed.value);
  const combined = collector([...out.diagnostics, ...runtime.diagnostics]);
  if (!authored.course || !runtime.course
      || combined.diagnostics.some((item) => item.severity === 'error')) {
    return resultWithFailure(combined, sourceKind);
  }

  const assets = await validateAssets(authored.course, zip, combined);
  if (combined.diagnostics.some((item) => item.severity === 'error')) {
    return resultWithFailure(combined, sourceKind);
  }
  return {
    ...authored,
    // Keep the canonical document apart from validator-derived runtime fields.
    // On the next boot those derived counters and fingerprints would correctly
    // be rejected as unknown creator fields if they were persisted as input.
    authoredCourse: parsed.value,
    diagnostics: combined.diagnostics,
    sourceKind,
    runtimeCourse: runtime.course,
    media: assets.media,
    mediaIndexBySource: assets.mediaIndexBySource,
  };
}
