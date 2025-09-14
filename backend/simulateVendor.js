
// simulateVendor.js
// Simple vendor receipt simulator. Run while backend is running (node simulateVendor.js)
// It will POST delivery receipts for SENT communication_log entries that don't have deliveredAt yet.
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BACKEND_URL || 'http://localhost:4000';
const DATA_DIR = path.join(__dirname, 'data');
const COMM_LOG = path.join(DATA_DIR, 'communication_log.json');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8') || '[]'); } catch(e){ return []; }
}

async function postReceipt(campaignId, email, status='DELIVERED') {
  try {
    const resp = await axios.post(`${BASE}/api/delivery-receipt`, { campaignId, customer_email: email, status });
    console.log('Posted receipt', resp.data);
  } catch (e) {
    console.error('Failed to post receipt', e && e.response ? e.response.data : e.message);
  }
}

async function runOnce() {
  const logs = readJson(COMM_LOG);
  for (const l of logs) {
    if ((l.status === 'SENT' || l.status === 'PARTIAL_FAILED') && !l.deliveredAt) {
      console.log('Sending simulated receipt for', l.customer_email, l.campaignId);
      await postReceipt(l.campaignId, l.customer_email, 'DELIVERED');
      await new Promise(r => setTimeout(r, 200)); // small delay
    }
  }
  console.log('Simulation complete');
}

if (require.main === module) {
  runOnce();
}

module.exports = { runOnce };
