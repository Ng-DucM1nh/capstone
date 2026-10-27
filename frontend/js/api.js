// Local dev: same-origin on :8000, or frontend :3000 → API :8000
function resolveApiBase() {
  if (window.API_URL) return window.API_URL;
  const host = window.location.hostname;
  const port = window.location.port;
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (isLocal && port === '8000') return '/api';
  if (isLocal && port && port !== '8000') {
    const apiHost = host === '[::1]' ? 'localhost' : host;
    return `http://${apiHost}:8000/api`;
  }
  return '/api';
}
const API_BASE = resolveApiBase();

// Prefix same-site API-relative asset URLs (logo bytes served by the API)
function resolveAssetUrl(url) {
  if (!url) return url;
  if (url.startsWith('/api/')) {
    if (API_BASE.startsWith('http://') || API_BASE.startsWith('https://')) {
      const origin = API_BASE.replace(/\/api\/?$/, '');
      return `${origin}${url}`;
    }
    return url;
  }
  return url;
}
window.resolveAssetUrl = resolveAssetUrl;

// Server misconfiguration the user cannot fix (e.g. EID_PSEUDONYM_KEY missing): show the
// server's message in a banner on every page, for users and for whoever deploys the app.
const CONFIG_ERROR_CODES = new Set(['EID_PSEUDONYM_KEY_MISSING']);

function showConfigErrorBanner(message) {
  if (document.getElementById('config-error-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'config-error-banner';
  banner.setAttribute('role', 'alert');
  banner.style.cssText = [
    'position:sticky', 'top:0', 'z-index:10000', 'padding:12px 16px', 'background:#8b1e1e',
    'color:#fff', 'font:14px/1.5 system-ui,sans-serif', 'box-shadow:0 2px 6px rgba(0,0,0,.25)',
  ].join(';');
  const title = document.createElement('strong');
  title.textContent = 'The dashboard is unavailable: the server is misconfigured. Please contact your administrator. ';
  const detail = document.createElement('div');
  detail.style.cssText = 'margin-top:4px;font-family:ui-monospace,monospace;font-size:13px;opacity:.95';
  detail.textContent = `For developers: ${message}`;
  banner.append(title, detail);
  document.body.prepend(banner);
}

async function checkConfigError(res) {
  if (res.status !== 503) return;
  const body = await res.clone().json().catch(() => null);
  if (body && CONFIG_ERROR_CODES.has(body.code)) showConfigErrorBanner(body.detail);
}

async function apiFetch(path, options = {}) {
  const token = sessionStorage.getItem('access_token');
  const headers = { ...options.headers };
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const { signal, ...rest } = options;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...rest, headers, signal });

  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error(
      'Cannot reach the API. Run: cd backend && uvicorn app.main:app --reload --port 8000 then open http://localhost:8000/login.html'
    );
  }
  if (res.status === 401) {
    sessionStorage.removeItem('access_token');
    if (!window.location.pathname.includes('login')) {
      window.location.href = '/login.html';
    }
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (CONFIG_ERROR_CODES.has(err.code)) showConfigErrorBanner(err.detail);
    const detail = err.detail;
    let message = 'Request failed';
    if (typeof detail === 'string') message = detail;
    else if (Array.isArray(detail)) {
      message = detail.map(e => e.msg || e.message || JSON.stringify(e)).join('; ');
    } else if (detail && typeof detail === 'object') {
      message = detail.msg || detail.message || JSON.stringify(detail);
    }
    throw new Error(message);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res;
}

async function apiDownload(path, filename) {
  const token = sessionStorage.getItem('access_token');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let msg = 'Download failed';
    try {
      const err = await res.json();
      if (err.detail) msg = typeof err.detail === 'string' ? err.detail : msg;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function apiPostDownload(path, body, filename) {
  const token = sessionStorage.getItem('access_token');
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

window.checkConfigError = checkConfigError;
window.apiFetch = apiFetch;
window.apiDownload = apiDownload;
window.apiPostDownload = apiPostDownload;
window.API_BASE = API_BASE;
