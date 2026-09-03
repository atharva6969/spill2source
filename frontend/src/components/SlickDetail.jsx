import { useState } from 'react'

const FACTOR_LABEL = {
  proximity: 'Closest Approach',
  crossing: 'Track Crosses Origin',
  speed_anomaly: 'Speed Anomaly (Slowing)',
  ais_gap: 'AIS Silence (Dark Event)',
  type_prior: 'Vessel-Class Risk',
  course_align: 'Drift Axis Alignment',
  behavior_prior: 'Behavior History',
}

const FACTOR_ICON = {
  proximity: '📍',
  crossing: '⚡',
  speed_anomaly: '⚓',
  ais_gap: '📡',
  type_prior: '🚢',
  course_align: '🧭',
  behavior_prior: '📜',
}

function formatEvidenceText(key, evidence) {
  if (!evidence) return ''
  const str = String(evidence)
  if (key === 'proximity') {
    return str.replace(/d_min=([\d.]+)\s*km/i, '$1 km from release site')
  }
  if (key === 'speed_anomaly') {
    return str.replace(/sog=([\d.]+)\s*kn/i, 'Drifting / slowing at $1 kn')
  }
  if (key === 'ais_gap') {
    return str.replace(/gap=([\d]+)m/i, '$1 min AIS transmission gap')
  }
  return str
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
          <p className="empty-title">No Slick Selected</p>
          <p className="empty-desc">
            Select a detected slick polygon on the map or from the left feed to inspect origin trajectory & vessel attribution.
          </p>
        </div>
      </aside>
    )
  }

  const bw = detail.backward
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
      {/* Header */}
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

      <div className="panel-body">

      <section className="props-grid">
        <div className="prop-card">
          <span className="prop-lbl">SURFACE AREA</span>
          <b className="prop-val mono">{detail.area_km2} <small>km²</small></b>
        </div>
        <div className="prop-card">
          <span className="prop-lbl">DETECTION CONF</span>
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

      {/* Release Origin Card */}
      <section className="origin-banner mono">
        <div className="origin-banner-hdr">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
          </svg>
          <span>ESTIMATED RELEASE ORIGIN</span>
        </div>
        {bw ? (
          <div className="origin-details">
            <div><b>RELEASE TIME:</b> {utc(bw.release_time)}</div>
            <div><b>COORDINATES:</b> {bw.origin_lat?.toFixed(4)}°N {bw.origin_lon?.toFixed(4)}°E</div>
          </div>
        ) : (
          <div className="origin-details dim">Run trajectory analysis to calculate release site</div>
        )}
      </section>

      {/* Action Button */}
      <button className="btn btn-primary-action" onClick={onAnalyze}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        <span>RE-RUN HINDCAST & ATTRIBUTION</span>
      </button>

      {/* Suspects Header */}
      <div className="sect-hdr">
        <h3 className="sect-title">ATTRIBUTION CANDIDATES</h3>
        <span className="sect-count mono">{suspects.length} SCORED</span>
      </div>

      {/* Suspect Candidates List */}
      <ol className="suspects-list">
        {suspects.length === 0 && (
          <div className="empty-state-box inline">
            <p className="empty-title">No Suspects Correlated</p>
            <p className="empty-desc">No AIS vessel fixes were within the release window around the origin.</p>
          </div>
        )}

        {suspects.map((s) => {
          const isTop = s.rank === 1
          const scorePct = Math.min(100, Math.max(0, s.score))
          
          return (
            <li
              key={s.mmsi}
              className={`suspect-card ${isTop ? 'top-suspect-card' : ''} ${openRow === s.mmsi ? 'open' : ''}`}>
              
              {/* Top Suspect Header Badge */}
              {isTop && (
                <div className="top-suspect-banner mono">
                  <span>🚨 PRIMARY SUSPECT (#1 MATCH)</span>
                </div>
              )}

              {/* Main Card Header */}
              <div
                className="suspect-main-row"
                onClick={() => {
                  setOpenRow(openRow === s.mmsi ? null : s.mmsi)
                  onSelectVessel(s.mmsi)
                }}>
                <span className={`rank-badge mono ${s.rank <= 3 ? `top-${s.rank}` : ''}`}>
                  #{s.rank}
                </span>

                <div className="vessel-summary">
                  <b className="vessel-title">{s.name || `MMSI ${s.mmsi}`}</b>
                  <span className="vessel-meta mono dim">
                    {s.min_dist_km != null ? `${s.min_dist_km.toFixed(2)} km away` : ''}
                    {s.n_fixes ? ` · ${s.n_fixes} fixes` : ''}
                    {s.length ? ` · ${s.length}m` : ''}
                  </span>
                </div>

                <div className="suspect-score-box" title={`Score: ${s.score.toFixed(1)} / 100`}>
                  <div className="score-meter">
                    <div
                      className={`score-meter-fill ${scorePct > 60 ? 'high' : scorePct > 30 ? 'med' : 'low'}`}
                      style={{ width: `${scorePct}%` }}
                    />
                  </div>
                  <b className="mono score-val">{s.score.toFixed(0)}</b>
                  <span className="expand-indicator mono dim">{openRow === s.mmsi ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Expandable Reasoning, Actions & Evidence Breakdown */}
              {(openRow === s.mmsi || isTop) && (
                <div className="factors-panel">
                  {/* Automated Attribution Reasoning */}
                  {s.reasoning && (
                    <div className="suspect-reasoning-box">
                      <span className="reasoning-title">⚖️ ATTRIBUTION REASONING</span>
                      <p className="reasoning-text">{s.reasoning}</p>
                    </div>
                  )}

                  {/* Quick Action Buttons */}
                  <div className="suspect-actions-row">
                    <button
                      className="btn-action-chip focus-chip"
                      title="Fly map directly to vessel's position at estimated release time"
                      onClick={(e) => {
                        e.stopPropagation()
                        locateAtRelease(s)
                      }}>
                      🎯 FOCUS AT RELEASE
                    </button>
                    <button
                      className="btn-action-chip track-chip"
                      title="Plot 18-hour historical AIS track line"
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectVessel(s.mmsi)
                      }}>
                      📈 SHOW 18-HR AIS TRACK
                    </button>
                  </div>

                  <span className="factors-hdr">EVIDENCE & CORRELATION BREAKDOWN</span>

                  {Object.entries(s.factors || {}).map(([k, v]) => {
                    const factorScorePct = Math.round((v.score || 0) * 100)
                    const label = FACTOR_LABEL[k] || k
                    const icon = FACTOR_ICON[k] || '🔹'
                    const evText = formatEvidenceText(k, v.evidence)

                    return (
                      <div key={k} className="factor-row-item">
                        <div className="factor-row-hdr">
                          <span className="factor-label-text">
                            <span className="factor-icon">{icon}</span> {label}
                          </span>
                          <span className="factor-score-val mono">{factorScorePct}%</span>
                        </div>

                        <div className="factor-bar-bg">
                          <div
                            className="factor-bar-fg"
                            style={{ width: `${factorScorePct}%` }}
                          />
                        </div>

                        {evText && (
                          <div className="factor-evidence-chip mono">
                            {evText}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      </div>
    </aside>
  )
}

