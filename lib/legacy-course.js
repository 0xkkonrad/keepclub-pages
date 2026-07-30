/*
 * Permanent reader for the compact course objects keep club shipped before
 * the public course format existed.
 *
 * This module is deliberately pure. It imports nothing, touches no browser
 * storage, and builds a fresh descriptive object without changing its input.
 * New runtime code must not learn the compact vocabulary from this file; the
 * adapter is the one compatibility boundary where those names belong.
 */

export const LEGACY_COURSE_FORMAT = 1;
export const DESCRIPTIVE_COURSE_FORMAT = 2;

/* The prefix the app keeps for identities a person creates on their own
 * device: the cards they write into a deck, and the section those cards fall
 * into when the one they named is gone.
 *
 * Reserved in both directions, permanently. A course reader that accepted a
 * shipped card under this prefix would eventually ship one whose id a person
 * had already used for a card of their own — and the runtime index is a Map
 * built from the merged card list, where the last id in wins. The official
 * card would inherit a stranger's review history and no screen would say so.
 * Rejecting it here is the half of the rule that cannot be added later; the
 * layer's own half is that it accepts nothing else. */
export const RESERVED_ID_PREFIX = 'u.';

/** Whether this identity belongs to the person rather than to the course. */
export function isReservedId(value) {
  return typeof value === 'string' && value.startsWith(RESERVED_ID_PREFIX);
}

const SOURCE_LEGACY = 'legacy-v1';
const SOURCE_V2 = 'course-v2';
const SOURCE_UNKNOWN = 'unknown';
const SOURCE_UNSUPPORTED = 'unsupported';
const DIAGNOSTIC_LIMIT = 100;
const ITEM_LIMIT = 100000;
const ERROR_DOCS =
  'https://keepclub.app/docs/reference/errors/#legacy-compatibility';

const TOP_LEVEL_FIELDS = new Set([
  'format', 'name', 'course', 'sections', 'groups', 'cards', 'build', 'ds',
]);
const SECTION_FIELDS = new Set(['k', 't', 'n', 'o']);
const GROUP_FIELDS = new Set(['k', 't', 's', 'n', 'o']);
const CARD_FIELDS = new Set(['i', 's', 'q', 'a', 'm', 'd', 'f', 'r']);
const FIGURE_FIELDS = new Set(['n', 'on']);

class UnsafeInput extends Error {
  constructor(path, detail) {
    super(detail);
    this.path = path;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/*
 * Course data normally comes from JSON, but callers also hand this boundary
 * JavaScript values in tests, extensions, and browser migrations. Never invoke
 * an accessor while validating untrusted input: a getter can throw, mutate
 * storage, or return a different deck on each read.
 */
function ownValue(object, key, path) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch (error) {
    throw new UnsafeInput(path, `could not inspect this value: ${safeMessage(error)}`);
  }
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) {
    throw new UnsafeInput(path, 'accessor properties are not course data');
  }
  return descriptor.value;
}

function ownKeys(object, path) {
  try {
    return Object.keys(object);
  } catch (error) {
    throw new UnsafeInput(path, `could not inspect this object: ${safeMessage(error)}`);
  }
}

function arrayLength(array, path) {
  const length = ownValue(array, 'length', path);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new UnsafeInput(path, 'the list length is not readable');
  }
  return length;
}

function safeMessage(error) {
  try {
    return error instanceof Error && typeof error.message === 'string'
      ? error.message.slice(0, 160)
      : 'the input rejected inspection';
  } catch {
    return 'the input rejected inspection';
  }
}

