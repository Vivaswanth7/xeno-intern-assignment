// backend/index.js
const path = require('path');
const fs = require('fs');

// Load environment variables from backend/.env.local
const envPath = path.join(__dirname, '.env.local');
require('dotenv').config({ path: envPath });



const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Queue = require('bull');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();

// ---------- MIDDLEWARES ----------
app.use(cors({
  origin: "http://localhost:5173",
  credentials: true
}));
app.use(express.json());

// Session config
const isProd = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // keep false for local dev; set true in production with HTTPS
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// passport init
app.use(passport.initialize());
app.use(passport.session());

// tiny request logger
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.url, 'user:', req.user ? (req.user.displayName || req.user.id) : 'anonymous');
  next();
});


// --- Bull queue & Redis setup (for async ingestion) ---
const REDIS_URL = process.env.REDIS_URL || null;
let redisClientForQueue = null;
let customersQueue = null;
let ordersQueue = null;
try {
  if (REDIS_URL) {
    redisClientForQueue = new Redis(REDIS_URL);
    customersQueue = new Queue('customers', REDIS_URL);
    ordersQueue = new Queue('orders', REDIS_URL);
    console.log('Bull queues created using REDIS_URL');
  } else {
    try {
      redisClientForQueue = new Redis(); // defaults to localhost:6379
      customersQueue = new Queue('customers', { redis: { port: 6379, host: '127.0.0.1' } });
      ordersQueue = new Queue('orders', { redis: { port: 6379, host: '127.0.0.1' } });
      console.log('Bull queues created using local Redis');
    } catch (e) {
      console.warn('Redis not available - queues disabled, will fallback to synchronous writes.', e && e.message ? e.message : e);
      customersQueue = null;
      ordersQueue = null;
    }
  }
} catch (e) {
  console.warn('Error initializing Redis/Bull:', e && e.message ? e.message : e);
  customersQueue = null;
  ordersQueue = null;
}
// --- end Bull setup ---
// --- Queue processors (consume jobs and persist to disk) ---
if (typeof customersQueue !== 'undefined' && customersQueue) {
  customersQueue.process(async (job) => {
    try {
      const value = job.data.payload;
      const customers = readJsonSafe(CUSTOMERS_FILE);
      const existing = customers.find(c => c.email.toLowerCase() === value.email.toLowerCase());
      if (existing) return;
      const newCustomer = {
        id: uuidv4(),
        name: value.name,
        email: value.email.toLowerCase(),
        phone: value.phone || null,
        total_spent: Number(value.total_spent || 0),
        last_order_date: value.last_order_date ? new Date(value.last_order_date).toISOString() : null,
        metadata: value.metadata || {},
        createdAt: new Date().toISOString()
      };
      customers.push(newCustomer);
      writeJsonSafe(CUSTOMERS_FILE, customers);
    } catch (e) {
      console.error('customersQueue.process error', e && e.message ? e.message : e);
      throw e;
    }
  });
  console.log('customersQueue processor registered');
}

if (typeof ordersQueue !== 'undefined' && ordersQueue) {
  ordersQueue.process(async (job) => {
    try {
      const value = job.data.payload;
      const customers = readJsonSafe(CUSTOMERS_FILE);
      const customer = customers.find(c => c.email.toLowerCase() === value.customer_email.toLowerCase());
      if (!customer) {
        throw new Error('Customer not found for order: ' + value.customer_email);
      }
      const orders = readJsonSafe(ORDERS_FILE);
      const newOrder = {
        id: uuidv4(),
        customer_email: value.customer_email.toLowerCase(),
        amount: Number(value.amount),
        date: new Date(value.date).toISOString(),
        items: value.items || [],
        metadata: value.metadata || {},
        createdAt: new Date().toISOString()
      };
      orders.push(newOrder);
      writeJsonSafe(ORDERS_FILE, orders);

      // update customer
      customer.total_spent = Number((Number(customer.total_spent || 0) + Number(newOrder.amount)).toFixed(2));
      customer.last_order_date = newOrder.date;
      writeJsonSafe(CUSTOMERS_FILE, customers);
    } catch (e) {
      console.error('ordersQueue.process error', e && e.message ? e.message : e);
      throw e;
    }
  });
  console.log('ordersQueue processor registered');
}
// --- end queue processors ---





