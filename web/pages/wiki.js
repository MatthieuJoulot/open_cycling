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

      <div class="card mb-3">
        <div class="card-header fw-semibold">Difficulty score</div>
        <div class="card-body">
          <p>Every climb gets a difficulty score that makes climbs comparable at a glance — a number that captures how steep, how long and how high a climb is in one value. It is based on the <a href="https://en.wikipedia.org/wiki/Classification_de_la_F.F.C." target="_blank" rel="noopener">FIETS index</a> developed by the Dutch cycling magazine <em>Fiets</em>.</p>

          <p class="mb-2"><strong>Formula</strong> (climb page, full score):</p>
          <p class="text-center fs-5"><code>score = H² / (D × 10) + max(0, (T − 1000) / 1000)</code></p>
          <div class="table-responsive">
            <table class="table table-sm">
              <thead>
                <tr><th>Symbol</th><th>Meaning</th></tr>
              </thead>
              <tbody>
                <tr><td><code>H</code></td><td>Ascent: elevation gain from the bottom to the top, in metres</td></tr>
                <tr><td><code>D</code></td><td>Length of the climb, in metres</td></tr>
                <tr><td><code>T</code></td><td>Summit altitude (highest point of the climb), in metres</td></tr>
              </tbody>
            </table>
          </div>

          <p class="mt-3 mb-2"><strong>How to read it</strong></p>
          <ul>
            <li>The squared ascent term rewards steepness: doubling the gradient of a climb roughly quadruples its score.</li>
            <li>The second term adds a bonus for climbs finishing above 1000 m — thin-air territory. A 2000 m summit adds 1 point, a 2800 m summit adds 1.8 points.</li>
            <li>On the climbs list, the score is shown without the summit bonus (the list has no per-climb summit altitude); the climb page always shows the full score, so a climb can score slightly higher on its detail page.</li>
          </ul>

          <p class="mb-2"><strong>Reference values</strong></p>
          <div class="table-responsive">
            <table class="table table-sm">
              <thead>
                <tr><th>Climb</th><th>Score</th></tr>
              </thead>
              <tbody>
                <tr><td>Col du Tourmalet (east side, ~19 km at 7.3%)</td><td>≈ 11.3</td></tr>
                <tr><td>Mauna Kea (Hawai'i — world's hardest)</td><td>≈ 28.9</td></tr>
                <tr><td>Small 2 km hill at 5%</td><td>≈ 0.5</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Predicted climb time</div>
        <div class="card-body">
          <p>On every climb page you get a <strong>personal predicted time</strong> — how long the climb should take <em>you</em>, not a generic rider. It works even for climbs you have never ridden.</p>

          <p class="mb-2"><strong>How it works</strong></p>
          <p>Your climb history is fed into a power-law model: the app takes every recorded climb occurrence (at least 30 m of ascent and 300 m long, taking between 1 minute and 2 hours) and fits the relation</p>
          <p class="text-center fs-5"><code>T = a · H<sup>b</sup> · D<sup>c</sup></code></p>
          <p>where <code>T</code> is the time, <code>H</code> the ascent and <code>D</code> the length of the climb. The fit is done in log space with three-variable linear regression, so the model learns your personal pace: how much a climb slows down when it gets higher or longer. On the current history the fit explains about 92% of the variation in your climb times (R² ≈ 0.92).</p>

          <p class="mb-2"><strong>Reading it</strong></p>
          <ul>
            <li>The card shows the predicted time for the climb at hand; when you have ridden the climb before, it also shows the gap to your PR (e.g. <em>+6% vs PR</em> means the model expects you ~6% slower than your best time).</li>
            <li>A <em>+</em> gap (green) means your PR beat the prediction — a good day. A <em>−</em> gap (red) means you have never yet matched what your own history says you can do.</li>
            <li>The model needs at least 20 usable climbs to be trusted; before that the card shows a dash.</li>
          </ul>
        </div>
      </div>

      <div class="card mb-3">
        <div class="card-header fw-semibold">Climbing profile (VAM curve)</div>
        <div class="card-body">
          <p>On the statistics page, the <strong>climbing profile</strong> chart shows how hard you can climb depending on how long the effort lasts — the climbing equivalent of a power-duration curve, like the power profile Climbfinder builds for riders.</p>

          <p class="mb-2"><strong>How it works</strong></p>
          <ul>
            <li>Every dot is one climb you have recorded (≥50 m ascent, ≥2 min): its duration on the x-axis (log scale, with alternating shaded <strong>duration bands</strong>), and your <strong>VAM</strong> — vertical metres gained per hour — on the y-axis. VAM is the standard measure of climbing speed: it captures how fast you gain altitude regardless of the road's gradient.</li>
            <li>Climbs are grouped into duration bands (2–5 min, 5–10, 10–20, 20–40, 40–90, 90+ min). In each band the 90th-percentile VAM is kept — a robust best effort, immune to one freak climb — and these define your <em>envelope</em>: what you can do on a good day.</li>
            <li>The red <strong>envelope curve</strong> fits those points with <code>VAM = V₀ + K / T<sup>b</sup></code>, the same shape as the critical-power model used for wattage curves. The floor <code>V₀</code> is your <strong>sustainable VAM</strong> — the vertical speed you could theoretically hold for hours; the bigger <code>K</code> is, the more extra punch you have on short efforts. This shape is used instead of a simple power law because a real rider's curve flattens to a nonzero floor instead of decaying to zero.</li>
            <li>The grey dashed <strong>steady-pace floor</strong> is the same fit on the 25th percentile per band: your typical everyday climbing speed. Together the two curves complete the picture — your rides live between "what you can do" and "what you normally do".</li>
            <li>The dashed <strong>recent form</strong> curve fits only the most recent third of your history and compares it with your early years: green means your sustainable VAM improved, amber means it dropped. It is the equivalent of Climbfinder telling you that you got better (or worse) than before.</li>
          </ul>

          <p class="mb-2"><strong>Reading it</strong></p>
          <ul>
            <li>Top-left corner = your anaerobic punch (short, steep bursts). The flat right side = your aerobic engine (long cols).</li>
            <li>Most blue dots sit <em>between</em> the two curves — that is normal: the envelope only tracks best efforts, the floor your easy days.</li>
            <li>A flatter envelope over time means better endurance; a higher left side means better short-climb punch. Use the period buttons above the chart to compare.</li>
          </ul>
        </div>
      </div>
    </div>
  `;
}
