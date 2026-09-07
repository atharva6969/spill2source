import React, { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

// High-definition public satellite Earth texture maps
const EARTH_DAY_URL = 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'
const EARTH_NIGHT_URL = 'https://unpkg.com/three-globe/example/img/earth-night.jpg'

/**
 * Atmospheric Outer Limb Scattering Shader (FrontSide Additive)
 * Thin, razor-sharp atmospheric cyan halo.
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
      
      // Thin, razor-sharp atmospheric limb edge
      float NdotV = max(0.0, dot(N, V));
      float rim = 1.0 - NdotV;
      float rimIntensity = pow(rim, 5.0);
      
      float sunDot = dot(N, L);
      
      vec3 electricCyan = vec3(0.02, 0.85, 1.0);
      vec3 deepSapphire = vec3(0.01, 0.20, 0.70);
      vec3 solarGold = vec3(1.0, 0.75, 0.30);
      
      vec3 atmosColor = mix(deepSapphire, electricCyan, clamp(sunDot + 0.5, 0.0, 1.0));
      if (sunDot > 0.4) {
        atmosColor = mix(atmosColor, solarGold, (sunDot - 0.4) * 0.6);
      }
      
      gl_FragColor = vec4(atmosColor * 1.5, rimIntensity * 0.85);
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

function EarthBackgroundComponent({ onLoaded }) {
  const mountRef = useRef(null)
  const [webglError, setWebglError] = useState(false)
  const onLoadedRef = useRef(onLoaded)

  useEffect(() => {
    onLoadedRef.current = onLoaded
  }, [onLoaded])

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
      if (onLoadedRef.current) onLoadedRef.current()
      return
    }

    const width = container.clientWidth || window.innerWidth
    const height = container.clientHeight || window.innerHeight

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x020409, 1.0)
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.0
    container.appendChild(renderer.domElement)

    const scene = new THREE.Scene()

    // Orbital Perspective Camera
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 1000)
    camera.position.set(0, 0.15, 5.0)
    camera.lookAt(0, -0.20, 0)

    // Earth group positioned lower-center for reference video composition
    const earthGroup = new THREE.Group()
    earthGroup.position.set(-0.55, -2.85, -0.10)
    earthGroup.rotation.x = -0.12
    earthGroup.rotation.z = -0.06
    earthGroup.rotation.y = 4.65
    scene.add(earthGroup)

    const EARTH_RADIUS = 3.65
    const sphereGeo = new THREE.SphereGeometry(EARTH_RADIUS, 128, 128)

    // Sun position (upper-left horizon)
    const sunWorldPos = new THREE.Vector3(-1.75, 1.10, -0.85)

    // Balanced directional lighting (prevents washed-out glare)
    const sunLight = new THREE.DirectionalLight(0xfff5e6, 1.6)
    sunLight.position.copy(sunWorldPos)
    scene.add(sunLight)

    const ambientLight = new THREE.AmbientLight(0x081628, 0.4)
    scene.add(ambientLight)

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
          vec3 dayTex = vec3(0.02, 0.08, 0.18);
          vec3 nightTex = vec3(0.0);
          
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
          
          // Differentiate landmass from ocean
          float landMask = smoothstep(0.02, 0.08, (dayTex.r + dayTex.g) * 0.7 - dayTex.b * 0.5);
          
          // Deep ocean (midnight blue)
          vec3 ocean = vec3(0.005, 0.015, 0.035);
          vec3 landSurface = dayTex * 0.75 + vec3(0.01, 0.02, 0.03);
          vec3 baseSurface = mix(ocean, landSurface, landMask);
          
          // Golden city lights on night side
          float cityLum = max(nightTex.r, max(nightTex.g, nightTex.b));
          vec3 cityLights = vec3(1.0, 0.82, 0.42) * pow(cityLum, 1.2) * 3.8 * (0.3 + 0.7 * landMask);
          
          vec3 nightSide = baseSurface * 0.20 + cityLights;
          vec3 daySide = baseSurface * (max(0.0, sunDot) * 1.1 + 0.10);
          
          // Subtle ocean specular
          if (sunDot > 0.0) {
            vec3 H = normalize(L + V);
            float spec = pow(max(0.0, dot(N, H)), 40.0);
            daySide += vec3(1.0, 0.90, 0.70) * spec * (1.0 - landMask) * 0.35;
          }
          
          float dayFactor = smoothstep(-0.06, 0.18, sunDot);
          vec3 finalSurface = mix(nightSide, daySide, dayFactor);
          
          // Thin atmospheric rim haze
          float rim = 1.0 - max(0.0, dot(N, V));
          float rimStrength = pow(rim, 4.5);
          finalSurface += vec3(0.02, 0.75, 1.0) * rimStrength * 0.50;
          
          gl_FragColor = vec4(finalSurface, 1.0);
        }
      `,
      depthWrite: true,
      depthTest: true
    })

    const maxAnisotropy = renderer.capabilities.getMaxAnisotropy() || 16

    textureLoader.load(EARTH_NIGHT_URL, (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.anisotropy = maxAnisotropy
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      tex.needsUpdate = true
      earthMat.uniforms.uNightTexture.value = tex
      earthMat.needsUpdate = true
    })

    textureLoader.load(EARTH_DAY_URL, (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.anisotropy = maxAnisotropy
      tex.minFilter = THREE.LinearMipmapLinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = true
      tex.needsUpdate = true
      earthMat.uniforms.uDayTexture.value = tex
      earthMat.needsUpdate = true
    })

    const earthMesh = new THREE.Mesh(sphereGeo, earthMat)
    earthGroup.add(earthMesh)

    // Atmospheric Horizon Glow Shell (Limb)
    const atmosGeo = new THREE.SphereGeometry(EARTH_RADIUS * 1.012, 128, 128)
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

    // Sparse, Subtle Pinpoint Starfield
    const starCount = 1000
    const starGeo = new THREE.BufferGeometry()
    const starPositions = new Float32Array(starCount * 3)
    const starColors = new Float32Array(starCount * 3)
    const starTex = createStarTexture()

    for (let i = 0; i < starCount; i++) {
      const radius = 70 + Math.random() * 100
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 2 - 1)

      starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta)
      starPositions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta)
      starPositions[i * 3 + 2] = radius * Math.cos(phi)

      starColors[i * 3] = 0.90
      starColors[i * 3 + 1] = 0.94
      starColors[i * 3 + 2] = 1.0
    }

    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3))

    const starMat = new THREE.PointsMaterial({
      size: 1.6,
      map: starTex,
      vertexColors: true,
      transparent: true,
      opacity: 0.65,
      sizeAttenuation: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    const starField = new THREE.Points(starGeo, starMat)
    scene.add(starField)

    // Mouse parallax
    let mouseX = 0
    let mouseY = 0
    const handleMouseMove = (e) => {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 0.05
      mouseY = (e.clientY / window.innerHeight - 0.5) * 0.05
    }
    window.addEventListener('mousemove', handleMouseMove)

    // Animation loop (slow cinematic motion)
    let animFrameId
    const animate = () => {
      animFrameId = requestAnimationFrame(animate)

      // Smooth cinematic revolving Earth rotation
      earthGroup.rotation.y += 0.00022

      // Subtle parallax camera breathing
      camera.position.x += (mouseX - camera.position.x) * 0.020
      camera.position.y += (0.15 - mouseY - camera.position.y) * 0.020

      // Update shader uniforms
      earthMat.uniforms.uCameraPos.value.copy(camera.position)
      atmosMat.uniforms.uCameraPos.value.copy(camera.position)

      renderer.render(scene, camera)
    }

    animate()
    if (onLoadedRef.current) onLoadedRef.current()

    // Responsive resize handler
    const handleResize = () => {
      if (!container) return
      const w = container.clientWidth || window.innerWidth
      const h = container.clientHeight || window.innerHeight

      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)

      if (w < 768) {
        camera.position.set(0, 0.35, 5.6)
        earthGroup.position.set(0, -3.20, -0.30)
      } else if (w < 1100) {
        camera.position.set(0, 0.20, 5.2)
        earthGroup.position.set(-0.35, -2.95, -0.20)
      } else {
        camera.position.set(0, 0.15, 5.0)
        earthGroup.position.set(-0.55, -2.85, -0.10)
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
      starGeo.dispose()
      starMat.dispose()
      starTex.dispose()

      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement)
      }
      renderer.dispose()
    }
  }, [])

  if (webglError) {
    return <div className="space-fallback-bg" />
  }

  return <div ref={mountRef} className="space-3d-canvas-container" />
}

const EarthBackground = React.memo(EarthBackgroundComponent)
export default EarthBackground
