import { toggleTheme } from '../utils/theme.js';

export function renderNav(showBack = false) {
  const nav = document.getElementById('nav');
  nav.innerHTML = `
    <nav class="navbar navbar-expand navbar-light bg-light border rounded mb-3" data-bs-theme="light" data-theme-nav>
      <div class="container-fluid">
        <a class="navbar-brand fw-bold" href="#home" id="nav-home">Climb Analyzer</a>
        <button class="btn btn-sm btn-outline-secondary" id="theme-toggle" title="Toggle dark mode">◐</button>
        ${showBack ? `
          <a class="btn btn-sm btn-outline-secondary ms-2" href="#home" id="nav-back">← Back</a>
        ` : ''}
      </div>
    </nav>
  `;
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
}
