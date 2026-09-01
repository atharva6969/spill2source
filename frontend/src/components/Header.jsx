import { useEffect, useState } from 'react'

const LEDS = [
  { key: 'ais', label: 'AIS TRAFFIC', desc: 'Live AIS vessel data' },
  { key: 'met', label: 'MET-OCEAN', desc: 'Wind & wave fields' },
  { key: 'sat', label: 'SENTINEL-1 SAR', desc: 'Copernicus radar imagery' },
]

export default function Header({
  status,
  riskOn,
  onToggleRisk,
  riskStatus,
  showVessels,
  onToggleVessels,
  basemapKey,
  onSelectBasemap,
  basemaps,
  onResetView,
}) {
  const [now, setNow] = useState(new Date())
  const [basemapOpen, setBasemapOpen] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const ledState = (key) => {
    if (!status) return { state: 'idle', label: 'CONNECTING' }
    if (key === 'ais') {
      if (status.ais?.error) return { state: 'down', label: 'OFFLINE' }
      const isLive = Date.now() / 1000 - (status.ais?.last_poll || 0) < 90
      return isLive ? { state: 'live', label: 'ONLINE' } : { state: 'stale', label: 'DELAYED' }
    }
    if (key === 'met') {
      if (status.met?.error) return { state: 'down', label: 'ERROR' }
      const isReady = status.met?.ready && Date.now() / 1000 - (status.met.last_refresh || 0) < 7200
      return isReady ? { state: 'live', label: 'READY' } : { state: 'stale', label: 'STALE' }
    }
    if (key === 'sat') {
      return status.cdse_configured
        ? { state: 'live', label: 'ACTIVE' }
        : { state: 'idle', label: 'PUBLIC' }
    }
    return { state: 'idle', label: 'STANDBY' }
  }

  const fmtTime = (d) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`

  const fmtDate = (d) =>
    d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).toUpperCase()

  return (
    <header className="hdr">
      <div className="brand">
        <div className="brand-logo" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" strokeOpacity="0.4" />
            <circle cx="12" cy="12" r="5" strokeOpacity="0.7" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeOpacity="0.5" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-title-row">
            <h1>SLICKTRACE</h1>
            <span className="system-tag">SENTINEL-1 MONITOR</span>
          </div>
          <p>Gulf of Finland · Automated SAR Spill Detection & AIS Attribution</p>
        </div>
      </div>

      <nav className="leds" aria-label="System Data Feeds">
        {LEDS.map((l) => {
          const { state, label } = ledState(l.key)
          return (
            <div key={l.key} className={`led ${state}`} title={`${l.desc} (${label})`}>
              <span className="dot" aria-hidden="true" />
              <span className="led-name">{l.label}</span>
              <span className="led-status mono">{label}</span>
            </div>
          )
        })}
      </nav>

      <div className="header-actions">
        {/* Basemap Switcher */}
        {basemaps && (
          <div className="toolbar-group">
            <button
              className={`header-btn ${basemapOpen ? 'active' : ''}`}
              onClick={() => setBasemapOpen(!basemapOpen)}
              title="Switch Basemap Style">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <span>{basemaps[basemapKey]?.name || 'Basemap'}</span>
            </button>
            {basemapOpen && (
              <div className="basemap-dropdown">
                {Object.entries(basemaps).map(([k, bm]) => (
                  <button
                    key={k}
                    className={`bm-option ${basemapKey === k ? 'selected' : ''}`}
                    onClick={() => {
                      onSelectBasemap(k)
                      setBasemapOpen(false)
                    }}>
                    {bm.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* AIS Traffic Toggle */}
        <button
          className={`header-btn ${showVessels ? 'on' : ''}`}
          onClick={onToggleVessels}
          title="Toggle AIS Vessel Traffic Overlay">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 19 21 12 17 5 21 12 2" />
          </svg>
          <span>AIS TRAFFIC</span>
        </button>

        {/* Risk Layer Toggle */}
        <button
          className={`header-btn risk-toggle ${riskOn ? 'on' : ''}`}
          onClick={onToggleRisk}
          title={
            riskStatus?.trained
              ? `Spill Risk Model active · Spatial AUC ${riskStatus.auc_mean?.toFixed(2)}`
              : 'Toggle predictive spill risk layer'
          }>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <span>SPILL RISK LAYER</span>
          {riskStatus?.trained && (
            <span className="risk-auc mono">AUC {riskStatus.auc_mean?.toFixed(2)}</span>
          )}
        </button>

        {/* Reset AOI View */}
        <button
          className="header-btn"
          onClick={onResetView}
          title="Reset Map to Gulf of Finland AOI">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          <span>RESET AOI</span>
        </button>

        {/* Live UTC Clock */}
        <div className="clock-card">
          <span className="clock-time mono">{fmtTime(now)} <small>UTC</small></span>
          <span className="clock-date mono">{fmtDate(now)}</span>
        </div>
      </div>
    </header>
  )
}
