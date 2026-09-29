// Fullscreen mode for charts and maps.
//
// `attachFullscreen(cardEl, contentEl, { onResize })` adds an expand button
// to a Bootstrap card header. Clicking it floats the content element into a
// fixed overlay covering the viewport, so the chart or map gets the whole
// page. Closing (Escape, the close button, or re-clicking) puts the element
// back where it came from.
//
// Handles the two gotchas:
//  - Leaflet maps must call `map.invalidateSize()` after the container
//    changes size (via the onResize callback).
//  - Chart.js charts with `responsive: true` resize themselves when their
//    container moves/changes size, so usually no callback is needed.

let active = null;   // { contentEl, placeholder, overlay, onResize, previousParent, previousIndex }

export function attachFullscreen(cardEl, contentEl, { onResize, headerEl, floatCard } = {}) {
  const target = floatCard ? (cardEl || contentEl) : contentEl;
  if (!target) return;
  const header = headerEl || (cardEl && cardEl.querySelector('.card-header'));
  if (!header) return;
  if (header.querySelector('.fs-btn')) return;   // already attached

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm btn-outline-secondary fs-btn';
  btn.innerHTML = '&#x26F6;';   // ⬉-style expand glyph
  btn.title = 'Fullscreen';
  btn.style.marginLeft = 'auto';
  btn.setAttribute('aria-label', 'Toggle fullscreen');
  btn.addEventListener('click', () => toggle(target, onResize));

  if (header.classList.contains('justify-content-between') && header.children.length > 1) {
    // Layouts like "title left, controls right": appending a third child
    // would re-distribute space-between and shift the controls. Instead,
    // group everything after the first child (the title) with the button.
    header.classList.remove('justify-content-between');
    const group = document.createElement('div');
    group.className = 'd-flex align-items-center gap-2 ms-auto';
    while (header.children.length > 1) group.appendChild(header.children[1]);
    group.appendChild(btn);
    header.appendChild(group);
  } else {
    header.classList.add('d-flex');
    header.classList.add('align-items-center');
    header.appendChild(btn);
  }
}

function toggle(contentEl, onResize) {
  if (active && active.contentEl === contentEl) close();
  else open(contentEl, onResize);
}

function open(contentEl, onResize) {
  if (active) close();

  // Remember where the element came from so close() can restore it.
  const previousParent = contentEl.parentNode;
  const previousIndex = previousParent ? Array.prototype.indexOf.call(previousParent.children, contentEl) : 0;

  // Placeholder keeps the page layout from collapsing while the content is
  // floated into the overlay.
  const placeholder = document.createElement('div');
  placeholder.style.display = 'none';

  const overlay = document.createElement('div');
  overlay.className = 'fs-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2000',
    'background:var(--bs-body-bg)',
    'display:flex', 'flex-direction:column', 'padding:0.75rem',
  ].join(';');

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;margin-bottom:0.5rem;gap:0.5rem;flex:none;';

  const title = document.createElement('span');
  title.className = 'fw-semibold small text-muted';
  const card = contentEl.closest('.card');
  const headerText = card ? card.querySelector('.card-header') : contentEl.previousElementSibling;
  title.textContent = (headerText ? headerText.textContent.replace(/[⛶×\s]+$/, '').trim() : '') || 'Fullscreen';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-sm btn-outline-secondary ms-auto fs-btn';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = 'Close fullscreen (Esc)';
  closeBtn.addEventListener('click', () => close());

  bar.appendChild(title);
  bar.appendChild(closeBtn);
  overlay.appendChild(bar);

  const holder = document.createElement('div');
  holder.style.cssText = 'flex:1 1 auto;min-height:0;position:relative;';
  overlay.appendChild(holder);

  previousParent.insertBefore(placeholder, contentEl);
  holder.appendChild(contentEl);
  // Grow the content to fill the holder. Inline sizes (e.g. map height)
  // would otherwise cap it.
  contentEl.dataset.fsPrevStyle = contentEl.getAttribute('style') || '';
  contentEl.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:flex;flex-direction:column;';

  // Intermediate containers between the floated element and the chart
  // (e.g. .card-body when floating a whole card) must pass the space down:
  // make every ancestor of a canvas a flex column that shares leftover room.
  const chartHosts = [];
  const stretch = (el) => {
    if (el.dataset.fsStretch) return;
    el.dataset.fsPrevStyle = el.getAttribute('style') || '';
    el.dataset.fsStretch = '1';
    if (el.tagName !== 'CANVAS') {
      // Containers must both grow AND pass the space down.
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
    }
    el.style.flex = '1 1 auto';
    el.style.minHeight = '0';
    el.style.minWidth = '0';
    chartHosts.push(el);
  };
  for (const c of contentEl.querySelectorAll('canvas')) {
    let node = c;
    while (node && node !== contentEl) {
      stretch(node);
      node = node.parentElement;
    }
  }
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  active = {
    contentEl, placeholder, overlay, onResize,
    previousParent, previousIndex, onKey,
    prevBodyOverflow: document.body.style.overflow,
    chartHosts,
  };
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    if (typeof onResize === 'function') onResize(contentEl);
    // Re-run for ~1.5s: the flex layout (and Leaflet tiles) settle
    // asynchronously, so a single early resize pass can read a stale size.
    for (let i = 0; i < 6; i++) {
      setTimeout(() => resizeCharts(contentEl), i * 250);
    }
  });
}

function resizeCharts(root) {
  for (const c of root.querySelectorAll('canvas')) {
    const ch = window.Chart && window.Chart.getChart(c);
    if (!ch) continue;
    // Explicit size from the canvas box: bare resize() keeps stale inline
    // dimensions when the canvas still carries an old Chart.js height.
    const r = c.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) ch.resize(Math.round(r.width), Math.round(r.height));
  }
}

function close() {
  if (!active) return;
  const {
    contentEl, placeholder, overlay, onResize,
    previousParent, previousIndex, onKey, prevBodyOverflow, chartHosts,
  } = active;
  active = null;

  document.removeEventListener('keydown', onKey);
  overlay.remove();
  document.body.style.overflow = prevBodyOverflow;

  for (const w of chartHosts || []) {
    w.setAttribute('style', w.dataset.fsPrevStyle || '');
    delete w.dataset.fsPrevStyle;
    delete w.dataset.fsStretch;
  }
  contentEl.setAttribute('style', contentEl.dataset.fsPrevStyle || '');
  delete contentEl.dataset.fsPrevStyle;

  if (previousParent) {
    const ref = previousParent.children[previousIndex] || null;
    previousParent.insertBefore(contentEl, ref);
    placeholder.remove();
  }

  if (typeof onResize === 'function') onResize(contentEl);
  // Same on close: the chart returned to its small wrapper.
  for (let i = 0; i < 6; i++) {
    setTimeout(() => {
      if (!active || active.contentEl !== contentEl) return;   // reopened meanwhile
      resizeCharts(contentEl);
    }, i * 250);
  }
}
