import { useEffect, useRef } from 'react'
import L from 'leaflet'

const C = {
  abyss: '#071320', hull: '#0D2438', line: '#1B3A52',
  foam: '#DCE9F2', dim: '#7FA0B8',
  amber: '#F2B23E', cyan: '#56C8DF', spill: '#FF5C38',
}

function hydroCoord(lat, lon) {
  const f = (v, pos, neg) => {
    const d = Math.floor(Math.abs(v))
    const m = (Math.abs(v) - d) * 60
    return `${String(d).padStart(2, '0')}°${m.toFixed(1)}′${v >= 0 ? pos : neg}`
  }
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`
}

export default function MapView({ vessels, slicks, detail, vesselMmsi,
                                  riskOn, riskData, onSelectSlick, onSelectVessel }) {
  const boxRef = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)      // dynamic data layer group
  const onSelectVesselRef = useRef(onSelectVessel)
  onSelectVesselRef.current = onSelectVessel

  // --- init ------------------------------------------------------------------
  useEffect(() => {
    const map = L.map(boxRef.current, {
      zoomControl: false,
      attributionControl: true,
      preferCanvas: true,
    }).setView([59.9, 25.4], 8)

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap · &copy; CARTO',
    }).addTo(map)

    L.control.zoom({ position: 'topright' }).addTo(map)
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
      map.flyTo([e.detail.lat, e.detail.lon], 9, { duration: 1.2 })
    }
    window.addEventListener('fly-to', onFly)
    return () => {
      window.removeEventListener('vessel-track', onTrack)
      window.removeEventListener('fly-to', onFly)
      map.remove()
    }
  }, [])

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
      color: C.amber, weight: 2.5, opacity: 0.9, dashArray: '6 5',
    }).addTo(lg).bindTooltip(tr.name ? `Track · ${tr.name}` : `Track MMSI ${tr.mmsi}`)
    mapRef.current._trackStart = L.circleMarker(ll[0], {
      radius: 4, color: C.amber, fillColor: C.amber, fillOpacity: 1,
    }).addTo(lg)

    // "where was this vessel at the estimated release moment?"
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
        const label = tr.name || `MMSI ${tr.mmsi}`
        mapRef.current._trackAt = L.marker([best[1], best[0]], {
          icon: L.divIcon({
            className: '',
            html: `<div class="at-release"><span class="at-dot"></span><span class="at-lbl mono">${label} · at release ${hhmm}</span></div>`,
            iconSize: [0, 0], iconAnchor: [0, 0],
          }),
        }).addTo(lg)
        mapRef.current.flyTo([best[1], best[0]], 10, { duration: 1.2 })
        return
      }
    }
    mapRef.current.fitBounds(L.latLngBounds(ll), { padding: [40, 40], maxZoom: 11 })
  }

  // --- spill-risk heatmap ------------------------------------------------------
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
    const grp = L.featureGroup(riskData.features.map((f) => {
      const p = f.properties.p
      const t = (p - pMin) / span            // normalized for contrast
      const ring = f.geometry.coordinates[0]
      return L.rectangle([ring[0].slice().reverse(), ring[2].slice().reverse()], {
        color: 'transparent', weight: 0, fill: true,
        fillColor: '#F2B23E',
        fillOpacity: 0.05 + 0.55 * t,
      }).bindTooltip(`Spill risk ${(p * 100).toFixed(0)}%`, { sticky: true })
    }))
    grp.addTo(lg)
    mapRef.current._riskLayer = grp
  }, [riskOn, riskData])

  // --- vessels ---------------------------------------------------------------
  useEffect(() => {
    const lg = layerRef.current
    if (!lg || !vessels || !vessels.features) return
    if (mapRef.current._aisLayer) lg.removeLayer(mapRef.current._aisLayer)
    const pts = vessels.features.map((f) => ({
      ll: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
      p: f.properties,
    }))
    const grp = L.featureGroup(pts.map((v) =>
      L.circleMarker(v.ll, {
        radius: 2.6,
        color: v.p.navStat === 15 ? '#3a556b' : C.cyan,
        weight: 1,
        fillColor: C.cyan,
        fillOpacity: 0.85,
      }).on('click', () => onSelectVesselRef.current(v.p.mmsi))
        .bindTooltip(
          `${v.p.name || 'MMSI ' + v.p.mmsi}  ·  ${Math.round(v.p.sog ?? 0)} kn`,
          { direction: 'top', offset: [0, -6] })))
    grp.addTo(lg)
    mapRef.current._aisLayer = grp
  }, [vessels])

  // --- slick polygons (all detections) ----------------------------------------
  useEffect(() => {
    const lg = layerRef.current
    if (!lg) return
    if (mapRef.current._slickLayer) lg.removeLayer(mapRef.current._slickLayer)
    const items = []
    for (const s of slicks) {
      if (!s.geometry?.geometry) continue
      const rings = s.geometry.geometry.coordinates
      const polys = s.geometry.geometry.type === 'MultiPolygon'
        ? rings : [rings]
      for (const poly of polys) {
        items.push({
          latlngs: poly[0].map((c) => [c[1], c[0]]),
          props: s,
        })
      }
    }
    const grp = L.featureGroup(items.map((it) =>
      L.polygon(it.latlngs, {
        color: C.spill, weight: 1.6, opacity: 0.95,
        fillColor: C.spill, fillOpacity: 0.30,
      }).on('click', () => onSelectSlick(it.props.id))
        .bindTooltip(`Slick #${it.props.id} · ${it.props.area_km2} km²`, {
          direction: 'top',
        })))
    grp.addTo(lg)
    mapRef.current._slickLayer = grp
  }, [slicks])

  // --- selected-slick analysis overlay ------------------------------------------
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
        color: C.amber, weight: 2, dashArray: '2 7', opacity: 0.9,
      }).addTo(grp)
      line.bindTooltip('Backward drift path — traced to release', {
        permanent: true, direction: 'right', offset: [6, 0],
        className: 'map-label',
      })
    }
    if (fw?.path?.centroid_path?.length && fw.path.centroid_path.some((p) => p[0] != null)) {
      const pts = fw.path.centroid_path.filter((p) => p[0] != null)
        .map((p) => [p[1], p[0]])
      const line = L.polyline(pts, {
        color: C.cyan, weight: 2, dashArray: '9 6', opacity: 0.85,
      }).addTo(grp)
      line.bindTooltip('Forward forecast — predicted drift', {
        permanent: true, direction: 'right', offset: [6, 0],
        className: 'map-label',
      })
    }
    if (fw?.cone?.length) {
      for (const c of fw.cone.filter((k) => k.lon != null)) {
        L.circle([c.lat, c.lon], {
          radius: c.radius_km * 1000, color: C.cyan, weight: 1,
          opacity: 0.28, fill: false,
        }).addTo(grp)
      }
    }
    if (detail.geometry?.geometry?.coordinates) {
      const ring = detail.geometry.geometry.coordinates[0]
      const ll = ring.map((c) => [c[1], c[0]])
      L.polygon(ll, {
        color: C.spill, weight: 2.4, opacity: 1,
        fillColor: C.spill, fillOpacity: 0.45,
      }).bindTooltip('Detected slick footprint (Sentinel-1)', {
        permanent: true, direction: 'top', className: 'map-label',
      }).addTo(grp)
    }
    if (bw && bw.origin_lon != null) {
      const icon = L.divIcon({
        className: '',
        html: `<div class="origin-marker${bw.origin_sigma_km > 20 ? ' wide' : ''}">
                 <span></span><span></span><span></span>
               </div>`,
        iconSize: [46, 46], iconAnchor: [23, 23],
      })
      L.marker([bw.origin_lat, bw.origin_lon], { icon })
        .bindTooltip(
          `Estimated release point — σ ≈ ${bw.origin_sigma_km.toFixed(1)} km`,
          { permanent: true, direction: 'top', offset: [0, -26],
            className: 'map-label' })
        .addTo(grp)
    }

    grp.addTo(lg)
    mapRef.current._analysisLayer = grp

    // frame the analysis
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

      <div className="map-legend">
        <div className="lg-title">CHART KEY</div>
        <div><span className="sw slick" /> detected slick (Sentinel-1)</div>
        <div><span className="sw origin" /> estimated release point</div>
        <div><span className="sw back" /> backward drift (hindcast)</div>
        <div><span className="sw fwd" /> forward forecast + cone</div>
        <div><span className="sw ais" /> live AIS vessel</div>
        <div><span className="sw suspect" /> ranked suspect</div>
      </div>

      {riskOn && (
        <div className="risk-legend">
          <span>spill risk</span>
          <span className="ramp" aria-hidden="true" />
          <span className="mono">low → high</span>
        </div>
      )}
      <div className="coord-strip mono" id="coord-strip">59°54.0′N 025°18.0′E</div>
    </div>
  )
}
