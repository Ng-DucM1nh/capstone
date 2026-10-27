const SAVED_VIEWS_KEY = 'livestock_saved_views';

const defaultFilters = () => ({
  year: null,
  month: 'All',
  day: 'All',
  sex: ['Overall'],
  treatment: ['Overall'],
  breed: ['Overall'],
  mob: ['Overall'],
  eid: ['Overall'],
  measure: 'finalpweight',
  measures: ['finalpweight'],
  cohort_percentile: 10,
  active_only: false,
  active_days: 30,
  active_reference_mode: 'auto',
});

let filterState = defaultFilters();
let choices = null;
let queryResult = null;
let debounceTimer = null;
let onFilterChange = null;
let choicesRequest = 0;
/** farm_id → { choices, summary, measure } — keeps farm switches warm */
const farmBootCache = Object.create(null);
/** farm_id → Promise — coalesce concurrent bootstrap fetches */
const farmBootInflight = Object.create(null);

function yearStorageKey(farmId) {
  return `livestock_year_${farmId || 'KF'}`;
}

function readFarmYear(farmId) {
  try {
    const stored = Number(localStorage.getItem(yearStorageKey(farmId)));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch (_) { /* ignore */ }
  return null;
}

function writeFarmYear(farmId, year) {
  if (!farmId || year == null) return;
  try {
    localStorage.setItem(yearStorageKey(farmId), String(year));
    localStorage.setItem('livestock_last_year', String(year));
  } catch (_) { /* ignore */ }
}

function debounce(fn, ms = 300) {
  return (...args) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fn(...args), ms);
  };
}

function getMeasureLabel(key) {
  if (typeof choices !== 'undefined' && choices?.measures) {
    const found = choices.measures.find(m => (m.key || m.value) === key);
    if (found) return found.label || found.name || key;
  }
  const fallback = {
    finalpweight: 'Final processed weight (kg)',
    finalgrowthpbs: 'Final growth PBS',
    finaldailygrowth: 'Final daily growth',
    feedintakekgd: 'Feed intake (kg/d)',
    feedintakepct: 'Feed intake (%)',
    methane: 'Methane (g/d)',
    animalvalue: 'Animal value ($)',
    animalprod: 'Animal prod',
    carcassweight: 'Carcass weight (kg)',
    dressedcarcass: 'Dressed carcass (%)',
  };
  return fallback[key] || key;
}

function getFilterPayload() {
  const user = getUser();
  const measures = filterState.measures && filterState.measures.length ? filterState.measures : [filterState.measure || 'finalpweight'];
  return {
    ...filterState,
    farm_id: getFarmId(),
    measures,
    measure: measures[0] || 'finalpweight',
    eid: user?.is_admin ? filterState.eid : ['Overall'],
  };
}

function getActiveHerdCountKey() {
  const mode = filterState.active_reference_mode || 'auto';
  const days = filterState.active_days || 30;
  return `${mode}_${days}`;
}

function resolveActiveHerdCount() {
  const key = getActiveHerdCountKey();
  if (choices?.active_counts && choices.active_counts[key] != null) {
    return choices.active_counts[key];
  }
  return choices?.active_animal_count;
}

async function syncActiveHerdBadgeLive() {
  const key = getActiveHerdCountKey();
  if (choices?.active_counts && choices.active_counts[key] != null) return;
  try {
    const farmId = getFarmId();
    const mode = filterState.active_reference_mode || 'auto';
    const days = filterState.active_days || 30;
    const res = await apiFetch(`/filters/active-count?farm_id=${encodeURIComponent(farmId)}&active_days=${days}&active_reference_mode=${encodeURIComponent(mode)}`);
    if (res && res.active_animal_count != null) {
      if (!choices) choices = {};
      if (!choices.active_counts) choices.active_counts = {};
      choices.active_counts[key] = res.active_animal_count;
      if (res.total_animal_count != null) choices.total_animal_count = res.total_animal_count;
      updateRecordCountBadge();
    }
  } catch (_) {}
}

function updateRecordCountBadge(recordCount, totalRecords, activeAnimalCount, totalAnimalCount) {
  const countEl = document.getElementById('record-count');
  if (countEl && recordCount != null) {
    const total = totalRecords ?? choices?.total_records ?? recordCount;
    countEl.textContent = `Showing ${Number(recordCount).toLocaleString()} of ${Number(total).toLocaleString()} records`;
  }
  const badgeEl = document.getElementById('active-herd-badge');
  if (badgeEl) {
    const active = activeAnimalCount ?? resolveActiveHerdCount();
    const totalHead = totalAnimalCount ?? choices?.total_animal_count;
    if (active != null && totalHead != null) {
      badgeEl.textContent = `Active: ${Number(active).toLocaleString()} / ${Number(totalHead).toLocaleString()} head`;
    }
  }
}

