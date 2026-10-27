function loadSavedViews() {
  try {
    return JSON.parse(localStorage.getItem('livestock_saved_views') || '{}');
  } catch { return {}; }
}

function saveSavedViews(views) {
  localStorage.setItem('livestock_saved_views', JSON.stringify(views));
}

function renderSavedViews() {
  const list = document.getElementById('saved-views-list');
  if (!list) return;
  const views = loadSavedViews();
  const names = Object.keys(views);
  if (!names.length) {
    list.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">No saved views yet</p>';
    return;
  }
  list.innerHTML = names.map(name => `
    <div class="saved-view-item">
      <span>${name}</span>
      <span>
        <button class="btn btn-sm btn-secondary" onclick="loadView('${name.replace(/'/g, "\\'")}')" title="Load" aria-label="Load view ${name}"><i class="fa fa-play" aria-hidden="true"></i></button>
        <button class="btn btn-sm btn-danger" onclick="deleteView('${name.replace(/'/g, "\\'")}')" title="Delete" aria-label="Delete view ${name}"><i class="fa fa-trash" aria-hidden="true"></i></button>
      </span>
    </div>
  `).join('');
}

function saveView() {
  const input = document.getElementById('view-name');
  const name = input?.value?.trim();
  if (!name) { showToast('Enter a view name', 'error'); return; }
  const views = loadSavedViews();
  const state = getFilterState();
  const user = getUser();
  views[name] = {
    ...state,
    timestamp: new Date().toISOString(),
  };
  if (!user?.is_admin) delete views[name].eid;
  saveSavedViews(views);
  if (input) input.value = '';
  renderSavedViews();
  showToast(`Saved view "${name}"`, 'success');
}

function loadView(name) {
  const views = loadSavedViews();
  if (views[name]) {
    setFilterState(views[name]);
    showToast(`Loaded view "${name}"`, 'success');
  }
}

function deleteView(name) {
  const views = loadSavedViews();
  delete views[name];
  saveSavedViews(views);
  renderSavedViews();
  showToast(`Deleted view "${name}"`, 'success');
}

function initSavedViews() {
  renderSavedViews();
  document.getElementById('save-view')?.addEventListener('click', saveView);
}

window.loadView = loadView;
window.deleteView = deleteView;
window.initSavedViews = initSavedViews;
