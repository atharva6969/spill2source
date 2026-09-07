import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

/**
 * Custom GLSL Shader for Atmospheric Horizon Glow (Fresnel rim scattering)
 */
const AtmosphereShader = {
  vertexShader: `
    varying vec3 vNormal;
    varying vec3 vPosition;
    void main() {
      vNormal = normalize(normalMatrix * normal);
      vPosition = (modelViewMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * vec4(vPosition, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vNormal;
    varying vec3 vPosition;
    uniform vec3 uColorCyan;
    uniform vec3 uColorAmber;
    uniform vec3 uSunPosition;
    
    void main() {
      vec3 viewDir = normalize(-vPosition);
      float intensity = pow(1.0 - abs(dot(vNormal, viewDir)), 3.2);
      
      vec3 sunDir = normalize(uSunPosition);
      float sunDot = max(0.0, dot(vNormal, sunDir));
      
      vec3 glowColor = mix(uColorCyan, uColorAmber, pow(sunDot, 2.0));
      gl_FragColor = vec4(glowColor, intensity * 0.9);
    }
  `
}

/**
 * Helper to dynamically generate high-definition procedural Earth Day & Night Light Textures
 */
function createEarthTextures() {
  // 1. Day / Ocean Surface Texture
  const dayCanvas = document.createElement('canvas')
  dayCanvas.width = 2048
  dayCanvas.height = 1024
  const dayCtx = dayCanvas.getContext('2d')

  // Deep ocean indigo background
  dayCtx.fillStyle = '#030a18'
  dayCtx.fillRect(0, 0, 2048, 1024)

  const oceanGrad = dayCtx.createLinearGradient(0, 0, 0, 1024)
  oceanGrad.addColorStop(0, '#01050e')
  oceanGrad.addColorStop(0.5, '#05142a')
  oceanGrad.addColorStop(1, '#01050e')
  dayCtx.fillStyle = oceanGrad
  dayCtx.fillRect(0, 0, 2048, 1024)

  // 2. Night City Lights Texture (Golden/Amber glow clusters)
  const nightCanvas = document.createElement('canvas')
  nightCanvas.width = 2048
  nightCanvas.height = 1024
  const nightCtx = nightCanvas.getContext('2d')

  nightCtx.fillStyle = '#010309'
  nightCtx.fillRect(0, 0, 2048, 1024)

  const seedLandmasses = [
    { x: 1050, y: 320, r: 180, density: 1.0 },  // Europe & Baltic
    { x: 1120, y: 280, r: 120, density: 0.9 },  // Scandinavia
    { x: 980, y: 350, r: 140, density: 0.95 },  // Western Europe
    { x: 1180, y: 380, r: 160, density: 0.85 },  // Eastern Europe
    { x: 520, y: 340, r: 240, density: 0.9 },   // North America East
    { x: 420, y: 400, r: 160, density: 0.7 },   // North America West
    { x: 1450, y: 360, r: 280, density: 0.9 },  // Asia Central
    { x: 1600, y: 420, r: 190, density: 0.95 }, // Japan / East Asia
    { x: 1350, y: 480, r: 150, density: 0.8 },  // India / SE Asia
    { x: 1220, y: 440, r: 110, density: 0.85 }, // Middle East
    { x: 680, y: 650, r: 180, density: 0.6 },   // South America
    { x: 1080, y: 580, r: 200, density: 0.65 }  // Africa
  ]

  seedLandmasses.forEach(({ x, y, r, density }) => {
    dayCtx.fillStyle = '#08172c'
    dayCtx.beginPath()
    dayCtx.arc(x, y, r, 0, Math.PI * 2)
    dayCtx.fill()

    const numClusters = Math.floor(160 * density)
    for (let i = 0; i < numClusters; i++) {
      const angle = Math.random() * Math.PI * 2
      const dist = Math.pow(Math.random(), 0.7) * r
      const cx = x + Math.cos(angle) * dist
      const cy = y + Math.sin(angle) * dist

      if (cx < 0 || cx > 2048 || cy < 0 || cy > 1024) continue

      const clusterSize = Math.random() * 5 + 1.5
      const brightness = Math.random()

      const lightGrad = nightCtx.createRadialGradient(cx, cy, 0, cx, cy, clusterSize * 2.5)
      if (brightness > 0.85) {
        lightGrad.addColorStop(0, '#ffffff')
        lightGrad.addColorStop(0.2, '#ffea9f')
        lightGrad.addColorStop(0.6, 'rgba(255, 160, 40, 0.8)')
        lightGrad.addColorStop(1, 'rgba(255, 110, 10, 0)')
      } else if (brightness > 0.4) {
        lightGrad.addColorStop(0, '#ffe082')
        lightGrad.addColorStop(0.4, 'rgba(255, 150, 30, 0.7)')
        lightGrad.addColorStop(1, 'rgba(255, 90, 0, 0)')
      } else {
        lightGrad.addColorStop(0, '#ffb74d')
        lightGrad.addColorStop(0.5, 'rgba(230, 100, 20, 0.5)')
        lightGrad.addColorStop(1, 'rgba(200, 60, 0, 0)')
      }

      nightCtx.fillStyle = lightGrad
      nightCtx.beginPath()
      nightCtx.arc(cx, cy, clusterSize * 2.5, 0, Math.PI * 2)
      nightCtx.fill()
    }
  })

  const dayTex = new THREE.CanvasTexture(dayCanvas)
  const nightTex = new THREE.CanvasTexture(nightCanvas)

  dayTex.wrapS = THREE.RepeatWrapping
  dayTex.wrapT = THREE.ClampToEdgeWrapping
  dayTex.minFilter = THREE.LinearFilter
  dayTex.magFilter = THREE.LinearFilter

  nightTex.wrapS = THREE.RepeatWrapping
  nightTex.wrapT = THREE.ClampToEdgeWrapping
  nightTex.minFilter = THREE.LinearFilter
  nightTex.magFilter = THREE.LinearFilter

  dayTex.needsUpdate = true
  nightTex.needsUpdate = true

  return { dayTex, nightTex }
}