// --- AI Suggest Message Endpoint (patched) ---
// Rate limit: 10 requests per minute per IP (adjust windowMs/max as needed)
const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

app.post("/api/ai/suggest-message", aiRateLimiter, async (req, res) => {
  // Minimal logging only — don't log user-provided content to avoid leaking PII.
  console.log(new Date().toISOString(), "AI suggest-message called from", req.ip || req.connection.remoteAddress);

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { /* keep as string */ }
    }

    const context = body && body.context;
    const audience = body && body.audience;
    const tone = body && body.tone;
    const n = body && body.n ? Number(body.n) : 3;

    if (!context && !audience) {
      return res.status(400).json({ error: "Provide `context` or `audience` in the body." });
    }

    const promptParts = [
      context ? `Campaign goal / context: ${context}` : null,
      audience ? `Audience: ${audience}` : null,
      tone ? `Tone: ${tone}` : "Tone: friendly, concise"
    ].filter(Boolean).join("\n");

    // If no API key is configured, return canned suggestions for offline/demo mode.
    if (!process.env.OPENAI_API_KEY) {
      const canned = [
        `Big Sale! Save 20% today — ${audience || "our valued customers"}.`,
        `Exclusive offer for you: ${context || "limited time discount"}. Click to claim!`,
        `Don't miss out — special deals for ${audience || "selected customers"} this week.`
      ];
      return res.json({ model: "local-canned", suggestions: canned.slice(0, n || 3) });
    }

    // Use configured model from env or fallback
    const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const count = Number(n) || 3;
    const userMessage = `You are a copywriting assistant. Given the inputs below, produce exactly ${count} short marketing messages (each <= 100 characters). Return as a JSON array only, no extra commentary.\n\nInputs:\n${promptParts}\n\nOutput format:\n["suggestion 1", "suggestion 2", ...]`;

    const response = await openai.chat.completions.create({
      model: modelName,
      messages: [
        { role: "system", content: "You are a helpful marketing copy assistant." },
        { role: "user", content: userMessage }
      ],
      max_tokens: 128,
      temperature: 0.8,
    });

    const raw = response.choices?.[0]?.message?.content || response.choices?.[0]?.text || "";
    let suggestions = [];
    try {
      const jsonStart = raw.indexOf("[");
      const jsonEnd = raw.lastIndexOf("]") + 1;
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonText = raw.substring(jsonStart, jsonEnd);
        suggestions = JSON.parse(jsonText);
      } else {
        suggestions = raw.split(/\r?\n/).filter(Boolean).slice(0, count).map(s => s.replace(/^[-\d\.\)\s"]+/, "").trim());
      }
    } catch (e) {
      suggestions = raw.split(/\r?\n/).filter(Boolean).slice(0, count).map(s => s.replace(/^[-\d\.\)\s"]+/, "").trim());
    }

    return res.json({ model: modelName, suggestions: suggestions.slice(0, count) });
  } catch (err) {
    console.error("AI suggestion error:", err && err.message ? err.message : err);
    return res.status(500).json({ error: "AI request failed", detail: err && err.message ? err.message : String(err) });
  }
});
// --- end AI route (patched) ---



// ---------- PASSPORT STRATEGY ----------
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:4000/auth/google/callback';

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  try {
    passport.use(new GoogleStrategy({
      clientID: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL
    }, (accessToken, refreshToken, profile, done) => {
      // For this assignment we store the full profile in session.
      // In production, persist user in DB and serialize only user.id.
      return done(null, profile);
    }));

    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    console.log('DEBUG: GoogleStrategy registered successfully.');
    console.log('DEBUG: passport._strategy("google") ->', typeof passport._strategy === 'function' ? !!passport._strategy('google') : 'no _strategy func');
  } catch (err) {
    console.error('ERROR: Failed to register GoogleStrategy ->', err && err.message);
  }
} else {
  console.warn('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env.local to enable auth.');
}

