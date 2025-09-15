// src/App.jsx
import React, { useEffect, useState } from 'react'
import { Routes, Route, Link, Navigate } from 'react-router-dom'
import axios from 'axios'
import Home from './pages/Home'
import CreateSegment from './pages/CreateSegment'
import Campaigns from './pages/Campaigns'
import Logs from './pages/Logs'

/*
  API_BASE resolution priority:
  1) VITE_API_URL (set in Vercel / build env) — recommended for production when backend is on a different host
  2) If running in browser:
       - if host is localhost -> use local backend http://localhost:4000 (dev)
       - otherwise assume same origin (window.location.origin) — good if frontend & backend share domain
  3) Fallback to http://localhost:4000
*/
const API_BASE = (() => {
  // read env (Vite exposes import.meta.env.VITE_* at build time)
  const raw = import.meta.env.VITE_API_URL
  if (raw && typeof raw === 'string' && raw.trim() !== '') {
    return raw.replace(/\/$/, '')
  }

  // If we are in the browser, decide based on the current origin
  if (typeof window !== 'undefined' && window.location) {
    const origin = window.location.origin
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      // developer machine -> use local backend
      return 'http://localhost:4000'
    }
    // production: assume backend is served from same origin unless VITE_API_URL is set
    return origin
  }

  // final fallback (shouldn't normally hit)
  return 'http://localhost:4000'
})()

// Configure axios defaults
axios.defaults.withCredentials = true // required if you use cookies for session
axios.defaults.baseURL = API_BASE

export default function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // use absolute paths — axios will prefix with baseURL automatically
    axios.get('/me')
      .then(res => {
        // defensive: res.data might be shaped differently; adapt if needed
        setUser(res.data?.data ?? res.data ?? null)
      })
      .catch(err => {
        setUser(null)
        // optionally log for debugging (remove in prod)
        // console.error('me fetch error', err)
      })
      .finally(() => setLoading(false))
  }, [])

  const handleLogout = () => {
    axios.get('/logout')
      .then(() => {
        setUser(null)
        // If frontend and backend are same origin this reload is fine
        // If backend is separate, you might want to redirect to a safe route instead
        window.location.href = '/'
      })
      .catch(() => {
        setUser(null)
        window.location.href = '/'
      })
  }

  if (loading) return <div>Loading...</div>

  return (
    <div className="app">
      <header className="topbar" style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
        <div>
          <h1>Xeno - Mini CRM (Intern)</h1>
          <nav>
            <Link to="/">Home</Link>
            {user && (
              <>
                {" | "}
                <Link to="/create">Create Segment</Link>
                {" | "}
                <Link to="/campaigns">Campaigns</Link>
                {" | "}
                <Link to="/logs">Logs</Link>
              </>
            )}
          </nav>
        </div>

        <div>
          {user ? (
            <div style={{display: "flex", gap: "10px", alignItems: "center"}}>
              <span>👤 {user.displayName || user.emails?.[0]?.value}</span>
              <button onClick={handleLogout} style={{padding: "5px 10px", background: "red", color: "white", border: "none", borderRadius: "5px"}}>
                Logout
              </button>
            </div>
          ) : (
            <a
              href={`${API_BASE.replace(/\/$/, '')}/auth/google`}
              style={{padding: "5px 10px", background: "blue", color: "white", borderRadius: "5px", textDecoration: "none"}}
            >
              Login with Google
            </a>
          )}
        </div>
      </header>

      <main className="container">
        <Routes>
          <Route path="/" element={<Home />} />

          {/* Protected Routes */}
          <Route path="/create" element={user ? <CreateSegment /> : <Navigate to="/" />} />
          <Route path="/campaigns" element={user ? <Campaigns /> : <Navigate to="/" />} />
          <Route path="/logs" element={user ? <Logs /> : <Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}
