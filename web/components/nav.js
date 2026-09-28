import { toggleTheme } from '../utils/theme.js';

// Where the "← Back" button goes: the last list page we were on
// (feed, climbs, …) rather than always the feed.
let lastListHash = 'feed';

export function rememberListPage(hash) {
  if (!hash) return;
  if (hash === 'feed' || hash === 'home' || hash === '' || hash === 'climbs'
      || hash === 'statistics' || hash === 'training' || hash === 'explore'
      || hash === 'wiki' || hash === 'parameters') {
    lastListHash = hash;
  } else if (hash.startsWith('activity/')) {
    // Detail pages: remember the activity itself so "back" from its
    // climbs returns to that activity.
    lastListHash = hash;
  }
}

export function renderNav(showBack = false) {
  const nav = document.getElementById('nav');
  nav.innerHTML = `
    <nav class="navbar border rounded mb-3" data-theme-nav>
      <div class="container-fluid">
        <a class="navbar-brand fw-bold" href="#home" id="nav-home">Climb Analyzer</a>
        <button class="btn btn-sm btn-outline-secondary" id="theme-toggle" title="Toggle dark mode">◐</button>
        ${showBack ? `
          <a class="btn btn-sm btn-outline-secondary ms-2" href="#${lastListHash}" id="nav-back">← Back</a>
        ` : ''}
      </div>
    </nav>
  `;
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
}
