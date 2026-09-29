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
      <div class="container-fluid d-flex align-items-center">
        <a class="navbar-brand fw-bold me-auto" href="#home" id="nav-home">Climb Analyzer</a>
        <button class="btn btn-sm btn-outline-secondary" id="theme-toggle" title="Toggle dark mode">◐</button>
        ${showBack ? `
          <button class="btn btn-sm btn-outline-secondary ms-2" id="nav-back" title="Go back">← Back</button>
        ` : ''}
        <a class="btn btn-sm btn-outline-secondary ms-2 d-inline-flex align-items-center gap-1"
           href="https://github.com/MatthieuJoulot/open_cycling" target="_blank" rel="noopener"
           id="nav-github" title="View project on GitHub">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
          </svg>
          GitHub
        </a>
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
