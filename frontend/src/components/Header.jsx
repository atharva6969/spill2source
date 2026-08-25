import { useEffect, useState } from 'react'

const LEDS = [
  { key: 'ais', label: 'AIS FEED' },
  { key: 'met', 'label': 'MET-OCEAN' },
  { key: 'sat', label: 'SENTINEL-1' },
]

export default function Header({ status, riskOn, onToggleRisk, riskStatus }) {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const ledState = (key) => {
    if (!status) return 'idle'
    if (key === 'ais') {
      return status.ais?.error ? 'down' :
        (Date.now() / 1000 - (status.ais.last_poll || 0) < 90 ? 'live' : 'stale')
    }
    if (key === 'met') {
      return status.met?.ready &&
        Date.now() / 1000 - (status.met.last_refresh || 0) < 7200 ? 'live' : 'stale'
    }
    if (key === 'sat') {
      return status.cdse_configured ? 'live' : 'idle'
    }
    return 'idle'
  }

  const fmt = (d) =>
    `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`

  return (
    <header className="hdr">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <div>
          <h1>SLICKTRACE</h1>
          <p>Gulf of Finland · live oil-spill watch</p>
        </div>
      </div>
      <nav className="leds" aria-label="pipeline status">
        {LEDS.map((l) => (
          <div key={l.key} className={`led ${ledState(l.key)}`}>
            <span className="dot" aria-hidden="true" />
            {l.label}
          </div>
        ))}
      </nav>
      <button
        className={`risk-toggle ${riskOn ? 'on' : ''}`}
        onClick={onToggleRisk}
        title={riskStatus?.trained
          ? `Risk model · spatial AUC ${riskStatus.auc_mean?.toFixed(2)}`
          : 'Risk model not trained yet'}>
        RISK LAYER
      </button>
      <div className="clock mono">{fmt(now)} UTC</div>
    </header>
  )
}
