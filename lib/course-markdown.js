/* Public course Markdown boundary.
 *
 * Course format 2 deliberately supports less than all of CommonMark. Parse
 * with the reference implementation, inspect its AST against that contract,
 * render only known nodes, then pass the generated markup through the same
 * sanitizer used by imported cards. No author-supplied HTML is ever trusted.
 */

import { clean, toText } from './html.js';

export const COURSE_MARKDOWN_LIMITS = Object.freeze({
  inputCodePoints: 256 * 1024,
  nestingDepth: 64,
  syntaxNodes: 100000,
});

const DOCS = 'https://docs.keepclub.app/reference/errors/';
const MAX_DIAGNOSTICS = 100;
const unsupportedNames = Object.freeze({
  block_quote: 'block quote',
  code: 'inline code',
  code_block: 'code block',
  custom_block: 'custom block',
  custom_inline: 'custom inline',
  heading: 'heading',
  image: 'Markdown image',
  thematic_break: 'thematic break',
});
const supported = new Set([
  'document',
  'paragraph',
  'text',
  'softbreak',
  'linebreak',
  'emph',
  'strong',
  'list',
  'item',
  'link',
  'html_inline',
  'html_block',
]);
const descriptions = Object.freeze({
  'markdown.too_long': [
    'The Markdown field is longer than 256 KiB.',
    'Split or shorten the field.',
  ],
  'markdown.too_deep': [
    'The Markdown structure is nested more than 64 levels.',
    'Flatten deeply nested lists or formatting.',
  ],
  'markdown.too_complex': [
    'The Markdown field contains more than 100,000 syntax nodes.',
    'Split or simplify the field.',
  ],
  'markdown.unsupported_construct': [
    'The Markdown field uses a construct outside the course format 2 subset.',
    'Use paragraphs, line breaks, emphasis, strong emphasis, lists, or links.',
  ],
  'markdown.unsafe_link': [
    'The Markdown link is not an HTTPS or mailto link.',
    'Use an https: or mailto: destination, or leave the label as plain text.',
  ],
  'markdown.empty': [
    'The Markdown field has no visible content.',
    'Add visible text or omit this optional field.',
  ],
  'markdown.too_many_errors': [
    'The Markdown field has more than 100 errors.',
    'Fix the reported errors, then validate the field again.',
  ],
});

let commonmarkModule;

function loadCommonMark() {
  return commonmarkModule ||= import('./vendor/commonmark-parser-0.31.2.min.js');
}

function codePointLengthOver(source, limit) {
  let count = 0;
  for (const _character of source) {
    if (++count > limit) return true;
  }
  return false;
}

function sourceLocation(node) {
  let current = node;
  while (current && !current.sourcepos) current = current.parent;
  const start = current?.sourcepos?.[0];
  return {
    line: Number.isInteger(start?.[0]) && start[0] > 0 ? start[0] : 1,
    column: Number.isInteger(start?.[1]) && start[1] > 0 ? start[1] : 1,
  };
}

function diagnostic(code, path, node = null, extra = {}) {
  const [message, correction] = descriptions[code];
  return {
    code,
    severity: 'error',
    path,
    ...sourceLocation(node),
    message,
    correction,
    docsUrl: `${DOCS}#${code.replace(/[._]/g, '-')}`,
    ...extra,
  };
}

function pushDiagnostic(diagnostics, item) {
  if (diagnostics.some((entry) => entry.code === 'markdown.too_many_errors')) return;
  if (diagnostics.length < MAX_DIAGNOSTICS) {
    diagnostics.push(item);
    return;
  }
  diagnostics.push(diagnostic('markdown.too_many_errors', item.path, item));
}

function safeLinkDestination(destination) {
  const value = String(destination ?? '').trim();
  if (!value) return null;

  // Do not "repair" invisible characters. Removing one can turn an inert
  // spelling into a live scheme and can also change a legitimate destination.
  if (/[\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200f\u2028-\u202f\ufeff]/u.test(value)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol === 'https:' && parsed.hostname) return value;
  if (parsed.protocol === 'mailto:' && value.slice(value.indexOf(':') + 1)) return value;
  return null;
}