// ---------- DATA FILES ----------
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SEGMENTS_FILE = path.join(DATA_DIR, 'segments.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const COMM_LOG_FILE = path.join(DATA_DIR, 'communication_log.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([]));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
if (!fs.existsSync(SEGMENTS_FILE)) fs.writeFileSync(SEGMENTS_FILE, JSON.stringify([]));
if (!fs.existsSync(CAMPAIGNS_FILE)) fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify([]));
if (!fs.existsSync(COMM_LOG_FILE)) fs.writeFileSync(COMM_LOG_FILE, JSON.stringify([]));


// ---------- PUB-SUB QUEUES (Bull + Redis) ----------
const customerQueue = new Queue('customers', { redis: { host: '127.0.0.1', port: 6379 } });
const orderQueue = new Queue('orders', { redis: { host: '127.0.0.1', port: 6379 } });

customerQueue.process(async (job) => {
  const data = job.data;
  const customers = readJsonSafe(CUSTOMERS_FILE);
  const existing = customers.find(c => c.email.toLowerCase() === data.email.toLowerCase());
  if (!existing) {
    customers.push(data);
    writeJsonSafe(CUSTOMERS_FILE, customers);
  }
});

orderQueue.process(async (job) => {
  const data = job.data;
  const customers = readJsonSafe(CUSTOMERS_FILE);
  const customer = customers.find(c => c.email.toLowerCase() === data.customer_email.toLowerCase());
  if (!customer) return;
  const orders = readJsonSafe(ORDERS_FILE);
  orders.push(data);
  writeJsonSafe(ORDERS_FILE, orders);
  customer.total_spent = Number((Number(customer.total_spent || 0) + Number(data.amount)).toFixed(2));
  customer.last_order_date = data.date;
  writeJsonSafe(CUSTOMERS_FILE, customers);
});


function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('readJsonSafe error for', filePath, err.message || err);
    return [];
  }
}
function writeJsonSafe(filePath, arr) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.error('writeJsonSafe error for', filePath, err.message || err);
    throw err;
  }
}

// ---------- AUTH HELPERS & ROUTES ----------
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

// Start Google OAuth flow
app.get('/auth/google', (req, res, next) => {
  if (typeof passport._strategy !== 'function' || !passport._strategy('google')) {
    return res.status(500).json({ error: 'Google OAuth not configured on server.' });
  }
  passport.authenticate('google', { scope: ['profile', 'email'] })(req, res, next);
});

// Callback
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/auth/failure', session: true }),
  (req, res) => {
    // successful auth — redirect to frontend
    res.redirect('http://localhost:5173');
  }
);

app.get('/auth/failure', (req, res) => res.status(401).json({ error: 'Authentication failed' }));

app.get('/logout', (req, res, next) => {
  req.logout(function(err) {
    if (err) return next(err);
    if (req.session) {
      req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.json({ ok: true });
      });
    } else {
      res.json({ ok: true });
    }
  });
});

app.get('/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const u = req.user || {};
    const user = {
      id: u.id,
      displayName: u.displayName,
      emails: u.emails,
      provider: u.provider
    };
    return res.json({ data: user });
  }
  return res.json({ data: null });
});

// ---------- VALIDATION SCHEMAS ----------
const customerSchema = Joi.object({
  name: Joi.string().min(1).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().optional().allow('', null),
  total_spent: Joi.number().min(0).optional().default(0),
  last_order_date: Joi.date().iso().optional().allow(null),
  metadata: Joi.object().optional().default({})
});

