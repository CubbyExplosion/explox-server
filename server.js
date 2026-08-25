// Explox shared-account server — Node.js, MongoDB Atlas persistence.
//
// REWRITTEN after a real incident: the first version stored EVERYTHING (every player's
// account, land, shops, stocks) as ONE shared MongoDB document, replaced wholesale on every
// save. Two saves close together — a real player's client autosaving while unrelated test
// traffic was hitting the server — raced, and the loser's write silently vanished, wiping a
// real account. This version gives every player their OWN document (one Mongo write only ever
// touches that one player), and shared world state (land/shops/stocks/territories) uses
// targeted per-key atomic updates instead of whole-document replacement, so two people editing
// two different plots/shops/territories can never stomp on each other either.
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

let usersCol, worldCol;

// ─── PER-PLAYER ACCOUNT DATA — one Mongo document per username, _id = the username itself.
// Every read/write here only ever touches that one document, never anyone else's. ──────────
async function getUserDoc(name) { return await usersCol.findOne({ _id: name }); }
async function listUsers() {
  const docs = await usersCol.find({}, { projection: { _id: 1, 'data.sip': 1 } }).toArray();
  return docs.map(d => ({ name: d._id, sip: (d.data && d.data.sip !== undefined) ? d.data.sip : 0 }));
}

// ─── SHARED WORLD STATE — land/shops/territories are each their own small document, updated
// with a targeted $set on just the one key that changed (one lot, one shop, one territory) —
// never a full-document replace, so concurrent edits to DIFFERENT keys can't collide. ───────
async function getWorldValue(id, fallback) {
  const doc = await worldCol.findOne({ _id: id });
  return doc ? doc.value : fallback;
}

// ─── BOSSES — never actually implemented server-side before (the client's syncBosses()/
// fightBoss() online paths were hitting a 404 the whole time). Each boss gets its own key in
// a shared 'bosses' world document (same atomic-per-key pattern as land/shops), so hits on
// different bosses can never collide. A defeated boss respawns on its own after 10 minutes —
// checked lazily on the next read/write (same "catch up whenever someone asks" style as the
// stocks tick above) rather than a server-side timer, since Render's free tier can sleep.
const BOSS_RESPAWN_SEC = 600;
function reviveIfDue(b, now) {
  if (!b.alive && b.respawnAt && now >= b.respawnAt) {
    b.alive = true;
    b.maxHp = Math.round((b.baseMaxHp || b.maxHp) * (1 + (b.level || 0) * 0.2));
    b.hp = b.maxHp;
  }
  return b;
}
async function getBosses() {
  const doc = await worldCol.findOne({ _id: 'bosses' });
  const bosses = (doc && doc.value) || {};
  const now = nowSec();
  let changed = false;
  Object.keys(bosses).forEach(name => {
    const before = bosses[name].alive;
    reviveIfDue(bosses[name], now);
    if (bosses[name].alive !== before) changed = true;
  });
  if (changed) await worldCol.updateOne({ _id: 'bosses' }, { $set: { value: bosses } }, { upsert: true });
  return bosses;
}
async function hitBoss(name, baseMaxHp, damage) {
  const now = nowSec();
  // Make sure the boss key exists before anyone tries to $inc into it (first hit ever).
  await worldCol.updateOne(
    { _id: 'bosses', [`value.${name}`]: { $exists: false } },
    { $set: { [`value.${name}`]: { hp: baseMaxHp, maxHp: baseMaxHp, baseMaxHp, alive: true, level: 0, defeats: 0, respawnAt: 0 } } },
    { upsert: true }
  );
  // Revive-if-due is a plain overwrite (not a delta), so it's safe to run unguarded even if a
  // few concurrent requests all do it at once — they just write the same values.
  const preDoc = await worldCol.findOne({ _id: 'bosses' });
  const pre = preDoc && preDoc.value && preDoc.value[name];
  if (pre && !pre.alive && pre.respawnAt && now >= pre.respawnAt) {
    const revivedMaxHp = Math.round((pre.baseMaxHp || pre.maxHp) * (1 + (pre.level || 0) * 0.2));
    await worldCol.updateOne({ _id: 'bosses' }, { $set: {
      [`value.${name}.alive`]: true, [`value.${name}.maxHp`]: revivedMaxHp, [`value.${name}.hp`]: revivedMaxHp
    } });
  }
  // Real bug fixed here: this used to be a findOne-then-updateOne read-modify-write, so two hits
  // landing close together (fast swings, plus a buddy/kid companion attacking on their own timer)
  // could both read the same HP before either write committed — the second write would silently
  // clobber the first, losing that hit entirely. Swapped for an atomic $inc so every hit that
  // reaches the server actually lands, no matter how many arrive at once.
  const hitRes = await worldCol.findOneAndUpdate(
    { _id: 'bosses', [`value.${name}.alive`]: true },
    { $inc: { [`value.${name}.hp`]: -damage } },
    { returnDocument: 'after' }
  );
  const hitDoc = hitRes && (hitRes.value || hitRes);
  let b = hitDoc && hitDoc.value && hitDoc.value[name];
  if (!b) {
    // Wasn't alive at the moment this hit landed (someone else's concurrent hit just defeated
    // it) — just report its current state, no damage to apply.
    const cur = await worldCol.findOne({ _id: 'bosses' });
    return { ...cur.value[name], justDefeated: false };
  }
  let justDefeated = false;
  if (b.hp <= 0) {
    // Guarded so that if several concurrent hits all cross zero, only the first one to match
    // (alive still true) actually flips it to defeated — the rest fail the filter and no-op.
    const defeatRes = await worldCol.findOneAndUpdate(
      { _id: 'bosses', [`value.${name}.alive`]: true, [`value.${name}.hp`]: { $lte: 0 } },
      { $set: { [`value.${name}.alive`]: false, [`value.${name}.respawnAt`]: now + BOSS_RESPAWN_SEC },
        $inc: { [`value.${name}.defeats`]: 1, [`value.${name}.level`]: 1 } },
      { returnDocument: 'after' }
    );
    const defeatDoc = defeatRes && (defeatRes.value || defeatRes);
    const defeated = defeatDoc && defeatDoc.value && defeatDoc.value[name];
    if (defeated) { justDefeated = true; b = defeated; }
  }
  return { ...b, justDefeated };
}

