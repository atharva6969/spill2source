import { useState, useMemo } from 'react'

const STATUS_LABEL = {
  catalogued: 'In Orbit Queue',
  fetching: 'Fetching AOI',
  downloading: 'Downloading',
  downloaded: 'Downloaded',
  processing: 'Processing SAR',
  detected: 'Candidates Found',
  clear: 'Sea Clear',
  error: 'Scan Error',
}

function utc(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())} ${d.toLocaleString('en-US', { month: 'short' })} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

function timeAgo(ts) {
  if (!ts) return '—'
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function LeftPanel({
  events,
  scenes,
  slicks,
  riskStatus,
  riskData,
  selectedSlickId,
  onOpenSlick,
  onScanScene,
  onSelectVessel,
}) {
  const [tab, setTab] = useState('slicks')
  const [alertFilter, setAlertFilter] = useState('all')
  const [alertSearch, setAlertSearch] = useState('')

  const alertCounts = useMemo(() => {
    const res = { all: events.length, alert: 0, warning: 0, info: 0 }
    for (const e of events) {
      if (e.severity === 'alert' || e.severity === 'spill') res.alert++
      else if (e.severity === 'warning' || e.severity === 'gap') res.warning++
      else res.info++
    }
    return res
  }, [events])

  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      if (alertFilter === 'alert' && e.severity !== 'alert' && e.severity !== 'spill') return false
      if (alertFilter === 'warning' && e.severity !== 'warning' && e.severity !== 'gap') return false
      if (alertFilter === 'info' && e.severity !== 'info' && e.severity !== 'action') return false
      if (alertSearch) {
        const q = alertSearch.toLowerCase()
        return (e.message || '').toLowerCase().includes(q) || (e.category || '').toLowerCase().includes(q)
      }
      return true
    })
  }, [events, alertFilter, alertSearch])

  const counts = {
    events: events.length,
    slicks: slicks.length,
    scenes: scenes.length,
    risk: riskStatus?.n_positive || 0,
  }

  const topRisk = (riskData?.features || [])
    .map((f) => ({ p: f.properties.p, ring: f.geometry.coordinates[0] }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 10)

  return (
    <aside className="panel left">
      <div className="tabs" role="tablist">
        {[
          {
            id: 'slicks',
            label: 'SLICKS',
            svg: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10A8 8 0 0 0 4 12c0 6 8 10 8 10z" />
              </svg>
            ),
          },
          {
            id: 'scenes',
            label: 'SCENES',
            svg: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            ),
          },
          {
            id: 'events',
            label: 'ALERTS',
            svg: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            ),
          },
          {
            id: 'risk',
            label: 'RISK',
            svg: (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
              </svg>
            ),
          },
        ].map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'on' : ''}`}
            onClick={() => setTab(t.id)}>
            <span className="tab-icon">{t.svg}</span>
            <span className="tab-label">{t.label}</span>
            {counts[t.id] > 0 && <span className="tab-badge mono">{counts[t.id]}</span>}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {tab === 'slicks' && (
          <ul className="feed slicks-feed">
            {slicks.length === 0 && (
              <div className="empty-state-box">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
                  <path d="M12 22s8-4 8-10A8 8 0 0 0 4 12c0 6 8 10 8 10z" />
                </svg>
                <p className="empty-title">No Oil Slicks Detected</p>
                <p className="empty-desc">Sentinel-1 SAR passes are continually scanned for dark patch candidates.</p>
              </div>
            )}
            {slicks.map((s) => (
              <li key={s.id}>
                <button
                  className={`row slick-row ${selectedSlickId === s.id ? 'on' : ''}`}
                  onClick={() => onOpenSlick(s.id)}>
                  <div className="slick-row-top">
                    <span className="slick-id-tag">SLICK #{s.id}</span>
                    <span className="slick-area-pill mono">{s.area_km2} km²</span>
                  </div>
                  <div className="slick-row-meta">
                    <span className="mono dim">{utc(s.detected_at)}</span>
                    <span className="conf-badge mono">{(s.confidence * 100).toFixed(0)}% CONF</span>
                  </div>
                  {s.age_estimate_h != null && (
                    <span className="slick-age-chip mono">Est. Age: ~{Number(s.age_estimate_h).toFixed(1)} hrs</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {tab === 'scenes' && (
          <ul className="feed scenes-feed">
            {scenes.length === 0 && (
              <div className="empty-state-box">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
                <p className="empty-title">Polling Copernicus Catalogue</p>
                <p className="empty-desc">Connecting to Sentinel-1 OData catalog stream...</p>
              </div>
            )}
            {scenes.map((s) => (
              <li key={s.product_id}>
                <div className="scene-card">
                  <div className="scene-card-hdr">
                    <span className="scene-title mono" title={s.name}>{s.name.replace('.SAFE', '')}</span>
                    <span className={`chip st-${s.status}`}>{STATUS_LABEL[s.status] || s.status}</span>
                  </div>
                  <div className="scene-card-meta mono dim">
                    <span>{utc(s.sensed_start)}</span>
                    <span title={`Full archive product: ${s.size_mb} MB. Only the VV/VH band + calibration are fetched.`}>~{Math.round(s.size_mb * 0.5)} MB fetch</span>
                  </div>
                  <button
                    className="btn btn-scan"
                    onClick={() => onScanScene(s.product_id, s.name)}
                    disabled={s.status === 'processing' || s.status === 'downloading' || s.status === 'fetching'}
                    title="Fetch AOI & run dark-patch segmentation">
                    {s.status === 'processing' ? 'PROCESSING SAR...' : s.status === 'fetching' ? 'FETCHING AOI...' : s.status === 'downloading' ? 'DOWNLOADING...' : 'SCAN SCENE'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {tab === 'events' && (
          <div className="alerts-tab-wrap">
            {/* Filter Pills & Search */}
            <div className="alerts-control-bar">
              <div className="alert-filter-pills">
                <button
                  className={`af-pill ${alertFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setAlertFilter('all')}>
                  ALL <span className="af-count mono">{alertCounts.all}</span>
                </button>
                <button
                  className={`af-pill sev-alert ${alertFilter === 'alert' ? 'active' : ''}`}
                  onClick={() => setAlertFilter('alert')}>
                  ALERTS <span className="af-count mono">{alertCounts.alert}</span>
                </button>
                <button
                  className={`af-pill sev-warning ${alertFilter === 'warning' ? 'active' : ''}`}
                  onClick={() => setAlertFilter('warning')}>
                  WARNINGS <span className="af-count mono">{alertCounts.warning}</span>
                </button>
                <button
                  className={`af-pill sev-info ${alertFilter === 'info' ? 'active' : ''}`}
                  onClick={() => setAlertFilter('info')}>
                  SYSTEM <span className="af-count mono">{alertCounts.info}</span>
                </button>
              </div>

              <div className="alert-search-row">
                <input
                  type="text"
                  className="alert-search-input"
                  placeholder="Filter alerts by vessel, slick, scene..."
                  value={alertSearch}
                  onChange={(e) => setAlertSearch(e.target.value)}
                />
                {alertSearch && (
                  <button className="alert-search-clear" onClick={() => setAlertSearch('')}>×</button>
                )}
              </div>
            </div>

            <ul className="feed events-feed">
              {filteredEvents.length === 0 && (
                <div className="empty-state-box">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
                    <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
                  </svg>
                  <p className="empty-title">
                    {alertSearch || alertFilter !== 'all' ? 'No Matching Alerts' : 'Surveillance Feed Active'}
                  </p>
                  <p className="empty-desc">
                    {alertSearch || alertFilter !== 'all'
                      ? 'Try clearing the search query or switching filters.'
                      : 'Live Sentinel-1 detections, AIS vessel silence gaps, and telemetry events log here in real time.'}
                  </p>
                </div>
              )}

              {filteredEvents.map((e, i) => {
                const slickMatch = e.payload?.slick_ids?.[0] || (e.message || '').match(/slick #?(\d+)/i)?.[1]
                const mmsiMatch = e.payload?.mmsi || (e.message || '').match(/MMSI (\d{9})/)?.[1]
                const isSceneEvent = e.category === 'scene' || (e.message || '').includes('.SAFE')

                return (
                  <li key={e.ts ? `${e.ts}-${i}` : i} className={`evt sev-${e.severity}`}>
                    <div className="evt-hdr">
                      <div className="evt-badge-group">
                        <span className={`evt-dot-indicator sev-${e.severity}`} />
                        <span className="evt-badge">{e.severity.toUpperCase()}</span>
                        {e.category && <span className="evt-cat mono">{e.category.toUpperCase()}</span>}
                      </div>
                      <span className="mono evt-ts" title={utc(e.ts)}>{timeAgo(e.ts)}</span>
                    </div>

                    <p className="evt-msg">{e.message}</p>

                    {/* Actionable buttons if linked to slick, vessel, or scene */}
                    {(slickMatch || mmsiMatch || isSceneEvent) && (
                      <div className="evt-action-row">
                        {slickMatch && (
                          <button
                            className="evt-action-btn slick-action"
                            onClick={() => onOpenSlick(Number(slickMatch))}>
                            <span>VIEW SLICK #{slickMatch}</span>
                            <span className="arr">→</span>
                          </button>
                        )}
                        {mmsiMatch && onSelectVessel && (
                          <button
                            className="evt-action-btn vessel-action"
                            onClick={() => onSelectVessel(Number(mmsiMatch))}>
                            <span>TRACK MMSI {mmsiMatch}</span>
                            <span className="arr">→</span>
                          </button>
                        )}
                        {isSceneEvent && (
                          <button
                            className="evt-action-btn scene-action"
                            onClick={() => setTab('scenes')}>
                            <span>VIEW SCENES</span>
                            <span className="arr">→</span>
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {tab === 'risk' && (
          <div className="risk-tab">
            {!riskStatus?.trained ? (
              <div className="empty-state-box">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.4">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <p className="empty-title">Risk Model Offline</p>
                <p className="empty-desc">
                  Spatial risk model is not yet trained. Run offline training script to enable threat map.
                </p>
              </div>
            ) : (
              <>
                <div className="risk-card">
                  <div className="risk-card-hdr">
                    <h4>HISTORICAL SPILL RISK MODEL</h4>
                    <span className="risk-auc-pill mono">AUC {riskStatus.auc_mean?.toFixed(3)}</span>
                  </div>
                  <p className="risk-desc">
                    Spatial machine-learning grid trained on <b>{riskStatus.n_positive}</b> historical SkyTruth Cerulean detections across <b>{riskStatus.n_cells}</b> Baltic sea cells.
                  </p>
                  
                  <div className="feature-importances">
                    <span className="fi-title">PREDICTIVE FEATURE WEIGHTS</span>
                    {Object.entries(riskStatus.importances || {})
                      .sort((a, b) => b[1] - a[1])
                      .slice(0, 4)
                      .map(([k, v]) => (
                        <div key={k} className="fi-row">
                          <span className="fi-name mono">{k}</span>
                          <div className="fi-bar-bg">
                            <div className="fi-bar-fg" style={{ width: `${(v * 100).toFixed(0)}%` }} />
                          </div>
                          <span className="fi-val mono">{(v * 100).toFixed(0)}%</span>
                        </div>
                      ))}
                  </div>
                </div>

                <h4 className="sect-title">HIGH-PROBABILITY GRID SECTORS</h4>
                <ul className="feed risk-grid-feed">
                  {topRisk.map((r, i) => {
                    const c = r.ring[0]
                    const lat = (c[1] + r.ring[2][1]) / 2
                    const lon = (c[0] + r.ring[2][0]) / 2
                    return (
                      <li key={i}>
                        <button
                          className="row risk-cell-row"
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent('fly-to', {
                                detail: { lat, lon },
                              })
                            )
                          }>
                          <div className="risk-cell-top">
                            <span className="risk-prob-badge mono">{(r.p * 100).toFixed(0)}% PROBABILITY</span>
                            <span className="risk-coords mono">{lat.toFixed(2)}°N {lon.toFixed(2)}°E</span>
                          </div>
                          <span className="risk-sub-label">Click to center chart view</span>
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
