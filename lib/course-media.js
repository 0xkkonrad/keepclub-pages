/*
 * Descriptive course-media rendering and resolution.
 *
 * Attachments retain their authored relative `source`. Built-in courses resolve
 * it beneath their own same-origin base; imported packages provide an async
 * `resolveMediaSource(source)` backed by mediaIndexBySource + IndexedDB. No card
 * learns a storage index and no undeclared remote origin is reachable.
 */

const SIDES = new Set(['front', 'back']);
const TYPES = new Set(['image', 'audio', 'video']);

export function mediaForSide(card, side) {
  if (!SIDES.has(side) || !Array.isArray(card?.media)) return [];
  return card.media.filter((item) =>
    item && item.side === side && TYPES.has(item.mediaType)
      && typeof item.source === 'string');
}

function safeBuiltInUrl(source, context) {
  if (!context?.base || context.deck || typeof document === 'undefined') return null;
  try {
    const base = new URL(context.base, document.baseURI);
    if (base.origin !== location.origin) return null;
    const encoded = source.split('/').map(encodeURIComponent).join('/');
    const url = new URL(encoded, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function resolveCourseMediaSource(source, context) {
  if (typeof source !== 'string' || !source) return null;
  if (typeof context?.resolveMediaSource === 'function') {
    const resolved = await context.resolveMediaSource(source);
    if (typeof resolved !== 'string' || !resolved) return null;
    try {
      const url = new URL(resolved, document.baseURI);
      if (url.origin === location.origin
          && (url.protocol === 'blob:' || url.protocol === location.protocol)) {
        return url.href;
      }
    } catch { /* not a safe URL */ }
    return null;
  }
  return safeBuiltInUrl(source, context);
}

function mediaHostAfter(anchor, side) {
  if (!anchor) return null;
  const selector = `.course-media-side[data-media-side="${side}"]`;
  let host = anchor.parentElement?.querySelector(`:scope > ${selector}`);
  if (!host) {
    host = document.createElement('div');
    host.className = 'course-media-side';
    host.dataset.mediaSide = side;
    anchor.insertAdjacentElement('afterend', host);
  }
  return host;
}

function textBlock(className, html) {
  const block = document.createElement('div');
  block.className = className;
  // readCourseForRuntime rendered and sanitized these two Markdown fields.
  block.innerHTML = html;
  return block;
}

function sourceNode(media) {
  let element;
  if (media.mediaType === 'image') {
    element = document.createElement('img');
    element.alt = media.decorative === true ? '' : (media.alternativeText || '');
    element.loading = 'lazy';
    element.decoding = 'async';
    if (media.width && media.height) {
      element.width = media.width;
      element.height = media.height;
    }
  } else {
    element = document.createElement(media.mediaType);
    element.controls = true;
    element.preload = 'metadata';
    if (media.mediaType === 'video') {
      element.playsInline = true;
      if (media.width && media.height) {
        element.width = media.width;
        element.height = media.height;
      }
    }
    const label = media.caption || media.transcript
      || `${media.mediaType} attachment`;
    element.setAttribute('aria-label', String(label).replace(/<[^>]*>/g, '').slice(0, 200));
  }
  element.dataset.courseMediaSource = media.source;
  return element;
}

function captionTrackNodes(video, tracks) {
  for (const track of tracks || []) {
    const node = document.createElement('track');
    node.kind = 'captions';
    node.srclang = track.language;
    if (track.label) node.label = track.label;
    if (track.default === true) node.default = true;
    node.dataset.courseMediaTrack = track.source;
    video.append(node);
  }
}

function mediaFigure(media, onOpenImage) {
  const figure = document.createElement('figure');
  figure.className = `course-media course-media-${media.mediaType}`;
  const element = sourceNode(media);
  const setMissing = (missing) => {
    const notice = figure.querySelector('.course-media-missing');
    if (notice) notice.hidden = !missing;
  };
  element.addEventListener('error', () => setMissing(true));
  element.addEventListener(media.mediaType === 'image' ? 'load' : 'loadedmetadata',
    () => setMissing(false));
  if (media.mediaType === 'video') {
    if (media.posterImage) element.dataset.courseMediaPoster = media.posterImage;
    captionTrackNodes(element, media.captionTracks);
  }
  if (media.mediaType === 'image' && typeof onOpenImage === 'function') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'course-media-image-button side-media-image';
    button.setAttribute('aria-label',
      `Enlarge image: ${media.alternativeText || (media.decorative ? 'decorative image' : 'image')}`);
    button.append(element);
    button.addEventListener('click', () => onOpenImage(media, element.currentSrc || element.src));
    figure.append(button);
  } else {
    figure.append(element);
  }

  if (media.caption || media.credit) {
    const caption = document.createElement('figcaption');
    if (media.caption) caption.append(textBlock('course-media-caption', media.caption));
    if (media.credit?.name) {
      const credit = document.createElement('small');
      credit.className = 'course-media-credit';
      credit.append('credit: ');
      if (media.credit.website) {
        const link = document.createElement('a');
        link.href = media.credit.website;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = media.credit.name;
        credit.append(link);
      } else {
        credit.append(media.credit.name);
      }
      caption.append(credit);
    }
    figure.append(caption);
  }
  if (media.transcript) {
    const details = document.createElement('details');
    details.className = 'course-media-transcript';
    const summary = document.createElement('summary');
    summary.textContent = 'Transcript';
    details.append(summary, textBlock('course-media-transcript-text', media.transcript));
    figure.append(details);
  }
  const missing = document.createElement('p');
  missing.className = 'course-media-missing';
  missing.hidden = true;
  missing.textContent = 'This media is not available on this device. Reconnect or import the missing file.';
  figure.append(missing);
  return figure;
}

async function hydrateAttribute(element, dataName, attribute, context) {
  const source = element.dataset[dataName];
  if (!source || element.dataset[`${dataName}Loaded`] === '1') return;
  element.dataset[`${dataName}Loaded`] = '1';
  try {
    const url = await resolveCourseMediaSource(source, context);
    if (!url || !element.isConnected || element.dataset[dataName] !== source) {
      delete element.dataset[`${dataName}Loaded`];
      const missing = element.closest('.course-media')?.querySelector('.course-media-missing');
      if (missing) missing.hidden = false;
      return;
    }
    element.setAttribute(attribute, url);
    const missing = element.closest('.course-media')?.querySelector('.course-media-missing');
    if (missing) missing.hidden = true;
    if (attribute === 'src' && (element.tagName === 'AUDIO' || element.tagName === 'VIDEO')) {
      element.load();
    }
  } catch {
    delete element.dataset[`${dataName}Loaded`];
    const missing = element.closest('.course-media')?.querySelector('.course-media-missing');
    if (missing) missing.hidden = false;
  }
}

export function hydrateCourseMedia(root, context) {
  if (!root) return;
  for (const element of root.querySelectorAll('[data-course-media-source]')) {
    hydrateAttribute(element, 'courseMediaSource', 'src', context);
  }
  for (const element of root.querySelectorAll('[data-course-media-poster]')) {
    hydrateAttribute(element, 'courseMediaPoster', 'poster', context);
  }
  for (const element of root.querySelectorAll('[data-course-media-track]')) {
    hydrateAttribute(element, 'courseMediaTrack', 'src', context);
  }
}

export function resetCourseMedia(root = document) {
  for (const element of root.querySelectorAll('[data-course-media-source]')) {
    element.removeAttribute('src');
    delete element.dataset.courseMediaSourceLoaded;
  }
  for (const element of root.querySelectorAll('[data-course-media-poster]')) {
    element.removeAttribute('poster');
    delete element.dataset.courseMediaPosterLoaded;
  }
  for (const element of root.querySelectorAll('[data-course-media-track]')) {
    element.removeAttribute('src');
    delete element.dataset.courseMediaTrackLoaded;
  }
}

/**
 * Render one card side into a host supplied by a layout that already owns the
 * prompt/answer structure. Set load=false for a hidden answer.
 */
export function renderCourseMediaInto(
  host, card, side, context, { load = true, onOpenImage } = {},
) {
  if (!host) return null;
  host.classList.add('course-media-side');
  host.dataset.mediaSide = side;
  host.replaceChildren(...mediaForSide(card, side)
    .map((media) => mediaFigure(media, onOpenImage)));
  host.hidden = !host.childElementCount;
  if (load) hydrateCourseMedia(host, context);
  return host;
}

/**
 * Render one card side beside its text node when the surrounding layout has no
 * dedicated host. hydrateCourseMedia() loads a deferred hidden answer later.
 */
export function renderCourseMediaSide(anchor, card, side, context, options = {}) {
  return renderCourseMediaInto(mediaHostAfter(anchor, side), card, side, context, options);
}