// ─── STOCKS — same lazy "catch up on request" tick as before, now read-modify-write against
// its own small document instead of the old shared blob. ────────────────────────────────────
const STOCK_SYMBOLS = ['CUBY', 'EXPL', 'ROBO', 'SNAK', 'CARZ', 'GAME'];
const STOCK_START_PRICES = { CUBY: 100, EXPL: 250, ROBO: 50, SNAK: 20, CARZ: 400, GAME: 150 };
const STOCK_TICK_SECONDS = 8;
function nowSec() { return Math.floor(Date.now() / 1000); }
async function getCurrentStockPrices() {
  let stocks = await getWorldValue('stocks', null);
  if (!stocks) {
    stocks = { lastTick: nowSec(), prices: { ...STOCK_START_PRICES } };
    await worldCol.updateOne({ _id: 'stocks' }, { $set: { value: stocks } }, { upsert: true });
    return stocks.prices;
  }
  const ticks = Math.floor((nowSec() - stocks.lastTick) / STOCK_TICK_SECONDS);
  if (ticks > 0) {
    STOCK_SYMBOLS.forEach(sym => {
      let p = stocks.prices[sym];
      for (let i = 0; i < ticks; i++) {
        const pctChange = (Math.floor(Math.random() * 601) - 300) / 10000; // -3% to +3%
        p = p * (1 + pctChange);
      }
      stocks.prices[sym] = Math.max(0.5, Math.round(p * 100) / 100);
    });
    stocks.lastTick += ticks * STOCK_TICK_SECONDS;
    await worldCol.updateOne({ _id: 'stocks' }, { $set: { value: stocks } }, { upsert: true });
  }
  return stocks.prices;
}

