/* Strict YAML 1.2 input boundary for public keep club courses.
 *
 * Parsing is deliberately separate from course schema/semantic validation.
 * This module answers only: is this one bounded, inert YAML document, and if
 * so what plain JavaScript value did it contain?
 */

export const COURSE_YAML_LIMITS = Object.freeze({
  inputBytes: 5 * 1024 * 1024,
  nestingDepth: 24,
  scalarBytes: 1024 * 1024,
  collectionItems: 50000,
  totalNodes: 500000,
});

const DOCS = 'https://docs.keepclub.app/reference/errors/';
const MAX_DIAGNOSTICS = 100;
const SAFE_STANDARD_TAGS = new Set([
  'tag:yaml.org,2002:str',
  'tag:yaml.org,2002:map',
  'tag:yaml.org,2002:seq',
  'tag:yaml.org,2002:null',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:float',
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });
let yamlModule;

function loadYaml() {
  return yamlModule ||= import('./vendor/yaml-2.9.0.min.js');
}

const descriptions = {
  'document.invalid_yaml': [
    'The course is not valid YAML 1.2.',
    'Fix the YAML syntax at the reported location.',
  ],
  'document.multiple_documents': [
    'The file contains more than one YAML document.',
    'Keep exactly one course document in course.keep.yml.',
  ],
  'document.duplicate_key': [
    'A YAML mapping repeats a key.',
    'Remove one copy; keep club never chooses which duplicate wins.',
  ],
  'document.disallowed_tag': [
    'The file uses a custom YAML tag.',
    'Use plain YAML strings, numbers, booleans, nulls, lists, and mappings.',
  ],
  'document.disallowed_anchor': [
    'The file uses an anchor, alias, or merge key.',
    'Write the value explicitly instead of sharing it through YAML references.',
  ],
  'document.unsupported_yaml_version': [
    'The file selects a YAML version other than 1.2.',
    'Remove the version directive or declare %YAML 1.2.',
  ],
  'document.non_plain_value': [
    'The YAML value cannot be represented safely as plain course data.',
    'Use string-keyed mappings and finite, safely representable numbers.',
  ],
  'document.too_many_errors': [
    'The YAML has more than 100 parser or safety errors.',
    'Fix the reported errors, then validate the file again.',
  ],
  'limit.input_bytes': [
    'course.keep.yml is larger than 5 MiB.',
    'Split the course or reduce its text before importing it.',
  ],
  'limit.nesting': [
    'The YAML is nested more than 24 collection levels.',
    'Flatten the nested data.',
  ],
  'limit.scalar_length': [
    'A YAML scalar is larger than 1 MiB.',
    'Split or reduce the value.',
  ],
  'limit.collection_items': [
    'A YAML list or mapping has more than 50,000 entries.',
    'Split the collection or reduce the course.',
  ],
  'limit.node_count': [
    'The YAML document contains more than 500,000 nodes.',
    'Split or simplify the course.',
  ],
};

function location(lineCounter, offset = 0) {
  const pos = lineCounter?.linePos(Math.max(0, Number(offset) || 0));
  return { line: pos?.line || 1, column: pos?.col || 1 };
}

function diagnostic(code, lineCounter, offset, path = '') {
  const [message, correction] = descriptions[code];
  return {
    code,
    severity: 'error',
    path,
    ...location(lineCounter, offset),
    message,
    correction,
    docsUrl: `${DOCS}#${code.replace(/[._]/g, '-')}`,
  };
}

function offsetOf(node) {
  return Array.isArray(node?.range) ? node.range[0] : 0;
}

function keyPath(base, key) {
  if (typeof key !== 'string') return base ? `${base}.<key>` : '<key>';
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) return base ? `${base}.${key}` : key;
  return `${base || ''}[${JSON.stringify(key)}]`;
}

function pushOnce(list, seen, item) {
  const key = `${item.code}\0${item.line}\0${item.column}\0${item.path}`;
  if (seen.has(key) || seen.has('document.too_many_errors')) return;
  seen.add(key);
  if (list.length < MAX_DIAGNOSTICS) {
    list.push(item);
    return;
  }
  seen.add('document.too_many_errors');
  const [message, correction] = descriptions['document.too_many_errors'];
  list.push({
    ...item,
    code: 'document.too_many_errors',
    path: '',
    message,
    correction,
    docsUrl: `${DOCS}#document-too-many-errors`,
  });
}

