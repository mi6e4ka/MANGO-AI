const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

export function getTelegramUser() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user ?? null;
}

export function getTelegramHeaders() {
  const user = getTelegramUser();
  const headers = {};
  if (user?.id) headers['X-Telegram-Id'] = String(user.id);
  if (user?.username) headers['X-Telegram-Username'] = user.username;
  return headers;
}

export function b64ToImageSrc(b64) {
  if (!b64) return '';
  if (b64.startsWith('data:')) return b64;
  return `data:image/jpeg;base64,${b64}`;
}

export function imageUrl(mangoId, photoId) {
  if (!mangoId || !photoId) return '';
  return `${API_BASE}/api/image/${mangoId}/${photoId}`;
}

export function formatFoundBy(value) {
  if (value == null || value === '') return '—';
  const s = String(value);
  if (s.startsWith('@')) return s;
  if (/^\d+$/.test(s)) return `id:${s}`;
  return `@${s}`;
}

export function formatDateTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month} ${hours}:${minutes}`;
}

export async function fetchMangoes() {
  const res = await fetch(`${API_BASE}/api/mangoes`, {
    headers: getTelegramHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchMango(mangoId) {
  const res = await fetch(`${API_BASE}/api/mango/${mangoId}`, {
    headers: getTelegramHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

export async function analyzeMango(file) {
  const formData = new FormData();
  formData.append('file', file, `capture-${Date.now()}.jpg`);

  const res = await fetch(`${API_BASE}/api/analyze-mango`, {
    method: 'POST',
    body: formData,
    headers: getTelegramHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
