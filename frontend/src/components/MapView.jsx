import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'

const BASEMAPS = {
  dark: {
    name: 'Dark Carto',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap · &copy; CARTO',
  },
  satellite: {
    name: 'Satellite Imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
  },
  topo: {
    name: 'Ocean Topo',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenTopoMap',
  },
}

const C = {
  abyss: '#0B1326', hull: '#171F33', line: '#334155',
  foam: '#DAE2FD', dim: '#86948A',
  amber: '#F59E0B', cyan: '#38BDF8', spill: '#EF4444', good: '#10B981',
}

function hydroCoord(lat, lon) {
  const f = (v, pos, neg) => {
    const d = Math.floor(Math.abs(v))
    const m = (Math.abs(v) - d) * 60
    return `${String(d).padStart(2, '0')}\u00b0${m.toFixed(1)}\u2032${v >= 0 ? pos : neg}`
  }
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`
}

function escapeHtml(str) {
  if (!str) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export default function MapView({
  vessels,
  slicks,
  detail,
  vesselMmsi,
  riskOn,
  riskData,
  onSelectSlick,
  onSelectVessel,
}) {
  const boxRef = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const tileLayerRef = useRef(null)

  const [basemapKey, setBasemapKey] = useState('dark')
  const [showVessels, setShowVessels] = useState(true)
  const [basemapMenuOpen, setBasemapMenuOpen] = useState(false)

  const onSelectVesselRef = useRef(onSelectVessel)
  onSelectVesselRef.current = onSelectVessel

  // --- Map Initialization ----------------------------------------------------
  useEffect(() => {
    const map = L.map(boxRef.current, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    }).setView([59.9, 25.4], 8)

    const initialBm = BASEMAPS.dark
    const tileLg = L.tileLayer(initialBm.url, {
      maxZoom: 18,
      attribution: initialBm.attribution,
    }).addTo(map)
    tileLayerRef.current = tileLg

    const lg = L.layerGroup().addTo(map)
    layerRef.current = lg
    mapRef.current = map

    const strip = document.getElementById('coord-strip')
    map.on('mousemove', (e) => {
      if (strip) {
        strip.textContent = hydroCoord(e.latlng.lat, e.latlng.lng)
      }
    })
    map.on('mouseout', () => {
      if (strip) strip.textContent = '—′ —′'
    })

    const onTrack = (e) => {
      drawVesselTrack(e.detail)
    }
    window.addEventListener('vessel-track', onTrack)

    const onFly = (e) => {
      map.flyTo([e.detail.lat, e.detail.lon], 10, { duration: 1.4 })
    }
    window.addEventListener('fly-to', onFly)

    return () => {
      window.removeEventListener('vessel-track', onTrack)
      window.removeEventListener('fly-to', onFly)
      map.remove()
    }
  }, [])

  // --- Basemap Switcher ------------------------------------------------------
  const switchBasemap = (key) => {
    setBasemapKey(key)
    setBasemapMenuOpen(false)
    if (!mapRef.current || !tileLayerRef.current) return
    const bm = BASEMAPS[key]
    mapRef.current.removeLayer(tileLayerRef.current)
    tileLayerRef.current = L.tileLayer(bm.url, {
      maxZoom: 18,
      attribution: bm.attribution,
    }).addTo(mapRef.current)
  }

  const resetView = () => {
    if (mapRef.current) {
      mapRef.current.flyTo([59.9, 25.4], 8, { duration: 1.2 })
    }
  }

  // --- Vessel Track Draw ----------------------------------------------------
  const drawVesselTrack = (tr) => {
    const lg = layerRef.current
    if (!lg || !tr.points.length) return
    const ll = tr.points.map((p) => [p[1], p[0]])
    if (mapRef.current._trackLine) {
      lg.removeLayer(mapRef.current._trackLine)
      lg.removeLayer(mapRef.current._trackStart)
      if (mapRef.current._trackAt) lg.removeLayer(mapRef.current._trackAt)
      mapRef.current._trackAt = null
    }
    mapRef.current._trackLine = L.polyline(ll, {
      color: C.amber,
      weight: 2.5,
      opacity: 0.9,
      dashArray: '6 5',
    }).addTo(lg).bindTooltip(tr.name ? `Track · ${tr.name}` : `Track MMSI ${tr.mmsi}`)
    mapRef.current._trackStart = L.circleMarker(ll[0], {
      radius: 4,
      color: C.amber,
      fillColor: C.amber,
      fillOpacity: 1,
    }).addTo(lg)

    if (tr.highlight_ts != null) {
      let best = null
      for (const p of tr.points) {
        if (best == null || Math.abs(p[2] - tr.highlight_ts) < Math.abs(best[2] - tr.highlight_ts)) {
          best = p
        }
      }
      if (best) {
        const t = new Date(tr.highlight_ts * 1000)
        const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC`
        const safeLabel = escapeHtml(tr.name || `MMSI ${tr.mmsi}`)
        mapRef.current._trackAt = L.marker([best[1], best[0]], {
          icon: L.divIcon({
            className: '',
            html: `<div class="at-release"><span class="at-dot"></span><span class="at-lbl mono">${safeLabel} \u00b7 at release ${hhmm}</span></div>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        }).addTo(lg)
        mapRef.current.flyTo([best[1], best[0]], 10, { duration: 1.2 })
        return
      }
    }
    mapRef.current.fitBounds(L.latLngBounds(ll), { padding: [40, 40], maxZoom: 11 })
  }

  // --- Spill Risk Heatmap Layer ----------------------------------------------
  useEffect(() => {
    const lg = layerRef.current
    if (!lg) return
    if (mapRef.current._riskLayer) {
      lg.removeLayer(mapRef.current._riskLayer)
      mapRef.current._riskLayer = null
    }
    if (!riskOn || !riskData?.features) return
    const ps = riskData.features.map((f) => f.properties.p)
    const pMin = Math.min(...ps)
    const pMax = Math.max(...ps)
    const span = Math.max(pMax - pMin, 1e-6)
    const grp = L.featureGroup(
      riskData.features.map((f) => {
        const p = f.properties.p
        const t = (p - pMin) / span
        const ring = f.geometry.coordinates[0]
        return L.rectangle([ring[0].slice().reverse(), ring[2].slice().reverse()], {
          color: 'transparent',
          weight: 0,
          fill: true,
          fillColor: C.amber,
          fillOpacity: 0.05 + 0.55 * t,
        }).bindTooltip(`Spill risk ${(p * 100).toFixed(0)}%`, { sticky: true })
      })
    )
    grp.addTo(lg)
    mapRef.current._riskLayer = grp
  }, [riskOn, riskData])

  // --- AIS Vessels Layer -----------------------------------------------------
  useEffect(() => {
    const lg = layerRef.current
    if (!lg) return
    if (mapRef.current._aisLayer) lg.removeLayer(mapRef.current._aisLayer)
    if (!showVessels || !vessels || !vessels.features) return

    const pts = vessels.features.map((f) => ({
      ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
      p: f.properties,
    }))
    const grp = L.featureGroup(
      pts.map((v) =>
        L.circleMarker(v.ll, {
          radius: 3.5,
          color: v.p.navStat === 15 ? '#475569' : C.good,
          weight: 1.5,
          fillColor: C.good,
          fillOpacity: 0.85,
        })
          .on('click', () => onSelectVesselRef.current(v.p.mmsi))
          .bindTooltip(
            `${v.p.name || 'MMSI ' + v.p.mmsi} · ${Math.round(v.p.sog ?? 0)} kn`,
            { direction: 'top', offset: [0, -6] }
          )
      )
    )
    grp.addTo(lg)
    mapRef.current._aisLayer = grp
  }, [vessels, showVessels])

  // --- Slicks Polygon Layer --------------------------------------------------
  useEffect(() => {
    const lg = layerRef.current
    if (!lg) return
    if (mapRef.current._slickLayer) lg.removeLayer(mapRef.current._slickLayer)
    const items = []
    for (const s of slicks) {
      if (!s.geometry?.geometry) continue
      const rings = s.geometry.geometry.coordinates
      const polys = s.geometry.geometry.type === 'MultiPolygon' ? rings : [rings]
      for (const poly of polys) {
        items.push({
          latlngs: poly[0].map((c) => [c[1], c[0]]),
          props: s,
        })
      }
    }
    const grp = L.featureGroup(
      items.map((it) =>
        L.polygon(it.latlngs, {
          color: C.spill,
          weight: 2,
          opacity: 0.95,
          fillColor: C.spill,
          fillOpacity: 0.35,
        })
          .on('click', () => onSelectSlick(it.props.id))
          .bindTooltip(`Slick #${it.props.id} · ${it.props.area_km2} km²`, {
            direction: 'top',
          })
      )
    )
    grp.addTo(lg)
    mapRef.current._slickLayer = grp
  }, [slicks])

  // --- Selected Slick Analysis Overlay ---------------------------------------
  useEffect(() => {
    const lg = layerRef.current
    if (!lg) return
    if (mapRef.current._analysisLayer) lg.removeLayer(mapRef.current._analysisLayer)
    mapRef.current._analysisLayer = null
    if (!detail) return
    const map = mapRef.current
    const grp = L.layerGroup()
    const bw = detail.backward
    const fw = detail.forward

    if (bw?.path?.centroid_path?.length) {
      const pts = bw.path.centroid_path.map((p) => [p[1], p[0]])
      const line = L.polyline(pts, {
        color: C.amber,
        weight: 2.2,
        dashArray: '4 6',
        opacity: 0.9,
      }).addTo(grp)
      line.bindTooltip('Backward Drift Hindcast', {
        permanent: true,
        direction: 'right',
        offset: [6, 0],
        className: 'map-label',
      })
    }

    if (fw?.path?.centroid_path?.length && fw.path.centroid_path.some((p) => p[0] != null)) {
      const pts = fw.path.centroid_path.filter((p) => p[0] != null).map((p) => [p[1], p[0]])
      const line = L.polyline(pts, {
        color: C.cyan,
        weight: 2.2,
        dashArray: '8 5',
        opacity: 0.85,
      }).addTo(grp)
      line.bindTooltip('Forward Forecast', {
        permanent: true,
        direction: 'right',
        offset: [6, 0],
        className: 'map-label',
      })
    }

    if (fw?.cone?.length) {
      for (const c of fw.cone.filter((k) => k.lon != null)) {
        L.circle([c.lat, c.lon], {
          radius: c.radius_km * 1000,
          color: C.cyan,
          weight: 1,
          opacity: 0.3,
          fill: false,
        }).addTo(grp)
      }
    }

    if (detail.geometry?.geometry?.coordinates) {
      const ring = detail.geometry.geometry.coordinates[0]
      const ll = ring.map((c) => [c[1], c[0]])
      L.polygon(ll, {
        color: C.spill,
        weight: 2.5,
        opacity: 1,
        fillColor: C.spill,
        fillOpacity: 0.45,
      })
        .bindTooltip('Detected Slick Footprint (Sentinel-1)', {
          permanent: true,
          direction: 'top',
          className: 'map-label',
        })
        .addTo(grp)
    }

    if (bw && bw.origin_lon != null) {
      const icon = L.divIcon({
        className: '',
        html: `<div class="origin-marker"><span></span><span></span><span></span></div>`,
        iconSize: [44, 44],
        iconAnchor: [22, 22],
      })
      L.marker([bw.origin_lat, bw.origin_lon], { icon })
        .bindTooltip(`Estimated Release Point (σ ≈ ${bw.origin_sigma_km.toFixed(1)} km)`, {
          permanent: true,
          direction: 'top',
          offset: [0, -22],
          className: 'map-label',
        })
        .addTo(grp)
    }

    grp.addTo(lg)
    mapRef.current._analysisLayer = grp

    const b = []
    if (bw?.path?.centroid_path?.length) {
      bw.path.centroid_path.forEach((p) => b.push([p[1], p[0]]))
    }
    if (detail.geometry?.geometry?.coordinates) {
      detail.geometry.geometry.coordinates[0].forEach((c) => b.push([c[1], c[0]]))
    }
    if (fw?.cone?.length) {
      fw.cone.filter((k) => k.lon != null).slice(-1).forEach((c) => b.push([c.lat, c.lon]))
    }
    if (b.length > 1) {
      map.fitBounds(L.latLngBounds(b), { padding: [60, 60], maxZoom: 12 })
    }
  }, [detail])

  return (
    <div className="map-wrap">
      <div ref={boxRef} className="map" />

      {/* Interactive Map Floating Toolbar (Top Right) */}
      <div className="map-floating-toolbar">
        <div className="toolbar-group">
          <button
            className={`toolbar-btn ${basemapMenuOpen ? 'active' : ''}`}
            onClick={() => setBasemapMenuOpen(!basemapMenuOpen)}
            title="Switch Basemap Layer">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            <span className="btn-label">{BASEMAPS[basemapKey].name}</span>
          </button>

          {basemapMenuOpen && (
            <div className="basemap-dropdown">
              {Object.entries(BASEMAPS).map(([k, bm]) => (
                <button
                  key={k}
                  className={`bm-option ${basemapKey === k ? 'selected' : ''}`}
                  onClick={() => switchBasemap(k)}>
                  {bm.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          className={`toolbar-btn ${showVessels ? 'active' : ''}`}
          onClick={() => setShowVessels(!showVessels)}
          title="Toggle AIS Vessel Traffic Overlay">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="12 2 19 21 12 17 5 21 12 2" />
          </svg>
          <span className="btn-label">AIS TRAFFIC</span>
        </button>

        <button className="toolbar-btn" onClick={resetView} title="Reset Map View">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
          </svg>
          <span className="btn-label">RESET AOI</span>
        </button>
      </div>

      {/* Floating Chart Legend */}
      <div className="map-legend">
        <div className="lg-title">GIS LAYER KEY</div>
        <div><span className="sw slick" /> Detected Slick (Sentinel-1 SAR)</div>
        <div><span className="sw origin" /> Estimated Release Origin</div>
        <div><span className="sw back" /> Backward Drift Hindcast</div>
        <div><span className="sw fwd" /> Forward Forecast Cone</div>
        <div><span className="sw ais" /> Live AIS Vessel Target</div>
        <div><span className="sw suspect" /> Ranked Suspect Vessel</div>
      </div>

      {riskOn && (
        <div className="risk-legend">
          <span>SPILL RISK</span>
          <span className="ramp" aria-hidden="true" />
          <span className="mono">LOW → HIGH</span>
        </div>
      )}

      <div className="coord-strip mono" id="coord-strip">59°54.0′N 025°18.0′E</div>
    </div>
  )
}
