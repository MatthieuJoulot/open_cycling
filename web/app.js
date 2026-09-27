import { renderNav } from './components/nav.js';
import { renderSidebar, showSidebar, hideSidebar } from './components/sidebar.js';
import { renderHome } from './pages/home.js';
import { renderActivity } from './pages/activity.js';
import { renderClimbs } from './pages/climbs.js';
import { renderClimb } from './pages/climb.js';
import { renderWiki } from './pages/wiki.js';
import { renderParameters } from './pages/parameters.js';
import { renderStatistics } from './pages/statistics.js';
import { applyTheme } from './utils/theme.js';

applyTheme(document.documentElement.getAttribute('data-bs-theme') || 'light');

function route() {
  const hash = location.hash.replace(/^#/, '') || 'feed';
  const loading = document.getElementById('loading');
  loading.classList.remove('d-none');

  const app = document.getElementById('app');
  app.innerHTML = '';

  const feedHashes = ['feed', 'home', ''];
  const sectionHashes = ['statistics'];

  if (feedHashes.includes(hash)) {
    renderNav(false);
    showSidebar();
    renderSidebar('feed');
    renderHome().finally(() => loading.classList.add('d-none'));
    return;
  }

  if (hash === 'climbs') {
    renderNav(false);
    showSidebar();
    renderSidebar('climbs');
    renderClimbs().finally(() => loading.classList.add('d-none'));
    return;
  }

  if (hash === 'wiki') {
    renderNav(false);
    showSidebar();
    renderSidebar('wiki');
    renderWiki().finally(() => loading.classList.add('d-none'));
    return;
  }

  if (hash === 'parameters') {
    renderNav(false);
    showSidebar();
    renderSidebar('parameters');
    renderParameters().finally(() => loading.classList.add('d-none'));
    return;
  }

  if (hash === 'statistics') {
    renderNav(false);
    showSidebar();
    renderSidebar('statistics');
    renderStatistics().finally(() => loading.classList.add('d-none'));
    return;
  }

  if (sectionHashes.includes(hash)) {
    renderNav(false);
    showSidebar();
    renderSidebar(hash);
    app.innerHTML = `<div class="alert alert-info">${hash.charAt(0).toUpperCase() + hash.slice(1)} page coming soon.</div>`;
    loading.classList.add('d-none');
    return;
  }

  const m = hash.match(/^activity\/(.+)$/);
  if (m) {
    renderNav(true);
    hideSidebar();
    renderActivity(m[1]).finally(() => loading.classList.add('d-none'));
    return;
  }

  const cm = hash.match(/^climb\/(.+)$/);
  if (cm) {
    renderNav(true);
    hideSidebar();
    renderClimb(cm[1]).finally(() => loading.classList.add('d-none'));
    return;
  }

  location.hash = 'feed';
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