async function loadChoices(preloaded) {
  const farmId = getFarmId();
  if (preloaded && preloaded.farm_id === farmId && preloaded.choices) {
    choices = preloaded.choices;
  } else {
    choices = await apiFetch(`/filters/choices?farm_id=${farmId}`);
  }
  if (!filterState.year && choices.max_year) {
    filterState.year = choices.max_year;
  }
  renderFilterUI();
}

function renderSearchablePicker(containerId, field, options) {
  const container = document.getElementById(containerId) || document.getElementById(`picker-${field}`);
  if (!container) return;

  const currentSelected = filterState[field] || ['Overall'];

  let summaryText = 'Overall';
  if (currentSelected.length === 1) {
    summaryText = currentSelected[0];
  } else if (currentSelected.length > 1) {
    summaryText = `${currentSelected.length} selected`;
  }

  // Approach 1: Tag pills with dismiss button when multiple items selected
  const tagsHtml = (currentSelected.length > 1)
    ? currentSelected.map(opt => `<span class="picker-tag" data-val="${opt}">${opt} <button type="button" class="picker-tag-remove" data-remove="${opt}" aria-label="Remove ${opt}">&times;</button></span>`).join('')
    : '';

  const optionsHtml = options.map(opt => {
    const isChecked = currentSelected.includes(opt);
    return `<label><input type="checkbox" data-field="${field}" value="${opt}" ${isChecked ? 'checked' : ''}> <span>${opt}</span></label>`;
  }).join('');

  container.innerHTML = `
    <button type="button" class="picker-trigger" id="picker-btn-${field}" aria-haspopup="listbox" aria-expanded="false">
      <span class="picker-trigger-text">${summaryText}</span>
      <i class="fa fa-chevron-down picker-chevron" aria-hidden="true"></i>
    </button>
    <div class="picker-tags-wrap" id="picker-tags-${field}">${tagsHtml}</div>
    <div class="picker-menu" role="listbox" id="picker-menu-${field}">
      <div class="picker-search-wrap">
        <input type="text" class="picker-search-input" placeholder="Search options..." aria-label="Search ${field}">
      </div>
      <div class="picker-options-list">
        ${optionsHtml}
        <div class="picker-no-results" style="display:none;">No matching options</div>
      </div>
    </div>
  `;

  const trigger = container.querySelector('.picker-trigger');
  const menu = container.querySelector('.picker-menu');
  const searchInput = container.querySelector('.picker-search-input');
  const optionsList = container.querySelector('.picker-options-list');
  const noResults = container.querySelector('.picker-no-results');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = container.classList.contains('open');
    document.querySelectorAll('.custom-picker.open').forEach(p => {
      if (p !== container) {
        p.classList.remove('open');
        p.querySelector('.picker-trigger')?.setAttribute('aria-expanded', 'false');
      }
    });
    container.classList.toggle('open', !isOpen);
    trigger.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
    if (!isOpen && searchInput) {
      searchInput.value = '';
      optionsList.querySelectorAll('label').forEach(lbl => lbl.style.display = 'flex');
      if (noResults) noResults.style.display = 'none';
      setTimeout(() => searchInput.focus(), 50);
    }
  });

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    let visibleCount = 0;
    optionsList.querySelectorAll('label').forEach(lbl => {
      const txt = lbl.textContent.toLowerCase();
      const match = txt.includes(q);
      lbl.style.display = match ? 'flex' : 'none';
      if (match) visibleCount++;
    });
    if (noResults) {
      noResults.style.display = visibleCount === 0 ? 'block' : 'none';
    }
  });

  optionsList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      let selected = [...optionsList.querySelectorAll('input:checked')].map(i => i.value);

      // Only default to 'Overall' if none selected
      if (!selected.length) {
        const overallCb = optionsList.querySelector('input[value="Overall"]');
        if (overallCb) {
          overallCb.checked = true;
          selected = ['Overall'];
        }
      }

      filterState[field] = selected;
      updatePickerUI(container, field);
      notifyFilterChange({ dimOnly: field !== 'eid' });
    });
  });

  const tagsWrap = container.querySelector('.picker-tags-wrap');
  tagsWrap.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.picker-tag-remove');
    if (!removeBtn) return;
    e.stopPropagation();
    const valToRemove = removeBtn.dataset.remove;
    const targetCb = optionsList.querySelector(`input[value="${valToRemove}"]`);
    if (targetCb) {
      targetCb.checked = false;
    }
    let selected = [...optionsList.querySelectorAll('input:checked')].map(i => i.value);
    if (!selected.length) {
      const overallCb = optionsList.querySelector('input[value="Overall"]');
      if (overallCb) {
        overallCb.checked = true;
        selected = ['Overall'];
      }
    }
    filterState[field] = selected;
    updatePickerUI(container, field);
    notifyFilterChange({ dimOnly: field !== 'eid' });
  });
}

