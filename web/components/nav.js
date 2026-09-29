import { toggleTheme } from '../utils/theme.js';

// Where the "← Back" button goes. Three levels, in order:
//   1. If we got here by in-app navigation (there is history to go back
//      to), go back — this is always where the user came from.
//   2. Otherwise fall back to the last list page we visited (feed,
//      climbs, …), which survives full page loads.
//   3. Default to the feed.
let lastListHash = 'feed';
let appNavigated = false;

export function rememberListPage(hash) {
  if (!hash) return;
  if (hash === 'feed' || hash === 'home' || hash === '' || hash === 'climbs'
      || hash === 'statistics' || hash === 'training' || hash === 'explore'
      || hash === 'wiki' || hash === 'parameters') {
    lastListHash = hash;
    // Landing on a list page directly (e.g. a reload) resets history
    // knowledge: going back further would leave the app.
    appNavigated = false;
  } else {
    appNavigated = true;
  }
}

export function renderNav(showBack = false) {
  const nav = document.getElementById('nav');
  nav.innerHTML = `
    <nav class="navbar navbar-expand-lg bg-body-tertiary border-bottom" data-bs-theme="auto">
      <div class="container-fluid">
        <a class="navbar-brand fw-bold" href="#home" id="nav-home">Climb Analyzer</a>
        <button class="btn btn-sm btn-outline-secondary" id="theme-toggle" title="Toggle dark mode">◐</button>
        ${showBack ? `
          <button class="btn btn-sm btn-outline-secondary ms-2" id="nav-back" title="Go back">← Back</button>
        ` : ''}
      </div>
    </nav>
  `;
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  const back = document.getElementById('nav-back');
  if (back) back.addEventListener('click', () => {
    // history.length > 1 and we navigated inside the app: real back.
    if (appNavigated && history.length > 1) history.back();
    else location.hash = `#${lastListHash}`;
  });
}