function collector() {
  const diagnostics = [];
  const add = (code, severity, path, message, correction) => {
    if (diagnostics.length >= DIAGNOSTIC_LIMIT) return;
    diagnostics.push({
      code,
      severity,
      path,
      message,
      correction,
      docsUrl: ERROR_DOCS,
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

function reportUnknownFields(value, known, path, out) {
  for (const key of ownKeys(value, path)) {
    if (known.has(key)) continue;
    out.warning(
      'legacy.unknown_field',
      path === '$' ? `$.${key}` : `${path}.${key}`,
      `Legacy field "${key}" is not part of the shipped format-1 contract and was not normalized.`,
      'Move intentional third-party data into a namespaced format-2 extension.',
    );
  }
}

/**
 * Identify the outer course representation without validating its contents.
 * This function never throws, including for revoked proxies and accessors.
 *
 * @param {unknown} input
 * @returns {'legacy-v1'|'course-v2'|'unsupported'|'unknown'}
 */
export function detectCourseFormat(input) {
  try {
    if (!isObject(input)) return SOURCE_UNKNOWN;

    const schemaVersion = ownValue(input, 'schemaVersion', '$.schemaVersion');
    if (schemaVersion !== undefined) {
      return schemaVersion === DESCRIPTIVE_COURSE_FORMAT ? SOURCE_V2 : SOURCE_UNSUPPORTED;
    }

    const format = ownValue(input, 'format', '$.format');
    if (format !== undefined) {
      return format === LEGACY_COURSE_FORMAT ? SOURCE_LEGACY : SOURCE_UNSUPPORTED;
    }

    // Built-in cards.json files predate the format marker. Requiring both
    // compact tables avoids calling an arbitrary object with `cards` legacy.
    const sections = ownValue(input, 'sections', '$.sections');
    const cards = ownValue(input, 'cards', '$.cards');
    return Array.isArray(sections) && Array.isArray(cards) ? SOURCE_LEGACY : SOURCE_UNKNOWN;
  } catch {
    return SOURCE_UNKNOWN;
  }
}

function normalizeSection(raw, index, ids, out) {
  const path = `$.sections[${index}]`;
  if (!isObject(raw)) {
    out.error('section.not_object', path, 'This legacy section is not an object.',
      'Replace it with a section object containing a stable key and title.');
    return null;
  }
  reportUnknownFields(raw, SECTION_FIELDS, path, out);

  const sectionId = ownValue(raw, 'k', `${path}.k`);
  const title = ownValue(raw, 't', `${path}.t`);
  const claimedCount = ownValue(raw, 'n', `${path}.n`);

  if (!isNonEmptyString(sectionId)) {
    out.error('section.missing_id', `${path}.k`, 'This legacy section has no stable key.',
      'Restore the original non-empty section key.');
    return null;
  }
  if (ids.has(sectionId)) {
    out.error('section.duplicate_id', `${path}.k`,
      `Two legacy sections share the key "${sectionId}".`,
      'Give every section a unique stable key without changing existing keys.');
  }
  ids.add(sectionId);

  if (isReservedId(sectionId)) {
    out.error('course.reserved_id', `${path}.k`,
      `Section key "${sectionId}" uses the prefix reserved for what a person writes.`,
      'Use a section key that does not begin with "u.".');
  }

  if (!isNonEmptyString(title)) {
    out.error('section.missing_title', `${path}.t`,
      `Legacy section "${sectionId}" has no title.`,
      'Add a non-empty section title.');
  }
  if (!isFiniteNumber(claimedCount)) {
    out.error('section.missing_count', `${path}.n`,
      `Legacy section "${sectionId}" does not declare a finite card count.`,
      'Restore its format-1 card count; format 2 will derive it.');
  }

  return {
    sectionId,
    title: isNonEmptyString(title) ? title : sectionId,
    cardCount: 0,
    claimedCount,
  };
}

function normalizeFigure(raw, path, out) {
  if (!isObject(raw)) {
    out.warning('legacy.figure_invalid', path,
      'This legacy drawing reference is not an object and was not normalized.',
      'Use a drawing object with a non-empty drawing name.');
    return null;
  }
  reportUnknownFields(raw, FIGURE_FIELDS, path, out);
  const figureId = ownValue(raw, 'n', `${path}.n`);
  if (!isNonEmptyString(figureId)) {
    out.warning('legacy.figure_invalid', `${path}.n`,
      'This legacy drawing has no readable name and was not normalized.',
      'Restore the drawing name or remove the drawing reference.');
    return null;
  }
  const rawLabels = ownValue(raw, 'on', `${path}.on`);
  const highlightedLabels = [];
  if (rawLabels !== undefined) {
    if (!Array.isArray(rawLabels)) {
      out.warning('legacy.figure_labels_invalid', `${path}.on`,
        'The highlighted drawing labels are not a list and were omitted.',
        'Use a list of label strings.');
    } else {
      const length = checkedLength(rawLabels, `${path}.on`, out);
      for (let i = 0; i < length; i++) {
        const label = ownValue(rawLabels, String(i), `${path}.on[${i}]`);
        if (isNonEmptyString(label)) highlightedLabels.push(label);
        else out.warning('legacy.figure_label_invalid', `${path}.on[${i}]`,
          'This highlighted drawing label is empty or not text and was omitted.',
          'Use a non-empty label string.');
      }
    }
  }
  return { figureId, highlightedLabels };
}

function normalizedDimensions(raw, path, out) {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || arrayLength(raw, path) !== 2) {
    out.warning('legacy.media_dimensions_invalid', path,
      'Legacy image dimensions are not a two-number list and were omitted.',
      'Use positive numeric width and height values.');
    return null;
  }
  const width = ownValue(raw, '0', `${path}[0]`);
  const height = ownValue(raw, '1', `${path}[1]`);
  if (!isFiniteNumber(width) || width <= 0 || !isFiniteNumber(height) || height <= 0) {
    out.warning('legacy.media_dimensions_invalid', path,
      'Legacy image dimensions are not positive finite numbers and were omitted.',
      'Use positive numeric width and height values.');
    return null;
  }
  return { width, height };
}

function normalizeCard(raw, index, sectionIds, ids, counts, out) {
  const path = `$.cards[${index}]`;
  if (!isObject(raw)) {
    out.error('card.not_object', path, 'This legacy card is not an object.',
      'Replace it with a card object containing its original stable ID.');
    return null;
  }
  reportUnknownFields(raw, CARD_FIELDS, path, out);

  const cardId = ownValue(raw, 'i', `${path}.i`);
  const sectionId = ownValue(raw, 's', `${path}.s`);
  const front = ownValue(raw, 'q', `${path}.q`);
  const back = ownValue(raw, 'a', `${path}.a`);

  if (!isNonEmptyString(cardId)) {
    out.error('card.missing_id', `${path}.i`, 'This legacy card has no stable ID.',
      'Restore its original non-empty card ID so review progress can be matched.');
    return null;
  }
  if (ids.has(cardId)) {
    out.error('card.duplicate_id', `${path}.i`,
      `Two legacy cards share the ID "${cardId}".`,
      'Restore a unique stable ID for every card before importing.');
  }
  ids.add(cardId);

  // The half of the reserved-namespace rule that lives in the reader. Without
  // it, an official card shipped under a prefix somebody's own card already
  // uses would silently inherit that card's review history.
  if (isReservedId(cardId)) {
    out.error('course.reserved_id', `${path}.i`,
      `Card ID "${cardId}" uses the prefix reserved for cards written in the app.`,
      'Give this card an ID that does not begin with "u.".');
  }

  if (!isNonEmptyString(front)) {
    out.error('card.missing_front', `${path}.q`,
      `Legacy card "${cardId}" has no question side.`,
      'Restore its non-empty legacy question.');
  }
  // Format 1 required an answer. Format 2 allows front-only cards, but treating
  // a missing legacy answer as intentional would conceal old-data damage.
  if (!isNonEmptyString(back)) {
    out.error('card.missing_back', `${path}.a`,
      `Legacy card "${cardId}" has no answer side.`,
      'Restore its legacy answer; author intentional front-only cards as format 2.');
  }
  if (!isNonEmptyString(sectionId)) {
    out.error('card.missing_section', `${path}.s`,
      `Legacy card "${cardId}" has no section key.`,
      'Restore the card’s original section key.');
  } else if (!sectionIds.has(sectionId)) {
    out.error('card.unknown_section', `${path}.s`,
      `Legacy card "${cardId}" refers to missing section "${sectionId}".`,
      'Restore that section or correct the card’s section key.');
  } else {
    counts.set(sectionId, (counts.get(sectionId) || 0) + 1);
  }

  const card = {
    cardId,
    sectionId,
    front: isNonEmptyString(front) ? front : '',
    back: isNonEmptyString(back) ? back : '',
  };

  const imageName = ownValue(raw, 'm', `${path}.m`);
  const dimensions = normalizedDimensions(ownValue(raw, 'd', `${path}.d`), `${path}.d`, out);
  if (imageName !== undefined) {
    if (!isNonEmptyString(imageName)) {
      out.warning('legacy.media_source_invalid', `${path}.m`,
        'This legacy image name is empty or not text and was not normalized.',
        'Restore the image filename or remove the image reference.');
    } else {
      const image = {
        side: 'back',
        mediaType: 'image',
        source: `img/${imageName}`,
      };
      if (dimensions) Object.assign(image, dimensions);
      card.media = [image];
    }
  } else if (dimensions) {
    out.warning('legacy.media_dimensions_unused', `${path}.d`,
      'This card declares image dimensions but no image, so the dimensions were omitted.',
      'Restore the image filename or remove the dimensions.');
  }

  const rawFigure = ownValue(raw, 'f', `${path}.f`);
  if (rawFigure !== undefined) {
    const figure = normalizeFigure(rawFigure, `${path}.f`, out);
    if (figure) card.figure = figure;
  }

  const sourceSectionId = ownValue(raw, 'r', `${path}.r`);
  if (sourceSectionId !== undefined) {
    if (isNonEmptyString(sourceSectionId)) {
      card.reference = { sourceSectionId };
    } else {
      out.warning('legacy.reference_invalid', `${path}.r`,
        'This legacy source-section reference is empty or not text and was omitted.',
        'Use a non-empty source section ID or remove the reference.');
    }
  }

  return card;
}

function normalizeGroup(raw, index, sectionIds, grouped, counts, out) {
  const path = `$.groups[${index}]`;
  if (!isObject(raw)) {
    out.error('group.not_object', path, 'This legacy group is not an object.',
      'Replace it with a group object containing a stable key and section list.');
    return null;
  }
  reportUnknownFields(raw, GROUP_FIELDS, path, out);

  const groupId = ownValue(raw, 'k', `${path}.k`);
  const title = ownValue(raw, 't', `${path}.t`);
  const rawSections = ownValue(raw, 's', `${path}.s`);
  const claimedCount = ownValue(raw, 'n', `${path}.n`);

  if (!isNonEmptyString(groupId)) {
    out.error('group.missing_id', `${path}.k`, 'This legacy group has no stable key.',
      'Restore the original non-empty group key.');
    return null;
  }
  if (isReservedId(groupId)) {
    out.error('course.reserved_id', `${path}.k`,
      `Group key "${groupId}" uses the prefix reserved for what a person writes.`,
      'Use a group key that does not begin with "u.".');
  }
  if (!Array.isArray(rawSections)) {
    out.error('group.missing_sections', `${path}.s`,
      `Legacy group "${groupId}" does not contain a section list.`,
      'Add the section keys that belong to this group.');
    return null;
  }

  const sectionIdsInGroup = [];
  let cardCount = 0;
  const length = checkedLength(rawSections, `${path}.s`, out);
  for (let i = 0; i < length; i++) {
    const sectionId = ownValue(rawSections, String(i), `${path}.s[${i}]`);
    if (!isNonEmptyString(sectionId)) {
      out.error('group.invalid_section', `${path}.s[${i}]`,
        `Legacy group "${groupId}" contains an empty or non-text section key.`,
        'Use a non-empty existing section key.');
      continue;
    }
    sectionIdsInGroup.push(sectionId);
    if (!sectionIds.has(sectionId)) {
      out.error('group.unknown_section', `${path}.s[${i}]`,
        `Legacy group "${groupId}" refers to missing section "${sectionId}".`,
        'Restore that section or remove the reference.');
      continue;
    }
    if (grouped.has(sectionId)) {
      out.error('group.duplicate_membership', `${path}.s[${i}]`,
        `Legacy section "${sectionId}" appears in more than one group.`,
        'Keep each section in exactly one group.');
    }
    grouped.add(sectionId);
    cardCount += counts.get(sectionId) || 0;
  }

  if (!isNonEmptyString(title)) {
    out.warning('group.missing_title', `${path}.t`,
      `Legacy group "${groupId}" has no title; its key was used as the title.`,
      'Add a non-empty group title.');
  }
  if (claimedCount !== undefined && (!isFiniteNumber(claimedCount) || claimedCount !== cardCount)) {
    out.error('group.count_mismatch', `${path}.n`,
      `Legacy group "${groupId}" claims ${String(claimedCount)} cards but contains ${cardCount}.`,
      'Restore the correct legacy count; format 2 will derive it.');
  }

  return {
    groupId,
    title: isNonEmptyString(title) ? title : groupId,
    sectionIds: sectionIdsInGroup,
    cardCount,
  };
}

function checkedLength(array, path, out) {
  const length = arrayLength(array, path);
  if (length > ITEM_LIMIT) {
    out.error('legacy.too_many_items', path,
      `This legacy list contains ${length} items, above the compatibility limit of ${ITEM_LIMIT}.`,
      'Split the course into a reasonably sized artifact before importing it.');
    return ITEM_LIMIT;
  }
  return length;
}

/**
 * Project a trusted descriptive Anki build back to the permanent format-1
 * storage shape. Anki fronts/backs have already been rendered and sanitized;
 * storing them as schemaVersion 2 would make boot treat that HTML as authored
 * CommonMark. Keeping this inverse projection beside the format-1 reader makes
 * that compatibility decision explicit and prevents compact keys from leaking
 * back into the importer or builder.
 *
 * This is deliberately not a general format-2 serializer. The representation
 * marker is required so creator-authored CommonMark can never cross it.
 *
 * @param {object} input descriptive buildDeck output
 * @returns {object} format-1 object suitable for IndexedDB/backups
 */
export function projectDescriptiveCourseToLegacy(input) {
  if (!isObject(input)) throw new TypeError('the descriptive Anki course must be an object');
  if (ownValue(input, 'contentRepresentation', '$.contentRepresentation') !== 'sanitized-html') {
    throw new TypeError('only already-sanitized Anki HTML can use the legacy storage projection');
  }

  const title = ownValue(input, 'title', '$.title');
  const rawSections = ownValue(input, 'sections', '$.sections');
  const rawGroups = ownValue(input, 'groups', '$.groups');
  const rawCards = ownValue(input, 'cards', '$.cards');
  const buildFingerprint = ownValue(input, 'buildFingerprint', '$.buildFingerprint');
  if (!isNonEmptyString(title) || !Array.isArray(rawSections)
      || !Array.isArray(rawGroups) || !Array.isArray(rawCards)
      || !isNonEmptyString(buildFingerprint)) {
    throw new TypeError('the descriptive Anki course is incomplete');
  }

  const sections = Array.from(rawSections, (section, index) => {
    if (!isObject(section)) throw new TypeError(`section ${index} is not an object`);
    return {
      k: ownValue(section, 'sectionId', `$.sections[${index}].sectionId`),
      t: ownValue(section, 'title', `$.sections[${index}].title`),
      n: ownValue(section, 'cardCount', `$.sections[${index}].cardCount`),
      o: ownValue(section, 'order', `$.sections[${index}].order`),
    };
  });
  const groups = Array.from(rawGroups, (group, index) => {
    if (!isObject(group)) throw new TypeError(`group ${index} is not an object`);
    const sectionIds = ownValue(group, 'sectionIds', `$.groups[${index}].sectionIds`);
    if (!Array.isArray(sectionIds)) {
      throw new TypeError(`group ${index} has no section list`);
    }
    return {
      k: ownValue(group, 'groupId', `$.groups[${index}].groupId`),
      t: ownValue(group, 'title', `$.groups[${index}].title`),
      s: [...sectionIds],
      n: ownValue(group, 'cardCount', `$.groups[${index}].cardCount`),
    };
  });
  const cards = Array.from(rawCards, (card, index) => {
    if (!isObject(card)) throw new TypeError(`card ${index} is not an object`);
    return {
      i: ownValue(card, 'cardId', `$.cards[${index}].cardId`),
      q: ownValue(card, 'front', `$.cards[${index}].front`),
      a: ownValue(card, 'back', `$.cards[${index}].back`),
      s: ownValue(card, 'sectionId', `$.cards[${index}].sectionId`),
    };
  });

  return {
    format: LEGACY_COURSE_FORMAT,
    name: title,
    sections,
    groups,
    cards,
    build: buildFingerprint,
  };
}

/**
 * Normalize one compact format-1 course into a fresh descriptive format-2
 * runtime object. Legacy cards.json often has no course identity, so callers
 * must supply the surrounding course folder or imported-record ID.
 *
 * @param {unknown} input
 * @param {{courseId?: string}} [options]
 * @returns {{
 *   course: object|null,
 *   diagnostics: Array<object>,
 *   sourceFormat: 'legacy-v1'|'course-v2'|'unsupported'|'unknown'
 * }}
 */
export function normalizeLegacyCourse(input, options = {}) {
  const out = collector();
  let sourceFormat = SOURCE_UNKNOWN;
  try {
    sourceFormat = detectCourseFormat(input);
    if (!isObject(input)) {
      out.error('course.not_object', '$', 'The legacy course is not an object.',
        'Provide the parsed format-1 course object.');
      return { course: null, diagnostics: out.diagnostics, sourceFormat };
    }
    if (sourceFormat !== SOURCE_LEGACY) {
      const what = sourceFormat === SOURCE_V2
        ? 'This is a format-2 course; the legacy adapter cannot validate it.'
        : 'This object is not a supported format-1 course.';
      out.error('format.not_legacy', '$', what,
        sourceFormat === SOURCE_V2
          ? 'Pass it to the format-2 validator.'
          : 'Use a shipped format-1 object or a supported format-2 course.');
      return { course: null, diagnostics: out.diagnostics, sourceFormat };
    }

    reportUnknownFields(input, TOP_LEVEL_FIELDS, '$', out);

    const explicitFormat = ownValue(input, 'format', '$.format');
    if (explicitFormat !== undefined && explicitFormat !== LEGACY_COURSE_FORMAT) {
      out.error('format.unsupported', '$.format',
        `Legacy format ${String(explicitFormat)} is not supported.`,
        `Use format ${LEGACY_COURSE_FORMAT} or omit the marker for an original built-in course.`);
    }

    const contextualId = ownValue(options, 'courseId', 'options.courseId');
    const embeddedId = ownValue(input, 'course', '$.course');
    if (contextualId !== undefined && !isNonEmptyString(contextualId)) {
      out.error('course.invalid_context_id', 'options.courseId',
        'The surrounding course ID is empty or not text.',
        'Supply the exact non-empty folder or imported-record ID.');
    }
    if (embeddedId !== undefined && !isNonEmptyString(embeddedId)) {
      out.error('course.invalid_legacy_id', '$.course',
        'The embedded legacy course ID is empty or not text.',
        'Restore the original non-empty course ID.');
    }
    if (isNonEmptyString(contextualId) && isNonEmptyString(embeddedId)
        && contextualId !== embeddedId) {
      out.error('course.id_mismatch', '$.course',
        `The legacy course ID "${embeddedId}" disagrees with its surrounding ID "${contextualId}".`,
        'Use the original matching ID; changing it would fork review progress.');
    }
    const courseId = isNonEmptyString(contextualId) ? contextualId
      : (isNonEmptyString(embeddedId) ? embeddedId : null);
    if (!courseId) {
      out.error('course.missing_id', '$.course',
        'This legacy object does not carry a course ID.',
        'Supply its exact course-folder or imported-record ID as options.courseId.');
    }

    const rawSections = ownValue(input, 'sections', '$.sections');
    const rawCards = ownValue(input, 'cards', '$.cards');
    const rawGroups = ownValue(input, 'groups', '$.groups');
    if (!Array.isArray(rawSections) || !arrayLength(rawSections, '$.sections')) {
      out.error('course.missing_sections', '$.sections',
        'The legacy course has no section list.',
        'Restore its non-empty format-1 sections list.');
    }
    if (!Array.isArray(rawCards) || !arrayLength(rawCards, '$.cards')) {
      out.error('course.missing_cards', '$.cards',
        'The legacy course has no card list.',
        'Restore its non-empty format-1 cards list.');
    }
    if (rawGroups !== undefined && !Array.isArray(rawGroups)) {
      out.error('course.invalid_groups', '$.groups',
        'The legacy groups field is not a list.',
        'Use a list of groups or omit it.');
    }

    if (!Array.isArray(rawSections) || !Array.isArray(rawCards)
        || (rawGroups !== undefined && !Array.isArray(rawGroups))) {
      return { course: null, diagnostics: out.diagnostics, sourceFormat };
    }

    const sectionIds = new Set();
    const sections = [];
    const sectionLength = checkedLength(rawSections, '$.sections', out);
    for (let i = 0; i < sectionLength; i++) {
      const section = normalizeSection(
        ownValue(rawSections, String(i), `$.sections[${i}]`),
        i, sectionIds, out,
      );
      if (section) sections.push(section);
    }

    const ids = new Set();
    const counts = new Map();
    const cards = [];
    const cardLength = checkedLength(rawCards, '$.cards', out);
    for (let i = 0; i < cardLength; i++) {
      const card = normalizeCard(
        ownValue(rawCards, String(i), `$.cards[${i}]`),
        i, sectionIds, ids, counts, out,
      );
      if (card) cards.push(card);
    }

    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      const realCount = counts.get(section.sectionId) || 0;
      section.cardCount = realCount;
      if (!realCount) {
        out.error('section.empty', `$.sections[${i}]`,
          `Legacy section "${section.sectionId}" contains no cards.`,
          'Restore its cards or remove the empty section.');
      } else if (isFiniteNumber(section.claimedCount) && section.claimedCount !== realCount) {
        out.error('section.count_mismatch', `$.sections[${i}].n`,
          `Legacy section "${section.sectionId}" claims ${section.claimedCount} cards but contains ${realCount}.`,
          'Restore the correct legacy count; format 2 will derive it.');
      }
      delete section.claimedCount;
    }

    const groups = [];
    const grouped = new Set();
    if (Array.isArray(rawGroups)) {
      const groupIds = new Set();
      const groupLength = checkedLength(rawGroups, '$.groups', out);
      for (let i = 0; i < groupLength; i++) {
        const group = normalizeGroup(
          ownValue(rawGroups, String(i), `$.groups[${i}]`),
          i, sectionIds, grouped, counts, out,
        );
        if (!group) continue;
        if (groupIds.has(group.groupId)) {
          out.error('group.duplicate_id', `$.groups[${i}].k`,
            `Two legacy groups share the key "${group.groupId}".`,
            'Give every group a unique stable key.');
        }
        groupIds.add(group.groupId);
        groups.push(group);
      }
      if (groups.length && grouped.size !== sectionIds.size) {
        const missing = sections.map((section) => section.sectionId)
          .filter((sectionId) => !grouped.has(sectionId));
        out.error('group.incomplete_membership', '$.groups',
          `${missing.length} of ${sectionIds.size} legacy sections are in no group.`,
          `Add the missing section${missing.length === 1 ? '' : 's'} to a group: ${missing.join(', ')}.`);
      }
    }

    const title = ownValue(input, 'name', '$.name');
    if (title !== undefined && !isNonEmptyString(title)) {
      out.warning('course.invalid_title', '$.name',
        'The legacy title is empty or not text and was omitted.',
        'Use a non-empty title or omit it.');
    }
    const buildFingerprint = ownValue(input, 'build', '$.build');
    if (buildFingerprint !== undefined && !isNonEmptyString(buildFingerprint)) {
      out.warning('legacy.build_fingerprint_invalid', '$.build',
        'The legacy build fingerprint is empty or not text and was omitted.',
        'Use a non-empty build fingerprint or omit it.');
    }
    const dependencyBuildFingerprint = ownValue(input, 'ds', '$.ds');
    if (dependencyBuildFingerprint !== undefined
        && !isNonEmptyString(dependencyBuildFingerprint)) {
      out.warning('legacy.dependency_fingerprint_invalid', '$.ds',
        'The legacy dependency fingerprint is empty or not text and was omitted.',
        'Use a non-empty dependency fingerprint or omit it.');
    }

    const course = {
      schemaVersion: DESCRIPTIVE_COURSE_FORMAT,
      courseId: courseId || '',
      sections,
      groups,
      cards,
    };
    if (isNonEmptyString(title)) course.title = title;
    if (isNonEmptyString(buildFingerprint)) course.buildFingerprint = buildFingerprint;
    if (isNonEmptyString(dependencyBuildFingerprint)) {
      course.extensions = {
        'keepclub.app/legacy-v1': { dependencyBuildFingerprint },
      };
    }

    const hasErrors = out.diagnostics.some((diagnostic) => diagnostic.severity === 'error');
    return { course: hasErrors ? null : course, diagnostics: out.diagnostics, sourceFormat };
  } catch (error) {
    const path = error instanceof UnsafeInput ? error.path : '$';
    out.error('course.unreadable', path,
      error instanceof UnsafeInput ? error.message : `The legacy course could not be inspected: ${safeMessage(error)}.`,
      'Use ordinary parsed JSON data without accessors, proxies, or unreadable values.');
    return { course: null, diagnostics: out.diagnostics, sourceFormat };
  }
}