function updatePickerUI(container, field) {
  const currentSelected = filterState[field] || ['Overall'];

  const triggerText = container.querySelector('.picker-trigger-text');
  if (triggerText) {
    if (currentSelected.length === 1) {
      triggerText.textContent = currentSelected[0];
    } else if (currentSelected.length > 1) {
      triggerText.textContent = `${currentSelected.length} selected`;
    } else {
      triggerText.textContent = 'Overall';
    }
  }

  const tagsWrap = container.querySelector('.picker-tags-wrap');
  if (tagsWrap) {
    if (currentSelected.length > 1) {
      tagsWrap.innerHTML = currentSelected.map(opt => `<span class="picker-tag" data-val="${opt}">${opt} <button type="button" class="picker-tag-remove" data-remove="${opt}" aria-label="Remove ${opt}">&times;</button></span>`).join('');
    } else {
      tagsWrap.innerHTML = '';
    }
  }
}

function renderMeasureMultiPicker(containerId, rawOptions) {
  const container = document.getElementById(containerId) || document.getElementById('picker-measure');
  if (!container || !rawOptions) return;

  const options = rawOptions.map(opt => {
    if (typeof opt === 'object' && opt !== null) {
      const val = opt.key !== undefined ? opt.key : opt.value;
      const lbl = opt.label !== undefined ? opt.label : opt.name || String(val);
      return { value: val, label: lbl };
    }
    return { value: opt, label: String(opt) };
  });

  const currentSelected = (filterState.measures && filterState.measures.length)
    ? filterState.measures
    : [filterState.measure || 'finalpweight'];
  filterState.measures = currentSelected;
  filterState.measure = currentSelected[0] || 'finalpweight';

  let summaryText = 'Final processed weight (kg)';
  if (currentSelected.length === 1) {
    summaryText = getMeasureLabel(currentSelected[0]);
  } else if (currentSelected.length > 1) {
    summaryText = `${currentSelected.length} measures selected`;
  }

  const tagsHtml = (currentSelected.length > 1)
    ? currentSelected.map(opt => `<span class="picker-tag" data-val="${opt}">${getMeasureLabel(opt)} <button type="button" class="picker-tag-remove" data-remove="${opt}" aria-label="Remove ${getMeasureLabel(opt)}">&times;</button></span>`).join('')
    : '';

  const optionsHtml = options.map(opt => {
    const isChecked = currentSelected.includes(opt.value);
    return `<label><input type="checkbox" data-field="measure" value="${opt.value}" ${isChecked ? 'checked' : ''}> <span>${opt.label}</span></label>`;
  }).join('');

  container.innerHTML = `
    <button type="button" class="picker-trigger" id="picker-btn-measure" aria-haspopup="listbox" aria-expanded="false">
      <span class="picker-trigger-text">${summaryText}</span>
      <i class="fa fa-chevron-down picker-chevron" aria-hidden="true"></i>
    </button>
    <div class="picker-tags-wrap" id="picker-tags-measure">${tagsHtml}</div>
    <div class="picker-menu" role="listbox" id="picker-menu-measure">
      <div class="picker-search-wrap">
        <input type="text" class="picker-search-input" placeholder="Search measures..." aria-label="Search measure">
      </div>
      <div class="picker-options-list">
        ${optionsHtml}
        <div class="picker-no-results" style="display:none;">No matching measures</div>
      </div>
    </div>
  `;

  const trigger = container.querySelector('.picker-trigger');
  const menu = container.querySelector('.picker-menu');
  const searchInput = container.querySelector('.picker-search-input');
  const optionsList = container.querySelector('.picker-options-list');
  const noResults = container.querySelector('.picker-no-results');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = container.classList.contains('open');
    document.querySelectorAll('.custom-picker.open').forEach(p => {
      if (p !== container) {
        p.classList.remove('open');
        p.querySelector('.picker-trigger')?.setAttribute('aria-expanded', 'false');
      }
    });
    container.classList.toggle('open', !isOpen);
    trigger.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
    if (!isOpen && searchInput) {
      searchInput.value = '';
      optionsList.querySelectorAll('label').forEach(lbl => lbl.style.display = 'flex');
      if (noResults) noResults.style.display = 'none';
      setTimeout(() => searchInput.focus(), 50);
    }
  });

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    let visibleCount = 0;
    optionsList.querySelectorAll('label').forEach(lbl => {
      const txt = lbl.textContent.toLowerCase();
      const match = txt.includes(q);
      lbl.style.display = match ? 'flex' : 'none';
      if (match) visibleCount++;
    });
    if (noResults) {
      noResults.style.display = visibleCount === 0 ? 'block' : 'none';
    }
  });

  optionsList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      let selected = [...optionsList.querySelectorAll('input:checked')].map(i => i.value);
      if (!selected.length) {
        const defaultCb = optionsList.querySelector('input[value="finalpweight"]');
        if (defaultCb) {
          defaultCb.checked = true;
          selected = ['finalpweight'];
        }
      }
      filterState.measures = selected;
      filterState.measure = selected[0] || 'finalpweight';
      try {
        localStorage.setItem('livestock_last_measures', JSON.stringify(selected));
        localStorage.setItem('livestock_last_measure', filterState.measure);
      } catch (_) {}
      updateMeasurePickerUI(container);
      notifyFilterChange({ dimOnly: true });
    });
  });

  const tagsWrap = container.querySelector('.picker-tags-wrap');
  tagsWrap.addEventListener('click', (e) => {
    const removeBtn = e.target.closest('.picker-tag-remove');
    if (!removeBtn) return;
    e.stopPropagation();
    const valToRemove = removeBtn.dataset.remove;
    const targetCb = optionsList.querySelector(`input[value="${valToRemove}"]`);
    if (targetCb) {
      targetCb.checked = false;
    }
    let selected = [...optionsList.querySelectorAll('input:checked')].map(i => i.value);
    if (!selected.length) {
      const defaultCb = optionsList.querySelector('input[value="finalpweight"]');
      if (defaultCb) {
        defaultCb.checked = true;
        selected = ['finalpweight'];
      }
    }
    filterState.measures = selected;
    filterState.measure = selected[0] || 'finalpweight';
    try {
      localStorage.setItem('livestock_last_measures', JSON.stringify(selected));
      localStorage.setItem('livestock_last_measure', filterState.measure);
    } catch (_) {}
    updateMeasurePickerUI(container);
    notifyFilterChange({ dimOnly: true });
  });
}

