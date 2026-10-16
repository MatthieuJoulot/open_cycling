import { renderNav } from './components/nav.js';
import { renderSidebar, showSidebar } from './components/sidebar.js';
import { renderHome } from './pages/home.js';
import { renderActivity } from './pages/activity.js';
import { renderClimbs } from './pages/climbs.js';
import { renderClimb } from './pages/climb.js';
import { renderWiki } from './pages/wiki.js';
import { renderParameters } from './pages/parameters.js';
import { renderStatistics } from './pages/statistics.js';
import { renderExplore, renderClimbDbDetail } from './pages/explore.js';
import { renderFlyover } from './pages/flyover.js';
import { applyTheme } from './utils/theme.js';
import { rememberListPage } from './components/nav.js';

applyTheme(document.documentElement.getAttribute('data-bs-theme') || 'light');

function route() {
  let hash = location.hash.replace(/^#/, '') || 'feed';
  // Scoped sections: #feed/<sport>, #statistics/<sport>. Old #training/<sport>
  // bookmarks rewrite to the merged Statistics page.
  // The scope param goes to the page (sport filter / select).
  const scoped = hash.match(/^(feed|statistics|training)\/([a-z]*)$/);
  let scope;
  if (scoped) {
    if (scoped[1] === 'training') {
      history.replaceState(null, '', '#statistics' + (scoped[2] ? '/' + scoped[2] : '/'));
    }
    hash = scoped[1] === 'training' ? 'statistics' : scoped[1];
    scope = scoped[2] || null;
  } else if (hash === 'training') {
    history.replaceState(null, '', '#statistics/');
    hash = 'statistics';
  }
  rememberListPage(hash);
  const loading = document.getElementById('loading');
  loading.classList.remove('d-none');

  const app = document.getElementById('app');
  app.innerHTML = '';

  const feedHashes = ['feed', 'home', ''];
  const sectionHashes = ['statistics'];

  // Sidebar section id: which nav entry is highlighted / which group is
  // expanded. Scoped pages highlight inside their sport group.
  let sidebarSection = hash;
  if (scoped) {
    if (scoped[1] === 'feed') {
      sidebarSection = scope ? `${scope}-feed` : 'feed';
    } else {
      // #statistics/<sport> (and old #training/<sport> bookmarks): highlight
      // inside the sport group, or the Overall group when no sport is given.
      sidebarSection = scope ? `${scope}-statistics` : `overall-statistics`;
    }
  }
  if (['feed', 'home', ''].includes(hash)) sidebarSection = 'feed';

  if (feedHashes.includes(hash)) {
    renderNav(false);
    showSidebar();
    renderSidebar(sidebarSection);
    renderHome(scope).finally(() => loading.classList.add('d-none'));
    return;
  }

  if (hash === 'climbs') {
    renderNav(false);
    showSidebar();
    renderSidebar('climbs');
    renderClimbs().finally(() => loading.classList.add('d-none'));
    return;
  }

  const wm = hash.match(/^wiki(?:\/([a-z]*))?$/);
  if (wm) {
    renderNav(false);
    showSidebar();
    renderSidebar(`wiki-${wm[1] || ''}`);
    renderWiki(wm[1] || null).finally(() => loading.classList.add('d-none'));
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
    renderSidebar(sidebarSection);
    renderStatistics(scope).finally(() => loading.classList.add('d-none'));
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
    showSidebar();
    renderSidebar('explore');
    (async () => {
      // The detail page needs the full database for lookup.
      if (!document.getElementById('app')) return;
      await renderExplore();
      renderClimbDbDetail(ex[1]);
    })().finally(() => loading.classList.add('d-none'));
    return;
  }

  // Strip a ?query embedded in the hash (e.g. #flyover/<id>?export_seconds=2)
  // so it isn't mistaken for part of the id.
  const fo = hash.match(/^flyover\/([^\?]+)(\?.*)?$/);
  if (fo) {
    renderNav(true);
    showSidebar();
    renderSidebar('feed');
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
    showSidebar();
    renderSidebar('feed');
    renderActivity(m[1]).finally(() => loading.classList.add('d-none'));
    return;
  }

  const cm = hash.match(/^climb\/(.+)$/);
  if (cm) {
    renderNav(true);
    showSidebar();
    renderSidebar('climbs');
    renderClimb(cm[1]).finally(() => loading.classList.add('d-none'));
    return;
  }

  location.hash = 'feed';
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
