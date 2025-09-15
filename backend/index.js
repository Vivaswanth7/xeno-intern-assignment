// backend/index.js
const path = require('path');
const fs = require('fs');

// Load environment variables from backend/.env.local in local dev (keep this file in .gitignore)
const envPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const Queue = require('bull');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// OPTIONAL: OpenAI client (only created if OPENAI_API_KEY provided)
let openaiClient = null;
try {
  const { Configuration, OpenAIApi } = require('openai');
  if (process.env.OPENAI_API_KEY) {
    const cfg = new Configuration({ apiKey: process.env.OPENAI_API_KEY });
    openaiClient = new OpenAIApi(cfg);
    console.log('OpenAI client configured');
  }
} catch (e) {
  console.warn('OpenAI SDK not installed or failed to initialize. AI endpoints will return canned responses if no client is available.');
}

const app = express();

// ---------- MIDDLEWARES ----------
// CORS - read allowed origins from env and log them for debug
const rawAllowed = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = rawAllowed
  ? rawAllowed.split(',').map(s => s.trim()).filter(Boolean)
  : (process.env.FRONTEND_URL ? [process.env.FRONTEND_URL, 'http://localhost:5173'] : ['http://localhost:5173']);

console.log('DEBUG: ALLOWED_ORIGINS env =>', rawAllowed);
console.log('DEBUG: computed allowedOrigins =>', allowedOrigins);

// CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    // allow curl / server-to-server (no origin)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'), false);
  },
  credentials: true
}));

app.use(express.json());

// Session config
const isProd = (process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'prod');

// When behind a proxy (Render), trust the proxy so req.secure works
if (isProd) {
  app.set('trust proxy', 1); // trust first proxy
  console.log('DEBUG: trust proxy enabled (production)');
}

// IMPORTANT: MemoryStore is not suitable for production (only for small test apps).
// Consider using connect-redis / a DB-backed session store for production.
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,                    // true in production (requires HTTPS)
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax'  // cross-site cookies need SameSite=None and Secure
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

// ---------- QUEUES (optional) ----------
let customersQueue = null;
let ordersQueue = null;
if (process.env.REDIS_URL) {
  try {
    customersQueue = new Queue('customers', process.env.REDIS_URL);
    ordersQueue = new Queue('orders', process.env.REDIS_URL);
    console.log('Bull queues created using REDIS_URL');
  } catch (e) {
    console.warn('Failed to initialize Bull queues with REDIS_URL:', e && e.message ? e.message : e);
    customersQueue = null;
    ordersQueue = null;
  }
} else {
  console.log('REDIS_URL not set — running without job queues (synchronous writes).');
}

// ---------- DATA FILES ----------
const DATA_DIR = path.join(__dirname, 'data');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SEGMENTS_FILE = path.join(DATA_DIR, 'segments.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const COMM_LOG_FILE = path.join(DATA_DIR, 'communication_log.json');
const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(CUSTOMERS_FILE)) fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify([]));
if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, JSON.stringify([]));
if (!fs.existsSync(SEGMENTS_FILE)) fs.writeFileSync(SEGMENTS_FILE, JSON.stringify([]));
if (!fs.existsSync(CAMPAIGNS_FILE)) fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify([]));
if (!fs.existsSync(COMM_LOG_FILE)) fs.writeFileSync(COMM_LOG_FILE, JSON.stringify([]));
if (!fs.existsSync(RECEIPTS_FILE)) fs.writeFileSync(RECEIPTS_FILE, JSON.stringify([]));

// ---------- QUEUE PROCESSORS (guarded) ----------
if (customersQueue) {
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

if (ordersQueue) {
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

// ---------- UTILITIES ----------
function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    console.error('readJsonSafe error for', filePath, err && err.message ? err.message : err);
    return [];
  }
}
function writeJsonSafe(filePath, arr) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
  } catch (err) {
    console.error('writeJsonSafe error for', filePath, err && err.message ? err.message : err);
    throw err;
  }
}

// ---------- AI Suggest Message Endpoint ----------
const aiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

