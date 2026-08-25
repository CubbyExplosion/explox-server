// Explox shared-account server — Node.js port of Explox-Server.ps1, meant to run
// permanently on a real host instead of a family PC + temporary tunnel. Same API,
// same behavior — persistence now lives in MongoDB Atlas (a free, real database)
// instead of a local JSON file, since a host like Render doesn't keep local disk
// contents around between restarts/deploys.
const http = require('http');
const url = require('url');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 4501;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'explox';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI environment variable — set it in Render (or your host) to your Atlas connection string.');
  process.exit(1);
}

let db; // in-memory mirror of the one persisted document
let stateCollection;

function defaultDb() {
  return { users: [], pw: {}, data: {}, land: {}, shops: {}, stocks: { lastTick: 0, prices: {} }, territories: {} };
}

async function loadDb() {
  const existing = await stateCollection.findOne({ _id: 'main' });
  if (existing) {
    delete existing._id;
    return existing;
  }
  const fresh = defaultDb();
  await stateCollection.insertOne({ _id: 'main', ...fresh });
  return fresh;
}

async function saveDb() {
  await stateCollection.replaceOne({ _id: 'main' }, { _id: 'main', ...db }, { upsert: true });
}

// ─── STOCKS — same lazy "catch up on request" tick as the PowerShell version ──
const STOCK_SYMBOLS = ['CUBY', 'EXPL', 'ROBO', 'SNAK', 'CARZ', 'GAME'];
const STOCK_START_PRICES = { CUBY: 100, EXPL: 250, ROBO: 50, SNAK: 20, CARZ: 400, GAME: 150 };
const STOCK_TICK_SECONDS = 8;
function nowSec() { return Math.floor(Date.now() / 1000); }
async function getCurrentStockPrices() {
  if (db.stocks.lastTick === 0) {
    STOCK_SYMBOLS.forEach(sym => { db.stocks.prices[sym] = STOCK_START_PRICES[sym]; });
    db.stocks.lastTick = nowSec();
    await saveDb();
  }
  const ticks = Math.floor((nowSec() - db.stocks.lastTick) / STOCK_TICK_SECONDS);
  if (ticks > 0) {
    STOCK_SYMBOLS.forEach(sym => {
      let p = db.stocks.prices[sym];
      for (let i = 0; i < ticks; i++) {
        const pctChange = (Math.floor(Math.random() * 601) - 300) / 10000; // -3% to +3%
        p = p * (1 + pctChange);
      }
      db.stocks.prices[sym] = Math.max(0.5, Math.round(p * 100) / 100);
    });
    db.stocks.lastTick += ticks * STOCK_TICK_SECONDS;
    await saveDb();
  }
  return db.stocks.prices;
}

// ─── IN-MEMORY, EPHEMERAL STATE — presence/minigame/mailbox/events all work the
// same way: no business being persisted to disk, entries just expire on their own
// after a short timeout so there's never a separate "leave"/"end" call needed ────
const presence = {};       // name -> {..., lastSeen}
const PRESENCE_TIMEOUT_SEC = 8;
const minigameState = {};  // name -> {game, data, lastSeen}
const MINIGAME_TIMEOUT_SEC = 8;
const mailbox = {};        // name -> [{type, from, data}]

// ─── WORLD EVENTS — one shared event active at a time, anyone online can trigger
// one from the new Events board; everyone polling /api/event sees the same thing.
// In-memory like presence (a restart just means whatever was happening quietly
// stops - no real progress is at stake for a temporary world event).
let currentEvent = null; // {type, startedBy, startedAt, endsAt, data}

function pruneStale(obj, timeoutSec) {
  const now = nowSec();
  Object.keys(obj).forEach(k => { if (now - obj[k].lastSeen > timeoutSec) delete obj[k]; });
}

