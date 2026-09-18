export async function renderWiki() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div id="wiki-view">
      <h4 class="mb-3">Wiki</h4>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Climb grade colors</div>
        <div class="card-body">
          <p>The segment elevation chart colors each kilometer by its average grade.</p>
          <div class="table-responsive">
            <table class="table table-sm">
              <thead>
                <tr><th>Average grade</th><th>Color</th><th>Hex</th></tr>
              </thead>
              <tbody>
                <tr><td>Downhill (< -1%)</td><td><span class="badge" style="background:#0d6efd">blue</span></td><td><code>#0d6efd</code></td></tr>
                <tr><td>Flat (-1% to 1%)</td><td><span class="badge" style="background:#2ecc71">green</span></td><td><code>#2ecc71</code></td></tr>
                <tr><td>Low climb (1% to 3%)</td><td><span class="badge" style="background:#f7d794; color:#333">pale yellow</span></td><td><code>#f7d794</code></td></tr>
                <tr><td>Moderate (3% to 6%)</td><td><span class="badge" style="background:#ffc107; color:#333">gold</span></td><td><code>#ffc107</code></td></tr>
                <tr><td>Hard (6% to 9%)</td><td><span class="badge" style="background:#fd7e14">orange</span></td><td><code>#fd7e14</code></td></tr>
                <tr><td>Very hard (9% to 12%)</td><td><span class="badge" style="background:#dc3545">red</span></td><td><code>#dc3545</code></td></tr>
                <tr><td>Extreme (12% to 20%)</td><td><span class="badge" style="background:#6f42c1">purple</span></td><td><code>#6f42c1</code></td></tr>
                <tr><td>Brutal (> 20%)</td><td><span class="badge" style="background:#000000">black</span></td><td><code>#000000</code></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}