app.post('/api/ai/suggest-message', aiRateLimiter, async (req, res) => {
  console.log(new Date().toISOString(), 'AI suggest-message called from', req.ip || req.connection.remoteAddress);
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {}
    }
    const context = body && body.context;
    const audience = body && body.audience;
    const tone = body && body.tone;
    const n = body && body.n ? Number(body.n) : 3;
    if (!context && !audience) return res.status(400).json({ error: 'Provide `context` or `audience` in the body.' });

    const promptParts = [
      context ? `Campaign goal / context: ${context}` : null,
      audience ? `Audience: ${audience}` : null,
      tone ? `Tone: ${tone}` : 'Tone: friendly, concise'
    ].filter(Boolean).join('\n');

    if (!process.env.OPENAI_API_KEY || !openaiClient) {
      const canned = [
        `Big Sale! Save 20% today — ${audience || 'our valued customers'}.`,
        `Exclusive offer for you: ${context || 'limited time discount'}. Click to claim!`,
        `Don't miss out — special deals for ${audience || 'selected customers'} this week.`
      ];
      return res.json({ model: 'local-canned', suggestions: canned.slice(0, n || 3) });
    }

    const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const count = Number(n) || 3;
    const userMessage = `You are a copywriting assistant. Given the inputs below, produce exactly ${count} short marketing messages (each <= 100 characters). Return as a JSON array only, no extra commentary.\n\nInputs:\n${promptParts}\n\nOutput format:\n["suggestion 1", "suggestion 2", ...]`;

    const response = await openaiClient.createChatCompletion({
      model: modelName,
      messages: [
        { role: 'system', content: 'You are a helpful marketing copy assistant.' },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 128,
      temperature: 0.8,
    });

    const raw = response.data?.choices?.[0]?.message?.content || response.data?.choices?.[0]?.text || '';
    let suggestions = [];
    try {
      const jsonStart = raw.indexOf('[');
      const jsonEnd = raw.lastIndexOf(']') + 1;
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonText = raw.substring(jsonStart, jsonEnd);
        suggestions = JSON.parse(jsonText);
      } else {
        suggestions = raw.split(/\r?\n/).filter(Boolean).slice(0, count).map(s => s.replace(/^[-\d\.\)\s"]+/, '').trim());
      }
    } catch (e) {
      suggestions = raw.split(/\r?\n/).filter(Boolean).slice(0, count).map(s => s.replace(/^[-\d\.\)\s"]+/, '').trim());
    }

    return res.json({ model: modelName, suggestions: suggestions.slice(0, count) });
  } catch (err) {
    console.error('AI suggestion error:', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'AI request failed', detail: err && err.message ? err.message : String(err) });
  }
});

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
      return done(null, profile);
    }));

    passport.serializeUser((user, done) => done(null, user));
    passport.deserializeUser((obj, done) => done(null, obj));

    console.log('DEBUG: GoogleStrategy registered successfully.');
  } catch (err) {
    console.error('ERROR: Failed to register GoogleStrategy ->', err && err.message);
  }
} else {
  console.warn('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable auth.');
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
    // successful auth — redirect to frontend (env-driven)
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.redirect(FRONTEND_URL);
  }
);

app.get('/auth/failure', (req, res) => res.status(401).json({ error: 'Authentication failed' }));

app.get('/logout', (req, res, next) => {
  req.logout(function(err) {
    if (err) return next(err);
    if (req.session) {
      req.session.destroy(() => {
        // Clear the cookie with matching options so browsers actually remove it
        res.clearCookie('connect.sid', { path: '/', httpOnly: true, secure: isProd, sameSite: isProd ? 'none' : 'lax' });
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

// ... (rest of routes unchanged) ...
// For brevity, everything after /me remains the same as your original file
// including validation schemas, /api/customers, /api/orders, /api/segments,
// /api/campaigns, /api/communication-log, receipts processor, etc.

// schedule receipts batch
setInterval(processReceiptsBatch, 30 * 1000);
console.log('Receipts batch processor scheduled (every 30s).');

// start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Backend server listening on port ${PORT}`);
});