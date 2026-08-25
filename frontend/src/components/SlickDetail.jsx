import { useState } from 'react'

const FACTOR_LABEL = {
  proximity: 'Closest approach',
  crossing: 'Track crosses slick/origin',
  speed_anomaly: 'Low-speed / drifting',
  ais_gap: 'AIS silence (dark event)',
  type_prior: 'Vessel-class prior',
  course_align: 'Course vs slick axis',
}

function utc(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${d.toLocaleString('en', { month: 'short' })} · ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export default function SlickDetail({ detail, selectedSlickId, onSelectVessel,
                                      onAnalyze, onClose }) {
  const [openRow, setOpenRow] = useState(null)
  if (!detail || !selectedSlickId) {
    return (
      <aside className="panel right empty-state">
        <div>
          <h3>No slick selected</h3>
          <p>
            Click a red slick polygon on the chart — or pick one under
            SLICKS — to see its hindcast origin and ranked suspect vessels.
          </p>
        </div>
      </aside>
    )
  }

  const bw = detail.backward
  const fw = detail.forward
  const suspects = detail.suspects || []

  return (
    <aside className="panel right">
      <div className="detail-head">
        <div>
          <h2>Slick #{detail.id}</h2>
          <p className="mono dim">{detail.scene_name?.replace('.SAFE', '')}</p>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <section className="props">
        <div className="prop"><b>{detail.area_km2}</b><span>km²</span></div>
        <div className="prop"><b>{Number(detail.confidence * 100).toFixed(0)}%</b><span>confidence</span></div>
        <div className="prop">
          <b>{detail.age_estimate_h != null ? `~${Number(detail.age_estimate_h).toFixed(1)} h` : '—'}</b>
          <span>age est.</span>
        </div>
        <div className="prop">
          <b>{bw ? `${Number(bw.origin_sigma_km).toFixed(1)} km` : '—'}</b>
          <span>origin σ</span>
        </div>
      </section>

      <section className="origin-line mono dim">
        {bw
          ? <>release ≈ {utc(bw.release_time)} · origin {bw.origin_lat.toFixed(3)}°N {bw.origin_lon.toFixed(3)}°E</>
          : 'not yet analysed'}
      </section>

      <button className="btn" onClick={onAnalyze}>
        Re-run hindcast + attribution
      </button>

      <h3 className="sect-title">
        Suspect vessels <span className="dim mono">{suspects.length}</span>
      </h3>

      <ol className="suspects">
        {suspects.length === 0 && (
          <li className="empty">
            No AIS candidates scored for this window. The watch needs a few
            hours of accumulated traffic around the release point.
          </li>
        )}
        {suspects.map((s) => (
          <li key={s.mmsi} className={`suspect ${openRow === s.mmsi ? 'open' : ''}`}>
            <button className="sus-head"
                    onClick={() => {
                      setOpenRow(openRow === s.mmsi ? null : s.mmsi)
                      onSelectVessel(s.mmsi)
                    }}>
              <span className="rank mono">#{s.rank}</span>
              <span className="whoami">
                <b>{s.name || `MMSI ${s.mmsi}`}</b>
                <span className="mono dim">
                  {s.min_dist_km} km · {s.n_fixes} fixes
                  {s.length ? ` · ${s.length} m` : ''}
                </span>
              </span>
              <span className="score-wrap">
                <span className="score-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, s.score)}%` }} />
                </span>
                <b className="mono score-num">{s.score.toFixed(0)}</b>
              </span>
            </button>

            {openRow === s.mmsi && (
              <div className="factors">
                {Object.entries(s.factors).map(([k, v]) => (
                  <div key={k} className="factor">
                    <span className="flabel">{FACTOR_LABEL[k] || k}</span>
                    <span className="fbar" aria-hidden="true">
                      <span style={{ width: `${v.score * 100}%` }} />
                    </span>
                    <span className="fev">{v.evidence}</span>
                  </div>
                ))}
                <button className="btn ghost"
                        onClick={() => onSelectVessel(s.mmsi)}>
                  Show 18 h track on chart
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  )
}
