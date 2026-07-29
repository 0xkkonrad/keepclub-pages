/*
 * Compatibility wrapper for callers that still ask whether a shipped
 * format-1 deck is readable.
 *
 * The compact vocabulary belongs only to legacy-course.js. Keeping a second
 * hand-written validator here made every format rule exist twice and left 39
 * compact production accesses after the runtime migration. New public courses
 * go through course.js/course-runtime.js; this wrapper can disappear once the
 * built-in source gate calls the adapter directly.
 */

import { LEGACY_COURSE_FORMAT, normalizeLegacyCourse } from './legacy-course.js';

export const DECK_FORMAT = LEGACY_COURSE_FORMAT;

/**
 * @param {unknown} deck
 * @returns {{ok: boolean, errors: string[], format: number}}
 */
export function validateDeck(deck) {
  let courseId = 'validation-course';
  try {
    const descriptor = deck && Object.getOwnPropertyDescriptor(deck, 'course');
    if (descriptor && Object.hasOwn(descriptor, 'value')
        && typeof descriptor.value === 'string' && descriptor.value) {
      courseId = descriptor.value;
    }
  } catch { /* the adapter reports hostile input without throwing */ }
  const result = normalizeLegacyCourse(deck, { courseId });
  const errors = result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);
  return {
    ok: !!result.course && errors.length === 0,
    errors,
    format: DECK_FORMAT,
  };
}