function updateMeasurePickerUI(container) {
  const currentSelected = filterState.measures || ['finalpweight'];
  const triggerText = container.querySelector('.picker-trigger-text');
  if (triggerText) {
    if (currentSelected.length === 1) {
      triggerText.textContent = getMeasureLabel(currentSelected[0]);
    } else if (currentSelected.length > 1) {
      triggerText.textContent = `${currentSelected.length} measures selected`;
    } else {
      triggerText.textContent = 'Final processed weight (kg)';
    }
  }

  const tagsWrap = container.querySelector('.picker-tags-wrap');
  if (tagsWrap) {
    if (currentSelected.length > 1) {
      tagsWrap.innerHTML = currentSelected.map(opt => `<span class="picker-tag" data-val="${opt}">${getMeasureLabel(opt)} <button type="button" class="picker-tag-remove" data-remove="${opt}" aria-label="Remove ${getMeasureLabel(opt)}">&times;</button></span>`).join('');
    } else {
      tagsWrap.innerHTML = '';
    }
  }
}


if (!window.__pickerGlobalListenerInit) {
  window.__pickerGlobalListenerInit = true;
  document.addEventListener('click', (e) => {
    const selectAllBtn = e.target.closest('[data-select-all]');
    if (selectAllBtn) {
      e.preventDefault();
      selectAll(selectAllBtn.dataset.selectAll);
      return;
    }
    const invertBtn = e.target.closest('[data-invert]');
    if (invertBtn) {
      e.preventDefault();
      invertSelection(invertBtn.dataset.invert);
      return;
    }
    if (!e.target.closest('.custom-picker')) {
      document.querySelectorAll('.custom-picker.open').forEach(p => {
        p.classList.remove('open');
        p.querySelector('.picker-trigger')?.setAttribute('aria-expanded', 'false');
      });
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.custom-picker.open').forEach(p => {
        p.classList.remove('open');
        p.querySelector('.picker-trigger')?.setAttribute('aria-expanded', 'false');
      });
    }
  });
}

