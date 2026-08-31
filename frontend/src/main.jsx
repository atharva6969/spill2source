import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    console.error('SlickTrace crashed:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', background: '#0B1326',
          color: '#DAE2FD', fontFamily: 'monospace', padding: '2rem',
          textAlign: 'center',
        }}>
          <h1 style={{ color: '#EF4444', marginBottom: '1rem' }}>
            SYSTEM ERROR
          </h1>
          <p style={{ marginBottom: '1.5rem', opacity: 0.8 }}>
            The dashboard encountered an unexpected error.
          </p>
          <pre style={{
            background: '#171F33', padding: '1rem', borderRadius: '8px',
            maxWidth: '600px', overflow: 'auto', fontSize: '0.85rem',
            marginBottom: '1.5rem',
          }}>
            {this.state.error?.message || String(this.state.error)}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              background: '#38BDF8', color: '#0B1326', border: 'none',
              padding: '0.6rem 1.5rem', borderRadius: '6px', cursor: 'pointer',
              fontFamily: 'monospace', fontWeight: 'bold',
            }}>
            Reload Dashboard
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
