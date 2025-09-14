import React, { useState } from "react";
import axios from "axios";

export default function MessageSuggester({ onPick, defaultContext }) {
  const [loading, setLoading] = useState(false);
  const [sugs, setSugs] = useState([]);

  async function suggest() {
    setLoading(true);
    try {
      const resp = await axios.post("/api/ai/suggest-message", {
        context: defaultContext || "Promote 20% off weekend sale",
        audience: "customers spent > 100",
        tone: "friendly",
        n: 3
      });
      setSugs(resp.data.suggestions || []);
    } catch (err) {
      console.error(err);
      alert("AI suggestion failed — check backend logs.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" onClick={suggest} disabled={loading}>
        {loading ? "Thinking…" : "Suggest Message"}
      </button>
      <ul style={{ marginTop: 6, paddingLeft: 18 }}>
        {sugs.map((s, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            {s}{" "}
            <button type="button" onClick={() => onPick(s)} style={{ marginLeft: 8 }}>
              Use
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
