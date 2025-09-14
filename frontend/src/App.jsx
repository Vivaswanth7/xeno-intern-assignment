// src/App.jsx
import React, { useEffect, useState } from 'react'
import { Routes, Route, Link, Navigate } from 'react-router-dom'
import axios from 'axios'
import Home from './pages/Home'
import CreateSegment from './pages/CreateSegment'
import Campaigns from './pages/Campaigns'
import Logs from './pages/Logs'

// ✅ set axios defaults for all requests
axios.defaults.withCredentials = true
axios.defaults.baseURL = "http://localhost:4000"

export default function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    axios.get("/me")
      .then(res => setUser(res.data.data))
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  const handleLogout = () => {
    axios.get("/logout")
      .then(() => {
        setUser(null)
        window.location.href = "/" // refresh to home after logout
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
              href="http://localhost:4000/auth/google"
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

          {/* ✅ Protected Routes */}
          <Route path="/create" element={user ? <CreateSegment /> : <Navigate to="/" />} />
          <Route path="/campaigns" element={user ? <Campaigns /> : <Navigate to="/" />} />
          <Route path="/logs" element={user ? <Logs /> : <Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}