async function readInput(input) {
  if (typeof input === 'string') {
    const bytes = textEncoder.encode(input).byteLength;
    return { bytes, text: bytes <= COURSE_YAML_LIMITS.inputBytes ? input : null };
  }

  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > COURSE_YAML_LIMITS.inputBytes) return { bytes: input.size, text: null };
    const bytes = new Uint8Array(await input.arrayBuffer());
    return { bytes: bytes.byteLength, text: textDecoder.decode(bytes) };
  }

  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError('course YAML input must be a string, Blob, ArrayBuffer, or typed array');
  }
  if (bytes.byteLength > COURSE_YAML_LIMITS.inputBytes) {
    return { bytes: bytes.byteLength, text: null };
  }
  return { bytes: bytes.byteLength, text: textDecoder.decode(bytes) };
}

function parserDiagnostic(error, lineCounter) {
  const code = error?.code === 'DUPLICATE_KEY'
    ? 'document.duplicate_key'
    : error?.code === 'TAG_RESOLVE_FAILED'
      ? 'document.disallowed_tag'
      : 'document.invalid_yaml';
  return diagnostic(code, lineCounter, error?.pos?.[0] || 0);
}

/* A full ranged YAML document is intentionally built after this pass. Count
 * scalar, pair, collection, and sequence indicators with yaml's own streaming
 * lexer first, so a token-dense input crosses the node budget before the
 * composer allocates hundreds of thousands of AST objects. The exact AST walk
 * below remains authoritative for structures this conservative estimate does
 * not see (notably nested block mappings). */
function exceedsPreparseNodeBudget(YAML, source) {
  let estimate = 0;
  for (const token of new YAML.Lexer().lex(source)) {
    if (token === '\x1f' || token === ':' || token === '['
        || token === '{' || token === '-') {
      if (++estimate > COURSE_YAML_LIMITS.totalNodes) return true;
    }
  }
  return false;
}

function inspectDocument(YAML, doc, lineCounter, diagnostics, seen) {
  const version = doc?.directives?.yaml?.version;
  if (version && version !== '1.2') {
    pushOnce(diagnostics, seen,
      diagnostic('document.unsupported_yaml_version', lineCounter, 0));
  }

  for (const error of doc.errors || []) {
    pushOnce(diagnostics, seen, parserDiagnostic(error, lineCounter));
  }
  for (const warning of doc.warnings || []) {
    if (warning?.code === 'TAG_RESOLVE_FAILED') continue; // AST walk adds path
    pushOnce(diagnostics, seen, parserDiagnostic(warning, lineCounter));
  }

  if (!doc.contents) return;
  let nodeCount = 0;
  const stack = [{ node: doc.contents, path: '', collectionDepth: 1 }];

  while (stack.length) {
    const { node, path, collectionDepth } = stack.pop();
    if (!node) continue;
    nodeCount++;
    if (nodeCount > COURSE_YAML_LIMITS.totalNodes) {
      pushOnce(diagnostics, seen,
        diagnostic('limit.node_count', lineCounter, offsetOf(node), path));
      break;
    }

    if (node.anchor) {
      pushOnce(diagnostics, seen,
        diagnostic('document.disallowed_anchor', lineCounter, offsetOf(node), path));
    }
    if (node.tag && !SAFE_STANDARD_TAGS.has(String(node.tag))) {
      pushOnce(diagnostics, seen,
        diagnostic('document.disallowed_tag', lineCounter, offsetOf(node), path));
    }
    if (YAML.isAlias(node)) {
      pushOnce(diagnostics, seen,
        diagnostic('document.disallowed_anchor', lineCounter, offsetOf(node), path));
      continue;
    }

    if (YAML.isScalar(node)) {
      const value = node.value;
      if (typeof value === 'string'
          && textEncoder.encode(value).byteLength > COURSE_YAML_LIMITS.scalarBytes) {
        pushOnce(diagnostics, seen,
          diagnostic('limit.scalar_length', lineCounter, offsetOf(node), path));
      } else if (typeof value === 'number'
          && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
        pushOnce(diagnostics, seen,
          diagnostic('document.non_plain_value', lineCounter, offsetOf(node), path));
      } else if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) {
        pushOnce(diagnostics, seen,
          diagnostic('document.non_plain_value', lineCounter, offsetOf(node), path));
      }
      continue;
    }

    if (YAML.isMap(node) || YAML.isSeq(node)) {
      if (collectionDepth > COURSE_YAML_LIMITS.nestingDepth) {
        pushOnce(diagnostics, seen,
          diagnostic('limit.nesting', lineCounter, offsetOf(node), path));
        continue;
      }
      if (node.items.length > COURSE_YAML_LIMITS.collectionItems) {
        pushOnce(diagnostics, seen,
          diagnostic('limit.collection_items', lineCounter, offsetOf(node), path));
        continue;
      }
    }

    if (YAML.isMap(node)) {
      for (let index = node.items.length - 1; index >= 0; index--) {
        const pair = node.items[index];
        nodeCount++;
        const key = YAML.isScalar(pair.key) ? pair.key.value : undefined;
        const childPath = keyPath(path, key);
        if (key === '<<') {
          pushOnce(diagnostics, seen,
            diagnostic('document.disallowed_anchor', lineCounter, offsetOf(pair.key), childPath));
        }
        if (typeof key !== 'string') {
          pushOnce(diagnostics, seen,
            diagnostic('document.non_plain_value', lineCounter, offsetOf(pair.key), childPath));
        }
        stack.push({ node: pair.key, path: childPath, collectionDepth });
        stack.push({
          node: pair.value,
          path: childPath,
          collectionDepth: collectionDepth + (YAML.isMap(pair.value) || YAML.isSeq(pair.value) ? 1 : 0),
        });
      }
    } else if (YAML.isSeq(node)) {
      for (let index = node.items.length - 1; index >= 0; index--) {
        const child = node.items[index];
        stack.push({
          node: child,
          path: `${path}[${index}]`,
          collectionDepth: collectionDepth + (YAML.isMap(child) || YAML.isSeq(child) ? 1 : 0),
        });
      }
    }
  }
}

