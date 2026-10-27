// Farm Branding & Logo Management Modal

function canManageBranding() {
  const user = typeof getUser === 'function' ? getUser() : null;
  return Boolean(user && user.is_admin);
}

function getActiveBrandingFarm() {
  const select = document.getElementById('farm-select');
  if (select && select.value) return select.value;
  return typeof getFarmId === 'function' ? getFarmId() : 'KF';
}

function setBrandingMessage(msg, type = '') {
  const el = document.getElementById('branding-message');
  if (!el) return;
  if (!msg) {
    el.textContent = '';
    el.className = 'credentials-message hidden';
    return;
  }
  el.textContent = msg;
  el.className = `credentials-message ${type}`;
}

function closeBranding() {
  const modal = document.getElementById('branding-modal');
  if (modal) modal.classList.add('hidden');
  setBrandingMessage('');
  const fileInput = document.getElementById('modal-logo-file-input');
  if (fileInput) fileInput.value = '';
  const fileName = document.getElementById('modal-logo-file-name');
  if (fileName) fileName.textContent = 'No file chosen';
  const uploadBtn = document.getElementById('btn-modal-upload-logo');
  if (uploadBtn) uploadBtn.disabled = true;
}

async function openBranding() {
  if (!canManageBranding()) return;
  const modal = document.getElementById('branding-modal');
  if (!modal) return;

  const currentFarm = getActiveBrandingFarm();
  const labelEl = document.getElementById('branding-farm-label');
  if (labelEl) labelEl.textContent = currentFarm;

  setBrandingMessage('');
  modal.classList.remove('hidden');
  await loadBrandingGallery(currentFarm);
}

async function loadBrandingGallery(farmId) {
  const gallery = document.getElementById('branding-gallery');
  if (!gallery) return;

  gallery.innerHTML = '<div style="font-size: var(--text-base); color: var(--text-secondary); padding: 8px 0;">Loading branding assets...</div>';

  try {
    const data = await apiFetch(`/admin/farms/${encodeURIComponent(farmId)}/logos`);
    const logos = data.logos || [];

    if (logos.length === 0) {
      gallery.innerHTML = '<div style="font-size: var(--text-base); color: var(--text-secondary); padding: 8px 0;">No logos configured. Using system fallback.</div>';
      return;
    }

    gallery.innerHTML = logos.map((l) => `
      <div class="branding-logo-item">
        <img src="${escapeHtml(resolveAssetUrl(l.url))}" alt="${escapeHtml(l.filename)}" class="branding-logo-img">
        <div class="branding-logo-details">
          <span class="branding-logo-filename">${escapeHtml(l.filename)}</span>
          <span class="branding-logo-type">${l.is_default ? 'Partner default' : 'Farm custom'}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm btn-delete-modal-logo" data-filename="${escapeHtml(l.filename)}" title="Delete logo" style="margin-left: auto;">
          Delete
        </button>
      </div>
    `).join('');

    gallery.querySelectorAll('.btn-delete-modal-logo').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const fname = btn.dataset.filename;
        if (!fname) return;
        setBrandingMessage('');
        try {
          await apiFetch(`/admin/farms/${encodeURIComponent(farmId)}/logos/${encodeURIComponent(fname)}`, {
            method: 'DELETE',
          });
          setBrandingMessage(`Logo '${fname}' removed`, 'success');
          if (typeof loadFarmLogos === 'function') loadFarmLogos(farmId);
          await loadBrandingGallery(farmId);
        } catch (err) {
          setBrandingMessage(err.message || 'Failed to remove logo', 'error');
        }
      });
    });
  } catch (err) {
    gallery.innerHTML = '<div style="font-size: var(--text-base); color: var(--danger); padding: 8px 0;">Failed to load logos: ' + escapeHtml(err.message) + '</div>';
  }
}

function initBranding() {
  const button = document.getElementById('branding-btn');
  if (button && canManageBranding()) {
    button.classList.remove('hidden');
  }

  button?.addEventListener('click', () => {
    openBranding();
  });

  document.getElementById('branding-close')?.addEventListener('click', closeBranding);

  const modal = document.getElementById('branding-modal');
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeBranding();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      closeBranding();
    }
  });

  const fileInput = document.getElementById('modal-logo-file-input');
  const uploadBtn = document.getElementById('btn-modal-upload-logo');
  const fileNameSpan = document.getElementById('modal-logo-file-name');

  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) {
      if (fileNameSpan) fileNameSpan.textContent = file.name;
      if (uploadBtn) uploadBtn.disabled = false;
    } else {
      if (fileNameSpan) fileNameSpan.textContent = 'No file chosen';
      if (uploadBtn) uploadBtn.disabled = true;
    }
  });

  uploadBtn?.addEventListener('click', async () => {
    const file = fileInput?.files?.[0];
    if (!file) return;

    const currentFarm = getActiveBrandingFarm();
    const formData = new FormData();
    formData.append('file', file);

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    setBrandingMessage('');

    try {
      await apiFetch(`/admin/farms/${encodeURIComponent(currentFarm)}/logos`, {
        method: 'POST',
        body: formData,
      });
      setBrandingMessage('Logo uploaded successfully', 'success');
      fileInput.value = '';
      if (fileNameSpan) fileNameSpan.textContent = 'No file chosen';
      if (typeof loadFarmLogos === 'function') loadFarmLogos(currentFarm);
      await loadBrandingGallery(currentFarm);
    } catch (err) {
      setBrandingMessage(err.message || 'Failed to upload logo', 'error');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload logo';
    }
  });

  document.getElementById('btn-modal-reset-logos')?.addEventListener('click', async () => {
    const currentFarm = getActiveBrandingFarm();
    setBrandingMessage('');
    try {
      await apiFetch(`/admin/farms/${encodeURIComponent(currentFarm)}/logos/reset`, {
        method: 'POST',
      });
      setBrandingMessage('Reverted farm branding to partner defaults', 'success');
      if (typeof loadFarmLogos === 'function') loadFarmLogos(currentFarm);
      await loadBrandingGallery(currentFarm);
    } catch (err) {
      setBrandingMessage(err.message || 'Failed to reset logos', 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', initBranding);

window.openBranding = openBranding;
window.closeBranding = closeBranding;
