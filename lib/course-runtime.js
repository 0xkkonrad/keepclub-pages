/*
 * Async course boundary for consumers that render card text as HTML.
 *
 * `readCourse()` deliberately leaves format-2 CommonMark authored and inert.
 * This layer renders and sanitizes it once, after validation, while legacy
 * format-1 content passes through unchanged because the adapter has already
 * sanitized it.
 */

import { readCourse } from './course.js';
import { renderCourseMarkdown } from './course-markdown.js';

const MAX_DIAGNOSTICS = 100;

function addDiagnostics(target, additions) {
  if (target.some((item) => item.code === 'document.too_many_errors'
      || item.code === 'markdown.too_many_errors')) return;
  for (const item of additions) {
    if (target.length < MAX_DIAGNOSTICS) {
      target.push(item);
      continue;
    }
    target.push({
      code: 'document.too_many_errors',
      severity: 'error',
      path: '',
      message: 'More than 100 validation errors exist.',
      correction: 'Fix the reported set, then validate the course again.',
      docsUrl: 'https://keepclub.app/docs/reference/errors/#document-too-many-errors',
    });
    return;
  }
}

/**
 * Validate and prepare one parsed course for safe runtime HTML consumption.
 *
 * @param {unknown} input already-parsed JSON/YAML data
 * @param {{courseId?: string}} [options] legacy identity context
 * @returns {Promise<ReturnType<typeof readCourse>>}
 */
export async function readCourseForRuntime(input, options = {}) {
  const result = readCourse(input, options);
  if (!result.course || result.contentRepresentation !== 'authored-commonmark') {
    return result;
  }

  const diagnostics = [...result.diagnostics];
  const course = { ...result.course };
  if (typeof course.description === 'string') {
    const rendered = await renderCourseMarkdown(course.description, {
      path: '$.description',
    });
    course.description = rendered.html;
    addDiagnostics(diagnostics, rendered.diagnostics);
  }
  for (const collection of ['sections', 'groups']) {
    course[collection] = [];
    for (let index = 0; index < result.course[collection].length; index++) {
      const source = result.course[collection][index];
      const item = { ...source };
      if (typeof item.description === 'string') {
        const rendered = await renderCourseMarkdown(item.description, {
          path: `$.${collection}[${index}].description`,
        });
        item.description = rendered.html;
        addDiagnostics(diagnostics, rendered.diagnostics);
      }
      course[collection].push(item);
    }
  }
  const cards = [];
  for (let index = 0; index < result.course.cards.length; index++) {
    const source = result.course.cards[index];
    const card = { ...source };
    for (const side of ['front', 'back']) {
      if (typeof source[side] !== 'string') continue;
      const rendered = await renderCourseMarkdown(source[side], {
        path: `$.cards[${index}].${side}`,
      });
      card[side] = rendered.html;
      addDiagnostics(diagnostics, rendered.diagnostics);
    }
    if (Array.isArray(source.media)) {
      card.media = [];
      for (let mediaIndex = 0; mediaIndex < source.media.length; mediaIndex++) {
        const attachment = { ...source.media[mediaIndex] };
        for (const field of ['caption', 'transcript']) {
          if (typeof attachment[field] !== 'string') continue;
          const rendered = await renderCourseMarkdown(attachment[field], {
            path: `$.cards[${index}].media[${mediaIndex}].${field}`,
          });
          attachment[field] = rendered.html;
          addDiagnostics(diagnostics, rendered.diagnostics);
        }
        card.media.push(attachment);
      }
    }
    cards.push(card);
    if (diagnostics.some((item) =>
      item.code === 'document.too_many_errors'
        || item.code === 'markdown.too_many_errors')) break;
  }

  const failed = diagnostics.some((item) => item.severity === 'error');
  return {
    ...result,
    course: failed ? null : { ...course, cards },
    diagnostics,
    contentRepresentation: 'sanitized-html',
  };
}