/**
 * Parse one bounded, inert YAML 1.2 document.
 *
 * @param {string|Blob|ArrayBuffer|ArrayBufferView} input
 * @returns {Promise<{value: unknown|null, diagnostics: object[]}>}
 */
export async function parseCourseYaml(input) {
  let source;
  try {
    source = await readInput(input);
  } catch {
    return {
      value: null,
      diagnostics: [diagnostic('document.invalid_yaml', null, 0)],
    };
  }

  if (source.bytes > COURSE_YAML_LIMITS.inputBytes) {
    return {
      value: null,
      diagnostics: [diagnostic('limit.input_bytes', null, 0)],
    };
  }

  let YAML;
  try {
    YAML = await loadYaml();
  } catch {
    return {
      value: null,
      diagnostics: [diagnostic('document.invalid_yaml', null, 0)],
    };
  }
  const lineCounter = new YAML.LineCounter();
  let documents;
  try {
    if (exceedsPreparseNodeBudget(YAML, source.text)) {
      return {
        value: null,
        diagnostics: [diagnostic('limit.node_count', lineCounter, 0)],
      };
    }
    documents = YAML.parseAllDocuments(source.text, {
      version: '1.2',
      strict: true,
      uniqueKeys: true,
      merge: false,
      prettyErrors: false,
      lineCounter,
    });
  } catch {
    return {
      value: null,
      diagnostics: [diagnostic('document.invalid_yaml', lineCounter, 0)],
    };
  }

  const diagnostics = [];
  const seen = new Set();
  if (documents.length === 0) {
    pushOnce(diagnostics, seen,
      diagnostic('document.invalid_yaml', lineCounter, 0));
  } else if (documents.length > 1) {
    const offset = documents[1]?.contents ? offsetOf(documents[1].contents) : 0;
    pushOnce(diagnostics, seen,
      diagnostic('document.multiple_documents', lineCounter, offset));
  }
  for (const doc of documents) {
    inspectDocument(YAML, doc, lineCounter, diagnostics, seen);
  }

  if (diagnostics.length || documents.length !== 1) {
    return { value: null, diagnostics };
  }

  try {
    const value = documents[0].toJS({ mapAsMap: false, maxAliasCount: 0 });
    return { value, diagnostics: [] };
  } catch {
    return {
      value: null,
      diagnostics: [diagnostic('document.non_plain_value', lineCounter, 0)],
    };
  }
}
