let histBins = 20;

async function renderDistributions(container) {
  const filters = getFilters();
  if (!filters.year) {
    container.innerHTML = '<div class="alert alert-muted">Loading filters…</div>';
    return;
  }
  showLoading(container);
  try {
    const measures = (filters.measures && filters.measures.length) ? filters.measures : [filters.measure || 'finalpweight'];
    const data = await apiFetch('/charts/distribution', {
      method: 'POST',
      body: JSON.stringify({ ...filters, hist_bins: histBins }),
    });
    if (typeof updateRecordCountBadge === 'function' && data.record_count != null) {
      updateRecordCountBadge(data.record_count);
    }
    if (!data.boxplot?.groups?.length) {
      showEmptyState(container, filters);
      return;
    }

    const stackedSectionsHtml = measures.map(m => {
      const label = typeof getMeasureLabel === 'function' ? getMeasureLabel(m) : m;
      return `
        <div class="distribution-measure-block" id="dist-block-${m}">
          <div class="chart-grid-2">
            <div class="chart-card">
              <h3>${label} — Histogram</h3>
              <div id="hist-chart-${m}" class="chart-canvas"></div>
            </div>
            <div class="chart-card">
              <h3>${label} — Box Plot</h3>
              <div id="box-chart-${m}" class="chart-canvas"></div>
            </div>
          </div>
        </div>`;
    }).join('');

    let html = `
      <div class="module-header">
        <div>
          <h2>Distributions Analysis</h2>
          <p>Density and quartile distributions evaluated on each animal's terminal 7-day rolling mean [max(date) − 6d, max(date)].</p>
        </div>
      </div>
      <div class="controls-bar">
        <label>Histogram Bins: <input type="range" id="hist-bins" min="10" max="50" step="5" value="${histBins}"> <span id="hist-bins-val">${histBins}</span></label>
      </div>
      <div class="stacked-card-wrapper">
        ${stackedSectionsHtml}
      </div>`;
    container.innerHTML = html;
    document.getElementById('hist-bins').oninput = async (e) => {
      histBins = parseInt(e.target.value);
      document.getElementById('hist-bins-val').textContent = histBins;
      const fresh = await apiFetch('/charts/distribution', {
        method: 'POST',
        body: JSON.stringify({ ...getFilters(), hist_bins: histBins }),
      });
      drawDistributions(fresh);
    };
    drawDistributions(data);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-warning">${err.message}</div>`;
  }
}

function drawDistributions(data) {
  const filters = getFilters();
  const measures = (filters.measures && filters.measures.length) ? filters.measures : [filters.measure || 'finalpweight'];

  for (const m of measures) {
    const histEl = document.getElementById(`hist-chart-${m}`) || document.getElementById('hist-chart');
    const boxEl = document.getElementById(`box-chart-${m}`) || document.getElementById('box-chart');
    if (!histEl || !boxEl) continue;

    const measureLabel = typeof getMeasureLabel === 'function' ? getMeasureLabel(m) : m;
    const histTraces = (data.histogram?.groups || []).map(g => ({
      x: g.values,
      name: g.group,
      type: 'histogram',
      opacity: 0.75,
      nbinsx: data.histogram?.bins || histBins,
    }));
    const shapes = [
      { type: 'line', x0: data.histogram?.mean, x1: data.histogram?.mean, y0: 0, y1: 1, yref: 'paper', line: { color: '#D97706', dash: 'dash', width: 2 } },
      { type: 'line', x0: data.histogram?.median, x1: data.histogram?.median, y0: 0, y1: 1, yref: 'paper', line: { color: '#475569', dash: 'dot', width: 2 } },
    ];
    Plotly.newPlot(histEl, histTraces, {
      barmode: 'overlay',
      shapes,
      xaxis: { title: measureLabel },
      yaxis: { title: 'Animal Count' },
      margin: { t: 16, r: 20, b: 40, l: 52 },
    }, { responsive: true });

    const boxTraces = (data.boxplot?.groups || []).map(g => ({
      y: g.values || [g.min, g.q1, g.median, g.q3, g.max],
      name: g.group,
      type: 'box',
      boxpoints: false,
    }));
    Plotly.newPlot(boxEl, boxTraces, {
      xaxis: { title: 'Animal Group' },
      yaxis: { title: measureLabel },
      margin: { t: 16, r: 20, b: 40, l: 52 },
    }, { responsive: true });
  }
}

window.renderDistributions = renderDistributions;
