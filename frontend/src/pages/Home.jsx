import React, { useEffect, useState } from "react"
import axios from "axios"

export default function Home() {
  const [user, setUser] = useState(null)
  const [customers, setCustomers] = useState([])
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // get current user
    axios.get("/me")
      .then(res => setUser(res.data.data))
      .catch(() => setUser(null))

    // fetch customers + orders
    Promise.all([
      axios.get("/api/customers"),
      axios.get("/api/orders")
    ])
      .then(([custRes, orderRes]) => {
        setCustomers(custRes.data.data || [])
        setOrders(orderRes.data.data || [])
      })
      .catch(() => {
        setCustomers([])
        setOrders([])
      })
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading...</p>

  return (
    <div style={{ marginTop: "20px" }}>
      <h2>Welcome to Xeno Mini CRM 🚀</h2>

      {user ? (
        <p style={{ fontSize: "18px", marginTop: "15px" }}>
          👋 Hello, <strong>{user.displayName || user.emails?.[0]?.value}</strong>!
        </p>
      ) : (
        <p style={{ fontSize: "16px", marginTop: "15px", color: "gray" }}>
          Please log in with Google to access Segments & Campaigns.
        </p>
      )}

      {/* Customers */}
      <div style={{ marginTop: "30px" }}>
        <h3>👥 Customers</h3>
        {customers.length === 0 ? (
          <p>No customers found.</p>
        ) : (
          <table border="1" cellPadding="6" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Total Spent</th>
                <th>Last Order</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.email}</td>
                  <td>{c.total_spent}</td>
                  <td>{c.last_order_date ? new Date(c.last_order_date).toLocaleDateString() : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Orders */}
      <div style={{ marginTop: "30px" }}>
        <h3>📦 Orders</h3>
        {orders.length === 0 ? (
          <p>No orders found.</p>
        ) : (
          <table border="1" cellPadding="6" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th>Customer Email</th>
                <th>Amount</th>
                <th>Date</th>
                <th>Items</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.customer_email}</td>
                  <td>{o.amount}</td>
                  <td>{new Date(o.date).toLocaleString()}</td>
                  <td>
                    {o.items && o.items.length > 0
                      ? o.items.map(it => `${it.sku} (x${it.qty})`).join(", ")
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
