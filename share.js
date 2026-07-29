/* Local, privacy-preserving achievement cards for keep club.
 *
 * This is a classic script because the shell is deliberately usable without a
 * bundler.  Callers pass a small display model; this file never reads progress,
 * storage, Sync, cards, or course files.  That boundary is intentional: a
 * share card cannot accidentally serialize state it has never been given.
 */
(function (root) {
  'use strict';

  const BRAND = 'keep club';
  const DEFAULT_BASE = 'https://keepclub.app/';
  const WIDTH = 1080;
  const HEIGHT = 1350;
  const COURSE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const HEX = /^#[0-9a-f]{6}$/i;
  const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZzEe0-9.,+\-\s]+$/;

  function text(value, limit, fallback) {
    if (value === undefined || value === null) return fallback || '';
    let clean = String(value)
      .normalize('NFC')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return fallback || '';
    if (clean.length > limit) clean = clean.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
    return clean;
  }

  function xml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function colour(value, fallback) {
    const candidate = String(value || '').trim();
    return HEX.test(candidate) ? candidate.toLowerCase() : fallback;
  }

  function graphic(value, fallbackViewBox) {
    const source = typeof value === 'string' ? { path: value } : value;
    if (!source || typeof source !== 'object') return null;
    const d = String(source.path || '').trim();
    if (!d || d.length > 50000 || !PATH_DATA.test(d)) return null;

    const raw = String(source.viewBox || fallbackViewBox || '0 0 32 32').trim();
    const parts = raw.split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)
        || parts[2] <= 0 || parts[3] <= 0) return null;
    return { path: d, viewBox: parts.join(' ') };
  }

  function safeCourse(value) {
    if (!value || value.kind !== 'built-in') return null;
    const id = text(value.id, 64);
    if (!COURSE_ID.test(id)) return null;
    return {
      kind: 'built-in',
      id,
      title: text(value.title, 72),
      accent: colour(value.accent, ''),
      art: graphic(value.art || value.artPath, value.artViewBox),
    };
  }

  /**
   * Reduce a caller-owned object to the fields the renderer understands.
   * Unknown properties—including URLs and storage-shaped metadata—are dropped.
   */
  function normalizeModel(input) {
    const source = input && typeof input === 'object' ? input : {};
    const course = safeCourse(source.course);
    return {
      version: 1,
      brand: BRAND,
      label: text(source.label || source.eyebrow, 48, 'member achievement'),
      title: text(source.title, 88, 'A memory worth keeping'),
      body: text(source.body, 220),
      stat: text(source.stat, 48),
      statLabel: text(source.statLabel, 56),
      cta: text(source.cta, 90, 'membership pays in memories.'),
      accent: colour(source.accent || (course && course.accent), '#e26443'),
      course,
      tower: graphic(source.tower || source.towerPath, source.towerViewBox),
    };
  }

  function baseUrl(value) {
    let parsed;
    try {
      parsed = new URL(value || (root.location && root.location.href) || DEFAULT_BASE);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
    } catch (_) {
      parsed = new URL(DEFAULT_BASE);
    }
    const clean = new URL('./', parsed);
    clean.username = '';
    clean.password = '';
    clean.search = '';
    clean.hash = '';
    return clean;
  }

  /**
   * Share URLs carry exactly one optional datum: a validated built-in course
   * id. Imported decks and invalid course models always point to the app root.
   */
  function shareUrl(input, from) {
    const model = normalizeModel(input);
    const url = baseUrl(from);
    if (model.course) url.searchParams.set('course', model.course.id);
    return url.href;
  }

  function rgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  function mixed(hex, target, amount) {
    const a = rgb(hex);
    const b = rgb(target);
    return '#' + a.map((n, i) =>
      Math.round(n + (b[i] - n) * amount).toString(16).padStart(2, '0')).join('');
  }

  function wrap(value, width, lines) {
    const words = text(value, 500).split(' ').filter(Boolean);
    const out = [];
    let line = '';
    for (const word of words) {
      const next = line ? line + ' ' + word : word;
      if (next.length <= width || !line) {
        line = next;
      } else {
        out.push(line);
        line = word;
        if (out.length === lines) break;
      }
    }
    if (out.length < lines && line) out.push(line);
    if (out.length === lines && words.join(' ').length > out.join(' ').length) {
      out[lines - 1] = out[lines - 1].replace(/[.,;:!?\s]*$/, '') + '…';
    }
    return out;
  }

  function tspans(lines, x, y, step) {
    return lines.map((line, index) =>
      `<tspan x="${x}" y="${y + index * step}">${xml(line)}</tspan>`).join('');
  }

  function pathArt(item, x, y, width, height, ink, opacity) {
    if (!item) return '';
    return `<svg x="${x}" y="${y}" width="${width}" height="${height}" `
      + `viewBox="${xml(item.viewBox)}" preserveAspectRatio="xMidYMid meet" `
      + `fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" `
      + `stroke-linejoin="round" overflow="visible" aria-hidden="true">`
      + `<path d="${xml(item.path)}" opacity="${opacity}"/></svg>`;
  }

  /**
   * Deterministic SVG source. Text is escaped and path data is accepted only
   * through the restricted SVG-path grammar above.
   */
  function renderSvg(input, options) {
    const model = normalizeModel(input);
    const opts = options || {};
    const width = Number.isFinite(opts.width) && opts.width >= 320
      ? Math.round(opts.width) : WIDTH;
    const height = Number.isFinite(opts.height) && opts.height >= 400
      ? Math.round(opts.height) : HEIGHT;
    const scaleX = width / WIDTH;
    const scaleY = height / HEIGHT;
    const accent = model.accent;
    const accentLight = mixed(accent, '#ffffff', 0.76);
    const accentDark = mixed(accent, '#172521', 0.48);
    const title = wrap(model.title, 22, 3);
    const body = wrap(model.body, 42, 3);
    const label = model.label.toUpperCase();
    const tower = pathArt(model.tower, 784, 88, 184, 184, '#17332c', 1);
    const courseArt = model.course
      ? pathArt(model.course.art, 690, 790, 275, 275, accentDark, 0.18) : '';
    const course = model.course && model.course.title
      ? `<text x="110" y="1120" font-size="31" font-weight="650" `
        + `fill="#3d524b">${xml(model.course.title)}</text>` : '';
    const printedUrl = model.course && model.course.id.length <= 32
      ? `keepclub.app/?course=${model.course.id}` : 'keepclub.app';
    const stat = model.stat
      ? `<text x="110" y="835" font-size="112" font-weight="800" `
        + `letter-spacing="-4" fill="#17332c">${xml(model.stat)}</text>`
        + (model.statLabel
          ? `<text x="114" y="892" font-size="31" font-weight="650" `
            + `fill="#53665f">${xml(model.statLabel)}</text>` : '')
      : '';
    const bodyBlock = body.length
      ? `<text font-size="36" font-weight="500" fill="#40534d">`
        + tspans(body, 114, 650, 49) + '</text>' : '';

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
      + `viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" `
      + `aria-label="${xml(model.title)}" font-family="&quot;DM Mono&quot;, `
      + `ui-monospace, &quot;SFMono-Regular&quot;, Menlo, Consolas, monospace">`
      + `<rect width="${WIDTH}" height="${HEIGHT}" fill="#f7f3e9"/>`
      + `<path d="M0 0H1080V350C864 395 714 279 500 330C293 379 151 430 0 388Z" `
      + `fill="${accentLight}"/>`
      + `<circle cx="946" cy="390" r="282" fill="${accent}" opacity=".08"/>`
      + `<circle cx="934" cy="380" r="211" fill="none" stroke="${accent}" `
      + `stroke-width="3" opacity=".18"/>`
      + `<rect x="56" y="54" width="968" height="1242" rx="50" fill="none" `
      + `stroke="${accentDark}" stroke-width="3" opacity=".28"/>`
      + `<text x="110" y="146" font-size="30" font-weight="800" letter-spacing="5" `
      + `fill="${accentDark}">${xml(label)}</text>`
      + (tower || `<g transform="translate(824 105)" fill="${accentDark}">`
        + '<rect x="0" y="75" width="118" height="76" rx="6"/>'
        + '<rect x="9" y="34" width="24" height="55"/><rect x="47" y="15" width="24" height="74"/>'
        + '<rect x="85" y="45" width="24" height="44"/><rect x="50" y="105" width="24" height="46"/>'
        + '</g>')
      + `<text font-size="78" font-weight="850" letter-spacing="-2.5" fill="#17332c">`
      + tspans(title, 110, 395, 91) + '</text>'
      + bodyBlock + stat + courseArt + course
      + `<line x1="110" x2="970" y1="1176" y2="1176" stroke="${accentDark}" `
      + `stroke-width="2" opacity=".22"/>`
      + `<text x="110" y="1238" font-size="30" font-weight="650" `
      + `fill="#53665f">${xml(model.cta)}</text>`
      + `<text x="970" y="1238" text-anchor="end" font-size="32" font-weight="850" `
      + `fill="#17332c">${BRAND}</text>`
      + `<text x="970" y="1271" text-anchor="end" font-size="22" font-weight="600" `
      + `letter-spacing="1" fill="#687972">${xml(printedUrl)}</text>`
      + `<metadata>keep club achievement card ${scaleX.toFixed(4)} ${scaleY.toFixed(4)}</metadata>`
      + '</svg>';
  }

  function safeFilename(input, extension) {
    const model = normalizeModel(input);
    const stem = model.title
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 54)
      .replace(/-+$/g, '') || 'achievement';
    const ext = extension === 'svg' ? 'svg' : 'png';
    return `keep-club-${stem}.${ext}`;
  }

  function fileFrom(blob, name, FileCtor) {
    const Constructor = FileCtor || root.File;
    if (typeof Constructor === 'function') {
      return new Constructor([blob], name, { type: blob.type, lastModified: 0 });
    }
    // Blob is sufficient for download and clipboard. Older WebViews without
    // File also cannot use the files member of Web Share.
    return null;
  }

  async function rasterize(svg, width, height, options) {
    const opts = options || {};
    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    if (typeof opts.rasterizer === 'function') {
      const result = await opts.rasterizer(svg, width, height);
      if (result && /^image\/png(?:$|;)/.test(result.type || '')) return result;
      throw new Error('rasterizer did not return a PNG Blob');
    }

    const doc = opts.document || root.document;
    const URLApi = opts.urlApi || root.URL;
    const ImageCtor = opts.Image || root.Image;
    if (!doc || typeof doc.createElement !== 'function' || !URLApi
        || typeof URLApi.createObjectURL !== 'function' || typeof ImageCtor !== 'function') {
      return null;
    }

    const objectUrl = URLApi.createObjectURL(svgBlob);
    try {
      const image = await new Promise((resolve, reject) => {
        const candidate = new ImageCtor();
        candidate.onload = () => resolve(candidate);
        candidate.onerror = () => reject(new Error('card image could not be decoded'));
        candidate.src = objectUrl;
      });
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext && canvas.getContext('2d');
      if (!context || typeof canvas.toBlob !== 'function') return null;
      context.drawImage(image, 0, 0, width, height);
      return await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/png', 0.94));
    } finally {
      URLApi.revokeObjectURL(objectUrl);
    }
  }

  /**
   * Produce PNG where canvas is available and a shareable SVG everywhere else.
   */
  async function createAsset(input, options) {
    const model = normalizeModel(input);
    const opts = options || {};
    const width = Number.isFinite(opts.width) && opts.width >= 320
      ? Math.round(opts.width) : WIDTH;
    const height = Number.isFinite(opts.height) && opts.height >= 400
      ? Math.round(opts.height) : HEIGHT;
    const svg = renderSvg(model, { width, height });
    let blob = null;
    try {
      blob = await rasterize(svg, width, height, opts);
    } catch (_) {
      // A malformed platform canvas or a memory-constrained WebView should
      // still get the vector card rather than losing the share moment.
    }
    const format = blob ? 'png' : 'svg';
    if (!blob) blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const filename = safeFilename(model, format);
    return {
      blob,
      file: fileFrom(blob, filename, opts.File),
      filename,
      format,
      width,
      height,
      svg,
    };
  }

  function isAbort(error) {
    return !!error && (error.name === 'AbortError' || error.code === 20);
  }

  function shareText(model) {
    return [model.title, model.stat && model.statLabel
      ? `${model.stat} ${model.statLabel}` : model.stat, model.body]
      .filter(Boolean).join('\n');
  }

  async function copyText(value, navigatorObject, documentObject) {
    if (navigatorObject && navigatorObject.clipboard
        && typeof navigatorObject.clipboard.writeText === 'function') {
      await navigatorObject.clipboard.writeText(value);
      return true;
    }
    if (!documentObject || typeof documentObject.createElement !== 'function') return false;
    const field = documentObject.createElement('textarea');
    field.value = value;
    field.readOnly = true;
    if (field.style) {
      field.style.position = 'fixed';
      field.style.opacity = '0';
    }
    documentObject.body.appendChild(field);
    field.select();
    const copied = !!(documentObject.execCommand && documentObject.execCommand('copy'));
    field.remove();
    return copied;
  }

  function download(asset, documentObject, URLApi) {
    if (!documentObject || typeof documentObject.createElement !== 'function'
        || !documentObject.body || !URLApi
        || typeof URLApi.createObjectURL !== 'function') return false;
    const href = URLApi.createObjectURL(asset.blob);
    try {
      const anchor = documentObject.createElement('a');
      anchor.href = href;
      anchor.download = asset.filename;
      anchor.rel = 'noopener';
      documentObject.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return true;
    } finally {
      root.setTimeout(() => URLApi.revokeObjectURL(href), 0);
    }
  }

  /**
   * Share a card without uploading it. The fallback order is:
   * native file share → native link share → image clipboard → text clipboard
   * → local download. Dismissing a native sheet stops immediately.
   */
  async function share(input, options) {
    const opts = options || {};
    const model = normalizeModel(input);
    const url = shareUrl(model, opts.baseUrl);
    const asset = opts.asset || await createAsset(model, opts);
    const nav = Object.prototype.hasOwnProperty.call(opts, 'navigator')
      ? opts.navigator : root.navigator;
    const doc = Object.prototype.hasOwnProperty.call(opts, 'document')
      ? opts.document : root.document;
    const URLApi = opts.urlApi || root.URL;
    const errors = [];
    const message = shareText(model);

    if (nav && typeof nav.share === 'function') {
      if (asset.file && typeof nav.canShare === 'function') {
        let fileData = {
          title: BRAND,
          text: message,
          url,
          files: [asset.file],
        };
        let supported = false;
        try {
          supported = !!nav.canShare(fileData);
        } catch (error) {
          errors.push(error);
        }
        // Some otherwise file-capable implementations reject a URL alongside
        // files. Keep the validated address in the text and retry capability
        // detection before giving up the image.
        if (!supported) {
          fileData = {
            title: BRAND,
            text: message + '\n' + url,
            files: [asset.file],
          };
          try {
            supported = !!nav.canShare(fileData);
          } catch (error) {
            errors.push(error);
          }
        }
        if (supported) {
          try {
            await nav.share(fileData);
            return { status: 'shared', method: 'native-file', url, asset };
          } catch (error) {
            if (isAbort(error)) {
              return { status: 'cancelled', method: 'native-file', url, asset };
            }
            errors.push(error);
          }
        }
      }

      try {
        await nav.share({ title: BRAND, text: message, url });
        return { status: 'shared', method: 'native-link', url, asset };
      } catch (error) {
        if (isAbort(error)) {
          return { status: 'cancelled', method: 'native-link', url, asset };
        }
        errors.push(error);
      }
    }

    const ClipboardCtor = opts.ClipboardItem || root.ClipboardItem;
    if (asset.format === 'png' && nav && nav.clipboard
        && typeof nav.clipboard.write === 'function'
        && typeof ClipboardCtor === 'function') {
      try {
        const item = new ClipboardCtor({
          'image/png': asset.blob,
          'text/plain': new Blob([message + '\n' + url], { type: 'text/plain' }),
        });
        await nav.clipboard.write([item]);
        return { status: 'copied', method: 'clipboard-image', url, asset };
      } catch (error) {
        errors.push(error);
        // A few clipboard implementations accept PNG but reject a multi-type
        // item. Preserve the card before falling all the way back to bare text.
        try {
          const item = new ClipboardCtor({ 'image/png': asset.blob });
          await nav.clipboard.write([item]);
          return { status: 'copied', method: 'clipboard-image', url, asset };
        } catch (imageError) {
          errors.push(imageError);
        }
      }
    }

    try {
      if (await copyText(message + '\n' + url, nav, doc)) {
        return { status: 'copied', method: 'clipboard-text', url, asset };
      }
    } catch (error) {
      errors.push(error);
    }

    if (download(asset, doc, URLApi)) {
      return { status: 'downloaded', method: 'download', url, asset };
    }
    return { status: 'unavailable', method: 'none', url, asset, errors };
  }

  root.KeepShare = Object.freeze({
    normalizeModel,
    shareUrl,
    renderSvg,
    safeFilename,
    createAsset,
    share,
  });
}(globalThis));