function inspect(ast, path) {
  const diagnostics = [];
  const safeLinks = new WeakMap();
  const walker = ast.walker();
  let event;
  let containers = 0;
  let nodes = 0;
  let fatal = false;

  while ((event = walker.next())) {
    const { node, entering } = event;
    if (entering) {
      nodes++;
      const depth = containers + 1;
      if (nodes > COURSE_MARKDOWN_LIMITS.syntaxNodes) {
        pushDiagnostic(diagnostics, diagnostic('markdown.too_complex', path, node));
        fatal = true;
        break;
      }
      if (depth > COURSE_MARKDOWN_LIMITS.nestingDepth) {
        pushDiagnostic(diagnostics, diagnostic('markdown.too_deep', path, node));
        fatal = true;
        break;
      }

      if (node.type === 'link') {
        const destination = safeLinkDestination(node.destination);
        safeLinks.set(node, destination);
        if (!destination) {
          pushDiagnostic(diagnostics,
            diagnostic('markdown.unsafe_link', path, node, {
              destination: String(node.destination ?? ''),
            }));
        }
      } else if (!supported.has(node.type)) {
        pushDiagnostic(diagnostics,
          diagnostic('markdown.unsupported_construct', path, node, {
            construct: unsupportedNames[node.type] || node.type,
          }));
      }
      if (node.isContainer) containers++;
    } else if (node.isContainer) {
      containers--;
    }
  }

  return { diagnostics, fatal, safeLinks };
}

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function blockLiteral(value) {
  return `<p>${escapeHtml(value).replace(/\r\n?|\n/g, '<br>')}</p>\n`;
}

function isTightListParagraph(node) {
  const list = node.parent?.parent;
  return list?.type === 'list' && list.listTight;
}

function renderAst(ast, safeLinks) {
  const output = [];
  const walker = ast.walker();
  let event;

  while ((event = walker.next())) {
    const { node, entering } = event;
    switch (node.type) {
      case 'document':
        break;
      case 'paragraph':
        if (!isTightListParagraph(node)) output.push(entering ? '<p>' : '</p>\n');
        break;
      case 'text':
        if (entering) output.push(escapeHtml(node.literal));
        break;
      case 'softbreak':
        if (entering) output.push('\n');
        break;
      case 'linebreak':
        if (entering) output.push('<br>\n');
        break;
      case 'emph':
        output.push(entering ? '<em>' : '</em>');
        break;
      case 'strong':
        output.push(entering ? '<strong>' : '</strong>');
        break;
      case 'list':
        output.push(entering
          ? (node.listType === 'bullet' ? '<ul>\n' : '<ol>\n')
          : (node.listType === 'bullet' ? '</ul>\n' : '</ol>\n'));
        break;
      case 'item':
        output.push(entering ? '<li>' : '</li>\n');
        break;
      case 'link': {
        const destination = safeLinks.get(node);
        if (destination) {
          output.push(entering
            ? `<a href="${escapeHtml(destination).replace(/"/g, '&quot;')}">`
            : '</a>');
        }
        break;
      }
      case 'html_inline':
        if (entering) output.push(escapeHtml(node.literal));
        break;
      case 'html_block':
        if (entering) output.push(blockLiteral(node.literal));
        break;
      case 'heading':
        output.push(entering ? '<p>' : '</p>\n');
        break;
      case 'code':
        if (entering) output.push(escapeHtml(node.literal));
        break;
      case 'code_block':
        if (entering) output.push(blockLiteral(node.literal));
        break;
      case 'thematic_break':
        if (entering) output.push('<p>---</p>\n');
        break;
      case 'image':
      case 'block_quote':
      case 'custom_inline':
      case 'custom_block':
        // Their children remain visible, but unsupported markup is never
        // emitted. The diagnostic blocks import rather than silently changing
        // the author's course.
        break;
      default:
        if (entering && node.literal) output.push(escapeHtml(node.literal));
    }
  }

  return output.join('');
}

/**
 * Render one public course Markdown field.
 *
 * Empty fields are accepted by default so optional `back`, caption, and
 * transcript values can normalize away. Pass `{ allowEmpty: false }` where
 * the caller requires independently visible text.
 *
 * @param {string} source
 * @param {{path?: string, allowEmpty?: boolean}} options
 * @returns {Promise<{html: string, text: string, diagnostics: object[]}>}
 */
export async function renderCourseMarkdown(source, options = {}) {
  if (typeof source !== 'string') {
    throw new TypeError('course Markdown input must be a string');
  }
  const path = typeof options.path === 'string' ? options.path : '';
  const allowEmpty = options.allowEmpty !== false;

  if (codePointLengthOver(source, COURSE_MARKDOWN_LIMITS.inputCodePoints)) {
    return {
      html: '',
      text: '',
      diagnostics: [diagnostic('markdown.too_long', path)],
    };
  }
  if (!source.trim()) {
    return {
      html: '',
      text: '',
      diagnostics: allowEmpty ? [] : [diagnostic('markdown.empty', path)],
    };
  }

  const { default: Parser } = await loadCommonMark();
  const ast = new Parser().parse(source);
  const inspected = inspect(ast, path);
  if (inspected.fatal) {
    return { html: '', text: '', diagnostics: inspected.diagnostics };
  }

  const html = clean(renderAst(ast, inspected.safeLinks)).html;
  const text = toText(html);
  if (!text && !allowEmpty) {
    pushDiagnostic(inspected.diagnostics, diagnostic('markdown.empty', path, ast));
  }
  return { html, text, diagnostics: inspected.diagnostics };
}
