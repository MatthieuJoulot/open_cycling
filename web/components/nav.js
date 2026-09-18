export function renderNav(showBack = false) {
  const nav = document.getElementById('nav');
  nav.innerHTML = `
    <nav class="navbar navbar-expand navbar-light bg-light mb-3 border rounded">
      <div class="container-fluid">
        <a class="navbar-brand fw-bold" href="#home" id="nav-home">Climb Analyzer</a>
        ${showBack ? `
          <a class="btn btn-sm btn-outline-secondary" href="#home" id="nav-back">← Back</a>
        ` : ''}
      </div>
    </nav>
  `;
}