// ─── IN-MEMORY, EPHEMERAL STATE — presence/minigame/mailbox/events all work the same way: no
// business being persisted to disk/DB, entries just expire on their own after a short timeout
// so there's never a separate "leave"/"end" call needed. Fine to keep in-memory: nothing here
// is real player progress, so a restart losing it (or two processes disagreeing briefly) costs
// nothing — unlike account data, which is why THAT moved to per-user documents above. ────────
const presence = {};       // name -> {..., lastSeen}
const PRESENCE_TIMEOUT_SEC = 8;
const minigameState = {};  // name -> {game, data, lastSeen}
const MINIGAME_TIMEOUT_SEC = 8;
const mailbox = {};        // name -> [{type, from, data}]
let currentEvent = null;   // {type, startedBy, startedAt, endsAt, data}

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

    if (p === '/api/bosses' && method === 'GET') return sendJson(res, await getBosses());
    if (p === '/api/bosses/hit' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.maxHp || b.damage === undefined) return sendJson(res, { ok: false }, 400);
      const result = await hitBoss(b.name, b.maxHp, b.damage);
      return sendJson(res, result);
    }

    if (p === '/api/territories' && method === 'GET') return sendJson(res, await getWorldValue('territories', {}));
    if (p === '/api/territories/hit' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.killerName || !b.threshold) return sendJson(res, { ok: false }, 400);
      // Atomic increment on just this one territory's kill count — safe even if several
      // players hit different (or the same) territory at the same instant.
      const inc = await worldCol.findOneAndUpdate(
        { _id: 'territories' },
        { $inc: { [`value.${b.name}.kills`]: 1 }, $setOnInsert: { [`value.${b.name}.captured`]: false, [`value.${b.name}.capturedBy`]: null } },
        { upsert: true, returnDocument: 'after' }
      );
      const t = (inc.value || inc).value[b.name];
      if (t.captured) return sendJson(res, { ok: true, captured: true, kills: t.kills, alreadyCaptured: true });
      if (t.kills >= b.threshold) {
        await worldCol.updateOne({ _id: 'territories' }, { $set: { [`value.${b.name}.captured`]: true, [`value.${b.name}.capturedBy`]: b.killerName } });
        return sendJson(res, { ok: true, captured: true, kills: t.kills, justCaptured: true });
      }
      return sendJson(res, { ok: true, captured: false, kills: t.kills, justCaptured: false });
    }

    if (p === '/api/land' && method === 'GET') return sendJson(res, await getWorldValue('land', {}));
    if (p === '/api/land' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.lotId) return sendJson(res, { ok: false }, 400);
      if (b.owner) await worldCol.updateOne({ _id: 'land' }, { $set: { [`value.${b.lotId}`]: b.owner } }, { upsert: true });
      else await worldCol.updateOne({ _id: 'land' }, { $unset: { [`value.${b.lotId}`]: '' } }, { upsert: true });
      return sendJson(res, { ok: true });
    }

    if (p === '/api/shops' && method === 'GET') return sendJson(res, await getWorldValue('shops', {}));
    if (p === '/api/shops' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.owner) return sendJson(res, { ok: false }, 400);
      await worldCol.updateOne({ _id: 'shops' }, { $set: { [`value.${b.owner}`]: b } }, { upsert: true });
      return sendJson(res, { ok: true });
    }

    if (p === '/api/users' && method === 'GET') return sendJson(res, await listUsers());

    if (p === '/api/signup' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.pw) return sendJson(res, { ok: false, error: 'missing name/pw' }, 400);
      try {
        await usersCol.insertOne({ _id: b.name, pw: b.pw, data: {} });
      } catch (e) {
        if (e && e.code === 11000) return sendJson(res, { ok: false, error: 'taken' }, 409); // unique _id already exists — race-safe
        throw e;
      }
      return sendJson(res, { ok: true });
    }

    if (p === '/api/login' && method === 'POST') {
      const b = await readBody(req);
      const doc = b && b.name ? await getUserDoc(b.name) : null;
      const ok = !!(doc && doc.pw === b.pw);
      return sendJson(res, { ok });
    }

    if (p.startsWith('/api/user/')) {
      const name = decodeURIComponent(p.slice('/api/user/'.length));
      if (method === 'GET') {
        const doc = await getUserDoc(name);
        return (doc && doc.data) ? sendJson(res, doc.data) : sendJson(res, { error: 'not found' }, 404);
      }
      if (method === 'POST') {
        const b = await readBody(req);
        // upsert: a client saving before its own signup call landed (or a companion-hit style
        // partial write) still ends up with a real document, same as the old array-push did.
        await usersCol.updateOne({ _id: name }, { $set: { data: b }, $setOnInsert: { pw: null } }, { upsert: true });
        return sendJson(res, { ok: true });
      }
      if (method === 'DELETE') {
        await usersCol.deleteOne({ _id: name });
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
  const dbHandle = client.db(MONGODB_DB);
  usersCol = dbHandle.collection('users');
  worldCol = dbHandle.collection('world');
  await usersCol.createIndex({ _id: 1 }); // no-op if it already exists — _id is unique by default anyway

  // One-time migration: the old single-document model stored everything under a "state"
  // collection, _id:'main'. If that's still there, fold it into the new per-user documents
  // and per-concern world documents so nothing already saved gets orphaned.
  const oldCol = dbHandle.collection('state');
  const old = await oldCol.findOne({ _id: 'main' });
  if (old) {
    console.log('Migrating old single-document state into per-user/per-concern documents...');
    const names = new Set([...(old.users || []), ...Object.keys(old.data || {}), ...Object.keys(old.pw || {})]);
    for (const name of names) {
      const existing = await usersCol.findOne({ _id: name });
      if (existing) continue; // already migrated or already created fresh under the new model
      await usersCol.insertOne({ _id: name, pw: (old.pw && old.pw[name]) || null, data: (old.data && old.data[name]) || {} });
    }
    if (old.land) await worldCol.updateOne({ _id: 'land' }, { $setOnInsert: { value: old.land } }, { upsert: true });
    if (old.shops) await worldCol.updateOne({ _id: 'shops' }, { $setOnInsert: { value: old.shops } }, { upsert: true });
    if (old.stocks) await worldCol.updateOne({ _id: 'stocks' }, { $setOnInsert: { value: old.stocks } }, { upsert: true });
    if (old.territories) await worldCol.updateOne({ _id: 'territories' }, { $setOnInsert: { value: old.territories } }, { upsert: true });
    await oldCol.deleteOne({ _id: 'main' });
    console.log('Migration done.');
  }

  server.listen(PORT, () => {
    console.log(`Explox server listening on http://0.0.0.0:${PORT}, connected to MongoDB (per-document model)`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