const orderSchema = Joi.object({
  customer_email: Joi.string().email().required(),
  amount: Joi.number().min(0).required(),
  date: Joi.date().iso().optional().default(() => new Date().toISOString()),
  items: Joi.array().items(
    Joi.object({
      sku: Joi.string().required(),
      qty: Joi.number().min(1).required()
    })
  ).optional().default([]),
  metadata: Joi.object().optional().default({})
});

const previewSchema = Joi.object({
  conditions: Joi.array().items(
    Joi.object({
      field: Joi.string().valid('total_spent', 'email', 'last_order_date').required(),
      op: Joi.string().valid('gt','gte','lt','lte','eq','neq').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.date().iso()).required()
    })
  ).min(1).required(),
  logic: Joi.string().valid('AND','OR').optional().default('AND')
});

// ---------- ROUTES (API) ----------
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Hello from backend — express is working!' }));
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));

/** POST /api/customers */

app.post('/api/customers', (req, res) => {
  const { error, value } = customerSchema.validate(req.body, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });

  // If customersQueue is available, enqueue job and return 202 Accepted.
  if (typeof customersQueue !== 'undefined' && customersQueue) {
    customersQueue.add({ payload: value }).then(job => {
      return res.status(202).json({ message: 'Customer enqueued for async ingestion', jobId: job.id });
    }).catch(err => {
      console.error('Queue add error:', err && err.message ? err.message : err);
      // fallback to synchronous write if enqueue fails
    });
    return;
  }

  // Fallback synchronous write (existing behavior)
  const customers = readJsonSafe(CUSTOMERS_FILE);
  const existing = customers.find(c => c.email.toLowerCase() === value.email.toLowerCase());
  if (existing) return res.status(200).json({ message: 'Customer already exists', data: existing });

  const newCustomer = {
    id: uuidv4(),
    name: value.name,
    email: value.email.toLowerCase(),
    phone: value.phone || null,
    total_spent: Number(value.total_spent || 0),
    last_order_date: value.last_order_date ? new Date(value.last_order_date).toISOString() : null,
    metadata: value.metadata || {},
    createdAt: new Date().toISOString()
  };
  customers.push(newCustomer);
  writeJsonSafe(CUSTOMERS_FILE, customers);
  return res.status(201).json({ data: newCustomer });
});
app.get('/api/customers', (req, res) => {
  const customers = readJsonSafe(CUSTOMERS_FILE);
  res.json({ data: customers });
});

/** POST /api/orders */

app.post('/api/orders', (req, res) => {
  const { error, value } = orderSchema.validate(req.body, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });

  // If ordersQueue is available, enqueue job and return 202 Accepted.
  if (typeof ordersQueue !== 'undefined' && ordersQueue) {
    ordersQueue.add({ payload: value }).then(job => {
      return res.status(202).json({ message: 'Order enqueued for async ingestion', jobId: job.id });
    }).catch(err => {
      console.error('Queue add error:', err && err.message ? err.message : err);
      // fallback to synchronous write if enqueue fails
    });
    return;
  }

  // Fallback synchronous write (existing behavior)
  const customers = readJsonSafe(CUSTOMERS_FILE);
  const customer = customers.find(c => c.email.toLowerCase() === value.customer_email.toLowerCase());
  if (!customer) return res.status(404).json({ error: 'Customer not found. Ingest customer first.' });

  const orders = readJsonSafe(ORDERS_FILE);
  const newOrder = {
    id: uuidv4(),
    customer_email: value.customer_email.toLowerCase(),
    amount: Number(value.amount),
    date: new Date(value.date).toISOString(),
    items: value.items || [],
    metadata: value.metadata || {},
    createdAt: new Date().toISOString()
  };
  orders.push(newOrder);
  writeJsonSafe(ORDERS_FILE, orders);

  // update customer
  customer.total_spent = Number((Number(customer.total_spent || 0) + Number(newOrder.amount)).toFixed(2));
  customer.last_order_date = newOrder.date;
  writeJsonSafe(CUSTOMERS_FILE, customers);

  return res.status(201).json({ data: newOrder });
});
app.get('/api/orders', (req, res) => {
  const orders = readJsonSafe(ORDERS_FILE);
  res.json({ data: orders });
});

