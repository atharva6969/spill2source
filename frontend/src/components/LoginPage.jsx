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
      {/* Cinematic 3D Earth WebGL Background */}
      <EarthBackground onLoaded={() => setSceneLoaded(true)} />

      {/* Subtle Right-Side Gradient for pristine card readability */}
      <div className="login-backdrop-vignette" />

      {/* Minimal Top Telemetry (Tiny & discreet) */}
      <div className="telemetry-top">
        <span className="telemetry-dot" />
        <span>SYSTEM ONLINE</span>
      </div>

      {/* Main Floating Glass Login Card */}
      <div className="login-card-anchor">
        <div className="cinematic-glass-card">
          {/* Header */}
          <div className="card-branding">
            <div className="brand-icon-wrapper">
              <svg width="28" height="28" viewBox="0 0 32 32" fill="none">
                <circle cx="16" cy="16" r="14" stroke="rgba(6, 217, 255, 0.4)" strokeWidth="1.2" />
                <circle cx="16" cy="16" r="8" stroke="#06d9ff" strokeWidth="1.5" />
                <circle cx="16" cy="16" r="2.5" fill="#06d9ff" />
                <path d="M16 2V6M16 26V30M2 16H6M26 16H30" stroke="#06d9ff" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <h1 className="brand-title">SPILL2SOURCE</h1>
            <p className="brand-subtitle">AI-powered marine intelligence and spill attribution</p>
          </div>

          <div className="card-divider" />

          {/* Validation Alert */}
          {error && (
            <div className="auth-alert" role="alert">
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
                    alert('Password reset instructions have been dispatched to your email.')
                  }}
                >
                  Forgot password?
                </a>
              </div>
              <div className="password-wrapper">
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
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
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
                <span className="checkbox-text">Remember me</span>
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
                  <span>Signing in...</span>
                </span>
              ) : (
                <span>Sign In</span>
              )}
            </button>
          </form>

          {/* Discreet Demo Autofill Link */}
          <div className="card-footnote">
            <span>Evaluating the platform? </span>
            <button type="button" className="demo-fill-btn" onClick={handleFillDemo}>
              Use demo credentials
            </button>
          </div>
        </div>
      </div>

      {/* Minimal Discreet Bottom Telemetry */}
      <div className="telemetry-bottom">
        <span>GLOBAL MARITIME SURVEILLANCE</span>
      </div>
    </div>
  )
}
