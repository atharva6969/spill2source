import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

// High-resolution public NASA Earth textures
const EARTH_NIGHT_URL = 'https://unpkg.com/three-globe/example/img/earth-night.jpg'
const EARTH_DAY_URL = 'https://unpkg.com/three-globe/example/img/earth-day.jpg'

/**
 * Atmospheric Horizon Rim Glow GLSL Shader (Fresnel scattering + Sunrise solar flare)
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
      
      vec3 glowColor = mix(uColorCyan, uColorAmber, pow(sunDot, 1.8));
      float flare = pow(sunDot, 6.0) * 1.5;
      glowColor += vec3(1.0, 0.75, 0.4) * flare;
      
      gl_FragColor = vec4(glowColor, intensity * 0.95);
    }
  `
}

/**
 * Procedural Fallback Earth Textures
 */
function createFallbackEarthTextures() {
  const canvas = document.createElement('canvas')
  canvas.width = 1024
  canvas.height = 512
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#030914'
  ctx.fillRect(0, 0, 1024, 512)

  const continents = [
    { x: 500, y: 160, r: 110 }, { x: 540, y: 130, r: 80 }, { x: 480, y: 180, r: 90 },
    { x: 240, y: 170, r: 130 }, { x: 200, y: 200, r: 90 },
    { x: 720, y: 180, r: 150 }, { x: 800, y: 210, r: 100 }, { x: 680, y: 240, r: 80 },
    { x: 530, y: 290, r: 110 }, { x: 340, y: 320, r: 90 }
  ]

  continents.forEach(({ x, y, r }) => {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, '#0c264a')
    grad.addColorStop(0.7, '#071830')
    grad.addColorStop(1, 'rgba(3, 9, 20, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  })

  const nCanvas = document.createElement('canvas')
  nCanvas.width = 1024
  nCanvas.height = 512
  const nCtx = nCanvas.getContext('2d')
  nCtx.fillStyle = '#010308'
  nCtx.fillRect(0, 0, 1024, 512)

  continents.forEach(({ x, y, r }) => {
    for (let i = 0; i < 90; i++) {
      const angle = Math.random() * Math.PI * 2
      const dist = Math.pow(Math.random(), 0.6) * r * 0.85
      const cx = x + Math.cos(angle) * dist
      const cy = y + Math.sin(angle) * dist

      const size = Math.random() * 3 + 1
      const lGrad = nCtx.createRadialGradient(cx, cy, 0, cx, cy, size * 2)
      lGrad.addColorStop(0, '#ffffff')
      lGrad.addColorStop(0.3, '#ffcc55')
      lGrad.addColorStop(1, 'rgba(255, 100, 0, 0)')

      nCtx.fillStyle = lGrad
      nCtx.beginPath()
      nCtx.arc(cx, cy, size * 2, 0, Math.PI * 2)
      nCtx.fill()
    }
  })

  const dayTex = new THREE.CanvasTexture(canvas)
  const nightTex = new THREE.CanvasTexture(nCanvas)
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
    renderer.toneMappingExposure = 1.3
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 1000)

    camera.position.set(0, 0.2, 4.5)
    camera.lookAt(0.3, -0.6, 0)

    const earthGroup = new THREE.Group()
    earthGroup.position.set(-0.75, -2.75, -0.2)
    earthGroup.rotation.x = 0.52
    earthGroup.rotation.z = -0.35
    scene.add(earthGroup)

    const EARTH_RADIUS = 3.5
    const sphereGeo = new THREE.SphereGeometry(EARTH_RADIUS, 128, 128)

    const textureLoader = new THREE.TextureLoader()
    const fallbacks = createFallbackEarthTextures()

    let dayTex = fallbacks.dayTex
    let nightTex = fallbacks.nightTex

    const earthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uDayTexture: { value: dayTex },
        uNightTexture: { value: nightTex },
        uSunDirection: { value: new THREE.Vector3(3.8, 1.9, 0.8).normalize() }
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
          float dayMix = smoothstep(-0.25, 0.25, sunDot);
          
          vec3 nightLights = nightColor * 2.8;
          vec3 daySurface = dayColor * (sunDot * 1.15 + 0.12);
          
          vec3 finalColor = mix(nightLights, daySurface, dayMix);
          
          if (sunDot > 0.0) {
            vec3 viewDir = normalize(cameraPosition - vWorldPosition);
            vec3 halfDir = normalize(uSunDirection + viewDir);
            float spec = pow(max(0.0, dot(vNormal, halfDir)), 32.0);
            finalColor += vec3(0.4, 0.75, 1.0) * spec * 0.4 * dayMix;
          }
          
          gl_FragColor = vec4(finalColor, 1.0);
        }
      `,
      depthWrite: true,
      depthTest: true
    })

    textureLoader.load(EARTH_NIGHT_URL, (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      earthMaterial.uniforms.uNightTexture.value = tex
      earthMaterial.needsUpdate = true
    })

    textureLoader.load(EARTH_DAY_URL, (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      earthMaterial.uniforms.uDayTexture.value = tex
      earthMaterial.needsUpdate = true
    })

    const earthMesh = new THREE.Mesh(sphereGeo, earthMaterial)
    earthGroup.add(earthMesh)

    // Atmospheric Fresnel Glow Layer
    const atmosGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.025, 128, 128)
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: AtmosphereShader.vertexShader,
      fragmentShader: AtmosphereShader.fragmentShader,
      uniforms: {
        uColorCyan: { value: new THREE.Color('#00e5ff') },
        uColorAmber: { value: new THREE.Color('#ffaa00') },
        uSunPosition: { value: new THREE.Vector3(3.8, 1.9, 0.8) }
      },
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true
    })
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat)
    earthGroup.add(atmosMesh)

    // Directional Sunlight
    const sunPos = new THREE.Vector3(3.6, 1.6, -0.4)
    const sunLight = new THREE.DirectionalLight(0xfff6e5, 3.8)
    sunLight.position.copy(sunPos)
    scene.add(sunLight)

    const ambientLight = new THREE.AmbientLight(0x040c18, 0.7)
    scene.add(ambientLight)

    // Circular Sprite Lens Flare
    const flareCanvas = document.createElement('canvas')
    flareCanvas.width = 256
    flareCanvas.height = 256
    const flareCtx = flareCanvas.getContext('2d')
    const flareGrad = flareCtx.createRadialGradient(128, 128, 0, 128, 128, 128)
    flareGrad.addColorStop(0, 'rgba(255, 255, 245, 1.0)')
    flareGrad.addColorStop(0.15, 'rgba(255, 215, 130, 0.95)')
    flareGrad.addColorStop(0.4, 'rgba(255, 135, 35, 0.6)')
    flareGrad.addColorStop(0.7, 'rgba(0, 215, 255, 0.25)')
    flareGrad.addColorStop(1, 'rgba(0, 0, 0, 0)')

    flareCtx.fillStyle = flareGrad
    flareCtx.fillRect(0, 0, 256, 256)

    const flareTex = new THREE.CanvasTexture(flareCanvas)
    const spriteMat = new THREE.SpriteMaterial({
      map: flareTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false
    })
    const flareSprite = new THREE.Sprite(spriteMat)
    flareSprite.position.copy(sunPos)
    flareSprite.scale.set(4.5, 4.5, 1.0)
    scene.add(flareSprite)

    // Starfield Background
    const starCount = 3000
    const starGeo = new THREE.BufferGeometry()
    const starPositions = new Float32Array(starCount * 3)
    const starColors = new Float32Array(starCount * 3)

    const colorPalette = [
      new THREE.Color('#ffffff'),
      new THREE.Color('#7ce8ff'),
      new THREE.Color('#ffe2b3'),
      new THREE.Color('#cce5ff')
    ]

    for (let i = 0; i < starCount; i++) {
      const radius = 90 + Math.random() * 210
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
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    })
    const starField = new THREE.Points(starGeo, starMat)
    scene.add(starField)

    // Floating Bokeh Space Particles
    const dustCount = 70
    const dustGeo = new THREE.BufferGeometry()
    const dustPositions = new Float32Array(dustCount * 3)
    for (let i = 0; i < dustCount; i++) {
      dustPositions[i * 3] = (Math.random() - 0.5) * 9
      dustPositions[i * 3 + 1] = (Math.random() - 0.5) * 7
      dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 4 + 1
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3))
    const dustMat = new THREE.PointsMaterial({
      size: 3.8,
      color: 0x70e0ff,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
    const dustParticles = new THREE.Points(dustGeo, dustMat)
    scene.add(dustParticles)

    // Parallax mouse drift
    let mouseX = 0
    let mouseY = 0
    const handleMouseMove = (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 0.12
      mouseY = (e.clientY / window.innerHeight - 0.5) * 0.12
    }
    window.addEventListener('mousemove', handleMouseMove)

    // Animation Loop
    let animFrameId
    let clock = new THREE.Clock()

    const animate = () => {
      animFrameId = requestAnimationFrame(animate)
      const elapsedTime = clock.getElapsedTime()

      earthGroup.rotation.y += 0.0004

      camera.position.x += (mouseX - camera.position.x) * 0.035
      camera.position.y += (0.2 - mouseY - camera.position.y) * 0.035

      const dustPos = dustGeo.attributes.position.array
      for (let i = 0; i < dustCount; i++) {
        dustPos[i * 3 + 1] += Math.sin(elapsedTime + i) * 0.0007
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
        camera.position.z = 5.4
        earthGroup.position.set(0, -3.4, -0.6)
      } else {
        camera.position.z = 4.5
        earthGroup.position.set(-0.75, -2.75, -0.2)
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
      spriteMat.dispose()
      starGeo.dispose()
      starMat.dispose()
      dustGeo.dispose()
      dustMat.dispose()

      fallbacks.dayTex.dispose()
      fallbacks.nightTex.dispose()
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
