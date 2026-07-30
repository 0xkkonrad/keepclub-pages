/*
 * The single pure boundary between course artifacts and the descriptive app
 * model. Parsed format-2 text is still authored CommonMark here: callers must
 * render and sanitize it before it can reach innerHTML.
 */

import {
  detectCourseFormat, isReservedId, normalizeLegacyCourse, RESERVED_ID_PREFIX,
} from './legacy-course.js';

const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DOCS = 'https://keepclub.app/docs/reference/errors/#';
const MAX_DIAGNOSTICS = 100;
const LONG_SIDE_CODE_POINTS = 4000;
const MAX_SECTIONS = 1000;
const MAX_GROUPS = 250;
const MAX_GROUP_SECTION_IDS = 1000;
const MAX_TAGS = 64;
const MAX_TAG_CODE_POINTS = 100;
const MEDIA_TYPES = new Set(['image', 'audio', 'video']);
const MEDIA_FIELDS = new Set([
  'mediaId', 'side', 'mediaType', 'source', 'mimeType', 'alternativeText',
  'decorative', 'caption', 'posterImage', 'transcript', 'captionTracks',
  'durationSeconds', 'width', 'height', 'credit', 'extensions',
]);
const CAPTION_TRACK_FIELDS = new Set(['source', 'language', 'label', 'default']);
const CREDIT_FIELDS = new Set(['name', 'website']);
const PERSON_FIELDS = new Set(['name', 'website', 'email']);
const LICENSE_FIELDS = new Set(['identifier', 'name', 'website', 'attribution']);
const SOURCE_FIELDS = new Set(['website', 'repository']);
const THEME_FIELDS = new Set([
  'accentColor', 'accentColorDark', 'accentInkColor', 'accentInkColorDark',
  'paperColor', 'paperColorDark', 'shelfArtwork', 'sectionArtwork',
  'loadingArtwork', 'loadingText', 'loadingAnimation',
]);
const COLOR_FIELDS = new Set([
  'accentColor', 'accentColorDark', 'accentInkColor', 'accentInkColorDark',
  'paperColor', 'paperColorDark',
]);
const ARTWORK_FIELDS = new Set(['shelfArtwork', 'sectionArtwork', 'loadingArtwork']);
const DEFAULT_THEME = Object.freeze({
  accentColor: '#0e3f39',
  accentColorDark: '#35917f',
  accentInkColor: '#fffdf7',
  accentInkColorDark: '#141519',
  paperColor: '#fffdf7',
  paperColorDark: '#1c1e25',
  loadingText: 'Loading…',
  loadingAnimation: 'gentle-bob',
});
const TYPE_FIELDS = Object.freeze({
  image: new Set([
    'mediaId', 'side', 'mediaType', 'source', 'mimeType', 'alternativeText',
    'decorative', 'caption', 'width', 'height', 'credit', 'extensions',
  ]),
  audio: new Set([
    'mediaId', 'side', 'mediaType', 'source', 'mimeType', 'caption',
    'transcript', 'durationSeconds', 'credit', 'extensions',
  ]),
  video: new Set([
    'mediaId', 'side', 'mediaType', 'source', 'mimeType', 'caption',
    'posterImage', 'transcript', 'captionTracks', 'durationSeconds',
    'width', 'height', 'credit', 'extensions',
  ]),
});
const EXTENSIONS_BY_TYPE = Object.freeze({
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']),
  audio: new Set(['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac']),
  video: new Set(['mp4', 'webm']),
});
const TOP_FIELDS = new Set([
  'schemaVersion', 'courseId', 'title', 'shortTitle', 'tagline', 'description',
  'contentLanguage', 'instructionLanguage', 'authors', 'license', 'source',
  'sections', 'groups', 'cards', 'theme', 'extensions',
]);
const CARD_FIELDS = new Set([
  'cardId', 'front', 'back', 'sectionId', 'tags', 'media', 'extensions',
]);
const SECTION_FIELDS = new Set(['sectionId', 'title', 'description', 'extensions']);
const GROUP_FIELDS = new Set([
  'groupId', 'title', 'description', 'sectionIds', 'extensions',
]);

class UnreadableData extends Error {
  constructor(path, message) {
    super(message);
    this.path = path;
  }
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function ownKeys(value, path) {
  try {
    return Object.keys(value);
  } catch {
    throw new UnreadableData(path, 'This value cannot be inspected safely.');
  }
}

function ownValue(value, key, path) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new UnreadableData(path, 'This value cannot be inspected safely.');
  }
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new UnreadableData(path, 'Accessor properties are not course data.');
  }
  return descriptor.value;
}

/* Clone only inert JSON-compatible data. This makes normalization independent
 * of later caller mutation and bounds hostile cyclic/accessor inputs. */
