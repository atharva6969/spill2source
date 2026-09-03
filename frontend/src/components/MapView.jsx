import { useCallback, useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'

// Raster basemaps. MapLibre has no {s} subdomain token, so OSM is expanded into
// explicit per-subdomain URLs. maxzoom is each service's real limit — MapLibre
// overzooms (stretches) past it instead of showing blank tiles.
export const BASEMAPS = {
  dark: {
    name: 'Dark Maritime',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxzoom: 16,
  },
  ocean: {
    name: 'Ocean Topo',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}'],
    attribution: '&copy; Esri, GEBCO, NOAA, Garmin',
    maxzoom: 13,
  },
  satellite: {
    name: 'Satellite Imagery',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    attribution: '&copy; Esri, Maxar, Earthstar Geographics',
    maxzoom: 18,
  },
  osm: {
    name: 'OpenStreetMap',
    tiles: [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    ],
    attribution: '&copy; OpenStreetMap contributors',
    maxzoom: 19,
  },
}

const C = {
  abyss: '#0B1326', hull: '#171F33', line: '#334155',
  foam: '#DAE2FD', dim: '#86948A',
  amber: '#F59E0B', cyan: '#38BDF8', spill: '#EF4444', good: '#10B981',
}

// Gulf of Finland AOI. MapLibre takes [lon, lat] — the opposite of Leaflet.
const HOME = { center: [25.4, 59.9], zoom: 8 }

// Atmosphere. Alpha below 1 at low zoom lets the starfield behind the canvas
// show through, so the Earth reads as a planet in space, not a flat disc.
const SKY = {
  'sky-color': '#0A1832',
  'sky-horizon-blend': 0.6,
  'horizon-color': '#1E4E8C',
  'horizon-fog-blend': 0.55,
  'fog-color': '#0B1326',
  'fog-ground-blend': 0.1,
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 5, 0.5, 7, 0],
}

const EMPTY = { type: 'FeatureCollection', features: [] }

// Overlay draw order, bottom → top. The basemap is re-inserted below the first
// of these that exists, so switching basemap never reshuffles the overlays.
const OVERLAY_ORDER = [
  'risk-fill', 'slick-fill', 'slick-line', 'cone-line',
  'footprint-fill', 'footprint-line', 'drift-back', 'drift-fwd',
  'track-line', 'track-start', 'vessels',
]

