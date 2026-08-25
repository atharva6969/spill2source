function utc(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${d.toLocaleString('en', { month: 'short' })} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
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
  const w = 300, h = 46
  const t0 = series[0][0], t1 = series[series.length - 1][0]
  const smax = Math.max(16, ...series.map((s) => s[1]))
  const pts = series.map(([t, v]) =>
    `${(((t - t0) / Math.max(t1 - t0, 1)) * w).toFixed(1)},` +
    `${(h - (v / smax) * h).toFixed(1)}`).join(' ')
  return (
    <div className="spark">
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
           aria-label="speed over time">
        <polyline points={pts} fill="none" stroke="var(--cyan)"
                  strokeWidth="1.6" />
      </svg>
      <span className="mono dim">speed kn · max {smax.toFixed(0)}</span>
    </div>
  )
}

export default function VesselCard({ details, onShowTrack, onClose }) {
  if (!details) return null
  const h = details.history || {}
  const live = details.live
  return (
    <aside className="panel right">
      <div className="detail-head">
        <div>
          <h2 className="vsl-name">
            <span className="vsl-icon" aria-hidden="true">{details.type_icon}</span>
            {details.name || `MMSI ${details.mmsi}`}
          </h2>
          <p className="mono dim">
            {details.type_label} · {details.flag}
          </p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <section className="kv">
        <div><span>MMSI</span><b className="mono">{details.mmsi}</b></div>
        <div><span>IMO</span><b className="mono">{details.imo || '—'}</b></div>
        <div><span>Call sign</span><b className="mono">{details.call_sign || '—'}</b></div>
        <div>
          <span>Size</span>
          <b className="mono">
            {details.length && details.width
              ? `${details.length} × ${details.width} m` : '—'}
          </b>
        </div>
        <div><span>Draught</span><b className="mono">{details.draught ? `${details.draught} m` : '—'}</b></div>
        <div><span>Destination</span><b className="mono">{details.destination || '—'}</b></div>
      </section>

      {live && (
        <section className="live-block">
          <div className="live-row">
            <span className="live-num mono">{live.sog ?? '—'}<small> kn</small></span>
            <span className="live-num mono">{live.cog ?? '—'}<small>°</small></span>
            <span className="live-num mono">{hydro(live.lat, live.lon)}</span>
          </div>
          <p className="mono dim">
            {live.nav_status} · report {ago(live.ts)}
          </p>
        </section>
      )}

      {h.speed_series?.length > 3 && <SpeedSparkline series={h.speed_series} />}

      <section className="kv hist">
        <div><span>First seen</span><b className="mono">{utc(h.first_seen)}</b></div>
        <div><span>Positions</span><b className="mono">{h.positions ?? '—'}</b></div>
        <div><span>Sailed (24 h)</span><b className="mono">{h.distance_24h_km ?? '—'} km</b></div>
        <div>
          <span>Speed avg/max</span>
          <b className="mono">
            {h.avg_speed != null ? `${h.avg_speed} / ${h.max_speed} kn` : '—'}
          </b>
        </div>
        <div><span>Stops ≥15 min</span><b className="mono">{h.stops?.length ?? 0}</b></div>
        <div><span>Dark gaps &gt;30 min</span><b className="mono">{h.dark_gaps ?? '—'}</b></div>
      </section>

      {h.stops?.length > 0 && (
        <ul className="stops">
          {h.stops.slice(0, 3).map((s, i) => (
            <li key={i} className="mono dim">
              stop · {s.minutes} min · {s.lat.toFixed(2)}°N {s.lon.toFixed(2)}°E
            </li>
          ))}
        </ul>
      )}

      <button className="btn" onClick={() => onShowTrack(details.mmsi)}>
        Show 18 h track on chart
      </button>
    </aside>
  )
}
