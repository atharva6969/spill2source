import { useState } from 'react'
import EarthBackground from './EarthBackground.jsx'

export default function LoginPage({ onLoginSuccess }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sceneLoaded, setSceneLoaded] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    setError('')

    if (!email || !email.includes('@')) {
      setError('Please enter a valid maritime command email address.')
      return
    }

    if (!password || password.length < 4) {
      setError('Password must be at least 4 characters long.')
      return
    }

    setLoading(true)

    // Simulate authenticating against command gateway
    setTimeout(() => {
      setLoading(false)
      if (onLoginSuccess) {
        onLoginSuccess({ email, role: 'Intelligence Officer' })
      }
    }, 1200)
  }

  const handleDemoAccess = () => {
    setEmail('command@spill2source.io')
    setPassword('maritime2026')
    setLoading(true)
    setError('')
    setTimeout(() => {
      setLoading(false)
      if (onLoginSuccess) {
        onLoginSuccess({ email: 'command@spill2source.io', role: 'Chief Intelligence Analyst' })
      }
    }, 800)
  }

  return (
    <div className={`login-view-root ${sceneLoaded ? 'ready' : ''}`}>
      {/* 3D Orbital Earth Scene Background */}
      <EarthBackground onLoaded={() => setSceneLoaded(true)} />

      {/* Top Bar Branding */}
      <header className="login-top-header">
        <div className="brand-badge-small">
          <span className="live-dot" />
          <span>SATELLITE ORBITAL SURVEILLANCE LIVE</span>
        </div>
        <div className="version-tag">v2.4.0-SIH</div>
      </header>

      {/* Main Glassmorphism Login Container */}
      <main className="login-panel-wrapper">
        <div className="glass-login-card">
          {/* Logo & Header */}
          <div className="login-card-head">
            <div className="logo-icon-glow">
              <svg width="40" height="40" viewBox="0 0 36 36" fill="none">
                <circle cx="18" cy="18" r="15" stroke="url(#cyan-grad)" strokeWidth="1.5" strokeDasharray="3 3" />
                <circle cx="18" cy="18" r="9" stroke="#00f0ff" strokeWidth="1.8" />
                <circle cx="18" cy="18" r="3" fill="#00f0ff" />
                <path d="M18 3V9M18 27V33M3 18H9M27 18H33" stroke="#00f0ff" strokeWidth="1.5" strokeLinecap="round" />
                <defs>
                  <linearGradient id="cyan-grad" x1="0" y1="0" x2="36" y2="36">
                    <stop offset="0%" stopColor="#00f0ff" />
                    <stop offset="100%" stopColor="#0055ff" />
                  </linearGradient>
                </defs>
              </svg>
            </div>
            <h1 className="project-title">SPILL2SOURCE</h1>
            <p className="project-subtitle">
              SAR Oil Spill Intelligence & Dark Maritime Surveillance
            </p>
          </div>

          {/* Validation Error Alert */}
          {error && (
            <div className="login-alert-box error" role="alert">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

          {/* Authentication Form */}
          <form onSubmit={handleSubmit} className="login-form">
            {/* Email Field */}
            <div className="input-group">
              <label htmlFor="login-email">Command Email</label>

              <div className="input-field-wrapper">
                <svg className="input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                <input
                  id="login-email"
                  type="email"
                  placeholder="analyst@spill2source.io"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="input-group">
              <div className="label-row">
                <label htmlFor="login-password">Password</label>
                <a href="#forgot" className="forgot-link" onClick={(e) => { e.preventDefault(); alert('Password reset instructions sent to command administrator.') }}>
                  Forgot password?
                </a>
              </div>
              <div className="input-field-wrapper">
                <svg className="input-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                  className="toggle-password-btn"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {/* Remember Me Checkbox */}
            <div className="checkbox-row">
              <label className="custom-checkbox-container">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span className="checkmark" />
                <span className="checkbox-label">Keep active station session</span>
              </label>
            </div>

            {/* Main Action Button */}
            <button
              type="submit"
              className={`btn-cyber-submit ${loading ? 'loading' : ''}`}
              disabled={loading}
            >
              {loading ? (
                <span className="spinner-row">
                  <span className="cyber-spinner" />
                  <span>INITIALIZING STATION GATEWAY...</span>
                </span>
              ) : (
                <span className="btn-content">
                  <span>AUTHENTICATE & ACCESS PLATFORM</span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="5" y1="12" x2="19" y2="12" />
                    <polyline points="12 5 19 12 12 19" />
                  </svg>
                </span>
              )}
            </button>
          </form>

          {/* Quick Demo Access Action for Judges */}
          <div className="divider-row">
            <span className="line" />
            <span className="divider-text">INSTANT EVALUATION</span>
            <span className="line" />
          </div>

          <button
            type="button"
            className="btn-demo-quick"
            onClick={handleDemoAccess}
            disabled={loading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />
            </svg>
            <span>ONE-CLICK DEMO ACCESS (COMMANDER MODE)</span>
          </button>

          {/* Footer Subtext */}
          <div className="card-footer-note">
            <span>Powered by Copernicus Sentinel-1 SAR Radar & ECMWF Oceanography</span>
          </div>
        </div>
      </main>

      {/* Footer System Status */}
      <footer className="login-footer-bar">
        <div className="footer-stat">
          <span className="lbl">AOI:</span>
          <span className="val">GULF OF FINLAND / BALTIC</span>
        </div>
        <div className="footer-stat">
          <span className="lbl">SYSTEM:</span>
          <span className="val green">ONLINE (1.4s LATENCY)</span>
        </div>
      </footer>
    </div>
  )
}
