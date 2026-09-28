import { renderNav } from './components/nav.js';
import { renderSidebar, showSidebar, hideSidebar } from './components/sidebar.js';
import { renderHome } from './pages/home.js';
import { renderActivity } from './pages/activity.js';
import { renderClimbs } from './pages/climbs.js';
import { renderClimb } from './pages/climb.js';
import { renderWiki } from './pages/wiki.js';
import { renderParameters } from './pages/parameters.js';
import { renderStatistics } from './pages/statistics.js';
import { renderTraining } from './pages/training.js';
import { renderExplore, renderClimbDbDetail } from './pages/explore.js';
import { renderFlyover } from './pages/flyover.js';
import { applyTheme } from './utils/theme.js';
import { rememberListPage } from './components/nav.js';

applyTheme(document.documentElement.getAttribute('data-bs-theme') || 'light');

function route() {
  const hash = location.hash.replace(/^#/, '') || 'feed';
  rememberListPage(hash);
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

  if (hash === 'training') {
    renderNav(false);
    showSidebar();
    renderSidebar('training');
    renderTraining().finally(() => loading.classList.add('d-none'));
    return;
  }

  if (hash === 'explore') {
    renderNav(false);
    showSidebar();
    renderSidebar('explore');
    renderExplore().finally(() => loading.classList.add('d-none'));
    return;
  }

  const ex = hash.match(/^explore\/(.+)$/);
  if (ex) {
    renderNav(true);
    hideSidebar();
    (async () => {
      // The detail page needs the full database for lookup.
      if (!document.getElementById('app')) return;
      await renderExplore();
      renderClimbDbDetail(ex[1]);
    })().finally(() => loading.classList.add('d-none'));
    return;
  }

  const fo = hash.match(/^flyover\/(.+)$/);
  if (fo) {
    renderNav(true);
    hideSidebar();
    renderFlyover(fo[1]).finally(() => loading.classList.add('d-none'));
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
