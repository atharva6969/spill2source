import { useEffect, useRef, useCallback, useState } from 'react'
import { getJSON, postJSON } from './api.js'
import Header from './components/Header.jsx'
import MapView from './components/MapView.jsx'
import LeftPanel from './components/LeftPanel.jsx'
import SlickDetail from './components/SlickDetail.jsx'
import VesselCard from './components/VesselCard.jsx'

export default function App() {
  const [status, setStatus] = useState(null)
  const [vessels, setVessels] = useState(null)
  const [scenes, setScenes] = useState([])
  const [slicks, setSlicks] = useState([])
  const [events, setEvents] = useState([])
  const [selectedSlickId, setSelectedSlickId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [vesselMmsi, setVesselMmsi] = useState(null)
  const [vesselDetails, setVesselDetails] = useState(null)
  const [riskOn, setRiskOn] = useState(false)
  const [riskData, setRiskData] = useState(null)
  const riskStatusRef = useRef(null)
  const [toast, setToast] = useState(null)
  const [leftPanelOpen, setLeftPanelOpen] = useState(true)
  const toastTimerRef = useRef(null)

  const showToast = useCallback((m) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(String(m))
    toastTimerRef.current = setTimeout(() => setToast(null), 6000)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    try {
      const st = await getJSON('/api/status')
      setStatus(st)
      setVessels(await getJSON('/api/vessels/live'))
      setScenes(await getJSON('/api/scenes'))
      setSlicks(await getJSON('/api/slicks'))
      setEvents(await getJSON('/api/events?limit=60'))
      if (!riskStatusRef.current) {
        getJSON('/api/risk/status')
          .then((rs) => { riskStatusRef.current = rs })
          .catch(() => {})
      }
    } catch {
      setToast('Backend unreachable — start it with run.bat')
    }
  }, [])

  const toggleRisk = useCallback(async () => {
    setRiskOn((prev) => {
      const next = !prev
      if (next && !riskData) {
        getJSON('/api/risk/grid?min_p=0.05')
          .then(setRiskData)
          .catch(() => {
            showToast('Risk model not trained yet — run scripts/train_risk_model.py')
            setRiskOn(false)
          })
      }
      return next
    })
  }, [riskData, showToast])

  useEffect(() => {
    refreshAll()
    const t = setInterval(refreshAll, 15000)
    return () => clearInterval(t)
  }, [refreshAll])

  const slickRef = useRef(null)
  slickRef.current = selectedSlickId
  const detailRef = useRef(null)

  useEffect(() => {
    let ws = null
    let reconnectTimer = null
    let reconnectDelay = 1000
    let closed = false

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)

      ws.onopen = () => {
        reconnectDelay = 1000
      }

      ws.onmessage = (m) => {
        let msg
        try { msg = JSON.parse(m.data) } catch { return }
        if (msg.type === 'event') {
          setEvents((prev) => [msg.event, ...prev].slice(0, 80))
          refreshAll()
        } else if (msg.type === 'scene') {
          setScenes((prev) => [{
            product_id: msg.product_id, name: msg.name,
            sensed_start: msg.sensed_start, size_mb: msg.size_mb,
            footprint: msg.footprint, status: 'catalogued',
          }, ...prev])
        } else if (msg.type === 'scene_status') {
          setScenes((prev) => prev.map((s) =>
            s.product_id === msg.product_id ? { ...s, status: msg.status } : s))
        } else if (msg.type === 'analysis_complete') {
          refreshAll()
          if (slickRef.current === msg.slick_id && detailRef.current !== null) {
            getJSON(`/api/slicks/${msg.slick_id}`).then(setDetail)
          }
        }
      }

      ws.onclose = () => {
        if (closed) return
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 30000)
          connect()
        }, reconnectDelay)
      }

      ws.onerror = () => {
        ws.close()
      }
    }

    connect()

    return () => {
      closed = true
      if (ws) ws.close()
      if (reconnectTimer) clearTimeout(reconnectTimer)
    }
  }, [refreshAll])

  detailRef.current = detail

  const openSlick = useCallback(async (id) => {
    setSelectedSlickId(id)
    try { setDetail(await getJSON(`/api/slicks/${id}`)) } catch { /* noop */ }
  }, [])

  const scanScene = useCallback(async (pid, name) => {
    showToast(`Downloading + scanning ${name || pid.slice(0, 10)}…`)
    try {
      const r = await postJSON(`/api/scenes/${pid}/scan`)
      showToast(r.slick_ids?.length
        ? `Scan complete — ${r.slick_ids.length} oil-candidate patch(es)`
        : 'Scan complete — sea clear')
      await refreshAll()
    } catch (e) { showToast(e.message) }
  }, [showToast, refreshAll])

  const reanalyze = useCallback(async (id) => {
    showToast('Hindcast + attribution running…')
    try {
      await postJSON(`/api/slicks/${id}/analyze`)
      await openSlick(id)
      showToast('Analysis complete')
    } catch (e) { showToast(e.message) }
  }, [showToast, openSlick])

  const selectVessel = useCallback((mmsi) => {
    setVesselMmsi(mmsi)
    setVesselDetails(null)
    if (!mmsi) return
    getJSON(`/api/vessels/${mmsi}/details`)
      .then(setVesselDetails)
      .catch(() => {})
    getJSON(`/api/vessels/${mmsi}/track?hours=18`)
      .then((tr) => window.dispatchEvent(
        new CustomEvent('vessel-track', { detail: tr })))
      .catch(() => {})
  }, [])

  return (
    <div className="app-hud">
      {/* 1. Full Screen Map Base Layer */}
      <div className="map-background">
        <MapView
          vessels={vessels}
          slicks={slicks}
          detail={detail}
          vesselMmsi={vesselMmsi}
          riskOn={riskOn}
          riskData={riskData}
          onSelectSlick={openSlick}
          onSelectVessel={selectVessel}
        />
      </div>

      {/* 2. Floating Top Island Glass Bar */}
      <Header
        status={status}
        riskOn={riskOn}
        onToggleRisk={toggleRisk}
        riskStatus={riskStatusRef.current}
      />

      {/* 3. Floating Left Intelligence Dock */}
      <div className={`left-hud-dock ${leftPanelOpen ? 'open' : 'collapsed'}`}>
        <button
          className="dock-toggle-btn"
          onClick={() => setLeftPanelOpen(!leftPanelOpen)}
          title={leftPanelOpen ? 'Collapse side dock' : 'Expand side dock'}>
          {leftPanelOpen ? '\u25c0' : '\u25b6'}
        </button>
        {leftPanelOpen && (
          <LeftPanel
            events={events}
            scenes={scenes}
            slicks={slicks}
            riskStatus={riskStatusRef.current}
            riskData={riskData}
            selectedSlickId={selectedSlickId}
            onOpenSlick={openSlick}
            onScanScene={scanScene}
          />
        )}
      </div>

      {/* 4. Floating Right Inspector Card */}
      <div className="right-hud-dock">
        {vesselMmsi ? (
          <VesselCard
            details={vesselDetails}
            onShowTrack={selectVessel}
            onClose={() => { setVesselMmsi(null); setVesselDetails(null) }}
          />
        ) : (
          <SlickDetail
            detail={detail}
            selectedSlickId={selectedSlickId}
            onSelectVessel={selectVessel}
            onAnalyze={() => reanalyze(detail?.id)}
            onClose={() => { setDetail(null); setSelectedSlickId(null) }}
          />
        )}
      </div>

      {/* 5. Floating Bottom Telemetry Ticker */}
      <div className="bottom-hud-ticker mono">
        <div className="ticker-item">
          <span className="ticker-label">SURVEILLANCE AOI:</span>
          <span className="ticker-val">GULF OF FINLAND</span>
        </div>
        <div className="ticker-divider" />
        <div className="ticker-item">
          <span className="ticker-label">ACTIVE VESSELS:</span>
          <span className="ticker-val">{vessels?.features?.length || 0}</span>
        </div>
        <div className="ticker-divider" />
        <div className="ticker-item">
          <span className="ticker-label">DETECTED SLICKS:</span>
          <span className="ticker-val alert">{slicks?.length || 0}</span>
        </div>
        <div className="ticker-divider" />
        <div className="ticker-item">
          <span className="ticker-label">SAR SCENES:</span>
          <span className="ticker-val">{scenes?.length || 0}</span>
        </div>
      </div>

      {/* 6. Notification Toast */}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