function hydroCoord(lat, lon) {
  const f = (v, pos, neg) => {
    const d = Math.floor(Math.abs(v))
    const m = (Math.abs(v) - d) * 60
    return `${String(d).padStart(2, '0')}°${m.toFixed(1)}′${v >= 0 ? pos : neg}`
  }
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`
}

function escapeHtml(str) {
  if (str === null || str === undefined) return ''
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Spinning the globe past the antimeridian pushes lon beyond ±180; wrap it back
// so the coordinate readout never reads 400°E.
const wrapLon = (lon) =>
  (lon >= -180 && lon <= 180 ? lon : ((((lon + 180) % 360) + 360) % 360) - 180)

const fc = (features) => ({ type: 'FeatureCollection', features })

// MapLibre circle radii are in pixels, so a metric radius has to become a real
// polygon. Small-angle approximation is plenty at forecast-cone scales.
function circleRing(lon, lat, radiusKm, steps = 72) {
  const dLat = radiusKm / 110.574
  const cosLat = Math.cos((lat * Math.PI) / 180)
  const dLon = radiusKm / (111.32 * Math.max(Math.abs(cosLat), 1e-6))
  const ring = []
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * Math.PI * 2
    ring.push([lon + dLon * Math.cos(th), lat + dLat * Math.sin(th)])
  }
  return ring
}

const midpoint = (coords) =>
  coords && coords.length ? coords[Math.floor(coords.length / 2)] : null

function ringCentroid(ring) {
  if (!ring || !ring.length) return null
  // GeoJSON rings repeat the first vertex last; counting it twice drags the
  // label toward that corner.
  const first = ring[0]
  const last = ring[ring.length - 1]
  const pts = ring.length > 2 && last && first[0] === last[0] && first[1] === last[1]
    ? ring.slice(0, -1)
    : ring
  let x = 0
  let y = 0
  for (const c of pts) {
    x += c[0]
    y += c[1]
  }
  return [x / pts.length, y / pts.length]
}

// The `background` layer paints the globe's surface (not the space around it),
// so it doubles as the deep-ocean fill while raster tiles stream in.
function buildStyle(bm) {
  return {
    version: 8,
    projection: { type: 'globe' },
    sky: SKY,
    sources: {
      basemap: {
        type: 'raster',
        tiles: bm.tiles,
        tileSize: 256,
        minzoom: 0,
        maxzoom: bm.maxzoom ?? 18,
        attribution: bm.attribution,
      },
    },
    layers: [
      { id: 'globe-surface', type: 'background', paint: { 'background-color': C.abyss } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  }
}

// Every overlay is created once as an empty GeoJSON source; updates are pure
// setData() calls, which keeps the globe from rebuilding layers on each poll.
function addOverlays(map) {
  const src = (id) => {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: EMPTY })
  }
  ;['s-risk', 's-slicks', 's-vessels', 's-cone', 's-footprint',
    's-back', 's-fwd', 's-track', 's-track-start'].forEach(src)

  const layer = (def) => {
    if (!map.getLayer(def.id)) map.addLayer(def)
  }

  layer({
    id: 'risk-fill', type: 'fill', source: 's-risk',
    paint: { 'fill-color': C.amber, 'fill-opacity': ['get', 'o'] },
  })
  layer({
    id: 'slick-fill', type: 'fill', source: 's-slicks',
    paint: { 'fill-color': C.spill, 'fill-opacity': 0.35 },
  })
  layer({
    id: 'slick-line', type: 'line', source: 's-slicks',
    paint: { 'line-color': C.spill, 'line-width': 2, 'line-opacity': 0.95 },
  })
  layer({
    id: 'cone-line', type: 'line', source: 's-cone',
    paint: { 'line-color': C.cyan, 'line-width': 1, 'line-opacity': 0.3 },
  })
  layer({
    id: 'footprint-fill', type: 'fill', source: 's-footprint',
    paint: { 'fill-color': C.spill, 'fill-opacity': 0.45 },
  })
  layer({
    id: 'footprint-line', type: 'line', source: 's-footprint',
    paint: { 'line-color': C.spill, 'line-width': 2.5, 'line-opacity': 1 },
  })
  layer({
    id: 'drift-back', type: 'line', source: 's-back',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': C.amber, 'line-width': 2.2, 'line-opacity': 0.9,
      'line-dasharray': [2, 2.5],
    },
  })

  layer({
    id: 'drift-fwd', type: 'line', source: 's-fwd',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': C.cyan, 'line-width': 2.2, 'line-opacity': 0.85,
      'line-dasharray': [3, 2],
    },
  })
  layer({
    id: 'track-line', type: 'line', source: 's-track',
    layout: { 'line-join': 'round' },
    paint: {
      'line-color': C.amber, 'line-width': 2.5, 'line-opacity': 0.9,
      'line-dasharray': [2.5, 2],
    },
  })
  layer({
    id: 'track-start', type: 'circle', source: 's-track-start',
    paint: { 'circle-radius': 4, 'circle-color': C.amber, 'circle-opacity': 1 },
  })
  layer({
    id: 'vessels', type: 'circle', source: 's-vessels',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 2.4, 8, 3.8, 13, 6],
      'circle-color': C.good,
      'circle-opacity': 0.85,
      'circle-stroke-width': 1.5,
      // Nav status 15 = "undefined" in AIS; grey those hulls out.
      'circle-stroke-color': ['case', ['==', ['get', 'navStat'], 15], '#475569', C.good],
    },
  })
}

export default function MapView({
  vessels,
  slicks,
  detail,
  vesselMmsi,
  riskOn,
  riskData,
  showVessels,
  basemapKey,
  projection = 'globe',
  leftPanelOpen,
  rightPanelOpen,
  onSelectSlick,
  onSelectVessel,
}) {
  const boxRef = useRef(null)
  const mapRef = useRef(null)
  const readyRef = useRef(false)
  const popupRef = useRef(null)
  const labelsRef = useRef([])
  const pendingFocusRef = useRef(null)

  // Latest props mirrored into a ref so the one-shot map effect and the async
  // style-load callback always render the current data, whatever order they run.
  const dataRef = useRef({
    vessels: null, slicks: [], detail: null,
    riskOn: false, riskData: null, showVessels: true, track: null,
  })
  dataRef.current.vessels = vessels
  dataRef.current.slicks = slicks
  dataRef.current.detail = detail
  dataRef.current.riskOn = riskOn
  dataRef.current.riskData = riskData
  dataRef.current.showVessels = showVessels

  const cbRef = useRef({ onSelectSlick, onSelectVessel })
  cbRef.current = { onSelectSlick, onSelectVessel }

  const projRef = useRef(projection)
  projRef.current = projection

  // MapLibre has no glyph server configured here, so the "always on" analysis
  // labels are HTML markers rather than symbol layers.
  const clearLabels = () => {
    labelsRef.current.forEach((m) => m.remove())
    labelsRef.current = []
  }

  const addLabel = (map, lngLat, text, anchor = 'left') => {
    if (!lngLat || !Number.isFinite(lngLat[0]) || !Number.isFinite(lngLat[1])) return
    const el = document.createElement('div')
    el.className = 'map-label'
    el.textContent = text
    labelsRef.current.push(
      new maplibregl.Marker({ element: el, anchor }).setLngLat(lngLat).addTo(map)
    )
  }

  const addOriginMarker = (map, lngLat, sigmaKm) => {
    const el = document.createElement('div')
    el.className = 'origin-marker'
    el.innerHTML = '<span></span><span></span><span></span>'
    labelsRef.current.push(
      new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(lngLat).addTo(map)
    )
    addLabel(map, lngLat, `Estimated Release Point (σ ≈ ${sigmaKm.toFixed(1)} km)`, 'bottom')
  }

  const applyData = useCallback(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const d = dataRef.current
    const setSrc = (id, data) => {
      const s = map.getSource(id)
      if (s) s.setData(data)
    }

    // Spill-risk grid: features are already GeoJSON polygons, so only the
    // per-cell opacity needs deriving.
    let risk = []
    if (d.riskOn && d.riskData?.features?.length) {
      const ps = d.riskData.features.map((f) => f.properties.p)
      const pMin = Math.min(...ps)
      const span = Math.max(Math.max(...ps) - pMin, 1e-6)
      risk = d.riskData.features.map((f) => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: { p: f.properties.p, o: 0.05 + 0.55 * ((f.properties.p - pMin) / span) },
      }))
    }
    setSrc('s-risk', fc(risk))

    setSrc('s-slicks', fc(
      (d.slicks || [])
        .filter((s) => s.geometry?.geometry)
        .map((s) => ({
          type: 'Feature',
          geometry: s.geometry.geometry,
          properties: { id: s.id, area_km2: s.area_km2 },
        }))
    ))

    // /api/vessels/live is already a GeoJSON FeatureCollection of points.
    setSrc('s-vessels', fc(
      d.showVessels && d.vessels?.features ? d.vessels.features : []
    ))

    clearLabels()

    // --- selected slick: hindcast, forecast, cone, footprint, origin ---------
    const back = []
    const fwd = []
    const cone = []
    const foot = []
    const det = d.detail
    if (det) {
      const bw = det.backward
      const fw = det.forward

      // centroid_path entries arrive as [lon, lat] — already MapLibre's order.
      const bwPts = (bw?.path?.centroid_path || []).filter((p) => p?.[0] != null)
      if (bwPts.length > 1) {
        const coords = bwPts.map((p) => [p[0], p[1]])
        back.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })
        addLabel(map, midpoint(coords), 'Backward Drift Hindcast', 'left')
      }

      const fwPts = (fw?.path?.centroid_path || []).filter((p) => p?.[0] != null)
      if (fwPts.length > 1) {
        const coords = fwPts.map((p) => [p[0], p[1]])
        fwd.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })
        addLabel(map, midpoint(coords), 'Forward Forecast', 'left')
      }

      for (const c of (fw?.cone || []).filter((k) => k.lon != null)) {
        cone.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [circleRing(c.lon, c.lat, c.radius_km)] },
        })
      }

      const geom = det.geometry?.geometry
      if (geom?.coordinates?.length) {
        foot.push({ type: 'Feature', properties: {}, geometry: geom })
        const ring = geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0]
        addLabel(map, ringCentroid(ring), 'Detected Slick Footprint (Sentinel-1)', 'bottom')
      }

      if (bw && bw.origin_lon != null) {
        addOriginMarker(map, [bw.origin_lon, bw.origin_lat], bw.origin_sigma_km ?? 0)
      }
    }
    setSrc('s-back', fc(back))
    setSrc('s-fwd', fc(fwd))
    setSrc('s-cone', fc(cone))
    setSrc('s-footprint', fc(foot))

    // --- AIS track of the selected vessel -----------------------------------
    const tr = d.track
    const pts = (tr?.points || []).filter((p) => p?.[0] != null)
    if (pts.length > 1) {
      const coords = pts.map((p) => [p[0], p[1]])
      setSrc('s-track', fc([
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
      ]))
      setSrc('s-track-start', fc([
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords[0] } },
      ]))

      // Where the vessel was at the estimated release time.
      if (tr.highlight_ts != null) {
        let best = null
        for (const p of pts) {
          if (!best || Math.abs(p[2] - tr.highlight_ts) < Math.abs(best[2] - tr.highlight_ts)) best = p
        }
        if (best) {
          const t = new Date(tr.highlight_ts * 1000)
          const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')} UTC`
          const el = document.createElement('div')
          el.className = 'at-release'
          el.innerHTML = `<span class="at-dot"></span><span class="at-lbl mono">${escapeHtml(tr.name || `MMSI ${tr.mmsi}`)} · at release ${hhmm}</span>`
          labelsRef.current.push(
            new maplibregl.Marker({ element: el, anchor: 'left' })
              .setLngLat([best[0], best[1]]).addTo(map)
          )
        }
      }
    } else {
      setSrc('s-track', EMPTY)
      setSrc('s-track-start', EMPTY)
    }
  }, [])

  // --- camera --------------------------------------------------------------
  const fitCoords = (coords, maxZoom = 12, padding = 60) => {
    const map = mapRef.current
    const ok = coords.filter((c) => Number.isFinite(c?.[0]) && Number.isFinite(c?.[1]))
    if (!map || ok.length < 2) return
    const b = new maplibregl.LngLatBounds(ok[0], ok[0])
    ok.forEach((c) => b.extend(c))
    map.fitBounds(b, { padding, maxZoom, duration: 1200 })
  }

  const focusDetail = useCallback(() => {
    const det = dataRef.current.detail
    if (!det) return
    const coords = []
    for (const p of det.backward?.path?.centroid_path || []) {
      if (p?.[0] != null) coords.push([p[0], p[1]])
    }
    const geom = det.geometry?.geometry
    if (geom?.coordinates?.length) {
      const ring = geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0]
      for (const c of ring) coords.push([c[0], c[1]])
    }
    for (const c of (det.forward?.cone || []).filter((k) => k.lon != null).slice(-1)) {
      coords.push([c.lon, c.lat])
    }
    fitCoords(coords, 12, 60)
  }, [])

  const focusTrack = useCallback((tr) => {
    const map = mapRef.current
    const pts = (tr?.points || []).filter((p) => p?.[0] != null)
    if (!map || !pts.length) return
    if (tr.highlight_ts != null) {
      let best = null
      for (const p of pts) {
        if (!best || Math.abs(p[2] - tr.highlight_ts) < Math.abs(best[2] - tr.highlight_ts)) best = p
      }
      if (best) {
        map.flyTo({ center: [best[0], best[1]], zoom: 10, duration: 1200 })
        return
      }
    }
    fitCoords(pts.map((p) => [p[0], p[1]]), 11, 40)
  }, [])

  // --- map init (once) ------------------------------------------------------
  useEffect(() => {
    const bm = BASEMAPS[basemapKey] || BASEMAPS.dark
    const map = new maplibregl.Map({
      container: boxRef.current,
      style: buildStyle(bm),
      center: HOME.center,
      zoom: HOME.zoom,
      minZoom: 1,
      maxZoom: 18,
      maxPitch: 85,
      // Single continuous world / seamless 3D globe (no duplicate repeating tiles)
      renderWorldCopies: false,
      // Placed manually below so it never stacks under the nav control.
      attributionControl: false,
      canvasContextAttributes: { antialias: true },
    })
    mapRef.current = map

    // Zoom, compass (drag to rotate) and a pitch indicator for the 3D camera.
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left')

    const popup = new maplibregl.Popup({
      closeButton: false, closeOnClick: false, offset: 12,
      className: 'hud-popup', maxWidth: '260px',
    })
    popupRef.current = popup

    map.on('load', () => {
      readyRef.current = true
      try {
        map.setProjection({ type: projRef.current === 'flat' ? 'mercator' : 'globe' })
      } catch { /* projection unsupported — falls back to mercator */ }
      try {
        map.setSky(SKY)
      } catch { /* sky unsupported — globe still renders */ }
      addOverlays(map)
      applyData()
      if (pendingFocusRef.current) {
        pendingFocusRef.current()
        pendingFocusRef.current = null
      }
    })

    map.on('error', (e) => {
      // Tile 404s are routine at the edges of a service's zoom range.
      if (e?.error?.status === 404) return
      console.warn('MapLibre:', e?.error?.message || e)
    })

    // --- hover readouts (Leaflet tooltips → a single shared popup) ----------
    const HOVER = [
      ['vessels', (p) => `${escapeHtml(p.name || `MMSI ${p.mmsi}`)} · ${Math.round(p.sog ?? 0)} kn`],
      ['slick-fill', (p) => `Slick #${escapeHtml(p.id)} · ${escapeHtml(p.area_km2)} km²`],
      ['risk-fill', (p) => `Spill risk ${(Number(p.p) * 100).toFixed(0)}%`],
    ]
    HOVER.forEach(([id, fmt]) => {
      map.on('mousemove', id, (e) => {
        const f = e.features?.[0]
        if (!f) return
        map.getCanvas().style.cursor = id === 'risk-fill' ? '' : 'pointer'
        popup.setLngLat(e.lngLat).setHTML(fmt(f.properties)).addTo(map)
      })
      map.on('mouseleave', id, () => {
        map.getCanvas().style.cursor = ''
        popup.remove()
      })
    })

    const onVesselClick = (e) => {
      const p = e.features?.[0]?.properties
      if (p) cbRef.current.onSelectVessel(p.mmsi)
    }
    const onSlickClick = (e) => {
      const p = e.features?.[0]?.properties
      if (p) cbRef.current.onSelectSlick(p.id)
    }
    map.on('click', 'vessels', onVesselClick)
    map.on('click', 'slick-fill', onSlickClick)

    // --- coordinate readout -------------------------------------------------
    const strip = document.getElementById('coord-strip')
    map.on('mousemove', (e) => {
      if (!strip) return
      const lat = e.lngLat?.lat
      const lng = e.lngLat?.lng
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        strip.textContent = hydroCoord(lat, wrapLon(lng))
      }
    })
    map.on('mouseout', () => {
      if (strip) strip.textContent = '—′ —′'
    })

    // --- app-level events ---------------------------------------------------
    const onTrack = (e) => {
      dataRef.current.track = e.detail
      applyData()
      if (readyRef.current) focusTrack(e.detail)
      else pendingFocusRef.current = () => focusTrack(e.detail)
    }
    const onFly = (e) => {
      map.flyTo({ center: [e.detail.lon, e.detail.lat], zoom: 10, duration: 1400 })
    }
    const onReset = () => {
      map.flyTo({
        center: HOME.center, zoom: HOME.zoom,
        pitch: 0, bearing: 0, duration: 1200,
      })
    }
    window.addEventListener('vessel-track', onTrack)
    window.addEventListener('fly-to', onFly)
    window.addEventListener('reset-map-view', onReset)

    return () => {
      window.removeEventListener('vessel-track', onTrack)
      window.removeEventListener('fly-to', onFly)
      window.removeEventListener('reset-map-view', onReset)
      clearLabels()
      popup.remove()
      readyRef.current = false
      mapRef.current = null
      map.remove()
    }
    // Basemap and projection are read once here; their own effects handle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- basemap swap: replace only the raster layer, leave overlays alone -----
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    const bm = BASEMAPS[basemapKey] || BASEMAPS.dark
    const below = OVERLAY_ORDER.find((id) => map.getLayer(id))
    if (map.getLayer('basemap')) map.removeLayer('basemap')
    if (map.getSource('basemap')) map.removeSource('basemap')
    map.addSource('basemap', {
      type: 'raster',
      tiles: bm.tiles,
      tileSize: 256,
      minzoom: 0,
      maxzoom: bm.maxzoom ?? 18,
      attribution: bm.attribution,
    })
    map.addLayer({ id: 'basemap', type: 'raster', source: 'basemap' }, below)
  }, [basemapKey])

  // --- 3D globe ⇄ flat mercator ---------------------------------------------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !readyRef.current) return
    try {
      map.setProjection({ type: projection === 'flat' ? 'mercator' : 'globe' })
    } catch { /* older build without globe support */ }
  }, [projection])

  useEffect(() => {
    applyData()
  }, [vessels, showVessels, slicks, riskOn, riskData, applyData])

  useEffect(() => {
    applyData()
    if (!detail) return
    if (readyRef.current) focusDetail()
    else pendingFocusRef.current = focusDetail
  }, [detail, applyData, focusDetail])

  return (
    <div className={`map-wrap ${rightPanelOpen ? 'dock-r-open' : 'dock-r-closed'}`}>
      {/* Deep space + stars, visible through the translucent atmosphere */}
      <div className="space-backdrop" aria-hidden="true" />
      <div ref={boxRef} className="map" />

      {/* Floating Chart Legend (smoothly offsets when left intelligence dock opens) */}
      <div className={`map-legend ${leftPanelOpen ? 'dock-open' : 'dock-closed'}`}>
        <div className="lg-title">GIS LAYER KEY</div>
        <div><span className="sw slick" /> Detected Slick (Sentinel-1 SAR)</div>
        <div><span className="sw origin" /> Estimated Release Origin</div>
        <div><span className="sw back" /> Backward Drift Hindcast</div>
        <div><span className="sw fwd" /> Forward Forecast Cone</div>
        <div><span className="sw ais" /> Live AIS Vessel Target</div>
        <div><span className="sw suspect" /> Ranked Suspect Vessel</div>
      </div>

      {riskOn && (
        <div className={`risk-legend ${rightPanelOpen ? 'dock-open' : 'dock-closed'}`}>
          <span>SPILL RISK</span>
          <span className="ramp" aria-hidden="true" />
          <span className="mono">LOW → HIGH</span>
        </div>
      )}

      <div className={`coord-strip mono ${leftPanelOpen ? 'dock-open' : 'dock-closed'}`} id="coord-strip">
        59°54.0′N 025°18.0′E
      </div>
    </div>
  )
}