export default function EarthBackground({ onLoaded }) {
  const mountRef = useRef(null)
  const [webglError, setWebglError] = useState(false)

  useEffect(() => {
    const container = mountRef.current
    if (!container) return

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance'
      })
    } catch (e) {
      console.warn('WebGL initialization failed, falling back to CSS background', e)
      setWebglError(true)
      if (onLoaded) onLoaded()
      return
    }

    const width = container.clientWidth || window.innerWidth
    const height = container.clientHeight || window.innerHeight

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000)

    // Orbital camera looking at Earth horizon
    camera.position.set(0, 0.3, 4.4)
    camera.lookAt(0.4, -0.5, 0)

    const earthGroup = new THREE.Group()
    earthGroup.position.set(-0.85, -2.6, -0.4)
    earthGroup.rotation.x = 0.45
    earthGroup.rotation.z = -0.2
    scene.add(earthGroup)

    const EARTH_RADIUS = 3.4
    const sphereGeo = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96)

    const { dayTex, nightTex } = createEarthTextures()

    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDayTexture: { value: dayTex },
        uNightTexture: { value: nightTex },
        uSunDirection: { value: new THREE.Vector3(3.5, 1.8, 1.2).normalize() }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        void main() {
          vUv = uv;
          vNormal = normalize(mat3(modelMatrix) * normal);
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        
        uniform sampler2D uDayTexture;
        uniform sampler2D uNightTexture;
        uniform vec3 uSunDirection;
        
        void main() {
          vec3 dayColor = texture2D(uDayTexture, vUv).rgb;
          vec3 nightColor = texture2D(uNightTexture, vUv).rgb;
          
          float sunDot = dot(vNormal, uSunDirection);
          float dayMix = smoothstep(-0.2, 0.2, sunDot);
          
          vec3 finalColor = mix(nightColor * 2.2, dayColor * (sunDot * 1.1 + 0.1), dayMix);
          
          if (sunDot > 0.0) {
            vec3 viewDir = normalize(cameraPosition - vWorldPosition);
            vec3 halfDir = normalize(uSunDirection + viewDir);
            float spec = pow(max(0.0, dot(vNormal, halfDir)), 24.0);
            finalColor += vec3(0.35, 0.65, 1.0) * spec * 0.35 * dayMix;
          }
          
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `
    })

    const earthMesh = new THREE.Mesh(sphereGeo, earthMaterial)
    earthGroup.add(earthMesh)

    // Atmospheric Glow Shell
    const atmosGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.025, 96, 96)
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: AtmosphereShader.vertexShader,
      fragmentShader: AtmosphereShader.fragmentShader,
      uniforms: {
        uColorCyan: { value: new THREE.Color('#00e5ff') },
        uColorAmber: { value: new THREE.Color('#ff9d00') },
        uSunPosition: { value: new THREE.Vector3(3.5, 1.8, 1.2) }
      },
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true
    })
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat)
    earthGroup.add(atmosMesh)

    // Directional Sunlight & Ambient Light
    const sunPos = new THREE.Vector3(3.2, 1.4, -0.6)
    const sunLight = new THREE.DirectionalLight(0xfff5e0, 3.5)
    sunLight.position.copy(sunPos)
    scene.add(sunLight)

    const ambientLight = new THREE.AmbientLight(0x061020, 0.8)
    scene.add(ambientLight)

    // Sunrise Horizon Flare Mesh
    const flareGeo = new THREE.PlaneGeometry(3.6, 3.6)
    const flareCanvas = document.createElement('canvas')
    flareCanvas.width = 512
    flareCanvas.height = 512
    const flareCtx = flareCanvas.getContext('2d')
    const flareGrad = flareCtx.createRadialGradient(256, 256, 0, 256, 256, 256)
    flareGrad.addColorStop(0, 'rgba(255, 255, 245, 1.0)')
    flareGrad.addColorStop(0.12, 'rgba(255, 210, 120, 0.95)')
    flareGrad.addColorStop(0.35, 'rgba(255, 130, 30, 0.6)')
    flareGrad.addColorStop(0.65, 'rgba(0, 200, 255, 0.25)')
    flareGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')

    flareCtx.fillStyle = flareGrad
    flareCtx.fillRect(0, 0, 512, 512)

    const flareTex = new THREE.CanvasTexture(flareCanvas)
    const flareMat = new THREE.MeshBasicMaterial({
      map: flareTex,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const flareMesh = new THREE.Mesh(flareGeo, flareMat)
    flareMesh.position.copy(sunPos)
    scene.add(flareMesh)

    // Starfield & Floating Space Particles
    const starCount = 2400
    const starGeo = new THREE.BufferGeometry()
    const starPositions = new Float32Array(starCount * 3)
    const starColors = new Float32Array(starCount * 3)

    const colorPalette = [
      new THREE.Color('#ffffff'),
      new THREE.Color('#80f0ff'),
      new THREE.Color('#ffd194'),
      new THREE.Color('#b3d9ff')
    ]

    for (let i = 0; i < starCount; i++) {
      const radius = 80 + Math.random() * 200
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 2 - 1)

      starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
      starPositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
      starPositions[i * 3 + 2] = radius * Math.cos(phi)

      const col = colorPalette[Math.floor(Math.random() * colorPalette.length)]
      starColors[i * 3] = col.r
      starColors[i * 3 + 1] = col.g
      starColors[i * 3 + 2] = col.b
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3))

    const starMat = new THREE.PointsMaterial({
      size: 1.4,
      vertexColors: true,
      transparent: true,
      opacity: 0.85
    })
    const starField = new THREE.Points(starGeo, starMat)
    scene.add(starField)

    // Floating Dust Particles
    const dustCount = 50
    const dustGeo = new THREE.BufferGeometry()
    const dustPositions = new Float32Array(dustCount * 3)
    for (let i = 0; i < dustCount; i++) {
      dustPositions[i * 3] = (Math.random() - 0.5) * 8
      dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 6
      dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 4 + 1
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
    const dustMat = new THREE.PointsMaterial({
      size: 3.2,
      color: 0x80e5ff,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending
    })
    const dustParticles = new THREE.Points(dustGeo, dustMat)
    scene.add(dustParticles)

    // Interactive Parallax
    let mouseX = 0
    let mouseY = 0
    const handleMouseMove = (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 0.12
      mouseY = (e.clientY / window.innerHeight - 0.5) * 0.12
    }
    window.addEventListener('mousemove', handleMouseMove)

    // Render loop
    let animFrameId
    let clock = new THREE.Clock()

    const animate = () => {
      animFrameId = requestAnimationFrame(animate)
      const elapsedTime = clock.getElapsedTime()

      earthGroup.rotation.y += 0.00045

      camera.position.x += (mouseX - camera.position.x) * 0.03
      camera.position.y += (0.3 - mouseY - camera.position.y) * 0.03

      const dustPos = dustGeo.attributes.position.array
      for (let i = 0; i < dustCount; i++) {
        dustPos[i * 3 + 1] += Math.sin(elapsedTime + i) * 0.0008
      }
      dustGeo.attributes.position.needsUpdate = true

      renderer.render(scene, camera)
    }

    animate()
    if (onLoaded) onLoaded()

    const handleResize = () => {
      if (!container) return
      const w = container.clientWidth || window.innerWidth
      const h = container.clientHeight || window.innerHeight

      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)

      if (w < 768) {
        camera.position.z = 5.2
        earthGroup.position.set(0, -3.2, -0.6)
      } else {
        camera.position.z = 4.4
        earthGroup.position.set(-0.85, -2.6, -0.4)
      }
    }

    window.addEventListener('resize', handleResize)
    handleResize()

    return () => {
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('resize', handleResize)

      sphereGeo.dispose()
      earthMaterial.dispose()
      atmosGeo.dispose()
      atmosMat.dispose()
      flareGeo.dispose()
      flareMat.dispose()
      starGeo.dispose()
      starMat.dispose()
      dustGeo.dispose()
      dustMat.dispose()

      dayTex.dispose()
      nightTex.dispose()
      flareTex.dispose()

      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
      renderer.dispose()
    }
  }, [onLoaded])

  if (webglError) {
    return <div className="space-fallback-bg" />
  }

  return <div ref={mountRef} className="space-3d-canvas-container" />
}
