
# Xeno Internship Assignment

## Architecture
![Architecture](./architecture.png)

- **Backend**: Node.js + Express + Passport (Google OAuth)
- **Frontend**: React (Vite)
- **Storage**: JSON files (customers, orders, segments, campaigns, logs)
- **Queues**: Bull + Redis for pub-sub ingestion
- **AI**: OpenAI API (with fallback to canned suggestions)

## Features
- Google OAuth authentication
- Customer & Order ingestion (via Bull queue)
- Segment creation with flexible rules and preview
- Campaign creation & sending (90% success simulation)
- Delivery receipt endpoint + batch processor
- AI-driven message suggestions (rate-limited)
- Postman collection included (`Xeno.postman_collection.json`)

## Environment Variables
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
- `SESSION_SECRET`
- `OPENAI_API_KEY` (optional)
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `REDIS_HOST`, `REDIS_PORT` (for Bull)

## Deployment
- **Backend**: Render (Node service)
- **Frontend**: Vercel (set VITE_BACKEND_URL)
- OAuth redirect URIs must match deployment

## Demo Script
1. Login with Google
2. Add customer + order
3. Create segment with rule
4. Preview & save segment
5. Create campaign, use AI Suggest Message
6. Send campaign (simulate)
7. View communication logs
8. Vendor posts receipts → batch consumer updates logs
9. Logout



## Final patches added
- Delivery receipt endpoint `/api/delivery-receipt` + receipts batch processor (runs every 30s).
- Async ingestion using Bull + Redis for `/api/customers` and `/api/orders` (falls back to sync if Redis not configured).
- Protected GET /api/campaigns and GET /api/segments with authentication (ensureAuth).
- Postman collection at `campaign-app.postman_collection.json`.

Note: To use queues you must run Redis and set REDIS_URL or run Redis locally on default port.
