import { useEffect, useState } from "react";
import axios from "axios";
import MessageSuggester from "../components/MessageSuggester";
export default function Campaigns() {
  const [campaigns, setCampaigns] = useState([]);
  const [segments, setSegments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // form state
  const [name, setName] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [message, setMessage] = useState("");

  // logs state
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);
  const [visibleLogsCampaignId, setVisibleLogsCampaignId] = useState(null);
  const [visibleLogs, setVisibleLogs] = useState([]);

  // fetch campaigns + segments
  useEffect(() => {
    Promise.all([
      axios.get("/api/campaigns"),
      axios.get("/api/segments"),
    ])
      .then(([campaignRes, segmentRes]) => {
        setCampaigns(campaignRes.data.data || []);
        setSegments(segmentRes.data.data || []);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching data:", err);
        setError("Failed to fetch campaigns/segments");
        setLoading(false);
      });
  }, []);

  // create new campaign
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name || !segmentId || !message) {
      alert("Please fill all fields");
      return;
    }

    try {
      const res = await axios.post("/api/campaigns", {
        name,
        segmentId,
        message,
      });
      setCampaigns((prev) => [...prev, res.data.data]);
      setName("");
      setSegmentId("");
      setMessage("");
    } catch (err) {
      alert("Error creating campaign: " + err);
    }
  };

  // send campaign
  const handleSend = async (campaignId) => {
    if (!window.confirm("Send campaign now?")) return;
    try {
      const res = await axios.post(`/api/campaigns/${campaignId}/send`);
      const data = res.data;

      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === campaignId
            ? {
                ...c,
                status:
                  data.sent === 0 && data.failed === 0
                    ? "NO_AUDIENCE"
                    : data.failed === 0
                    ? "SENT"
                    : "PARTIAL_FAILED",
              }
            : c
        )
      );

      fetchLogsForCampaign(campaignId);
      alert(
        `Campaign sent. audience_count=${data.audience_count}, sent=${data.sent}, failed=${data.failed}`
      );
    } catch (err) {
      console.error("Send failed:", err);
      alert("Send failed: " + err);
    }
  };

  // fetch logs for campaign
  const fetchLogsForCampaign = async (campaignId) => {
    setLogsLoading(true);
    setLogsError(null);
    setVisibleLogsCampaignId(campaignId);
    setVisibleLogs([]);

    try {
      const res = await axios.get("/api/communication-log");
      const filtered = (res.data.data || []).filter(
        (r) => r.campaignId === campaignId
      );
      setVisibleLogs(filtered);
    } catch (err) {
      setLogsError("Failed to fetch logs");
    } finally {
      setLogsLoading(false);
    }
  };

  const hideLogs = () => {
    setVisibleLogsCampaignId(null);
    setVisibleLogs([]);
  };

  if (loading) return <p>Loading campaigns...</p>;
  if (error) return <p style={{ color: "red" }}>{error}</p>;

  return (
    <div style={{ padding: "20px" }}>
      <h2>Campaigns</h2>

      {/* Campaign form */}
      <div className="card" style={{ marginBottom: "20px", padding: "10px" }}>
        <h3>Create New Campaign</h3>
        <form onSubmit={handleSubmit}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Campaign Name"
          />
          <select
            value={segmentId}
            onChange={(e) => setSegmentId(e.target.value)}
          >
            <option value="">-- Select Segment --</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message"
          />
          <MessageSuggester onPick={(m) => setMessage(m)} defaultContext={"Promote 20% off weekend sale"} />
          <button type="submit">Create</button>
        </form>
      </div>

      {/* Campaign list */}
      <div className="card">
        {campaigns.length === 0 ? (
          <p>No campaigns yet</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>SegmentId</th>
                <th>Message</th>
                <th>Status</th>
                <th>CreatedAt</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>{c.name}</td>
                  <td>{c.segmentId}</td>
                  <td>{c.message}</td>
                  <td>{c.status}</td>
                  <td>{new Date(c.createdAt).toLocaleString()}</td>
                  <td>
                    <button
                      onClick={() => handleSend(c.id)}
                      disabled={["SENT", "PARTIAL_FAILED", "NO_AUDIENCE"].includes(
                        c.status
                      )}
                    >
                      Send
                    </button>
                    <button
                      onClick={() =>
                        visibleLogsCampaignId === c.id
                          ? hideLogs()
                          : fetchLogsForCampaign(c.id)
                      }
                    >
                      {visibleLogsCampaignId === c.id ? "Hide Logs" : "View Logs"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* logs */}
        {visibleLogsCampaignId && (
          <div>
            <h4>Logs for {visibleLogsCampaignId}</h4>
            {logsLoading ? (
              <p>Loading...</p>
            ) : logsError ? (
              <p>{logsError}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Status</th>
                    <th>Message</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLogs.map((log) => (
                    <tr key={log.id}>
                      <td>{log.customer_email}</td>
                      <td>{log.status}</td>
                      <td>{log.message}</td>
                      <td>{new Date(log.timestamp).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
