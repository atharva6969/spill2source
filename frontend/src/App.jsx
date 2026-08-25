import { useEffect, useRef, useState } from 'react'
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
  const [riskStatus, setRiskStatus] = useState(null)
  const [toast, setToast] = useState(null)

  const showToast = (m) => {
    setToast(String(m))
    setTimeout(() => setToast(null), 6000)
  }

  const refreshAll = async () => {
    try {
      const st = await getJSON('/api/status')
      setStatus(st)
      setVessels(await getJSON('/api/vessels/live'))
      setScenes(await getJSON('/api/scenes'))
      setSlicks(await getJSON('/api/slicks'))
      setEvents(await getJSON('/api/events?limit=60'))
      if (!riskStatus) {
        getJSON('/api/risk/status').then(setRiskStatus).catch(() => {})
      }
    } catch {
      setToast('Backend unreachable — start it with run.bat')
    }
  }

  const toggleRisk = async () => {
    const next = !riskOn
    setRiskOn(next)
    if (next && !riskData) {
      try {
        setRiskData(await getJSON('/api/risk/grid?min_p=0.05'))
      } catch {
        showToast('Risk model not trained yet — run scripts/train_risk_model.py')
        setRiskOn(false)
      }
    }
  }

  useEffect(() => {
    refreshAll()
    const t = setInterval(refreshAll, 15000)
    return () => clearInterval(t)
  }, [])

  const slickRef = useRef(null)
  slickRef.current = selectedSlickId
  const detailRef = useRef(null)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
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
    return () => ws.close()
  }, [])

  detailRef.current = detail

  const openSlick = async (id) => {
    setSelectedSlickId(id)
    try { setDetail(await getJSON(`/api/slicks/${id}`)) } catch { /* noop */ }
  }

  const scanScene = async (pid, name) => {
    showToast(`Downloading + scanning ${name || pid.slice(0, 10)}…`)
    try {
      const r = await postJSON(`/api/scenes/${pid}/scan`)
      showToast(r.slick_ids?.length
        ? `Scan complete — ${r.slick_ids.length} oil-candidate patch(es)`
        : 'Scan complete — sea clear')
      await refreshAll()
    } catch (e) { showToast(e.message) }
  }

  const reanalyze = async (id) => {
    showToast('Hindcast + attribution running…')
    try {
      await postJSON(`/api/slicks/${id}/analyze`)
      await openSlick(id)
      showToast('Analysis complete')
    } catch (e) { showToast(e.message) }
  }

  const selectVessel = (mmsi) => {
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
  }

  return (
    <div className="app">
      <Header status={status} riskOn={riskOn} onToggleRisk={toggleRisk}
              riskStatus={riskStatus} />
      <div className="main">
        <LeftPanel
          events={events}
          scenes={scenes}
          slicks={slicks}
          riskStatus={riskStatus}
          riskData={riskData}
          selectedSlickId={selectedSlickId}
          onOpenSlick={openSlick}
          onScanScene={scanScene}
        />
        <MapView vessels={vessels} slicks={slicks} detail={detail}
                 vesselMmsi={vesselMmsi} riskOn={riskOn} riskData={riskData}
                 onSelectSlick={openSlick} onSelectVessel={selectVessel} />
        {vesselMmsi ? (
          <VesselCard details={vesselDetails}
                      onShowTrack={selectVessel}
                      onClose={() => { setVesselMmsi(null); setVesselDetails(null) }} />
        ) : (
          <SlickDetail detail={detail} selectedSlickId={selectedSlickId}
                       onSelectVessel={selectVessel}
                       onAnalyze={() => reanalyze(detail.id)}
                       onClose={() => { setDetail(null); setSelectedSlickId(null) }} />
        )}
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
