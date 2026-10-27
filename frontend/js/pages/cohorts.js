let cohortPercentile = 10;
let cohortData = null;

async function renderCohorts(container) {
  showLoading(container);
  try {
    const f = getFilters();
    cohortPercentile = f.cohort_percentile || cohortPercentile || 10;
    const user = getUser();
    const isAdmin = Boolean(user && user.is_admin);

    cohortData = await apiFetch('/cohorts/analyze', {
      method: 'POST',
      body: JSON.stringify({ ...f, percentile: cohortPercentile }),
    });
    if (!cohortData.total_animals) {
      showEmptyState(container, getFilters());
      return;
    }
    const measures = (f.measures && f.measures.length) ? f.measures : [f.measure || 'finalpweight'];

    let html = `
      <div class="module-header">
        <div>
          <h2>Cohort Analysis</h2>
          <p>3-tier herd performance partitioning across high, medium, and low performance cohorts. Requires ≥2 observations per animal.</p>
        </div>
      </div>`;

    if (cohortData.show_mixed_warning) {
      html += `<div class="alert alert-warning">You have selected both 'Overall' and specific items in your filters. Cohort rankings use the filtered dataset but group comparisons may be affected.</div>`;
    }
    html += `<div class="stacked-card-wrapper">`;

    for (const m of measures) {
      const mLabel = typeof getMeasureLabel === 'function' ? getMeasureLabel(m) : m;
      html += `
        <div class="chart-card stacked-chart-card" id="cohort-card-${m}">
          <div class="chart-card-header">
            <h3>${mLabel} — Cohort Analysis</h3>
            ${isAdmin ? `
              <div class="chart-header-actions">
                <button class="btn btn-secondary btn-sm" onclick="exportCohort('all', '${m}')"><i class="fa fa-download"></i> Export (${mLabel})</button>
              </div>` : ''}
          </div>
          <div class="cohort-tier-grid">
            ${cohortTierCard('high', cohortData.high || cohortData.top, 'High Tier', isAdmin, m)}
            ${cohortTierCard('medium', cohortData.medium, 'Medium Tier', isAdmin, m)}
            ${cohortTierCard('low', cohortData.low || cohortData.bottom, 'Low Tier', isAdmin, m)}
          </div>
          <div id="cohort-timeline-${m}" class="chart-canvas" style="min-height: 380px;"></div>
        </div>`;
    }

    html += `
      </div>
      <div id="cohort-modal" class="modal-overlay hidden" onclick="if(event.target===this)closeCohortModal()">
        <div class="modal"><h3 id="cohort-modal-title"></h3><div class="table-wrap"><table class="data-table" id="cohort-modal-table"></table></div>
        <div class="modal-actions"><button class="btn btn-secondary" onclick="closeCohortModal()">Close</button></div></div>
      </div>`;
    container.innerHTML = html;

    drawCohortTimeline(cohortData);
  } catch (err) {
    container.innerHTML = `<div class="alert alert-warning">${err.message}</div>`;
  }
}