function renderSingleSelectPicker(containerId, field, rawOptions, currentValue, onSelect, withSearch = false) {
  const container = (typeof containerId === 'string' ? document.getElementById(containerId) : containerId) || document.getElementById(`picker-${field}`);
  if (!container) return;

  const options = rawOptions.map(opt => {
    if (typeof opt === 'object' && opt !== null) {
      const val = opt.key !== undefined ? opt.key : opt.value;
      const lbl = opt.label !== undefined ? opt.label : opt.name || String(val);
      return { value: val, label: lbl };
    }
    return { value: opt, label: String(opt) };
  });

  const activeOpt = options.find(o => String(o.value) === String(currentValue)) || options[0] || { value: '', label: '' };
  const currentLabel = activeOpt.label;

  const searchHtml = withSearch ? `
    <div class="picker-search-wrap">
      <input type="text" class="picker-search-input" placeholder="Search options..." aria-label="Search ${field}">
    </div>
  ` : '';

  const optionsHtml = options.map(opt => {
    const isSelected = String(opt.value) === String(currentValue);
    const checkmarkHtml = isSelected ? '<i class="fa fa-check picker-option-check" aria-hidden="true"></i>' : '';
    return `<div class="picker-option-item ${isSelected ? 'selected' : ''}" data-value="${opt.value}" role="option" aria-selected="${isSelected}"><span>${opt.label}</span>${checkmarkHtml}</div>`;
  }).join('');

  container.innerHTML = `
    <button type="button" class="picker-trigger" id="picker-btn-${field}" aria-haspopup="listbox" aria-expanded="false">
      <span class="picker-trigger-text">${currentLabel}</span>
      <i class="fa fa-chevron-down picker-chevron" aria-hidden="true"></i>
    </button>
    <div class="picker-menu" role="listbox" id="picker-menu-${field}">
      ${searchHtml}
      <div class="picker-options-list">
        ${optionsHtml}
        <div class="picker-no-results" style="display:none;">No matching options</div>
      </div>
    </div>
  `;

  const trigger = container.querySelector('.picker-trigger');
  const menu = container.querySelector('.picker-menu');
  const searchInput = container.querySelector('.picker-search-input');
  const optionsList = container.querySelector('.picker-options-list');
  const noResults = container.querySelector('.picker-no-results');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (container.classList.contains('disabled') || trigger.disabled) return;
    const isOpen = container.classList.contains('open');
    document.querySelectorAll('.custom-picker.open').forEach(p => {
      if (p !== container) {
        p.classList.remove('open');
        p.querySelector('.picker-trigger')?.setAttribute('aria-expanded', 'false');
      }
    });
    container.classList.toggle('open', !isOpen);
    trigger.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
    if (!isOpen && searchInput) {
      searchInput.value = '';
      optionsList.querySelectorAll('.picker-option-item').forEach(item => item.style.display = 'flex');
      if (noResults) noResults.style.display = 'none';
      setTimeout(() => searchInput.focus(), 50);
    }
  });

  menu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      let visibleCount = 0;
      optionsList.querySelectorAll('.picker-option-item').forEach(item => {
        const txt = item.textContent.toLowerCase();
        const match = txt.includes(q);
        item.style.display = match ? 'flex' : 'none';
        if (match) visibleCount++;
      });
      if (noResults) {
        noResults.style.display = visibleCount === 0 ? 'block' : 'none';
      }
    });
  }

  optionsList.querySelectorAll('.picker-option-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.dataset.value;
      const selectedOpt = options.find(o => String(o.value) === String(val));

      // Update trigger label
      const triggerText = trigger.querySelector('.picker-trigger-text');
      if (triggerText && selectedOpt) {
        triggerText.textContent = selectedOpt.label;
      }

      // Sync active classes and checkmark icons
      optionsList.querySelectorAll('.picker-option-item').forEach(optEl => {
        const isSelected = String(optEl.dataset.value) === String(val);
        optEl.classList.toggle('selected', isSelected);
        optEl.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        const existingCheck = optEl.querySelector('.picker-option-check');
        if (isSelected && !existingCheck) {
          optEl.insertAdjacentHTML('beforeend', '<i class="fa fa-check picker-option-check" aria-hidden="true"></i>');
        } else if (!isSelected && existingCheck) {
          existingCheck.remove();
        }
      });

      container.classList.remove('open');
      trigger.setAttribute('aria-expanded', 'false');

      if (searchInput) {
        searchInput.value = '';
        optionsList.querySelectorAll('.picker-option-item').forEach(it => it.style.display = 'flex');
        if (noResults) noResults.style.display = 'none';
      }

      if (onSelect) {
        onSelect(val);
      }
    });
  });
}

function updateSingleSelectPickerValue(field, value) {
  const container = document.getElementById(`picker-${field}`);
  if (!container) return;
  const triggerText = container.querySelector('.picker-trigger-text');
  const optionsList = container.querySelector('.picker-options-list');
  if (!optionsList) return;

  const targetItem = optionsList.querySelector(`.picker-option-item[data-value="${value}"]`);
  if (triggerText && targetItem) {
    const labelSpan = targetItem.querySelector('span');
    if (labelSpan) triggerText.textContent = labelSpan.textContent;
  }

  optionsList.querySelectorAll('.picker-option-item').forEach(optEl => {
    const isSelected = String(optEl.dataset.value) === String(value);
    optEl.classList.toggle('selected', isSelected);
    optEl.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    const existingCheck = optEl.querySelector('.picker-option-check');
    if (isSelected && !existingCheck) {
      optEl.insertAdjacentHTML('beforeend', '<i class="fa fa-check picker-option-check" aria-hidden="true"></i>');
    } else if (!isSelected && existingCheck) {
      existingCheck.remove();
    }
  });
}