/** POST /api/segments - save a segment definition (protected) */
app.post('/api/segments', ensureAuth, (req, res) => {
  const payload = req.body; // expect { name, conditions, logic }
  if (!payload || !payload.name || !Array.isArray(payload.conditions)) {
    return res.status(400).json({ error: 'Invalid segment payload. Expect { name, conditions: [] }' });
  }

  // validate conditions on save
  const { error, value } = previewSchema.validate({ conditions: payload.conditions, logic: payload.logic || 'AND' }, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });

  const segments = readJsonSafe(SEGMENTS_FILE);
  const seg = {
    id: uuidv4(),
    name: payload.name,
    conditions: value.conditions,
    logic: value.logic,
    createdAt: new Date().toISOString()
  };
  segments.push(seg);
  writeJsonSafe(SEGMENTS_FILE, segments);

  return res.status(201).json({ data: seg });
});

/** GET /api/segments - list saved segments (public) */
app.get('/api/segments', ensureAuth, (req, res) => {
  const segments = readJsonSafe(SEGMENTS_FILE);
  res.json({ data: segments });
});

/** POST /api/campaigns - create a campaign from a segment (protected) */
app.post('/api/campaigns', ensureAuth, (req, res) => {
  const { name, segmentId, message } = req.body;

  if (!name || !segmentId || !message) {
    return res.status(400).json({ error: 'name, segmentId and message are required' });
  }

  const segments = readJsonSafe(SEGMENTS_FILE);
  const segment = segments.find(s => s.id === segmentId);
  if (!segment) {
    return res.status(404).json({ error: 'Segment not found' });
  }

  const campaigns = readJsonSafe(CAMPAIGNS_FILE);
  const newCampaign = {
    id: uuidv4(),
    name,
    segmentId,
    message,
    status: 'CREATED',
    createdAt: new Date().toISOString()
  };
  campaigns.push(newCampaign);
  writeJsonSafe(CAMPAIGNS_FILE, campaigns);

  return res.status(201).json({ data: newCampaign });
});

/** GET /api/campaigns - list campaigns (public) */
app.get('/api/campaigns', ensureAuth, (req, res) => {
  const campaigns = readJsonSafe(CAMPAIGNS_FILE);
  res.json({ data: campaigns });
});

// ---------- SEGMENT PREVIEW / MATCHING ----------
function matchCondition(customer, condition) {
  const { field, op, value } = condition;
  const fieldVal = customer[field];

  // date field handling
  if (field === 'last_order_date') {
    const leftTs = fieldVal ? Date.parse(fieldVal) : 0;
    const rightTs = Date.parse(String(value));
    if (isNaN(rightTs)) return false;
    switch (op) {
      case 'gt': return leftTs > rightTs;
      case 'gte': return leftTs >= rightTs;
      case 'lt': return leftTs < rightTs;
      case 'lte': return leftTs <= rightTs;
      case 'eq': return leftTs === rightTs;
      case 'neq': return leftTs !== rightTs;
      default: return false;
    }
  }

  // numeric comparisons for total_spent
  if (field === 'total_spent') {
    const left = Number(fieldVal || 0);
    const right = Number(value);
    if (isNaN(right)) return false;
    switch (op) {
      case 'gt': return left > right;
      case 'gte': return left >= right;
      case 'lt': return left < right;
      case 'lte': return left <= right;
      case 'eq': return left === right;
      case 'neq': return left !== right;
      default: return false;
    }
  }

  // fallback string comparisons (email etc.)
  const leftStr = String(fieldVal || '').toLowerCase();
  const rightStr = String(value || '').toLowerCase();
  switch (op) {
    case 'eq': return leftStr === rightStr;
    case 'neq': return leftStr !== rightStr;
    default: return false;
  }
}

