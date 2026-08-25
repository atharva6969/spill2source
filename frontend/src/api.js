export async function getJSON(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: ${r.status}`)
  return r.json()
}

export async function postJSON(url) {
  const r = await fetch(url, { method: 'POST' })
  if (!r.ok) {
    const detail = await r.json().catch(() => ({}))
    throw new Error(detail.detail || `${url}: ${r.status}`)
  }
  return r.json()
}

export const EP = {
  status: '/api/status',
  vesselsLive: '/api/vessels/live',
  track: (mmsi, hours = 12) => `/api/vessels/${mmsi}/track?hours=${hours}`,
  scenes: '/api/scenes',
  scanScene: (pid) => `POST /api/scenes/${pid}/scan`,
  slicks: '/api/slicks',
  slickDetail: (id) => `/api/slicks/${id}`,
  analyzeSlick: (id) => `/api/slicks/${id}/analyze`,
  events: '/api/events',
}