function renderFilterUI() {
  if (!choices) return;

  if (choices.years && choices.years.length) {
    renderSingleSelectPicker('picker-year', 'year', choices.years, filterState.year, (val) => {
      filterState.year = parseInt(val);
      writeFarmYear(getFarmId(), filterState.year);
      debouncedQuery();
    }, false);
  }

  if (choices.months && choices.months.length) {
    renderSingleSelectPicker('picker-month', 'month', choices.months, filterState.month, (val) => {
      filterState.month = val;
      notifyFilterChange({ dimOnly: true });
    }, false);
  }

  if (choices.days && choices.days.length) {
    renderSingleSelectPicker('picker-day', 'day', choices.days, filterState.day, (val) => {
      filterState.day = val === 'All' ? 'All' : (isNaN(val) ? val : parseInt(val));
      notifyFilterChange({ dimOnly: true });
    }, true);
  }

  renderSearchablePicker('picker-sex', 'sex', choices.sexes);
  renderSearchablePicker('picker-treatment', 'treatment', choices.treatments);
  renderSearchablePicker('picker-breed', 'breed', choices.breeds);
  renderSearchablePicker('picker-mob', 'mob', choices.mobs);

  const user = getUser();
  const eidSection = document.getElementById('eid-section');
  if (eidSection) {
    eidSection.classList.toggle('hidden', !user?.is_admin);
    if (user?.is_admin && choices.eids) {
      renderSearchablePicker('picker-eid', 'eid', choices.eids);
    }
  }

  if (choices.measures && choices.measures.length) {
    renderMeasureMultiPicker('picker-measure', choices.measures);
  }

  renderSingleSelectPicker('picker-cohort-percentile', 'cohort_percentile', [
    { value: 10, label: '10%' },
    { value: 15, label: '15%' },
    { value: 20, label: '20%' },
  ], filterState.cohort_percentile || 10, (val) => {
    filterState.cohort_percentile = parseInt(val);
    notifyFilterChange({ dimOnly: false });
  }, false);

  // Active Herd On/Off toggle button and sub-pickers
  const activeToggleBtn = document.getElementById('btn-active-herd-toggle');
  const activeSuboptions = document.querySelectorAll('.active-herd-suboptions');
  if (activeToggleBtn) {
    const syncActiveUI = (isActive) => {
      activeToggleBtn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      activeToggleBtn.classList.toggle('active', isActive);
      activeToggleBtn.textContent = isActive ? 'On' : 'Off';
      activeToggleBtn.title = isActive ? 'Active herd filter enabled (click to disable)' : 'Active herd filter disabled (click to enable)';
      activeSuboptions.forEach(el => el.classList.toggle('disabled', !isActive));
    };

    syncActiveUI(Boolean(filterState.active_only));

    activeToggleBtn.onclick = () => {
      filterState.active_only = !filterState.active_only;
      syncActiveUI(Boolean(filterState.active_only));
      updateRecordCountBadge();
      notifyFilterChange({ dimOnly: false });
    };
  }

  renderSingleSelectPicker('picker-active-days', 'active_days', [
    { value: 7, label: '7d' },
    { value: 14, label: '14d' },
    { value: 30, label: '30d' },
  ], filterState.active_days || 30, (val) => {
    filterState.active_days = parseInt(val, 10) || 30;
    updateRecordCountBadge();
    syncActiveHerdBadgeLive();
    notifyFilterChange({ dimOnly: false });
  }, false);

  renderSingleSelectPicker('picker-active-ref', 'active_reference_mode', [
    { value: 'auto', label: 'Auto' },
    { value: 'max', label: 'Latest' },
    { value: 'today', label: 'Today' },
  ], filterState.active_reference_mode || 'auto', (val) => {
    filterState.active_reference_mode = val || 'auto';
    updateRecordCountBadge();
    syncActiveHerdBadgeLive();
    notifyFilterChange({ dimOnly: false });
  }, false);

  updateRecordCountBadge();
  syncActiveHerdBadgeLive();
  updateCohortPercentileModuleState();
}

let currentActiveModule = 'summary';

function updateCohortPercentileModuleState(activePage) {
  if (activePage) currentActiveModule = activePage;
  const section = document.getElementById('cohort-percentile-section');
  const picker = document.getElementById('picker-cohort-percentile');
  const trigger = document.getElementById('picker-btn-cohort_percentile');
  const hint = document.getElementById('cohort-percentile-hint');
  if (!section) return;
  const isRelevant = ['cohorts', 'reports'].includes(currentActiveModule);
  if (isRelevant) {
    section.style.opacity = '1';
    section.style.pointerEvents = 'auto';
    if (picker) picker.classList.remove('disabled');
    if (trigger) {
      trigger.disabled = false;
      trigger.title = '';
    }
    if (hint) hint.style.display = 'none';
  } else {
    section.style.opacity = '0.45';
    section.style.pointerEvents = 'none';
    if (picker) {
      picker.classList.add('disabled');
      picker.classList.remove('open');
    }
    if (trigger) {
      trigger.disabled = true;
      trigger.title = 'Applies to Cohorts and Reports modules only';
    }
    if (hint) hint.style.display = 'block';
  }
}