function sendJson(res, obj, status) {
  const json = JSON.stringify(obj);
  res.writeHead(status || 200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => { chunks += c; });
    req.on('end', () => {
      if (!chunks.trim()) return resolve(null);
      try { resolve(JSON.parse(chunks)); } catch (e) { resolve(null); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const p = parsed.pathname;
    const q = parsed.query;
    const method = req.method;

    if (method === 'OPTIONS') return sendJson(res, {}, 204);

    if (p === '/api/health' && method === 'GET') return sendJson(res, { ok: true });

    if (p === '/api/minigame' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.game) return sendJson(res, { ok: false }, 400);
      minigameState[b.name] = { game: b.game, data: b.data, lastSeen: nowSec() };
      return sendJson(res, { ok: true });
    }
    if (p === '/api/minigame' && method === 'GET') {
      pruneStale(minigameState, MINIGAME_TIMEOUT_SEC);
      const gameFilter = q.game, exclude = q.exclude;
      const list = Object.keys(minigameState)
        .filter(name => name !== exclude && (!gameFilter || minigameState[name].game === gameFilter))
        .map(name => ({ name, game: minigameState[name].game, data: minigameState[name].data }));
      return sendJson(res, list);
    }

    if (p === '/api/mailbox' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.to || !b.from || !b.type) return sendJson(res, { ok: false }, 400);
      if (!mailbox[b.to]) mailbox[b.to] = [];
      mailbox[b.to].push({ type: b.type, from: b.from, data: b.data });
      return sendJson(res, { ok: true });
    }
    if (p === '/api/mailbox' && method === 'GET') {
      const forName = q.for;
      const msgs = (forName && mailbox[forName]) || [];
      if (forName) mailbox[forName] = [];
      return sendJson(res, msgs);
    }

    if (p === '/api/presence' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name) return sendJson(res, { ok: false }, 400);
      presence[b.name] = Object.assign({}, b, { lastSeen: nowSec() });
      return sendJson(res, { ok: true });
    }
    if (p === '/api/presence' && method === 'GET') {
      pruneStale(presence, PRESENCE_TIMEOUT_SEC);
      const exclude = q.exclude;
      const list = Object.values(presence).filter(v => v.name !== exclude);
      return sendJson(res, list);
    }

    // World events: POST starts one (only if none is currently active or the
    // active one has expired); GET returns the current one, or null.
    if (p === '/api/event' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.type || !b.startedBy || !b.durationSec) return sendJson(res, { ok: false }, 400);
      const now = nowSec();
      if (currentEvent && currentEvent.endsAt > now) {
        return sendJson(res, { ok: false, error: 'event_active', event: currentEvent }, 409);
      }
      currentEvent = { type: b.type, startedBy: b.startedBy, startedAt: now, endsAt: now + b.durationSec, data: b.data || {} };
      return sendJson(res, { ok: true, event: currentEvent });
    }
    if (p === '/api/event' && method === 'GET') {
      if (currentEvent && currentEvent.endsAt <= nowSec()) currentEvent = null;
      return sendJson(res, currentEvent);
    }

    if (p === '/api/stocks' && method === 'GET') return sendJson(res, await getCurrentStockPrices());

    if (p === '/api/territories' && method === 'GET') return sendJson(res, db.territories);
    // A real kill at a territory - increments its kill count, captures it for real
    // (permanently) once the count reaches the CLIENT-supplied threshold (the
    // client owns the territory's difficulty config, the server just tracks/
    // enforces the count). Safe to call again after capture - no-op, no double-pay.
    if (p === '/api/territories/hit' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.killerName || !b.threshold) return sendJson(res, { ok: false }, 400);
      if (!db.territories[b.name]) db.territories[b.name] = { captured: false, kills: 0, capturedBy: null };
      const t = db.territories[b.name];
      if (t.captured) return sendJson(res, { ok: true, captured: true, kills: t.kills, alreadyCaptured: true });
      t.kills += 1;
      let justCaptured = false;
      if (t.kills >= b.threshold) { t.captured = true; t.capturedBy = b.killerName; justCaptured = true; }
      await saveDb();
      return sendJson(res, { ok: true, captured: t.captured, kills: t.kills, justCaptured });
    }

    if (p === '/api/land' && method === 'GET') return sendJson(res, db.land);
    if (p === '/api/land' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.lotId) return sendJson(res, { ok: false }, 400);
      if (b.owner) db.land[b.lotId] = b.owner; else delete db.land[b.lotId];
      await saveDb();
      return sendJson(res, { ok: true });
    }

    if (p === '/api/shops' && method === 'GET') return sendJson(res, db.shops);
    if (p === '/api/shops' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.owner) return sendJson(res, { ok: false }, 400);
      db.shops[b.owner] = b;
      await saveDb();
      return sendJson(res, { ok: true });
    }

    if (p === '/api/users' && method === 'GET') {
      const list = db.users.map(name => {
        const d = db.data[name];
        return { name, sip: (d && d.sip !== undefined) ? d.sip : 0 };
      });
      return sendJson(res, list);
    }

    if (p === '/api/signup' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.pw) return sendJson(res, { ok: false, error: 'missing name/pw' }, 400);
      if (db.users.includes(b.name)) return sendJson(res, { ok: false, error: 'taken' }, 409);
      db.users.push(b.name);
      db.pw[b.name] = b.pw;
      await saveDb();
      return sendJson(res, { ok: true });
    }

    if (p === '/api/login' && method === 'POST') {
      const b = await readBody(req);
      const ok = !!(b && db.pw[b.name] && db.pw[b.name] === b.pw);
      return sendJson(res, { ok });
    }

    if (p.startsWith('/api/user/')) {
      const name = decodeURIComponent(p.slice('/api/user/'.length));
      if (method === 'GET') {
        const d = db.data[name];
        return d ? sendJson(res, d) : sendJson(res, { error: 'not found' }, 404);
      }
      if (method === 'POST') {
        const b = await readBody(req);
        db.data[name] = b;
        if (!db.users.includes(name)) db.users.push(name);
        await saveDb();
        return sendJson(res, { ok: true });
      }
      if (method === 'DELETE') {
        db.users = db.users.filter(u => u !== name);
        delete db.pw[name];
        delete db.data[name];
        await saveDb();
        return sendJson(res, { ok: true });
      }
    }

    sendJson(res, { error: 'not found' }, 404);
  } catch (e) {
    try { sendJson(res, { error: e.message }, 500); } catch (e2) {}
  }
});

async function start() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  stateCollection = client.db(MONGODB_DB).collection('state');
  db = await loadDb();
  if (!db.land) db.land = {};
  if (!db.shops) db.shops = {};
  if (!db.stocks) db.stocks = { lastTick: 0, prices: {} };
  if (!db.territories) db.territories = {};

  server.listen(PORT, () => {
    console.log(`Explox server listening on http://0.0.0.0:${PORT}, connected to MongoDB`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
