import { useState } from 'react'

const FACTOR_LABEL = {
  proximity: 'Closest Approach',
  crossing: 'Track Crosses Slick/Origin',
  speed_anomaly: 'Low-Speed / Drifting',
  ais_gap: 'AIS Silence (Dark Event)',
  type_prior: 'Vessel-Class Prior',
  course_align: 'Course vs Slick Axis',
  behavior_prior: 'Behaviour History',
}

function utc(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${d.toLocaleString('en-US', { month: 'short' })} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export default function SlickDetail({
  detail,
  selectedSlickId,
  onSelectVessel,
  onAnalyze,
  onClose,
}) {
  const [openRow, setOpenRow] = useState(null)

  if (!detail || !selectedSlickId) {
    return (
      <aside className="panel right empty-state">
        <div className="empty-state-box">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <p className="empty-title">No Feature Selected</p>
          <p className="empty-desc">
            Select a detected slick polygon on the chart or from the list to view trajectory hindcast and vessel attribution.
          </p>
        </div>
      </aside>
    )
  }

  const bw = detail.backward
  const fw = detail.forward
  const suspects = detail.suspects || []

  const locateAtRelease = (s) => {
    const rel = bw?.release_time
    if (!rel) return
    const qs = `from_ts=${rel - 3 * 3600}&to_ts=${rel + 3 * 3600}`
    fetch(`/api/vessels/${s.mmsi}/track?${qs}`)
      .then((r) => r.json())
      .then((tr) => {
        if (!tr.points?.length) return
        window.dispatchEvent(
          new CustomEvent('vessel-track', {
            detail: { ...tr, highlight_ts: rel, name: s.name || `MMSI ${s.mmsi}` },
          })
        )
      })
      .catch(() => {})
  }

  return (
    <aside className="panel right">
      <div className="detail-head">
        <div>
          <div className="target-badge-row">
            <span className="target-tag">DETECTION TARGET</span>
            <h2>SLICK #{detail.id}</h2>
          </div>
          <p className="mono dim scene-id-sub">{detail.scene_name?.replace('.SAFE', '')}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close panel">✕</button>
      </div>

      <section className="props-grid">
        <div className="prop-card">
          <span className="prop-lbl">SURFACE AREA</span>
          <b className="prop-val mono">{detail.area_km2} <small>km²</small></b>
        </div>
        <div className="prop-card">
          <span className="prop-lbl">DETECTION CONFIDENCE</span>
          <b className="prop-val mono">{Number(detail.confidence * 100).toFixed(0)}%</b>
        </div>
        <div className="prop-card">
          <span className="prop-lbl">ESTIMATED SLICK AGE</span>
          <b className="prop-val mono">
            {detail.age_estimate_h != null ? `~${Number(detail.age_estimate_h).toFixed(1)} h` : '—'}
          </b>
        </div>
        <div className="prop-card">
          <span className="prop-lbl">ORIGIN UNCERTAINTY</span>
          <b className="prop-val mono">
            {bw ? `±${Number(bw.origin_sigma_km).toFixed(1)} km` : '—'}
          </b>
        </div>
      </section>

      <section className="origin-banner mono">
        <div className="origin-banner-hdr">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
          </svg>
          <span>HINDCAST RELEASE ORIGIN</span>
        </div>
        {bw ? (
          <div className="origin-details">
            <div><b>RELEASE TIME:</b> {utc(bw.release_time)}</div>
            <div><b>ESTIMATED POS:</b> {bw.origin_lat?.toFixed(4)}°N {bw.origin_lon?.toFixed(4)}°E</div>
          </div>
        ) : (
          <div className="origin-details">Trajectory calculation pending</div>
        )}
      </section>

      <button className="btn btn-primary-action" onClick={onAnalyze}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        <span>RUN HINDCAST & ATTRIBUTION</span>
      </button>

      <div className="sect-hdr">
        <h3 className="sect-title">ATTRIBUTION CANDIDATE RANKING</h3>
        <span className="sect-count mono">{suspects.length} RANKED</span>
      </div>

      <ol className="suspects-list">
        {suspects.length === 0 && (
          <div className="empty-state-box inline">
            <p className="empty-title">No Candidates Scored</p>
            <p className="empty-desc">No AIS vessel fixes correlated within the release window.</p>
          </div>
        )}
        {suspects.map((s) => (
          <li key={s.mmsi} className={`suspect-card ${openRow === s.mmsi ? 'open' : ''}`}>
            <div
              className="suspect-main-row"
              onClick={() => {
                setOpenRow(openRow === s.mmsi ? null : s.mmsi)
                onSelectVessel(s.mmsi)
              }}>
              <span className={`rank-badge mono ${s.rank <= 3 ? `top-${s.rank}` : ''}`}>#{s.rank}</span>
              <div className="vessel-summary">
                <b className="vessel-title">{s.name || `MMSI ${s.mmsi}`}</b>
                <span className="vessel-meta mono dim">
                  {s.min_dist_km} km dist · {s.n_fixes} fixes {s.length ? `· ${s.length}m` : ''}
                </span>
              </div>
              <div className="suspect-score-box">
                <div className="score-meter">
                  <div className="score-meter-fill" style={{ width: `${Math.min(100, s.score)}%` }} />
                </div>
                <b className="mono score-val">{s.score.toFixed(0)}</b>
              </div>
            </div>

            <div className="suspect-actions">
              <button
                className="locate-btn mono"
                title="Show vessel position at estimated release time"
                onClick={(e) => {
                  e.stopPropagation()
                  locateAtRelease(s)
                }}>
                FOCUS POSITION AT RELEASE
              </button>
            </div>

            {openRow === s.mmsi && (
              <div className="factors-panel">
                <span className="factors-hdr">SCORE BREAKDOWN & EVIDENCE</span>
                {Object.entries(s.factors).map(([k, v]) => (
                  <div key={k} className="factor-row">
                    <span className="flabel">{FACTOR_LABEL[k] || k}</span>
                    <div className="fbar">
                      <div className="fbar-fill" style={{ width: `${v.score * 100}%` }} />
                    </div>
                    <span className="fev mono">{v.evidence}</span>
                  </div>
                ))}
                <button
                  className="btn ghost full-w"
                  onClick={() => onSelectVessel(s.mmsi)}>
                  DISPLAY 18-HOUR AIS TRACK
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  )
}