function cohortTierCard(type, data, title, isAdmin, measureOverride = null) {
  const measure = measureOverride || getFilters().measure;
  if (!data) return '';
  const tierBadges = {
    high: `≥${100 - cohortPercentile}%`,
    top: `≥${100 - cohortPercentile}%`,
    medium: 'Core Mob',
    low: `≤${cohortPercentile}%`,
    bottom: `≤${cohortPercentile}%`,
  };
  const badgeText = tierBadges[type] || '';
  return `<div class="cohort-tier-card ${type}">
    <div class="cohort-tier-header">
      <span class="cohort-tier-title"><span class="cohort-legend-dot ${type}"></span> ${title}</span>
      <div class="cohort-header-actions">
        <span class="cohort-badge ${type}">${badgeText}</span>
        <button class="btn btn-secondary btn-sm" onclick="viewCohortAnimals('${type}', '${measure}')">View</button>
        ${isAdmin ? `<button class="btn btn-secondary btn-sm" onclick="exportCohort('${type}', '${measure}')" title="Export ${title} CSV"><i class="fa fa-download"></i></button>` : ''}
      </div>
    </div>
    <div class="cohort-stat-grid">
      <div class="cohort-stat-col">
        <div class="cohort-stat-row">
          <span class="stat-label">Avg</span>
          <span class="stat-val">${formatValue(data.average, measure)}</span>
        </div>
        <div class="cohort-stat-row">
          <span class="stat-label">Count</span>
          <span class="stat-val">${data.count}</span>
        </div>
      </div>
      <div class="cohort-stat-divider-v"></div>
      <div class="cohort-stat-col">
        <div class="cohort-stat-row">
          <span class="stat-label">Min</span>
          <span class="stat-val">${formatValue(data.min, measure)}</span>
        </div>
        <div class="cohort-stat-row">
          <span class="stat-label">Max</span>
          <span class="stat-val">${formatValue(data.max, measure)}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function drawCohortTimeline(data) {
  const highPts = data.timeline.filter(t => t.cohort === 'high' || t.cohort === 'top');
  const medPts = data.timeline.filter(t => t.cohort === 'medium');
  const lowPts = data.timeline.filter(t => t.cohort === 'low' || t.cohort === 'bottom');

  const traces = [];
  if (highPts.length) {
    traces.push({
      x: highPts.map(p => p.date),
      y: highPts.map(p => p.value),
      name: 'High Cohort',
      type: 'scatter',
      mode: 'lines+markers',
      line: { color: '#059669', width: 2 },
    });
  }
  if (medPts.length) {
    traces.push({
      x: medPts.map(p => p.date),
      y: medPts.map(p => p.value),
      name: 'Medium Cohort',
      type: 'scatter',
      mode: 'lines+markers',
      line: { color: '#475569', width: 2 },
    });
  }
  if (lowPts.length) {
    traces.push({
      x: lowPts.map(p => p.date),
      y: lowPts.map(p => p.value),
      name: 'Low Cohort',
      type: 'scatter',
      mode: 'lines+markers',
      line: { color: '#B91C1C', width: 2 },
    });
  }

  const filters = getFilters();
  const measures = (filters.measures && filters.measures.length) ? filters.measures : [filters.measure || 'finalpweight'];

  for (const m of measures) {
    const el = document.getElementById(`cohort-timeline-${m}`) || document.getElementById('cohort-timeline');
    if (!el) continue;
    const label = typeof getMeasureLabel === 'function' ? getMeasureLabel(m) : m;
    Plotly.newPlot(
      el,
      traces,
      {
        xaxis: { title: 'Date' },
        yaxis: { title: label },
        margin: { t: 16, r: 20, b: 54, l: 52 },
        legend: { orientation: 'h', y: -0.22 },
      },
      { responsive: true }
    );
  }
}

function viewCohortAnimals(type, measureOverride = null) {
  const normType = (type === 'top') ? 'high' : (type === 'bottom' ? 'low' : type);
  const data = cohortData[normType] || cohortData[type];
  if (!data) return;
  const titleMap = { high: 'High', medium: 'Medium', low: 'Low', top: 'High', bottom: 'Low' };
  document.getElementById('cohort-modal-title').textContent = `${titleMap[type] || type} Cohort Animals`;
  const f = getFilters();
  const measure = measureOverride || f.measure;
  const label = typeof getMeasureLabel === 'function' ? getMeasureLabel(measure) : measure;
  document.getElementById('cohort-modal-table').innerHTML = `
    <thead><tr><th>EID</th><th>Avg ${label}</th></tr></thead>
    <tbody>${data.animals.map(a => `<tr><td>${a.eid}</td><td>${formatValue(a.avg_measure, measure)}</td></tr>`).join('')}</tbody>`;
  document.getElementById('cohort-modal').classList.remove('hidden');
}

function closeCohortModal() {
  document.getElementById('cohort-modal')?.classList.add('hidden');
}

async function exportCohort(type, measureOverride = null) {
  const f = getFilters();
  const targetMeasure = measureOverride || f.measure;
  const params = new URLSearchParams({
    cohort: type,
    farm_id: f.farm_id,
    year: f.year,
    measure: targetMeasure,
    percentile: cohortPercentile,
  });
  await apiDownload(`/cohorts/export.csv?${params}`, `cohort_${type}_${targetMeasure}.csv`);
  showToast('Cohort exported', 'success');
}

window.renderCohorts = renderCohorts;
window.viewCohortAnimals = viewCohortAnimals;
window.closeCohortModal = closeCohortModal;
window.exportCohort = exportCohort;
