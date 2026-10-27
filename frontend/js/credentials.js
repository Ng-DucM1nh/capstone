function canManageCredentials() {
  const user = getUser();
  return Boolean(user && user.is_admin && String(user.username).toLowerCase() !== 'owner');
}

function escapeCred(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let credentialUsers = [];

function setCredentialMessage(text, kind) {
  const el = document.getElementById('credentials-message');
  if (!el) return;
  if (!text) {
    el.textContent = '';
    el.classList.add('hidden');
    el.classList.remove('error', 'success');
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden', 'error', 'success');
  if (kind) el.classList.add(kind);
}

function showCredentialPanel(name) {
  document.querySelectorAll('[data-cred-panel]').forEach((btn) => {
    const active = btn.dataset.credPanel === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.getElementById('cred-panel-view')?.classList.toggle('hidden', name !== 'view');
  document.getElementById('cred-panel-username')?.classList.toggle('hidden', name !== 'username');
  document.getElementById('cred-panel-password')?.classList.toggle('hidden', name !== 'password');
  setCredentialMessage('');
}

function fillCredentialSelects() {
  const options = credentialUsers.map((user) => (
    `<option value="${escapeCred(user.id)}">${escapeCred(user.username)}</option>`
  )).join('');
  const usernameSelect = document.getElementById('cred-username-user');
  const passwordSelect = document.getElementById('cred-password-user');
  if (usernameSelect) usernameSelect.innerHTML = options;
  if (passwordSelect) passwordSelect.innerHTML = options;
}

function renderCredentialUsers() {
  const body = document.getElementById('credentials-user-rows');
  if (!body) return;
  if (!credentialUsers.length) {
    body.innerHTML = '<tr><td colspan="4">No users found</td></tr>';
    return;
  }
  body.innerHTML = credentialUsers.map((user) => `
    <tr>
      <td>${escapeCred(user.id)}</td>
      <td>${escapeCred(user.username)}</td>
      <td>Hidden</td>
      <td>${escapeCred(user.role === 'admin' ? 'Admin' : 'User')}</td>
    </tr>
  `).join('');
  fillCredentialSelects();
}

async function loadCredentialUsers() {
  credentialUsers = await apiFetch('/admin/credentials/users');
  renderCredentialUsers();
}

function closeCredentials() {
  document.getElementById('credentials-modal')?.classList.add('hidden');
  setCredentialMessage('');
}

async function openCredentials() {
  if (!canManageCredentials()) return;
  const modal = document.getElementById('credentials-modal');
  if (!modal) return;
  showCredentialPanel('view');
  modal.classList.remove('hidden');
  try {
    await loadCredentialUsers();
  } catch (err) {
    setCredentialMessage(err.message || 'Could not load users', 'error');
  }
}

function initCredentials() {
  const button = document.getElementById('credentials-btn');
  if (button && canManageCredentials()) button.classList.remove('hidden');

  button?.addEventListener('click', () => { openCredentials(); });
  document.getElementById('credentials-close')?.addEventListener('click', closeCredentials);
  document.querySelectorAll('[data-cred-panel]').forEach((btn) => {
    btn.addEventListener('click', () => showCredentialPanel(btn.dataset.credPanel));
  });

  document.getElementById('cred-panel-username')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = Number(document.getElementById('cred-username-user')?.value);
    const newUsername = document.getElementById('cred-username-new')?.value || '';
    setCredentialMessage('');
    try {
      const result = await apiFetch('/admin/credentials/username', {
        method: 'PUT',
        body: JSON.stringify({ user_id: userId, new_username: newUsername }),
      });
      const sessionUser = getUser();
      if (sessionUser && sessionUser.id === userId) {
        sessionUser.username = result.username;
        sessionStorage.setItem('user', JSON.stringify(sessionUser));
      }
      document.getElementById('cred-username-new').value = '';
      await loadCredentialUsers();
      setCredentialMessage(`Username updated to ${result.username}`, 'success');
    } catch (err) {
      setCredentialMessage(err.message || 'Could not update username', 'error');
    }
  });

  document.getElementById('cred-panel-password')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const userId = Number(document.getElementById('cred-password-user')?.value);
    const newPassword = document.getElementById('cred-password-new')?.value || '';
    setCredentialMessage('');
    try {
      await apiFetch('/admin/credentials/password', {
        method: 'PUT',
        body: JSON.stringify({ user_id: userId, new_password: newPassword }),
      });
      document.getElementById('cred-password-new').value = '';
      const selected = credentialUsers.find((user) => user.id === userId);
      setCredentialMessage(`Password updated for ${selected?.username || 'that user'}`, 'success');
    } catch (err) {
      setCredentialMessage(err.message || 'Could not update password', 'error');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !document.getElementById('credentials-modal')?.classList.contains('hidden')) {
      closeCredentials();
    }
  });
}

document.addEventListener('DOMContentLoaded', initCredentials);

window.openCredentials = openCredentials;
window.closeCredentials = closeCredentials;
