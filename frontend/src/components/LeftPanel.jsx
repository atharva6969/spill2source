import { useState } from 'react'

const STATUS_LABEL = {
  catalogued: 'in orbit queue',
  downloading: 'downloading',
  downloaded: 'downloaded',
  processing: 'detecting',
  detected: 'slick candidates',
  clear: 'sea clear',
  error: 'error',
}

function ago(ts) {
  if (!ts) return ''
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function utc(ts) {
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${d.toLocaleString('en', { month: 'short' })} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export default function LeftPanel({ events, scenes, slicks, riskStatus,
                                    riskData, selectedSlickId,
                                    onOpenSlick, onScanScene }) {
  const [tab, setTab] = useState('events')
  const topRisk = (riskData?.features || [])
    .map((f) => ({ p: f.properties.p, ring: f.geometry.coordinates[0] }))
    .sort((a, b) => b.p - a.p).slice(0, 10)
  return (
    <aside className="panel left">
      <div className="tabs" role="tablist">
        {['events', 'slicks', 'scenes', 'risk'].map((t) => (
          <button key={t} role="tab" aria-selected={tab === t}
                  className={`tab ${tab === t ? 'on' : ''}`}
                  onClick={() => setTab(t)}>
            {t.toUpperCase()}
          </button>
        ))}
        <span className="tabs-line" aria-hidden="true" />
      </div>

      <div className="panel-body">
        {tab === 'events' && (
          <ul className="feed">
            {events.length === 0 && (
              <li className="empty">Watch is running — alerts will land here.</li>
            )}
            {events.map((e, i) => (
              <li key={i} className={`evt sev-${e.severity}`}>
                <span className="mono evt-ts">{utc(e.ts)}</span>
                <p>{e.message}</p>
              </li>
            ))}
          </ul>
        )}

        {tab === 'slicks' && (
          <ul className="feed">
            {slicks.length === 0 && (
              <li className="empty">
                No slick detections yet — the watch keeps scanning Sentinel-1
                passes over the Gulf.
              </li>
            )}
            {slicks.map((s) => (
              <li key={s.id}>
                <button
                  className={`row slick-row ${selectedSlickId === s.id ? 'on' : ''}`}
                  onClick={() => onOpenSlick(s.id)}>
                  <span className="row-title">
                    Slick #{s.id} · {s.area_km2} km²
                  </span>
                  <span className="row-sub mono">
                    {utc(s.detected_at)} · conf {(s.confidence * 100).toFixed(0)}%
                    {s.age_estimate_h != null ? ` · age ~${Number(s.age_estimate_h).toFixed(1)} h` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === 'scenes' && (
          <ul className="feed">
            {scenes.length === 0 && (
              <li className="empty">Waiting for the Sentinel-1 catalogue…</li>
            )}
            {scenes.map((s) => (
              <li key={s.product_id}>
                <button className="row scene-row"
                        onClick={() => onScanScene(s.product_id, s.name)}
                        title="Download + run detection">
                  <span className="row-title mono">{s.name.replace('.SAFE', '')}</span>
                  <span className="row-sub mono">
                    {utc(s.sensed_start)} · {s.size_mb} MB
                    · <b className={`chip st-${s.status}`}>{STATUS_LABEL[s.status] || s.status}</b>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === 'risk' && (
          <div className="risk-tab">
            {!riskStatus?.trained ? (
              <p className="empty">
                Risk model not trained yet. Run
                <code> scripts/fetch_cerulean_slicks.py</code> then
                <code> scripts/train_risk_model.py</code>.
              </p>
            ) : (
              <>
                <div className="risk-card">
                  <h4>Spill-risk model</h4>
                  <p>
                    Trained on <b>{riskStatus.n_positive}</b> historical
                    slick cells (SkyTruth Cerulean Sentinel-1 detections,
                    2020–2026) over {riskStatus.n_cells} sea cells.
                    Spatial holdout AUC{' '}
                    <b className="mono">{riskStatus.auc_mean?.toFixed(3)}</b>.
                  </p>
                  <p className="mono dim risk-feats">
                    {Object.entries(riskStatus.importances || {})
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 4)
                      .map(([k, v]) => `${k} ${v.toFixed(2)}`)
                      .join(' · ')}
                  </p>
                </div>
                <h4 className="sect-title">Highest-risk cells</h4>
                <ul className="feed">
                  {topRisk.map((r, i) => {
                    const c = r.ring[0]
                    return (
                      <li key={i}>
                        <button className="row"
                                onClick={() => window.dispatchEvent(
                                  new CustomEvent('fly-to', {
                                    detail: {
                                      lat: (c[1] + r.ring[2][1]) / 2,
                                      lon: (c[0] + r.ring[2][0]) / 2,
                                    },
                                  }))}>
                          <span className="row-title">
                            {(r.p * 100).toFixed(0)}% ·{' '}
                            {c[1].toFixed(2)}°N {c[0].toFixed(2)}°E
                          </span>
                          <span className="row-sub">
                            historical slick cell — click to inspect
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