function selectAll(field) {
  if (!choices) return;
  if (field === 'measure') {
    const all = (choices.measures || []).map(m => m.key || m.value || m);
    filterState.measures = all.length ? [...all] : ['finalpweight'];
    filterState.measure = filterState.measures[0] || 'finalpweight';
    renderFilterUI();
    notifyFilterChange({ dimOnly: true });
    return;
  }
  const map = { sex: 'sexes', treatment: 'treatments', breed: 'breeds', mob: 'mobs', eid: 'eids' };
  const allChoices = choices[map[field]] || [];
  filterState[field] = allChoices.length ? [...allChoices] : ['Overall'];
  renderFilterUI();
  notifyFilterChange({ dimOnly: field !== 'eid' });
}

function invertSelection(field) {
  if (!choices) return;
  if (field === 'measure') {
    const all = (choices.measures || []).map(m => m.key || m.value || m);
    const currentSet = new Set(filterState.measures || ['finalpweight']);
    let inverted = all.filter(v => !currentSet.has(v));
    if (!inverted.length) inverted = ['finalpweight'];
    filterState.measures = inverted;
    filterState.measure = filterState.measures[0] || 'finalpweight';
    renderFilterUI();
    notifyFilterChange({ dimOnly: true });
    return;
  }
  const map = { sex: 'sexes', treatment: 'treatments', breed: 'breeds', mob: 'mobs', eid: 'eids' };
  const allChoices = choices[map[field]] || [];
  const currentSet = new Set(filterState[field] || ['Overall']);
  let inverted = allChoices.filter(v => !currentSet.has(v));
  if (!inverted.length) inverted = ['Overall'];
  filterState[field] = inverted;
  renderFilterUI();
  notifyFilterChange({ dimOnly: field !== 'eid' });
}

function resetFiltersForFarm() {
  filterState = defaultFilters();
  choices = null;
  queryResult = null;
  window.__bootSummary = null;
}

function getFarmBootCache(farmId) {
  return farmId ? farmBootCache[farmId] || null : null;
}

function storeFarmBoot(farmId, boot, measure) {
  if (!farmId || !boot?.choices) return;
  farmBootCache[farmId] = {
    choices: boot.choices,
    summary: boot.summary || null,
    measure: measure || 'finalpweight',
  };
}

function applyFarmBoot(boot, measureHint, farmId) {
  choices = boot.choices;
  window.__bootSummary = boot.summary || null;
  const preferredYear = readFarmYear(farmId);
  if (preferredYear && Array.isArray(choices.years) && choices.years.includes(preferredYear)) {
    filterState.year = preferredYear;
  } else if (choices?.max_year) {
    filterState.year = choices.max_year;
  }
  if (filterState.year != null) writeFarmYear(farmId, filterState.year);
  try { localStorage.setItem('livestock_last_measure', measureHint); } catch (_) { /* ignore */ }
  filterState.measure = measureHint;
  if (!filterState.measures?.length) filterState.measures = [measureHint];
  renderFilterUI();
}

async function fetchFarmBoot(farmId, measureHint) {
  if (farmBootInflight[farmId]) return farmBootInflight[farmId];
  farmBootInflight[farmId] = (async () => {
    const boot = await apiFetch(
      `/filters/bootstrap?farm_id=${encodeURIComponent(farmId)}&measure=${encodeURIComponent(measureHint)}`,
    );
    storeFarmBoot(farmId, boot, measureHint);
    return boot;
  })();
  try {
    return await farmBootInflight[farmId];
  } finally {
    delete farmBootInflight[farmId];
  }
}

function prefetchOtherFarmBoots(currentFarmId, measureHint) {
  const farms = getUser()?.farms || [];
  for (const farm of farms) {
    const farmId = farm?.farm_id;
    if (!farmId || farmId === currentFarmId || farmBootCache[farmId]) continue;
    fetchFarmBoot(farmId, measureHint).then((boot) => {
      const year = boot?.choices?.max_year;
      if (!year || typeof ensureScopeGrain !== 'function') return;
      return ensureScopeGrain({
        farm_id: farmId,
        year,
        month: 'All',
        day: 'All',
        measure: measureHint,
        measures: [measureHint],
        sex: ['Overall'],
        treatment: ['Overall'],
        breed: ['Overall'],
        mob: ['Overall'],
        eid: ['Overall'],
      });
    }).catch(() => {});
  }
}

function clearAllFilters() {
  filterState = defaultFilters();
  if (choices?.max_year) filterState.year = choices.max_year;
  renderFilterUI();
  debouncedQuery();
  showToast('Filters cleared', 'success');
}

