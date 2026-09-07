import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

// High-resolution public NASA Earth maps
const EARTH_NIGHT_URL = 'https://unpkg.com/three-globe/example/img/earth-night.jpg'
const EARTH_DAY_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'

/**
 * Atmospheric Outer Limb Scattering Shader (FrontSide Additive)
 */
const AtmosphereShader = {
  vertexShader: `
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    
    void main() {
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `,
  fragmentShader: `
    varying vec3 vWorldNormal;
    varying vec3 vWorldPosition;
    
    uniform vec3 uSunPosition;
    uniform vec3 uCameraPos;
    
    void main() {
      vec3 N = normalize(vWorldNormal);
      vec3 V = normalize(uCameraPos - vWorldPosition);
      vec3 L = normalize(uSunPosition - vWorldPosition);
      
      // Razor-sharp atmospheric limb: 0 at center, 1 at silhouette edge
      float NdotV = max(0.0, dot(N, V));
      float rim = 1.0 - NdotV;
      float rimIntensity = pow(rim, 3.8);
      
      // Sun alignment along the horizon limb
      float sunDot = dot(N, L);
      
      // Multi-layer NASA atmospheric gradient:
      // Golden sunrise amber near sun, electric cyan along the flanks, deep cobalt blue on dark side
      vec3 deepCobalt = vec3(0.01, 0.32, 0.95);
      vec3 electricCyan = vec3(0.0, 0.90, 1.0);
      vec3 solarGold = vec3(1.0, 0.88, 0.45);
      vec3 fireOrange = vec3(1.0, 0.50, 0.12);
      
      vec3 atmosColor;
      if (sunDot > 0.10) {
        float t = clamp((sunDot - 0.10) / 0.90, 0.0, 1.0);
        vec3 warmRim = mix(fireOrange, solarGold, t);
        atmosColor = mix(electricCyan, warmRim, pow(t, 0.65));
      } else {
        float t = clamp((sunDot + 0.30) / 0.40, 0.0, 1.0);
        atmosColor = mix(deepCobalt, electricCyan, t);
      }
      
      // Limb brightening near the rising sun
      float limbGlow = 1.0 + max(0.0, sunDot) * 3.2;
      
      gl_FragColor = vec4(atmosColor * limbGlow, rimIntensity * 0.95);
    }
  `
}

/**
 * Generate circular particle texture for pinpoint stars
 */
function createStarTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)')
  grad.addColorStop(0.35, 'rgba(215, 238, 255, 0.85)')
  grad.addColorStop(1, 'rgba(215, 238, 255, 0.0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(16, 16, 16, 0, Math.PI * 2)
  ctx.fill()

  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/**
 * Generate soft circular bokeh orb texture for cinematic lens feel
 */
function createBokehTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255, 255, 255, 0.30)')
  grad.addColorStop(0.5, 'rgba(255, 225, 170, 0.18)')
  grad.addColorStop(0.85, 'rgba(90, 190, 255, 0.08)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(32, 32, 32, 0, Math.PI * 2)
  ctx.fill()

  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/**
 * Generate Sunrise Solar Flare Corona Texture
 */
function createSunriseCoronaTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
  grad.addColorStop(0, 'rgba(255, 255, 255, 1.0)')
  grad.addColorStop(0.08, 'rgba(255, 250, 225, 0.96)')
  grad.addColorStop(0.24, 'rgba(255, 205, 90, 0.70)')
  grad.addColorStop(0.50, 'rgba(255, 125, 30, 0.30)')
  grad.addColorStop(0.75, 'rgba(0, 190, 255, 0.08)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0.0)')
  ctx.fillStyle = grad
  ctx.beginPath()
  ctx.arc(128, 128, 128, 0, Math.PI * 2)
  ctx.fill()

  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
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
        alpha: false,
        powerPreference: 'high-performance'
      })
    } catch (e) {
      console.warn('WebGL initialization failed, using fallback', e)
      setWebglError(true)
      if (onLoaded) onLoaded()
      return
    }

    const width = container.clientWidth || window.innerWidth
    const height = container.clientHeight || window.innerHeight

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x020409, 1.0)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    // Orbital Satellite Perspective Camera
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000)
    camera.position.set(0, 0.28, 5.0)
    camera.lookAt(0.15, -0.22, 0)

    // Earth group positioned lower-left so Earth occupies ~50-60% of composition
    // Grazing horizon angle resembling orbital space photography
    const earthGroup = new THREE.Group()
    earthGroup.position.set(-0.75, -3.25, -0.25)
    earthGroup.rotation.x = -0.14  // Angled to showcase mid-latitude Europe & Mediterranean at night
    earthGroup.rotation.z = -0.22  // Cinematic diagonal horizon slope
    earthGroup.rotation.y = 4.65   // Positions Western Europe / Mediterranean / Atlantic facing camera
    scene.add(earthGroup)

    const EARTH_RADIUS = 3.65
    const sphereGeo = new THREE.SphereGeometry(EARTH_RADIUS, 128, 128)

    // The Sun is positioned behind the Earth's upper-right horizon limb
    // This naturally casts the visible facing side into night, while the horizon catches the brilliant sunrise!
    const sunWorldPos = new THREE.Vector3(0.88, 0.38, -0.65)

    // Realistic directional sunlight
    const sunLight = new THREE.DirectionalLight(0xfff5e6, 3.2)
    sunLight.position.copy(sunWorldPos)
    scene.add(sunLight)

    const ambientLight = new THREE.AmbientLight(0x060e1c, 0.5)
    scene.add(ambientLight)

    // Shaders for Earth: Vibrant golden city lights on dark side, dawn scattering along terminator
    const textureLoader = new THREE.TextureLoader()

    const earthMat = new THREE.ShaderMaterial({
      uniforms: {
        uDayTexture: { value: null },
        uNightTexture: { value: null },
        uSunPosition: { value: sunWorldPos },
        uCameraPos: { value: camera.position }
      },
      vertexShader: `
        varying vec3 vWorldNormal;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        
        void main() {
          vUv = uv;
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vWorldPosition = worldPos.xyz;
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        varying vec3 vWorldNormal;
        varying vec2 vUv;
        varying vec3 vWorldPosition;
        
        uniform sampler2D uDayTexture;
        uniform sampler2D uNightTexture;
        uniform vec3 uSunPosition;
        uniform vec3 uCameraPos;
        
        void main() {
          vec3 dayTex = vec3(0.04, 0.12, 0.25);
          vec3 nightTex = vec3(0.0, 0.0, 0.0);
          
          if (texture2D(uDayTexture, vUv).a > 0.0) {
            dayTex = texture2D(uDayTexture, vUv).rgb;
          }
          if (texture2D(uNightTexture, vUv).a > 0.0) {
            nightTex = texture2D(uNightTexture, vUv).rgb;
          }
          
          vec3 N = normalize(vWorldNormal);
          vec3 L = normalize(uSunPosition - vWorldPosition);
          vec3 V = normalize(uCameraPos - vWorldPosition);
          
          float sunDot = dot(N, L);
          
          // Night side: Golden incandescent city lights glowing on dark continents
          float cityIntensity = max(nightTex.r, max(nightTex.g, nightTex.b));
          float cityMask = smoothstep(0.08, 0.85, cityIntensity);
          vec3 cityGlow = vec3(1.0, 0.83, 0.44) * pow(cityMask, 0.8) * 5.2;
          
          // Pure clean deep ocean/land dark velvet (no muddy noise)
          vec3 darkEarth = vec3(0.006, 0.014, 0.035) + nightTex * 0.15;
          vec3 nightSide = darkEarth + cityGlow;
          
          // Day side: Natural satellite daylight (only where directly illuminated)
          vec3 daySide = dayTex * (max(0.0, sunDot) * 0.90 + 0.10);
          
          // Ocean specular sun glint
          if (sunDot > 0.0) {
            vec3 H = normalize(L + V);
            float spec = pow(max(0.0, dot(N, H)), 32.0);
            daySide += vec3(1.0, 0.88, 0.65) * spec * 0.40;
          }
          
          // Terminator blend (smooth transition between night and day)
          float dayFactor = smoothstep(-0.08, 0.22, sunDot);
          
          // Dawn / twilight atmospheric scattering across the terminator
          float twilight = smoothstep(-0.18, 0.0, sunDot) * (1.0 - smoothstep(0.0, 0.25, sunDot));
          vec3 twilightColor = vec3(1.0, 0.55, 0.18) * twilight * 0.75;
          
          vec3 finalSurface = mix(nightSide, daySide, dayFactor) + twilightColor;
          
          // Atmospheric limb haze on the planet surface edge (Fresnel)
          float rim = 1.0 - max(0.0, dot(N, V));
          float rimStrength = pow(rim, 3.8);
          float sunRim = max(0.0, dot(N, L));
          vec3 surfaceRimColor = mix(vec3(0.05, 0.72, 1.0), vec3(1.0, 0.78, 0.38), pow(sunRim, 2.0));
          finalSurface += surfaceRimColor * rimStrength * 0.65;
          
          gl_FragColor = vec4(finalSurface, 1.0);
        }
      `,
      depthWrite: true,
      depthTest: true
    })

    // Load NASA Maps asynchronously
    textureLoader.load(EARTH_NIGHT_URL, (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      earthMat.uniforms.uNightTexture.value = tex
      earthMat.needsUpdate = true
    })

    textureLoader.load(EARTH_DAY_URL, (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      earthMat.uniforms.uDayTexture.value = tex
      earthMat.needsUpdate = true
    })

    const earthMesh = new THREE.Mesh(sphereGeo, earthMat)
    earthGroup.add(earthMesh)

    // Atmospheric Horizon Glow Shell (Limb) - FrontSide Additive
    const atmosGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.016, 128, 128)
    const atmosMat = new THREE.ShaderMaterial({
      vertexShader: AtmosphereShader.vertexShader,
      fragmentShader: AtmosphereShader.fragmentShader,
      uniforms: {
        uSunPosition: { value: sunWorldPos },
        uCameraPos: { value: camera.position }
      },
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
      transparent: true,
      depthWrite: false,
      depthTest: true
    })
    const atmosMesh = new THREE.Mesh(atmosGeo, atmosMat)
    earthGroup.add(atmosMesh)

    // Sunrise Horizon Corona Flare (Soft circular glow right at the limb)
    const coronaTex = createSunriseCoronaTexture()
    const coronaMat = new THREE.SpriteMaterial({
      map: coronaTex,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: false
    })
    const coronaSprite = new THREE.Sprite(coronaMat)
    coronaSprite.position.copy(sunWorldPos)
    coronaSprite.scale.set(3.0, 3.0, 1.0)
    scene.add(coronaSprite)

    // Crisp Pinpoint Starfield
    const starCount = 1800
    const starGeo = new THREE.BufferGeometry()
    const starPositions = new Float32Array(starCount * 3)
    const starColors = new Float32Array(starCount * 3)
    const starTex = createStarTexture()

    for (let i = 0; i < starCount; i++) {
      const radius = 65 + Math.random() * 120
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 2 - 1)

      starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
      starPositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
      starPositions[i * 3 + 2] = radius * Math.cos(phi)

      const tint = Math.random()
      if (tint > 0.8) {
        starColors[i * 3] = 1.0
        starColors[i * 3 + 1] = 0.90
        starColors[i * 3 + 2] = 0.72
      } else if (tint > 0.4) {
        starColors[i * 3] = 0.86
        starColors[i * 3 + 1] = 0.94
        starColors[i * 3 + 2] = 1.0
      } else {
        starColors[i * 3] = 0.96
        starColors[i * 3 + 1] = 0.96
        starColors[i * 3 + 2] = 0.96
      }
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3))

    const starMat = new THREE.PointsMaterial({
      size: 2.2,
      map: starTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.82,
      sizeAttenuation: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    const starField = new THREE.Points(starGeo, starMat)
    scene.add(starField)

    // Subtle Floating Bokeh Dust Orbs
    const bokehCount = 38
    const bokehGeo = new THREE.BufferGeometry()
    const bokehPositions = new Float32Array(bokehCount * 3)
    const bokehColors = new Float32Array(bokehCount * 3)
    const bokehVelocities = []
    const bokehTex = createBokehTexture()

    for (let i = 0; i < bokehCount; i++) {
      bokehPositions[i * 3] = (Math.random() - 0.25) * 5.5
      bokehPositions[i * 3 + 1] = Math.random() * 3.2 - 0.3
      bokehPositions[i * 3 + 2] = 1.2 + Math.random() * 2.8

      const isWarm = Math.random() > 0.4
      if (isWarm) {
        bokehColors[i * 3] = 1.0
        bokehColors[i * 3 + 1] = 0.86
        bokehColors[i * 3 + 2] = 0.62
      } else {
        bokehColors[i * 3] = 0.72
        bokehColors[i * 3 + 1] = 0.90
        bokehColors[i * 3 + 2] = 1.0
      }

      bokehVelocities.push({
        vx: (Math.random() - 0.5) * 0.0005,
        vy: (Math.random() - 0.5) * 0.0005
      })
    }

    bokehGeo.setAttribute('position', new THREE.BufferAttribute(bokehPositions, 3))
    bokehGeo.setAttribute('color', new THREE.BufferAttribute(bokehColors, 3))

    const bokehMat = new THREE.PointsMaterial({
      size: 24.0,
      map: bokehTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.20,
      sizeAttenuation: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    const bokehParticles = new THREE.Points(bokehGeo, bokehMat)
    scene.add(bokehParticles)

    // Subtle parallax mouse interaction
    let mouseX = 0
    let mouseY = 0
    const handleMouseMove = (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 0.06
      mouseY = (e.clientY / window.innerHeight - 0.5) * 0.06
    }
    window.addEventListener('mousemove', handleMouseMove)

    // Animation loop (slow cinematic motion)
    let animFrameId
    const animate = () => {
      animFrameId = requestAnimationFrame(animate)

      // Cinematic slow rotation
      earthGroup.rotation.y += 0.00018

      // Gentle bokeh orb drift
      const posAttr = bokehGeo.attributes.position
      for (let i = 0; i < bokehCount; i++) {
        let x = posAttr.getX(i) + bokehVelocities[i].vx
        let y = posAttr.getY(i) + bokehVelocities[i].vy
        if (x > 4.5) x = -3.5
        if (x < -3.5) x = 4.5
        if (y > 3.5) y = -0.5
        if (y < -0.5) y = 3.5
        posAttr.setXY(i, x, y)
      }
      posAttr.needsUpdate = true

      // Subtle parallax camera breathing
      camera.position.x += (mouseX - camera.position.x) * 0.020
      camera.position.y += (0.28 - mouseY - camera.position.y) * 0.020

      // Update shader uniforms
      earthMat.uniforms.uCameraPos.value.copy(camera.position)
      atmosMat.uniforms.uCameraPos.value.copy(camera.position)

      renderer.render(scene, camera)
    }

    animate()
    if (onLoaded) onLoaded()

    // Responsive resize handler
    const handleResize = () => {
      if (!container) return
      const w = container.clientWidth || window.innerWidth
      const h = container.clientHeight || window.innerHeight

      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)

      // Responsive composition
      if (w < 768) {
        camera.position.set(0, 0.40, 5.6)
        earthGroup.position.set(0, -3.5, -0.35)
      } else if (w < 1100) {
        camera.position.set(0, 0.32, 5.2)
        earthGroup.position.set(-0.5, -3.35, -0.30)
      } else {
        camera.position.set(0, 0.28, 5.0)
        earthGroup.position.set(-0.75, -3.25, -0.25)
      }
    }

    window.addEventListener('resize', handleResize)
    handleResize()

    return () => {
      cancelAnimationFrame(animFrameId)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('resize', handleResize)

      sphereGeo.dispose()
      earthMat.dispose()
      atmosGeo.dispose()
      atmosMat.dispose()
      coronaMat.dispose()
      coronaTex.dispose()
      starGeo.dispose()
      starMat.dispose()
      starTex.dispose()
      bokehGeo.dispose()
      bokehMat.dispose()
      bokehTex.dispose()

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