app.post('/api/segments/preview', (req, res) => {
  const { error, value } = previewSchema.validate(req.body, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });

  const customers = readJsonSafe(CUSTOMERS_FILE);
  const matches = customers.filter(c => {
    const results = value.conditions.map(cond => matchCondition(c, cond));
    return value.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
  });

  return res.json({ audience_count: matches.length, sample: matches.slice(0, 10) });
});

// GET version (with ?rule=)
app.get('/api/segments/preview', (req, res) => {
  const ruleStr = req.query.rule;
  if (!ruleStr) return res.status(400).json({ error: 'Provide rule JSON in query param ?rule=' });
  let parsed;
  try { parsed = JSON.parse(ruleStr); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON in rule param' }); }
  const { error, value } = previewSchema.validate(parsed, { stripUnknown: true });
  if (error) return res.status(400).json({ error: error.details.map(d => d.message).join(', ') });

  const customers = readJsonSafe(CUSTOMERS_FILE);
  const matches = customers.filter(c => {
    const results = value.conditions.map(cond => matchCondition(c, cond));
    return value.logic === 'AND' ? results.every(Boolean) : results.some(Boolean);
  });
  return res.json({ audience_count: matches.length, sample: matches.slice(0, 10) });
});

// ==== Communication Log + Send Endpoint ====
function addCommRecord(record) {
  const logs = readJsonSafe(COMM_LOG_FILE);
  logs.push(record);
  writeJsonSafe(COMM_LOG_FILE, logs);
}


/** POST /api/delivery-receipt - accept delivery receipts from vendors */
app.post('/api/delivery-receipt', (req, res) => {
  const payload = req.body || req.query || {} ;
  const campaignId = payload.campaignId || payload.campaign_id || payload.campaignID;
  const customer_email = payload.customer_email || payload.email || payload.customerEmail;
  const status = payload.status || payload.state || 'SENT';
  if (!campaignId || !customer_email) {
    return res.status(400).json({ error: 'Provide campaignId and customer_email in body' });
  }
  try {
    const receipts = readJsonSafe("/mnt/data/xeno-intern-assignment-main-extracted/xeno-intern-assignment-main/backend/data/receipts.json");
    const rec = {
      id: uuidv4(),
      campaignId,
      customer_email: customer_email.toLowerCase(),
      status,
      receivedAt: new Date().toISOString()
    };
    receipts.push(rec);
    writeJsonSafe("/mnt/data/xeno-intern-assignment-main-extracted/xeno-intern-assignment-main/backend/data/receipts.json", receipts);
    return res.json({ ok: true, data: rec });
  } catch (e) {
    console.error('delivery-receipt error', e && e.message ? e.message : e);
    return res.status(500).json({ error: 'Failed to save receipt' });
  }
});
        
/** POST /api/campaigns/:id/send (protected) */
app.post('/api/campaigns/:id/send', ensureAuth, (req, res) => {
  const campaignId = req.params.id;
  const campaigns = readJsonSafe(CAMPAIGNS_FILE);
  const campaign = campaigns.find(c => c.id === campaignId);
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  // load segment
  const segments = readJsonSafe(SEGMENTS_FILE);
  const segment = segments.find(s => s.id === campaign.segmentId);
  if (!segment) {
    return res.status(404).json({ error: 'Segment for campaign not found' });
  }

  // get audience
  const customers = readJsonSafe(CUSTOMERS_FILE);
  const matches = customers.filter(c => {
    const results = segment.conditions.map(cond => matchCondition(c, cond));
    return (segment.logic === 'AND' ? results.every(Boolean) : results.some(Boolean));
  });

  if (matches.length === 0) {
    campaign.status = 'NO_AUDIENCE';
    writeJsonSafe(CAMPAIGNS_FILE, campaigns);
    return res.json({ audience_count: 0, sent: 0, failed: 0, sample: [] });
  }

  let sent = 0;
  let failed = 0;
  const sample = [];

  matches.forEach((cust) => {
    const success = Math.random() < 0.9; // 90% chance success
    const status = success ? 'SENT' : 'FAILED';
    const record = {
      id: uuidv4(),
      campaignId: campaign.id,
      customer_email: cust.email,
      status,
      message: campaign.message,
      timestamp: new Date().toISOString()
    };
    addCommRecord(record);
    if (success) sent++; else failed++;
    if (sample.length < 5) sample.push(record);
  });

  campaign.status = failed === 0 ? 'SENT' : 'PARTIAL_FAILED';
  writeJsonSafe(CAMPAIGNS_FILE, campaigns);

  return res.json({ audience_count: matches.length, sent, failed, sample });
});

/** GET /api/communication-log (public) */

// --- Receipts batch processor: runs every 30s and applies receipts to communication log ---
function processReceiptsBatch() {
  try {
    const receipts = readJsonSafe("/mnt/data/xeno-intern-assignment-main-extracted/xeno-intern-assignment-main/backend/data/receipts.json");
    if (!Array.isArray(receipts) || receipts.length === 0) return;
    const logs = readJsonSafe(COMM_LOG_FILE);
    let updated = false;
    receipts.forEach(r => {
      const idx = logs.findIndex(l => l.campaignId === r.campaignId && l.customer_email === r.customer_email);
      if (idx !== -1) {
        logs[idx].status = r.status;
        logs[idx].deliveredAt = r.receivedAt || new Date().toISOString();
        updated = true;
      }
    });
    if (updated) writeJsonSafe(COMM_LOG_FILE, logs);
    // clear receipts file
    writeJsonSafe("/mnt/data/xeno-intern-assignment-main-extracted/xeno-intern-assignment-main/backend/data/receipts.json", []);
  } catch (e) {
    console.error('processReceiptsBatch error', e && e.message ? e.message : e);
  }
}

// schedule processor every 30 seconds
setInterval(processReceiptsBatch, 30 * 1000);
console.log('Receipts batch processor scheduled (every 30s).');
app.get('/api/communication-log', (req, res) => {
  const logs = readJsonSafe(COMM_LOG_FILE);
  res.json({ data: logs });
});

// start server
const PORT = process.env.PORT || 4000;


// ---------- DELIVERY RECEIPT API + BATCH PROCESSOR ----------
const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json');
if (!fs.existsSync(RECEIPTS_FILE)) fs.writeFileSync(RECEIPTS_FILE, JSON.stringify([]));

app.post('/api/delivery-receipt', (req, res) => {
  const { campaignId, customer_email, status } = req.body || {};
  if (!campaignId || !customer_email || !status) {
    return res.status(400).json({ error: 'campaignId, customer_email, status required' });
  }
  const receipts = readJsonSafe(RECEIPTS_FILE);
  receipts.push({ campaignId, customer_email: customer_email.toLowerCase(), status, receivedAt: new Date().toISOString() });
  writeJsonSafe(RECEIPTS_FILE, receipts);
  return res.status(202).json({ message: 'Receipt accepted' });
});

// Batch processor every 30s
setInterval(() => {
  const receipts = readJsonSafe(RECEIPTS_FILE);
  if (receipts.length === 0) return;
  let logs = readJsonSafe(COMM_LOG_FILE);
  receipts.forEach(r => {
    const rec = logs.find(l => l.campaignId === r.campaignId && l.customer_email === r.customer_email);
    if (rec) rec.delivery_status = r.status;
  });
  writeJsonSafe(COMM_LOG_FILE, logs);
  fs.writeFileSync(RECEIPTS_FILE, JSON.stringify([]));
  console.log('Processed', receipts.length, 'receipts');
}, 30000);


app.listen(PORT, () => {
  console.log(`Backend server listening on http://localhost:${PORT}`);
});