function notifyFilterChange(options = {}) {
  if (onFilterChange) onFilterChange(options);
}

async function runQuery(options = {}) {
  const { render = true, dimOnly = false } = options;
  try {
    if (render && onFilterChange) {
      onFilterChange({ dimOnly });
      return;
    }
    queryResult = await apiFetch('/data/query', {
      method: 'POST',
      body: JSON.stringify({ ...getFilterPayload(), include_rows: false }),
    });
    updateRecordCountBadge(
      queryResult.record_count,
      queryResult.total_records,
      queryResult.active_animal_count,
      queryResult.total_animal_count
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
}

const debouncedQuery = debounce(() => runQuery({ render: true, dimOnly: false }), 120);

function getQueryResult() { return queryResult; }
function getFilters() { return getFilterPayload(); }
function getFilterState() { return filterState; }

function setFilterState(state) {
  filterState = { ...defaultFilters(), ...state };
  renderFilterUI();
  debouncedQuery();
}

async function initFilters(callback, bootCache = null) {
  onFilterChange = callback;
  const requestId = ++choicesRequest;

  const farmId = getFarmId();
  const measureHint = localStorage.getItem('livestock_last_measure') || filterState.measure || 'finalpweight';
  const cached = farmBootCache[farmId];

  // Warm path: reuse the last bootstrap for this farm so switches paint immediately.
  if (cached?.choices) {
    if (requestId !== choicesRequest) return;
    applyFarmBoot(cached, measureHint, farmId);
    if (onFilterChange) onFilterChange({ dimOnly: false });
    if (choices?.total_records != null) {
      updateRecordCountBadge(choices.total_records, choices.total_records);
    }
    if (typeof ensureScopeGrain === 'function') {
      ensureScopeGrain(getFilters()).then(() => {
        if (typeof scheduleMeasureGrainPrefetch === 'function') scheduleMeasureGrainPrefetch();
      }).catch(() => {});
    }
    // Refresh quietly; only re-paint if this farm is still selected.
    fetchFarmBoot(farmId, measureHint).then((boot) => {
      if (requestId !== choicesRequest || getFarmId() !== farmId) return;
      const prevTotal = choices?.total_records;
      applyFarmBoot(boot, measureHint, farmId);
      if (boot.choices?.total_records != null && boot.choices.total_records !== prevTotal) {
        updateRecordCountBadge(boot.choices.total_records, boot.choices.total_records);
      }
    }).catch(() => {});
    prefetchOtherFarmBoots(farmId, measureHint);
    const clearBtnWarm = document.getElementById('clear-filters');
    if (clearBtnWarm && !clearBtnWarm.dataset.bound) {
      clearBtnWarm.dataset.bound = '1';
      clearBtnWarm.addEventListener('click', clearAllFilters);
    }
    return;
  }

  try {
    const boot = await fetchFarmBoot(farmId, measureHint);
    if (requestId !== choicesRequest) return;
    applyFarmBoot(boot, measureHint, farmId);
  } catch (_) {
    if (requestId !== choicesRequest) return;
    const yearHint = readFarmYear(farmId) || Number(localStorage.getItem('livestock_last_year')) || 2023;
    if (!filterState.year) filterState.year = yearHint;
    await loadChoices(bootCache);
    if (choices?.max_year) {
      filterState.year = choices.max_year;
      writeFarmYear(farmId, choices.max_year);
    }
    window.__bootSummary = null;
  }

  if (onFilterChange) onFilterChange({ dimOnly: false });
  if (choices?.total_records != null) {
    updateRecordCountBadge(choices.total_records, choices.total_records);
  }
  // Prefetch year grain in background for month/day/measure + timeseries.
  if (typeof ensureScopeGrain === 'function') {
    ensureScopeGrain(getFilters()).then(() => {
      if (typeof scheduleMeasureGrainPrefetch === 'function') scheduleMeasureGrainPrefetch();
    }).catch(() => {});
  }
  prefetchOtherFarmBoots(farmId, measureHint);
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn && !clearBtn.dataset.bound) {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', clearAllFilters);
  }
}

window.initFilters = initFilters;
window.getFilters = getFilters;
window.getFilterState = getFilterState;
window.setFilterState = setFilterState;
window.getQueryResult = getQueryResult;
window.clearAllFilters = clearAllFilters;
window.resetFiltersForFarm = resetFiltersForFarm;
window.getFarmBootCache = getFarmBootCache;
window.prefetchOtherFarmBoots = prefetchOtherFarmBoots;
window.runQuery = runQuery;
window.updateRecordCountBadge = updateRecordCountBadge;
window.updateCohortPercentileModuleState = updateCohortPercentileModuleState;
window.updateSingleSelectPickerValue = updateSingleSelectPickerValue;
window.renderSingleSelectPicker = renderSingleSelectPicker;
