// Dark/light theme handling. Bootstrap 5.3 data-bs-theme drives component
// colors; Chart.js defaults are set here so charts follow the theme, and the
// toggle re-routes so every chart re-renders with the new defaults.
const KEY = 'theme';

export function getTheme() {
  const stored = localStorage.getItem(KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function isDark() {
  return getTheme() === 'dark';
}

function applyChartDefaults(dark) {
  if (typeof window.Chart === 'undefined') return;
  window.Chart.defaults.color = dark ? '#adb5bd' : '#668';
  window.Chart.defaults.borderColor = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';
  window.Chart.defaults.plugins.legend.labels.color = window.Chart.defaults.color;
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-bs-theme', theme);
  localStorage.setItem(KEY, theme);
  applyChartDefaults(theme === 'dark');
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  // Re-route: every page rebuilds its charts on render, so they pick up the
  // new Chart.js defaults.
  window.dispatchEvent(new Event('hashchange'));
}
