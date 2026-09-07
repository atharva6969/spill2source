import { useState, useCallback } from 'react'
import EarthBackground from './EarthBackground.jsx'

export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sceneLoaded, setSceneLoaded] = useState(false)

  // Memoized callback so EarthBackground never re-initializes on keystrokes
  const handleSceneLoaded = useCallback(() => {
    setSceneLoaded(true)
  }, [])

  const handleSubmit = (e) => {
    e.preventDefault()
    setError('')

    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address.')
      return
    }

    if (!password || password.length < 4) {
      setError('Password must be at least 4 characters long.')
      return
    }

    setLoading(true)

    setTimeout(() => {
      setLoading(false)
      if (onLoginSuccess) {
        onLoginSuccess({ email, role: 'Intelligence Officer' })
      }
    }, 900)
  }

  const handleFillDemo = (e) => {
    e.preventDefault()
    setEmail('command@spill2source.io')
    setPassword('maritime2026')
  }

  return (
    <div className={`login-page-container ${sceneLoaded ? 'loaded' : ''}`}>
      {/* 3D Earth WebGL Background - Small & Positioned Low (30-40% Width) */}
      <EarthBackground onLoaded={handleSceneLoaded} />

      {/* Top Header Navigation (Minimalist) */}
      <header className="ref-top-header">
        <div className="ref-brand-logo">
          <svg className="ref-star-icon" width="20" height="20" viewBox="0 0 32 32" fill="none">
            <path d="M16 2L19.5 12.5L30 16L19.5 19.5L16 30L12.5 19.5L2 16L12.5 12.5L16 2Z" fill="#ffffff" />
          </svg>
          <span className="ref-brand-name">SPILL2SOURCE</span>
        </div>

        <div className="ref-header-actions">
          <div className="telemetry-online-pill">
            <span className="telemetry-dot" />
            <span>SYSTEM ONLINE</span>
          </div>
        </div>
      </header>

      {/* Editorial Headline (Swiss / Typography-Driven) */}
      <div className="ref-hero-title-block">
        <h1 className="ref-hero-title">
          <span>GLOBAL MARINE</span>
          <span className="ref-title-accent">INTELLIGENCE</span>
        </h1>
        <p className="ref-hero-subtitle">
          Real-time satellite intelligence for marine monitoring and spill attribution.
        </p>
      </div>

      {/* Subtle Scientific Annotations (15% Opacity Orbit Arc) */}
      <div className="ref-orbit-ring-container" aria-hidden="true">
        <svg className="ref-orbit-svg" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMax meet">
          <defs>
            <path
              id="subtleOrbitArc"
              d="M 200 520 A 320 320 0 0 1 800 520"
              fill="none"
            />
          </defs>
          {/* Subtle Concentric Scientific Measurement Arc */}
          <circle
            cx="500"
            cy="520"
            r="320"
            fill="none"
            stroke="rgba(255, 255, 255, 0.12)"
            strokeWidth="1"
            strokeDasharray="3 5"
          />
          {/* Subtle Scientific Coordinates (15% Opacity) */}
          <text className="ref-orbit-text">
            <textPath href="#subtleOrbitArc" startOffset="50%" textAnchor="middle">
              01.40 // SAR RADAR &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; LAT 54° 12' N &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; ATTRIBUTION NET &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; S1 OBSERVATION NODE
            </textPath>
          </text>
        </svg>
      </div>

      {/* Refined Lightweight Minimal Login Card (Right Side, 380px, No Heavy Glassmorphism) */}
      <div className="login-card-anchor">
        <div className="minimal-editor-card">
          <div className="card-header">
            <h2 className="card-title">Sign in</h2>
            <p className="card-subtitle">Enter your organization credentials</p>
          </div>

          {/* Validation Alert */}
          {error && (
            <div className="auth-alert" role="alert">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Authentication Form */}
          <form onSubmit={handleSubmit} className="auth-form">
            {/* Email */}
            <div className="form-field">
              <label htmlFor="login-email">Email</label>
              <input
                id="login-email"
                type="email"
                placeholder="name@organization.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                spellCheck="false"
              />
            </div>

            {/* Password */}
            <div className="form-field">
              <div className="field-header">
                <label htmlFor="login-password">Password</label>
                <a
                  href="#forgot"
                  className="inline-link"
                  onClick={(e) => {
                    e.preventDefault()
                    alert('Password reset instructions dispatched to your email.')
                  }}
                >
                  Forgot?
                </a>
              </div>
              <div className="input-password-wrapper">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  tabIndex="-1"
                >
                  {showPassword ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Remember Me */}
            <div className="options-row">
              <label className="checkbox-control">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span className="checkbox-box" />
                <span className="checkbox-text">Keep session active</span>
              </label>
            </div>

            {/* Primary Sign In Button */}
            <button
              type="submit"
              className={`primary-submit-btn ${loading ? 'loading' : ''}`}
              disabled={loading}
            >
              {loading ? (
                <span className="loading-state">
                  <span className="loading-spinner" />
                  <span>Authenticating...</span>
                </span>
              ) : (
                <span className="btn-content">
                  <span>Sign in</span>
                  <span className="btn-arrow">→</span>
                </span>
              )}
            </button>
          </form>

          {/* Discreet Demo Autofill Link */}
          <div className="card-footnote">
            <button type="button" className="demo-fill-btn" onClick={handleFillDemo}>
              Use demo credentials
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
