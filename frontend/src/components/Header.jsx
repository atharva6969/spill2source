import { useEffect, useState, useRef } from 'react'

const LEDS = [
  { key: 'ais', label: 'AIS', desc: 'Live AIS vessel data' },
  { key: 'met', label: 'WAVES', desc: 'Wind & wave fields' },
  { key: 'sat', label: 'SAR', desc: 'Copernicus radar imagery' },
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
  projection = 'globe',
  onToggleProjection,
  onResetView,
  userSession,
  onLogout,
}) {
  const [now, setNow] = useState(new Date())
  const [basemapOpen, setBasemapOpen] = useState(false)
  const basemapGroupRef = useRef(null)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    if (!basemapOpen) return
    const handleClickOutside = (e) => {
      if (basemapGroupRef.current && !basemapGroupRef.current.contains(e.target)) {
        setBasemapOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [basemapOpen])

  const ledState = (key) => {
    if (!status) return { state: 'idle', label: 'WAIT' }
    if (key === 'ais') {
      if (status.ais?.error) return { state: 'down', label: 'OFF' }
      const isLive = Date.now() / 1000 - (status.ais?.last_poll || 0) < 90
      return isLive ? { state: 'live', label: 'LIVE' } : { state: 'stale', label: 'LATE' }
    }
    if (key === 'met') {
      const isFresh = status.met?.ready && Date.now() / 1000 - (status.met.last_refresh || 0) < 7200
      if (isFresh) return { state: 'live', label: 'OK' }
      if (status.met?.error) return { state: 'down', label: 'ERR' }
      return status.met?.ready ? { state: 'stale', label: 'OLD' } : { state: 'idle', label: 'WAIT' }
    }
    if (key === 'sat') {
      return status.cdse_configured
        ? { state: 'live', label: 'ON' }
        : { state: 'idle', label: 'PUB' }
    }
    return { state: 'idle', label: '—' }
  }

  const fmtTime = (d) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`

  const fmtDate = (d) =>
    d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric', timeZone: 'UTC' }).toUpperCase()

  return (
    <header className="hdr">
      <div className="brand">
        <div className="brand-logo" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="9" strokeOpacity="0.3" />
            <circle cx="12" cy="12" r="5" strokeOpacity="0.6" />
            <circle cx="12" cy="12" r="1.5" fill="currentColor" />
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" strokeOpacity="0.4" />
          </svg>
        </div>
        <div className="brand-text">
          <div className="brand-title-row">
            <h1>SPILL2SOURCE</h1>
            <span className="system-tag">S1 MONITOR</span>
          </div>
          <p>Gulf of Finland · SAR Oil-Spill Intelligence</p>
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
          <div className="toolbar-group" ref={basemapGroupRef}>
            <button
              className={`header-btn ${basemapOpen ? 'active' : ''}`}
              onClick={() => setBasemapOpen(!basemapOpen)}
              title="Switch Basemap Style">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
              <span>{basemaps[basemapKey]?.name || 'Map'}</span>
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

        {/* 2D/3D Map Projection Toggle */}
        <button
          className={`header-btn ${projection === 'flat' ? 'on' : ''}`}
          onClick={onToggleProjection}
          title={projection === 'globe' ? 'Switch to 2D Flat Mercator View' : 'Switch to 3D Earth Globe View'}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="9" />
            <line x1="3.6" y1="9" x2="20.4" y2="9" />
            <line x1="3.6" y1="15" x2="20.4" y2="15" />
            <path d="M11.5 3a17 17 0 0 0 0 18" />
            <path d="M12.5 3a17 17 0 0 1 0 18" />
          </svg>
          <span>{projection === 'globe' ? '3D GLOBE' : '2D FLAT'}</span>
        </button>

        {/* AIS Traffic Toggle */}
        <button
          className={`header-btn ${showVessels ? 'on' : ''}`}
          onClick={onToggleVessels}
          title="Toggle AIS Vessel Traffic Overlay">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 19 21 12 17 5 21 12 2" />
          </svg>
          <span>VESSELS</span>
        </button>

        {/* Risk Layer Toggle */}
        <button
          className={`header-btn risk-toggle ${riskOn ? 'on' : ''}`}
          onClick={onToggleRisk}
          title={
            riskStatus?.trained
              ? `Spill Risk Analytics active · Spatial AUC ${riskStatus.auc_mean?.toFixed(2)}`
              : 'Toggle predictive spill risk layer'
          }>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <span>RISK</span>
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
          <span>RESET</span>
        </button>

        {/* User Session & Lock Station Button */}
        {userSession && (
          <button
            className="header-btn user-lock-btn"
            onClick={onLogout}
            title={`Active: ${userSession.email} (${userSession.role || 'Officer'}) — Click to Lock Station / View 3D Earth Login`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>LOCK</span>
          </button>
        )}

        {/* Live UTC Clock */}
        <div className="clock-card">
          <span className="clock-time mono">{fmtTime(now)} <small>UTC</small></span>
          <span className="clock-date mono">{fmtDate(now)}</span>
        </div>
      </div>
    </header>
  )
}