function cloneData(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') {
    throw new UnreadableData(path, 'Course values must be JSON-compatible data.');
  }
  if (ancestors.has(value)) {
    throw new UnreadableData(path, 'Cyclic values are not valid course data.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = ownValue(value, 'length', path);
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new UnreadableData(path, 'This list has an unreadable length.');
      }
      const result = [];
      for (let i = 0; i < length; i++) {
        result.push(cloneData(ownValue(value, String(i), `${path}[${i}]`),
          `${path}[${i}]`, ancestors));
      }
      return result;
    }
    // A null prototype also isolates validation from an already-polluted
    // Object.prototype. Define properties explicitly so magic names such as
    // "__proto__" remain ordinary authored data for strict-field validation.
    const result = Object.create(null);
    for (const key of ownKeys(value, path)) {
      Object.defineProperty(result, key, {
        value: cloneData(ownValue(value, key, `${path}.${key}`),
          `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function diagnosticsCollector() {
  const diagnostics = [];
  let errorsTruncated = false;
  const add = (code, severity, path, message, correction) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) {
      diagnostics.push({
        code,
        severity,
        path,
        message,
        correction,
        docsUrl: DOCS + code.replace(/[._]/g, '-'),
      });
      return;
    }
    // Quality advice must never become a blocking error merely because there
    // is a lot of it. A later real error still records a bounded marker so it
    // cannot be hidden behind an earlier page of warnings.
    if (severity === 'warning' || errorsTruncated) return;
    errorsTruncated = true;
    diagnostics.push({
      code: 'document.too_many_errors',
      severity: 'error',
      path: '',
      message: 'More than 100 validation errors exist.',
      correction: 'Fix the reported set, then validate the course again.',
      docsUrl: DOCS + 'document-too-many-errors',
    });
  };
  return {
    diagnostics,
    error: (code, path, message, correction) =>
      add(code, 'error', path, message, correction),
    warning: (code, path, message, correction) =>
      add(code, 'warning', path, message, correction),
  };
}

function unknownFields(value, allowed, path, out) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      out.error('field.unknown', `${path}.${key}`,
        `Field "${key}" is not part of course format 2.`,
        'Remove it or move intentional third-party data into a namespaced extension.');
    }
  }
}

function validId(value, path, missingCode, out) {
  if (value === undefined) {
    out.error(missingCode, path, 'A stable ID is required.',
      'Add a stable lowercase ID before importing.');
    return false;
  }
  if (typeof value !== 'string' || !ID.test(value)) {
    out.error('course.invalid_id', path,
      'This ID does not match the lowercase stable-ID grammar.',
      'Use 1–128 lowercase letters, digits, dots, underscores, or hyphens.');
    return false;
  }
  // Every identity in a course document goes through here, which is the point:
  // the reserved prefix belongs to what a person writes on their own device,
  // and a shipped card that used it would end up owning their card's review
  // history the moment both are in the same index. See RESERVED_ID_PREFIX.
  if (isReservedId(value)) {
    out.error('course.reserved_id', path,
      `"${RESERVED_ID_PREFIX}" begins the identities reserved for what a person writes in the app.`,
      'Use an ID that does not begin with the reserved prefix.');
    return false;
  }
  return true;
}

function requiredTitle(value, path, out) {
  if (typeof value !== 'string') {
    out.error('field.invalid_type', path, 'A display title must be text.',
      'Provide a non-empty title.');
    return false;
  }
  const length = [...value].length;
  if (!length || length > 200) {
    out.error('field.empty', path, 'A display title must contain 1–200 characters.',
      'Provide a meaningful title or remove the containing object.');
    return false;
  }
  return true;
}

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  const text = stableString(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function optionalText(value, path, max, out) {
  if (value === undefined) return true;
  if (typeof value !== 'string') {
    out.error('field.invalid_type', path, 'This optional field must be text.',
      'Use text or omit the field.');
    return false;
  }
  if (!value.trim() || [...value].length > max) {
    out.error('field.empty', path,
      `This optional field must contain 1–${max} characters.`,
      'Provide meaningful text within the limit or omit the field.');
    return false;
  }
  return true;
}

function validLanguage(value, path, out) {
  if (value === undefined) return true;
  if (typeof value !== 'string'
      || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)
      || value.length > 63) {
    out.error('field.invalid_type', path, 'This must be a valid language tag.',
      'Use a tag such as en or en-GB, or omit it.');
    return false;
  }
  return true;
}

function validHttps(value, path, out) {
  if (typeof value !== 'string' || value.length > 2048
      || !/^https:\/\/[^\s]+$/.test(value)) {
    out.error('field.invalid_type', path, 'This must be an absolute HTTPS URL.',
      'Use an https: URL or omit it.');
    return false;
  }
  return true;
}

function normalizeExtensions(value, path, out) {
  if (value === undefined) return {};
  if (!isObject(value)) {
    out.error('field.invalid_type', path, 'extensions must be an object.',
      'Use namespaced extension keys or omit extensions.');
    return {};
  }
  const keys = Object.keys(value);
  if (keys.length > 100) {
    out.error('field.invalid_type', path, 'An extensions object may contain at most 100 keys.',
      'Reduce or combine extension data.');
  }
  for (const key of keys) {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+(?:\/[A-Za-z0-9._~-]+)*$/.test(key)) {
      out.error('extension.invalid_namespace', `${path}.${key}`,
        `Extension key "${key}" is not namespaced.`,
        'Use a reverse-domain key such as org.example.generator.');
    }
  }
  return { ...value };
}

function derivedTitle(courseId) {
  const words = typeof courseId === 'string'
    ? courseId.replace(/[._-]+/g, ' ')
    : 'course';
  return words.replace(/[a-z]/, (letter) => letter.toUpperCase());
}

function normalizePeople(value, path, out) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    out.error('field.invalid_type', path, 'authors must be a list.',
      'Use a list of author objects or omit authors.');
    return undefined;
  }
  if (!value.length) {
    out.warning('field.empty_optional', path, 'An empty authors list was removed.',
      'Omit authors when no authorship is claimed.');
    return undefined;
  }
  if (value.length > 32) {
    out.error('field.invalid_type', path, 'A course may declare at most 32 authors.',
      'Reduce or consolidate the author list.');
  }
  const authors = [];
  for (let index = 0; index < Math.min(value.length, 32); index++) {
    const author = value[index];
    const itemPath = `${path}[${index}]`;
    if (!isObject(author)) {
      out.error('field.invalid_type', itemPath, 'An author must be an object.',
        'Use an object with a name and optional website or email.');
      continue;
    }
    unknownFields(author, PERSON_FIELDS, itemPath, out);
    optionalText(author.name, `${itemPath}.name`, 200, out);
    if (author.name === undefined) {
      out.error('field.empty', `${itemPath}.name`, 'An author requires a name.',
        'Add the author name.');
    }
    if (author.website !== undefined) validHttps(author.website, `${itemPath}.website`, out);
    if (author.email !== undefined
        && (typeof author.email !== 'string' || author.email.length > 254
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(author.email))) {
      out.error('field.invalid_type', `${itemPath}.email`,
        'This must be a valid email address.', 'Correct the address or omit it.');
    }
    authors.push({ ...author });
  }
  return authors.length ? authors : undefined;
}

function normalizeNamedObject(value, path, allowed, fields, out) {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    out.error('field.invalid_type', path, `${path.split('.').at(-1)} must be an object.`,
      'Use the documented object shape or omit it.');
    return undefined;
  }
  unknownFields(value, allowed, path, out);
  if (!Object.keys(value).length) {
    out.error('field.empty', path, 'This object may not be empty.',
      'Add at least one documented field or omit the object.');
  }
  for (const [field, maximum] of Object.entries(fields.text || {})) {
    optionalText(value[field], `${path}.${field}`, maximum, out);
  }
  for (const field of fields.https || []) {
    if (value[field] !== undefined) validHttps(value[field], `${path}.${field}`, out);
  }
  return { ...value };
}

function contrastRatio(first, second) {
  const luminance = (hex) => {
    const channels = hex.slice(1, 7).match(/../g).map((pair) => {
      const value = Number.parseInt(pair, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function normalizeTheme(value, out) {
  if (value === undefined) return { ...DEFAULT_THEME };
  if (!isObject(value)) {
    out.error('field.invalid_type', '$.theme', 'theme must be an object.',
      'Use documented inert theme tokens or omit theme.');
    return { ...DEFAULT_THEME };
  }
  unknownFields(value, THEME_FIELDS, '$.theme', out);
  if (!Object.keys(value).length) {
    out.error('field.empty', '$.theme', 'A supplied theme may not be empty.',
      'Add at least one theme token or omit theme.');
  }
  for (const field of COLOR_FIELDS) {
    if (value[field] !== undefined
        && (typeof value[field] !== 'string'
          || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value[field]))) {
      out.error('field.invalid_type', `$.theme.${field}`,
        'Theme colors must be six- or eight-digit hexadecimal colors.',
        'Use a value such as #0e3f39.');
    }
  }
  for (const field of ARTWORK_FIELDS) {
    if (value[field] !== undefined) validAssetPath(value[field], `$.theme.${field}`, out);
  }
  optionalText(value.loadingText, '$.theme.loadingText', 120, out);
  if (value.loadingAnimation !== undefined
      && !['none', 'gentle-bob', 'pulse'].includes(value.loadingAnimation)) {
    out.error('field.invalid_type', '$.theme.loadingAnimation',
      'loadingAnimation must be none, gentle-bob, or pulse.',
      'Choose one app-owned animation name or omit it.');
  }
  for (const [background, foreground] of [
    ['accentColor', 'accentInkColor'],
    ['accentColorDark', 'accentInkColorDark'],
  ]) {
    if (typeof value[background] === 'string' && typeof value[foreground] === 'string'
        && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value[background])
        && /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(value[foreground])
        && contrastRatio(value[background], value[foreground]) < 4.5) {
      out.warning('theme.low_contrast', `$.theme.${foreground}`,
        `${foreground} has weak contrast against ${background}.`,
        'Choose a pair with at least 4.5:1 contrast for ordinary text.');
    }
  }
  return { ...DEFAULT_THEME, ...value };
}

function normalizeCourseMetadata(source, options, out) {
  optionalText(source.title, '$.title', 200, out);
  optionalText(source.shortTitle, '$.shortTitle', 60, out);
  optionalText(source.tagline, '$.tagline', 200, out);
  optionalText(source.description, '$.description', 262144, out);
  validLanguage(source.contentLanguage, '$.contentLanguage', out);
  validLanguage(source.instructionLanguage, '$.instructionLanguage', out);
  const title = source.title === undefined ? derivedTitle(source.courseId) : source.title;
  if (source.title === undefined) {
    out.warning('course.missing_title', '$.title',
      `The display title defaulted to "${title}".`,
      'Add title to control the display name.');
  }
  if (source.description === undefined) {
    out.warning('course.missing_description', '$.description',
      'This course has no description.', 'Add a short description when useful.');
  }
  const authors = normalizePeople(source.authors, '$.authors', out);
  const license = normalizeNamedObject(source.license, '$.license', LICENSE_FIELDS, {
    text: { identifier: 100, name: 200, attribution: 2000 },
    https: ['website'],
  }, out);
  const courseSource = normalizeNamedObject(source.source, '$.source', SOURCE_FIELDS, {
    https: ['website', 'repository'],
  }, out);
  if (!authors && !courseSource) {
    out.warning('metadata.missing_attribution', '$',
      'This course has no author or source attribution.',
      'Add authors or source when the origin is known.');
  }
  if (options.publication && !license) {
    out.error('publication.license_required', '$.license',
      'A published course requires license metadata.',
      'Add a license object before publication.');
  }
  return {
    title,
    shortTitle: source.shortTitle === undefined ? title : source.shortTitle,
    ...(source.tagline === undefined ? {} : { tagline: source.tagline }),
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.contentLanguage === undefined ? {} : { contentLanguage: source.contentLanguage }),
    ...(source.instructionLanguage === undefined
      ? (source.contentLanguage === undefined
        ? {} : { instructionLanguage: source.contentLanguage })
      : { instructionLanguage: source.instructionLanguage }),
    ...(authors ? { authors } : {}),
    ...(license ? { license } : {}),
    ...(courseSource ? { source: courseSource } : {}),
    theme: normalizeTheme(source.theme, out),
    extensions: normalizeExtensions(source.extensions, '$.extensions', out),
  };
}

function validAssetPath(value, path, out) {
  if (typeof value !== 'string') {
    out.error('field.invalid_type', path, 'An asset source must be text.',
      'Use one normalized relative package path.');
    return false;
  }
  const normalized = value.normalize('NFC');
  const parts = value.split('/');
  const unsafe = !value
    || [...value].length > 240
    || value !== normalized
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(value)
    || /%(?:2e|2f|5c)/i.test(value)
    || parts.some((part) => !part || part === '.' || part === '..');
  if (unsafe) {
    out.error('media.invalid_path', path,
      'This asset source is not one unambiguous normalized relative path.',
      'Remove schemes, roots, traversal, backslashes, controls, empty components, and ambiguous encoding.');
    return false;
  }
  return true;
}

function assetExtension(value) {
  if (typeof value !== 'string') return '';
  const filename = value.split('/').at(-1);
  return filename.includes('.') ? filename.split('.').at(-1).toLowerCase() : '';
}

function unicodeCaseFold(value) {
  if (typeof value !== 'string') return '';
  // Upper-then-lower handles multi-character and positional folds that a
  // simple toLowerCase misses (for example ß/SS and Greek final sigma).
  return value.normalize('NFKC').toUpperCase().toLowerCase();
}

function normalizedComparisonText(value) {
  return unicodeCaseFold(value).trim().replace(/\s+/gu, ' ');
}

function warnLongSide(value, path, out) {
  if (typeof value !== 'string') return;
  let codePoints = 0;
  for (const _character of value) {
    codePoints++;
    if (codePoints > LONG_SIDE_CODE_POINTS) {
      out.warning('card.long_side', path,
        `This card side is longer than ${LONG_SIDE_CODE_POINTS.toLocaleString('en-US')} characters.`,
        'Split the material across cards or tighten the wording when practical.');
      return;
    }
  }
}

function frontImpliesAnswer(value) {
  const text = normalizedComparisonText(value);
  if (!text) return false;
  return /\b(?:reveal|show|see|check|view)\s+(?:the\s+)?answer\b/u.test(text)
    || /\b(?:answer|solution)\s+(?:is\s+)?(?:below|above|on\s+the\s+back)\b/u.test(text)
    || /\b(?:flip|turn)(?:\s+the\s+card)?\s+over\b/u.test(text);
}

function weakAlternativeText(alternativeText, source) {
  if (typeof alternativeText !== 'string' || !alternativeText.trim()) return false;
  const text = normalizedComparisonText(alternativeText);
  const filename = typeof source === 'string' ? source.split('/').at(-1) : '';
  const stem = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  const normalizedFilename = normalizedComparisonText(filename);
  const normalizedStem = normalizedComparisonText(stem).replace(/[-_]+/gu, ' ');
  if (text === normalizedFilename || text === normalizedStem) return true;
  return /^(?:an?\s+)?(?:image|photo|picture|graphic|diagram|screenshot|icon|logo|illustration)(?:\s+\d+)?[.!]?$/u
    .test(text);
}

function normalizeTags(raw, path, out) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    out.error('field.invalid_type', path, 'tags must be a list.',
      'Use a list of non-blank tag strings or omit tags.');
    return undefined;
  }
  if (!raw.length) {
    out.warning('field.empty_optional', path,
      'An empty tag list was removed.', 'Omit tags when this card has no tags.');
    return undefined;
  }
  if (raw.length > MAX_TAGS) {
    out.error('field.invalid_type', path,
      `A card may declare at most ${MAX_TAGS} tags.`,
      'Reduce the tag list or split the card.');
  }
  const seen = new Set();
  const tags = [];
  for (let index = 0; index < Math.min(raw.length, MAX_TAGS); index++) {
    const tag = raw[index];
    if (typeof tag !== 'string') {
      out.error('field.invalid_type', `${path}[${index}]`,
        'A tag must be text.', 'Use a non-blank tag string or remove it.');
      continue;
    }
    if (!tag.trim() || [...tag].length > MAX_TAG_CODE_POINTS) {
      out.error('field.empty', `${path}[${index}]`,
        `A tag must contain 1–${MAX_TAG_CODE_POINTS} meaningful characters.`,
        'Use a shorter non-blank tag or remove it.');
      continue;
    }
    const comparison = unicodeCaseFold(tag);
    if (seen.has(comparison)) {
      out.warning('card.duplicate_tag', `${path}[${index}]`,
        `Tag "${tag}" duplicates an earlier tag on this card.`,
        'Remove the duplicate; the first spelling is retained.');
      continue;
    }
    seen.add(comparison);
    tags.push(tag);
  }
  return tags;
}

function positiveNumber(value, path, out, { integer = false, maximum = 86400 } = {}) {
  if (value === undefined) return true;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
      || value > maximum || (integer && !Number.isInteger(value))) {
    out.error('field.invalid_type', path,
      `This value must be a positive ${integer ? 'integer' : 'number'} no greater than ${maximum}.`,
      'Correct the value or omit it.');
    return false;
  }
  return true;
}

function normalizeCredit(raw, path, out) {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    out.error('field.invalid_type', path, 'credit must be an object.',
      'Use a credit object containing a name and optional HTTPS website.');
    return undefined;
  }
  unknownFields(raw, CREDIT_FIELDS, path, out);
  optionalText(raw.name, `${path}.name`, 200, out);
  if (raw.name === undefined) {
    out.error('field.empty', `${path}.name`, 'A credit requires a name.',
      'Add the credited person or organization name.');
  }
  if (raw.website !== undefined) validHttps(raw.website, `${path}.website`, out);
  return { ...raw };
}

function normalizeCaptionTracks(raw, path, out) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    out.error('field.invalid_type', path, 'captionTracks must be a list.',
      'Use a list of WebVTT track objects or omit it.');
    return undefined;
  }
  if (!raw.length) {
    out.warning('field.empty_optional', path,
      'An empty caption track list was removed.',
      'Omit captionTracks when there are no tracks.');
    return undefined;
  }
  if (raw.length > 16) {
    out.error('media.too_many', path, 'A video may declare at most 16 caption tracks.',
      'Reduce or combine caption tracks.');
  }
  let defaults = 0;
  const tracks = [];
  for (let index = 0; index < Math.min(raw.length, 16); index++) {
    const track = raw[index];
    const itemPath = `${path}[${index}]`;
    if (!isObject(track)) {
      out.error('field.invalid_type', itemPath, 'A caption track must be an object.',
        'Use an object with source and language.');
      continue;
    }
    unknownFields(track, CAPTION_TRACK_FIELDS, itemPath, out);
    validAssetPath(track.source, `${itemPath}.source`, out);
    if (typeof track.source === 'string' && assetExtension(track.source) !== 'vtt') {
      out.error('media.type_mismatch', `${itemPath}.source`,
        'A caption track must be a WebVTT (.vtt) asset.',
        'Use a packaged .vtt caption file.');
    }
    if (track.language === undefined) {
      out.error('field.invalid_type', `${itemPath}.language`,
        'A caption language must be a valid language tag.',
        'Use a tag such as en or en-GB.');
    } else {
      validLanguage(track.language, `${itemPath}.language`, out);
    }
    optionalText(track.label, `${itemPath}.label`, 100, out);
    if (track.default !== undefined && typeof track.default !== 'boolean') {
      out.error('field.invalid_type', `${itemPath}.default`,
        'A caption default marker must be true or false.',
        'Use a boolean or omit it.');
    }
    if (track.default === true) defaults++;
    tracks.push({ ...track });
  }
  if (defaults > 1) {
    out.error('field.invalid_type', path,
      'Only one caption track may be the default.',
      'Keep default: true on one track.');
  }
  return tracks;
}

function normalizeMedia(raw, path, out, options) {
  if (!isObject(raw)) {
    out.error('field.invalid_type', path, 'A media attachment must be an object.',
      'Use a media object with side, mediaType, and source.');
    return null;
  }
  unknownFields(raw, MEDIA_FIELDS, path, out);
  if (raw.mediaId !== undefined) validId(raw.mediaId, `${path}.mediaId`, 'course.invalid_id', out);
  if (raw.side !== 'front' && raw.side !== 'back') {
    out.error('field.invalid_type', `${path}.side`,
      'Media side must be front or back.',
      'Choose the side where this attachment appears.');
  }
  if (!MEDIA_TYPES.has(raw.mediaType)) {
    out.error('field.invalid_type', `${path}.mediaType`,
      'mediaType must be image, audio, or video.',
      'Declare the kind of media this file contains.');
  }
  const pathOk = validAssetPath(raw.source, `${path}.source`, out);
  const allowed = TYPE_FIELDS[raw.mediaType];
  if (allowed) {
    for (const key of Object.keys(raw)) {
      if (MEDIA_FIELDS.has(key) && !allowed.has(key)) {
        out.error('field.unknown', `${path}.${key}`,
          `Field "${key}" does not apply to ${raw.mediaType} media.`,
          `Remove it or use a field documented for ${raw.mediaType}.`);
      }
    }
  }

  if (raw.mimeType !== undefined) {
    if (typeof raw.mimeType !== 'string' || raw.mimeType.length > 100
        || !/^(?:image|audio|video)\/[A-Za-z0-9!#$&^_.+-]+$/.test(raw.mimeType)) {
      out.error('field.invalid_type', `${path}.mimeType`,
        'mimeType must be an image, audio, or video MIME type.',
        'Use a valid media MIME type or omit it.');
    } else if (MEDIA_TYPES.has(raw.mediaType)
        && !raw.mimeType.startsWith(`${raw.mediaType}/`)) {
      out.error('media.type_mismatch', `${path}.mimeType`,
        `The MIME type does not match mediaType "${raw.mediaType}".`,
        'Correct the MIME type or mediaType.');
    }
  }
  if (pathOk && MEDIA_TYPES.has(raw.mediaType)) {
    const extension = assetExtension(raw.source);
    if (!EXTENSIONS_BY_TYPE[raw.mediaType].has(extension)) {
      out.error('media.type_mismatch', `${path}.source`,
        `The filename extension does not match mediaType "${raw.mediaType}".`,
        'Use a documented extension for this media type.');
    }
  }

  optionalText(raw.alternativeText, `${path}.alternativeText`, 2000, out);
  optionalText(raw.caption, `${path}.caption`, 262144, out);
  optionalText(raw.transcript, `${path}.transcript`, 262144, out);
  if (raw.decorative !== undefined && typeof raw.decorative !== 'boolean') {
    out.error('field.invalid_type', `${path}.decorative`,
      'decorative must be true or false.',
      'Use a boolean or omit it.');
  }
  positiveNumber(raw.durationSeconds, `${path}.durationSeconds`, out);
  positiveNumber(raw.width, `${path}.width`, out, { integer: true, maximum: 32768 });
  positiveNumber(raw.height, `${path}.height`, out, { integer: true, maximum: 32768 });
  if ((raw.width === undefined) !== (raw.height === undefined)) {
    out.error('field.invalid_type', path,
      'Media dimensions must provide both width and height.',
      'Add the missing dimension or omit both.');
  }
  if (raw.posterImage !== undefined) {
    validAssetPath(raw.posterImage, `${path}.posterImage`, out);
    if (!EXTENSIONS_BY_TYPE.image.has(assetExtension(raw.posterImage))) {
      out.error('media.type_mismatch', `${path}.posterImage`,
        'A video poster must use a supported image extension.',
        'Use a packaged PNG, JPEG, WebP, GIF, or SVG image.');
    }
  }
  const captionTracks = normalizeCaptionTracks(raw.captionTracks, `${path}.captionTracks`, out);
  const credit = normalizeCredit(raw.credit, `${path}.credit`, out);

  if (raw.mediaType === 'image' && raw.decorative !== true && !raw.alternativeText) {
    const code = options.publication ? 'publication.image_alt_required' : 'media.alt_missing';
    const severity = options.publication ? 'error' : 'warning';
    out[severity](code, `${path}.alternativeText`,
      'This non-decorative image has no text alternative.',
      'Describe the useful visual content, or mark a truly decorative image decorative: true.');
  }
  if (raw.mediaType === 'image' && raw.decorative !== true
      && weakAlternativeText(raw.alternativeText, raw.source)) {
    out.warning('media.alt_weak', `${path}.alternativeText`,
      'This image alternative is filename-like or does not describe the useful content.',
      'Replace it with a concise description of what the image conveys.');
  }
  if (options.publication && raw.mediaType === 'image'
      && (!raw.width || !raw.height)) {
    out.error('publication.image_dimensions_required', path,
      'A published image requires width and height.',
      'Add its pixel dimensions.');
  }
  if ((raw.mediaType === 'audio' || raw.mediaType === 'video') && !raw.transcript) {
    out.warning('media.transcript_missing', `${path}.transcript`,
      'This media has no transcript.',
      'Add a transcript for accessibility.');
  }
  if (options.publication && raw.mediaType === 'video'
      && !raw.transcript && !captionTracks?.length) {
    out.error('publication.video_text_alternative_required', path,
      'A published video requires captions or a transcript.',
      'Add at least one WebVTT caption track or a transcript.');
  }

  const media = { ...raw };
  if (raw.extensions !== undefined) {
    media.extensions = normalizeExtensions(raw.extensions, `${path}.extensions`, out);
  }
  if (raw.captionTracks !== undefined) {
    if (captionTracks?.length) media.captionTracks = captionTracks;
    else delete media.captionTracks;
  }
  if (raw.credit !== undefined) {
    if (credit) media.credit = credit;
    else delete media.credit;
  }
  return media;
}

function normalizeMediaList(raw, path, out, options, tally) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    out.error('field.invalid_type', path, 'media must be a list.',
      'Use a list of media objects or omit media.');
    return undefined;
  }
  if (!raw.length) {
    out.warning('field.empty_optional', path,
      'An empty media list was removed.',
      'Omit media when this card has no attachments.');
    return undefined;
  }
  if (raw.length > 16) {
    out.error('media.too_many', path, 'A card may declare at most 16 media objects.',
      'Reduce the attachments or split the card.');
  }
  tally.count += raw.length;
  if (tally.count > 2000 && !tally.reported) {
    tally.reported = true;
    out.error('media.too_many', '$.cards',
      'A course may declare at most 2,000 media objects.',
      'Reduce attachments or split the course.');
  }
  const media = [];
  for (let index = 0; index < Math.min(raw.length, 16); index++) {
    const item = normalizeMedia(raw[index], `${path}[${index}]`, out, options);
    if (item) media.push(item);
  }
  return media.length ? media : undefined;
}

function normalizeV2(input, options = {}) {
  const out = diagnosticsCollector();
  let source;
  try {
    source = cloneData(input);
  } catch (error) {
    const path = error instanceof UnreadableData ? error.path : '$';
    out.error('field.invalid_type', path,
      error instanceof UnreadableData ? error.message : 'The course cannot be inspected safely.',
      'Use ordinary parsed YAML/JSON data without accessors, proxies, or cycles.');
    return {
      course: null,
      diagnostics: out.diagnostics,
      sourceFormat: 'course-v2',
      contentRepresentation: 'authored-commonmark',
    };
  }

  if (!isObject(source)) {
    out.error('course.not_object', '$', 'The course root is not an object.',
      'Make the document root a course mapping.');
    return {
      course: null,
      diagnostics: out.diagnostics,
      sourceFormat: 'course-v2',
      contentRepresentation: 'authored-commonmark',
    };
  }
  unknownFields(source, TOP_FIELDS, '$', out);
  if (source.schemaVersion !== 2) {
    out.error('course.unsupported_schema_version', '$.schemaVersion',
      'schemaVersion must be the integer 2.',
      'Set schemaVersion to 2 and use the format-2 contract.');
  }
  validId(source.courseId, '$.courseId', 'course.missing_id', out);
  const metadata = normalizeCourseMetadata(source, options, out);

  if (!Array.isArray(source.cards) || source.cards.length < 1
      || source.cards.length > 50000) {
    out.error('course.cards_required', '$.cards',
      'cards must be a list containing 1–50,000 cards.',
      'Provide at least one card, or split a course above the limit.');
  }

  const declaredSections = Array.isArray(source.sections) && source.sections.length > 0;
  if (source.sections !== undefined && !Array.isArray(source.sections)) {
    out.error('field.invalid_type', '$.sections', 'sections must be a list.',
      'Use a list of section objects or omit sections.');
  }
  if (Array.isArray(source.sections) && !source.sections.length) {
    out.warning('field.empty_optional', '$.sections',
      'An empty sections list was removed and the default section was generated.',
      'Omit sections when every card belongs to the generated section.');
  }
  if (Array.isArray(source.sections) && source.sections.length > MAX_SECTIONS) {
    out.error('field.invalid_type', '$.sections',
      `A course may declare at most ${MAX_SECTIONS.toLocaleString('en-US')} sections.`,
      'Reduce the sections or split the course.');
  }
  const sections = [];
  const sectionIds = new Set();
  if (declaredSections) {
    for (let i = 0; i < Math.min(source.sections.length, MAX_SECTIONS); i++) {
      const raw = source.sections[i];
      const path = `$.sections[${i}]`;
      if (!isObject(raw)) {
        out.error('field.invalid_type', path, 'A section must be an object.',
          'Use a section object with sectionId and title.');
        continue;
      }
      unknownFields(raw, SECTION_FIELDS, path, out);
      const idOk = validId(raw.sectionId, `${path}.sectionId`, 'course.invalid_id', out);
      requiredTitle(raw.title, `${path}.title`, out);
      optionalText(raw.description, `${path}.description`, 262144, out);
      if (idOk && sectionIds.has(raw.sectionId)) {
        out.error('section.duplicate_id', `${path}.sectionId`,
          `Section ID "${raw.sectionId}" is repeated.`,
          'Give every section one unique stable ID.');
      }
      if (idOk) sectionIds.add(raw.sectionId);
      sections.push({
        ...raw,
        ...(raw.extensions === undefined ? {} : {
          extensions: normalizeExtensions(raw.extensions, `${path}.extensions`, out),
        }),
        cardCount: 0,
      });
    }
  } else {
    sections.push({ sectionId: 'all-cards', title: 'All cards', cardCount: 0 });
    sectionIds.add('all-cards');
  }

  const cards = [];
  const cardIds = new Set();
  const firstCardByContent = new Map();
  const mediaTally = { count: 0, reported: false };
  if (Array.isArray(source.cards)) {
    for (let i = 0; i < source.cards.length; i++) {
      const raw = source.cards[i];
      const path = `$.cards[${i}]`;
      if (!isObject(raw)) {
        out.error('field.invalid_type', path, 'A card must be an object.',
          'Use a card object with a stable cardId.');
        continue;
      }
      unknownFields(raw, CARD_FIELDS, path, out);
      const idOk = validId(raw.cardId, `${path}.cardId`, 'card.missing_id', out);
      if (idOk && cardIds.has(raw.cardId)) {
        out.error('card.duplicate_id', `${path}.cardId`,
          `Card ID "${raw.cardId}" is repeated.`,
          'Give every review card one unique stable ID.');
      }
      if (idOk) cardIds.add(raw.cardId);

      if (raw.front !== undefined && typeof raw.front !== 'string') {
        out.error('field.invalid_type', `${path}.front`, 'front must be CommonMark text.',
          'Use text, or omit front and provide valid front-side media.');
      }
      if (raw.back !== undefined && typeof raw.back !== 'string') {
        out.error('field.invalid_type', `${path}.back`, 'back must be CommonMark text.',
          'Use text or omit back.');
      }
      const media = normalizeMediaList(
        raw.media, `${path}.media`, out, options, mediaTally,
      );
      const hasFrontText = typeof raw.front === 'string' && raw.front.trim().length > 0;
      const hasFrontMedia = Array.isArray(media)
        && media.some((item) => item.side === 'front'
          && MEDIA_TYPES.has(item.mediaType)
          && typeof item.source === 'string'
          && item.source.length > 0);
      if (!hasFrontText && !hasFrontMedia) {
        out.error('card.front_empty', path,
          'Neither front text nor front-side media can render a prompt.',
          'Add non-blank front text or at least one front-side media object.');
      }

      const card = { ...raw };
      if (raw.extensions !== undefined) {
        card.extensions = normalizeExtensions(raw.extensions, `${path}.extensions`, out);
      }
      if (raw.media !== undefined) {
        if (media) card.media = media;
        else delete card.media;
      }
      if (raw.tags !== undefined) {
        const tags = normalizeTags(raw.tags, `${path}.tags`, out);
        if (tags === undefined) delete card.tags;
        else card.tags = tags;
      }
      if (typeof card.back === 'string' && !card.back.trim()) {
        delete card.back;
        out.warning('field.empty_back', `${path}.back`,
          'A blank back was removed; this is a front-only card.',
          'Omit back to state front-only intent explicitly.');
      }
      warnLongSide(card.front, `${path}.front`, out);
      warnLongSide(card.back, `${path}.back`, out);

      const hasBackText = typeof card.back === 'string' && card.back.trim().length > 0;
      const hasBackMedia = Array.isArray(card.media)
        && card.media.some((item) => item.side === 'back'
          && MEDIA_TYPES.has(item.mediaType)
          && typeof item.source === 'string'
          && item.source.length > 0);
      if (!hasBackText && !hasBackMedia && frontImpliesAnswer(card.front)) {
        out.warning('card.front_only_answer_cue', `${path}.front`,
          'This front-only prompt implies that an answer will be revealed.',
          'Add the answer on the back, or reword the prompt as a front-only reminder.');
      }

      const normalizedFront = normalizedComparisonText(card.front);
      if (normalizedFront) {
        const signature = `${normalizedFront}\u0000${normalizedComparisonText(card.back)}`;
        const first = firstCardByContent.get(signature);
        if (first) {
          out.warning('card.duplicate_looking_content', path,
            `This card looks equivalent to earlier card "${first.cardId}".`,
            'Confirm both cards are intentional, or remove the duplicate.');
        } else {
          firstCardByContent.set(signature, {
            cardId: typeof card.cardId === 'string' ? card.cardId : `at index ${i}`,
          });
        }
      }

      let sectionId = card.sectionId;
      if (sectionId !== undefined && !validId(
        sectionId, `${path}.sectionId`, 'course.invalid_id', out,
      )) {
        sectionId = null;
      } else if (sectionId === undefined) {
        if (!declaredSections || sections.length === 1) {
          sectionId = sections[0]?.sectionId;
        } else {
          out.error('section.ambiguous_default', `${path}.sectionId`,
            'This card omits sectionId while multiple sections are declared.',
            'Name exactly which declared section owns this card.');
        }
      }
      if (sectionId && !sectionIds.has(sectionId)) {
        out.error('section.unknown', `${path}.sectionId`,
          `Section "${sectionId}" is not declared.`,
          'Declare the section or correct this card’s sectionId.');
      } else if (sectionId) {
        card.sectionId = sectionId;
        const section = sections.find((candidate) => candidate.sectionId === sectionId);
        if (section) section.cardCount++;
      }
      cards.push(card);
    }
  }

  if (declaredSections) {
    for (let i = 0; i < sections.length; i++) {
      if (sections[i].cardCount === 0) {
        out.error('section.empty', `$.sections[${i}]`,
          `Section "${sections[i].sectionId || i}" contains no cards.`,
          'Remove the section or place at least one card in it.');
      }
    }
  }

  if (source.groups !== undefined && !Array.isArray(source.groups)) {
    out.error('field.invalid_type', '$.groups', 'groups must be a list.',
      'Use a list of group objects or omit groups.');
  }
  if (Array.isArray(source.groups) && !source.groups.length) {
    out.warning('field.empty_optional', '$.groups',
      'An empty groups list was removed.', 'Omit groups when sections display directly.');
  }
  if (Array.isArray(source.groups) && source.groups.length > MAX_GROUPS) {
    out.error('field.invalid_type', '$.groups',
      `A course may declare at most ${MAX_GROUPS} groups.`,
      'Reduce the groups or split the course.');
  }
  const groups = [];
  const groupIds = new Set();
  const groupedSections = new Set();
  if (Array.isArray(source.groups)) {
    for (let i = 0; i < Math.min(source.groups.length, MAX_GROUPS); i++) {
      const raw = source.groups[i];
      const path = `$.groups[${i}]`;
      if (!isObject(raw)) {
        out.error('field.invalid_type', path, 'A group must be an object.',
          'Use a group object with groupId, title, and sectionIds.');
        continue;
      }
      unknownFields(raw, GROUP_FIELDS, path, out);
      const idOk = validId(raw.groupId, `${path}.groupId`, 'course.invalid_id', out);
      requiredTitle(raw.title, `${path}.title`, out);
      optionalText(raw.description, `${path}.description`, 262144, out);
      if (idOk && groupIds.has(raw.groupId)) {
        out.error('group.duplicate_id', `${path}.groupId`,
          `Group ID "${raw.groupId}" is repeated.`,
          'Give every group one unique stable ID.');
      }
      if (idOk) groupIds.add(raw.groupId);
      if (!Array.isArray(raw.sectionIds) || raw.sectionIds.length < 1) {
        out.error('field.invalid_type', `${path}.sectionIds`,
          'sectionIds must be a non-empty list.',
          'List every section in this group.');
        groups.push({
          ...raw,
          ...(raw.extensions === undefined ? {} : {
            extensions: normalizeExtensions(raw.extensions, `${path}.extensions`, out),
          }),
          sectionIds: [],
          cardCount: 0,
        });
        continue;
      }
      if (raw.sectionIds.length > MAX_GROUP_SECTION_IDS) {
        out.error('field.invalid_type', `${path}.sectionIds`,
          `A group may contain at most ${MAX_GROUP_SECTION_IDS.toLocaleString('en-US')} section IDs.`,
          'Reduce the group membership or split the course.');
      }
      const local = new Set();
      let cardCount = 0;
      for (let j = 0; j < Math.min(raw.sectionIds.length, MAX_GROUP_SECTION_IDS); j++) {
        const sectionId = raw.sectionIds[j];
        const memberPath = `${path}.sectionIds[${j}]`;
        if (!validId(sectionId, memberPath, 'course.invalid_id', out)) continue;
        if (!sectionIds.has(sectionId)) {
          out.error('group.unknown_section', memberPath,
            `Section "${sectionId}" is not declared.`,
            'Remove it or declare that section.');
          continue;
        }
        if (local.has(sectionId) || groupedSections.has(sectionId)) {
          out.error('group.duplicate_section', memberPath,
            `Section "${sectionId}" occurs more than once in groups.`,
            'Keep each declared section in exactly one group.');
        }
        local.add(sectionId);
        groupedSections.add(sectionId);
        cardCount += sections.find((section) => section.sectionId === sectionId)?.cardCount || 0;
      }
      groups.push({
        ...raw,
        ...(raw.extensions === undefined ? {} : {
          extensions: normalizeExtensions(raw.extensions, `${path}.extensions`, out),
        }),
        cardCount,
      });
    }
  }
  if (groups.length) {
    for (const section of sections) {
      if (!groupedSections.has(section.sectionId)) {
        out.error('group.ungrouped_section', '$.groups',
          `Section "${section.sectionId}" is not in any group.`,
          'Place every declared section in exactly one group.');
      }
    }
  }

  const course = {
    ...source,
    ...metadata,
    sections,
    groups,
    cards,
    cardCount: cards.length,
  };
  // A spread cannot express deletion. Keep empty optional metadata from leaking
  // back out of `source` after its normalizer deliberately removed it.
  for (const field of ['authors', 'license', 'source']) {
    if (!Object.hasOwn(metadata, field)) delete course[field];
  }
  course.buildFingerprint = fingerprint(course);
  const failed = out.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  return {
    course: failed ? null : course,
    diagnostics: out.diagnostics,
    sourceFormat: 'course-v2',
    contentRepresentation: 'authored-commonmark',
  };
}

/**
 * @param {unknown} input already-parsed JSON/YAML data
 * @param {{courseId?: string}} [options] legacy identity context
 */
export function readCourse(input, options = {}) {
  const sourceFormat = detectCourseFormat(input);
  let hasDescriptiveIdentity = false;
  let hasExplicitLegacyMarker = false;
  try {
    if (isObject(input)) {
      hasDescriptiveIdentity = !!Object.getOwnPropertyDescriptor(input, 'courseId');
      const format = Object.getOwnPropertyDescriptor(input, 'format');
      hasExplicitLegacyMarker = !!format && Object.hasOwn(format, 'value') && format.value === 1;
    }
  } catch { /* hostile values are handled below */ }
  // An unversioned descriptive object that declares sections can otherwise
  // resemble the original unmarked cards.json shape. A public courseId is the
  // disambiguator; missing schemaVersion must be reported, never read as v1.
  if (sourceFormat === 'legacy-v1'
      && (hasExplicitLegacyMarker || !hasDescriptiveIdentity)) {
    const result = normalizeLegacyCourse(input, options);
    return {
      ...result,
      diagnostics: result.diagnostics.map(({ docs, ...diagnostic }) => ({
        ...diagnostic,
        docsUrl: diagnostic.docsUrl || docs,
      })),
      contentRepresentation: 'sanitized-html',
    };
  }
  if (sourceFormat === 'course-v2') return normalizeV2(input, options);

  const out = diagnosticsCollector();
  let rootIsObject = false;
  try { rootIsObject = isObject(input); } catch { /* revoked proxy */ }
  if (!rootIsObject) {
    out.error('course.not_object', '$', 'The course root is not an object.',
      'Provide one parsed course mapping.');
  } else {
    out.error('course.unsupported_schema_version', '$.schemaVersion',
      'schemaVersion is missing or unsupported.',
      'Use schemaVersion: 2, or a deployed compact format-1 course.');
  }
  return {
    course: null,
    diagnostics: out.diagnostics,
    sourceFormat,
    contentRepresentation: 'unknown',
  };
}
