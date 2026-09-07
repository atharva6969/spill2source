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
      {/* 3D Earth WebGL Background */}
      <EarthBackground onLoaded={handleSceneLoaded} />

      {/* Top Header Bar (Reference Video Style) */}
      <header className="ref-top-header">
        <div className="ref-brand-logo">
          <svg className="ref-star-icon" width="22" height="22" viewBox="0 0 32 32" fill="none">
            <path d="M16 2L19.5 12.5L30 16L19.5 19.5L16 30L12.5 19.5L2 16L12.5 12.5L16 2Z" fill="#06c9e8" />
          </svg>
          <span className="ref-brand-name">SPILL2SOURCE</span>
        </div>

        <div className="ref-header-actions">
          <div className="telemetry-online-pill">
            <span className="telemetry-dot" />
            <span>SYSTEM ONLINE</span>
          </div>
          <button className="ref-icon-btn" aria-label="Search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button className="ref-icon-btn" aria-label="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="3" y1="8" x2="21" y2="8" />
              <line x1="3" y1="16" x2="21" y2="16" />
            </svg>
          </button>
        </div>
      </header>

      {/* Left Title Section (Reference Video Typography Style) */}
      <div className="ref-hero-title-block">
        <h1 className="ref-hero-title">
          <span>Global Marine</span>
          <span className="ref-title-accent">Intelligence</span>
        </h1>
        <p className="ref-hero-subtitle">
          Real-time SAR satellite detection & vessel spill attribution platform
        </p>
      </div>

      {/* Main Floating Glass Login Card (Right Side) */}
      <div className="login-card-anchor">
        <div className="cinematic-glass-card">
          {/* Top Sheen Accent Line */}
          <div className="card-top-sheen" />

          {/* Header */}
          <div className="card-branding">
            <div className="brand-header-row">
              <div className="brand-icon-wrapper">
                <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
                  <circle cx="16" cy="16" r="14" stroke="rgba(6, 201, 232, 0.35)" strokeWidth="1.2" />
                  <circle cx="16" cy="16" r="8" stroke="#06c9e8" strokeWidth="1.5" />
                  <circle cx="16" cy="16" r="2.5" fill="#06c9e8" />
                  <path d="M16 2V6M16 26V30M2 16H6M26 16H30" stroke="#06c9e8" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </div>
              <span className="brand-badge">S1 MONITOR</span>
            </div>

            <h2 className="brand-title">Sign In</h2>
            <p className="brand-subtitle">Access command dashboard & live radar stream</p>
          </div>

          <div className="card-divider" />

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
              <label htmlFor="login-email">Email Address</label>
              <div className="input-icon-wrapper">
                <svg className="field-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
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
                  Forgot password?
                </a>
              </div>
              <div className="input-icon-wrapper">
                <svg className="field-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
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
                  <span>Sign In</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </span>
              )}
            </button>
          </form>

          {/* Discreet Demo Autofill Link */}
          <div className="card-footnote">
            <span>New here? </span>
            <button type="button" className="demo-fill-btn" onClick={handleFillDemo}>
              Try demo credentials
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
