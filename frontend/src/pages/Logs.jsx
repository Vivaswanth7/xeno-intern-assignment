import React, { useEffect, useState } from 'react'
import axios from 'axios'

export default function Logs() {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    axios.get("/api/communication-log")
      .then(res => setLogs(res.data.data || []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div>Loading communication logs...</div>
  if (!logs.length) return <div>No communication logs found.</div>

  return (
    <div>
      <h2>📜 Communication Logs</h2>
      <table border="1" cellPadding="6" style={{ marginTop: "10px", borderCollapse: "collapse", width:"100%" }}>
        <thead>
          <tr>
            <th>Campaign ID</th>
            <th>Customer Email</th>
            <th>Status</th>
            <th>Message</th>
            <th>Timestamp</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td>{log.campaignId}</td>
              <td>{log.customer_email}</td>
              <td style={{ color: log.status === "SENT" ? "green" : "red" }}>
                {log.status}
              </td>
              <td>{log.message}</td>
              <td>{new Date(log.timestamp).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
