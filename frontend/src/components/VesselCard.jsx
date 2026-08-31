import { useState, useEffect } from 'react'

function utc(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${d.toLocaleString('en-US', { month: 'short' })} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

function ago(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function hydro(lat, lon) {
  const f = (v, pos, neg) => {
    const d = Math.floor(Math.abs(v))
    const m = (Math.abs(v) - d) * 60
    return `${String(d).padStart(2, '0')}°${m.toFixed(1)}′${v >= 0 ? pos : neg}`
  }
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`
}

function SpeedSparkline({ series }) {
  if (!series || series.length < 3) return null
  const w = 320, h = 48
  const t0 = series[0][0], t1 = series[series.length - 1][0]
  const smax = Math.max(16, ...series.map((s) => s[1]))
  const pts = series
    .map(
      ([t, v]) =>
        `${(((t - t0) / Math.max(t1 - t0, 1)) * w).toFixed(1)},` +
        `${(h - (v / smax) * h).toFixed(1)}`
    )
    .join(' ')
  return (
    <div className="spark-box">
      <div className="spark-hdr">
        <span className="spark-title">SPEED OVER TIME PROFILE (24H)</span>
        <span className="mono dim">MAX {smax.toFixed(1)} KN</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="speed profile graph">
        <defs>
          <linearGradient id="speedGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#38BDF8" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <polygon points={`0,${h} ${pts} ${w},${h}`} fill="url(#speedGrad)" />
        <polyline points={pts} fill="none" stroke="#38BDF8" strokeWidth="1.5" />
      </svg>
    </div>
  )
}

export default function VesselCard({ details, onShowTrack, onClose }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000)
    return () => clearInterval(t)
  }, [])
  if (!details) return null
  const h = details.history || {}
  const live = details.live

  return (
    <aside className="panel right vessel-panel">
      <div className="detail-head">
        <div>
          <div className="target-badge-row">
            <span className="target-tag tag-vessel">AIS VESSEL PROFILE</span>
            <span className="vsl-flag-chip">{details.flag || 'INTERNATIONAL'}</span>
          </div>
          <h2 className="vsl-name">
            <span className="vsl-icon-svg" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 19 21 12 17 5 21 12 2" />
              </svg>
            </span>
            {details.name || `MMSI ${details.mmsi}`}
          </h2>
          <p className="mono dim">{details.type_label || 'Vessel'}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">✕</button>
      </div>

      <section className="kv-grid">
        <div className="kv-item">
          <span>MMSI</span>
          <b className="mono">{details.mmsi}</b>
        </div>
        <div className="kv-item">
          <span>IMO NUMBER</span>
          <b className="mono">{details.imo || '—'}</b>
        </div>
        <div className="kv-item">
          <span>CALL SIGN</span>
          <b className="mono">{details.call_sign || '—'}</b>
        </div>
        <div className="kv-item">
          <span>DIMENSIONS</span>
          <b className="mono">
            {details.length && details.width
              ? `${details.length} × ${details.width} m`
              : '—'}
          </b>
        </div>
        <div className="kv-item">
          <span>DRAUGHT</span>
          <b className="mono">{details.draught ? `${details.draught} m` : '—'}</b>
        </div>
        <div className="kv-item">
          <span>DESTINATION</span>
          <b className="mono">{details.destination || '—'}</b>
        </div>
      </section>

      {live && (
        <section className="live-telemetry-box">
          <div className="live-box-hdr">
            <span>LIVE FIX TELEMETRY</span>
            <span className="live-status-pill">{live.nav_status}</span>
          </div>
          <div className="live-stats-row">
            <div className="stat-unit">
              <span className="unit-label">SPEED OVER GROUND</span>
              <b className="unit-val mono">{live.sog ?? '—'} <small>KN</small></b>
            </div>
            <div className="stat-unit">
              <span className="unit-label">COURSE</span>
              <b className="unit-val mono">{live.cog ?? '—'}°</b>
            </div>
            <div className="stat-unit">
              <span className="unit-label">LAST POSITION</span>
              <b className="unit-val mono small">{hydro(live.lat, live.lon)}</b>
            </div>
          </div>
          <span className="live-update-tag mono">Fix reported {ago(live.ts)}</span>
        </section>
      )}

      {h.speed_series?.length > 3 && <SpeedSparkline series={h.speed_series} />}

      <section className="kv-grid hist-grid">
        <div className="kv-item">
          <span>FIRST RECORDED</span>
          <b className="mono">{utc(h.first_seen)}</b>
        </div>
        <div className="kv-item">
          <span>RECEIVED FIXES</span>
          <b className="mono">{h.positions ?? '—'}</b>
        </div>
        <div className="kv-item">
          <span>SAILED (24H)</span>
          <b className="mono">{h.distance_24h_km ?? '—'} km</b>
        </div>
        <div className="kv-item">
          <span>AVG / MAX SPEED</span>
          <b className="mono">
            {h.avg_speed != null ? `${h.avg_speed} / ${h.max_speed} kn` : '—'}
          </b>
        </div>
        <div className="kv-item">
          <span>STOPS (≥15 MIN)</span>
          <b className="mono">{h.stops?.length ?? 0}</b>
        </div>
        <div className="kv-item">
          <span>DARK GAPS (&gt;30 MIN)</span>
          <b className="mono">{h.dark_gaps ?? '—'}</b>
        </div>
      </section>

      {h.stops?.length > 0 && (
        <div className="stops-box">
          <span className="stops-title">RECORDED DRIFT / STOP EVENTS</span>
          <ul className="stops-list">
            {h.stops.slice(0, 3).map((s, i) => (
              <li key={i} className="mono dim">
                • {s.minutes} min stop @ {s.lat.toFixed(2)}°N {s.lon.toFixed(2)}°E
              </li>
            ))}
          </ul>
        </div>
      )}

      <button
        className="btn btn-primary-action"
        onClick={() => onShowTrack(details.mmsi)}>
        <span>DISPLAY 18-HOUR AIS TRACK</span>
      </button>
    </aside>
  )
}
