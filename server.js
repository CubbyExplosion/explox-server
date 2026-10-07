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
const { MongoClient, ObjectId } = require('mongodb');

const PORT = process.env.PORT || 4501;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'explox';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI environment variable — set it in Render (or your host) to your Atlas connection string.');
  process.exit(1);
}

let usersCol, worldCol, animatorCol, exgunUsersCol, contactCol;

// ─── PER-PLAYER ACCOUNT DATA — one Mongo document per username, _id = the username itself.
// Every read/write here only ever touches that one document, never anyone else's. ──────────
async function getUserDoc(name) { return await usersCol.findOne({ _id: name }); }
async function listUsers() {
  const docs = await usersCol.find({}, { projection: { _id: 1, 'data.sip': 1, signupAt: 1, lastPlayedAt: 1 } }).toArray();
  return docs.map(d => ({
    name: d._id,
    sip: (d.data && d.data.sip !== undefined) ? d.data.sip : 0,
    // User's own ask: "how many people are there in the game this week" — real signup/last-played
    // timestamps (added below, both at /api/signup and the upsert-on-save path) so the client can
    // compute a real "new this week"/"active this week" stat instead of just a running total.
    // Older accounts predate this field entirely — null, not a fabricated date, so the client can
    // tell "we don't know" apart from "signed up a long time ago".
    signupAt: d.signupAt || null,
    lastPlayedAt: d.lastPlayedAt || null,
  }));
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

// ─── LEADERBOARD — for the Records tab: "who has the most" across every real account, not
// just your own personal peak. Same field names saveCurrentUser() in game.js writes into each
// user's `data` document. Scale here is tiny (a handful of real accounts), so a plain scan on
// every request is fine — no caching, same tradeoff listUsers() above already makes. ──────────
const LEADERBOARD_STATS = [
  { key: 'peakSip',              extract: d => Math.max(d.peakSip || 0, d.sip || 0) },
  { key: 'peakElite',            extract: d => Math.max(d.peakElite || 0, d.eliteCoins || 0) },
  { key: 'eliteLevel',           extract: d => d.eliteLevel || 0 },
  { key: 'totalBossesDefeated',  extract: d => d.totalBossesDefeated || 0 },
  { key: 'totalQuestsCompleted', extract: d => d.totalQuestsCompleted || 0 },
  { key: 'totalContractsCompleted', extract: d => d.totalContractsCompleted || 0 },
  { key: 'playTimeSeconds',      extract: d => d.playTimeSeconds || 0 },
  { key: 'ownedWeapons',         extract: d => (d.ownedWeapons || []).length },
  { key: 'lifetimeRobotKills',   extract: d => d.lifetimeRobotKills || 0 },
  { key: 'lifetimeRogueKills',   extract: d => d.lifetimeRogueKills || 0 },
  { key: 'lifetimeWarHits',      extract: d => d.lifetimeWarHits || 0 },
  { key: 'killerDefeats',        extract: d => d.killerDefeats || 0 },
  { key: 'ffaKills',             extract: d => d.ffaKills || 0 },
  { key: 'ownedCars',            extract: d => (d.ownedCars || []).length },
  { key: 'ownedComputers',       extract: d => (d.ownedComputers || []).length },
  { key: 'ownedFurniture',       extract: d => (d.ownedFurniture || []).length },
  { key: 'ownedSkins',           extract: d => (d.ownedSkins || []).length },
  { key: 'ownedArmor',           extract: d => (d.ownedArmor || []).length },
  { key: 'ownedItems',           extract: d => (d.ownedItems || []).length },
  { key: 'friends',              extract: d => (d.friends || []).length },
  { key: 'children',             extract: d => (d.children || []).length },
  { key: 'ownedStaff',           extract: d => (d.ownedStaff || []).length },
  { key: 'myUploads',            extract: d => (d.myUploads || []).length },
  { key: 'mySubscribers',        extract: d => d.mySubscribers || 0 },
  { key: 'ownedLand',            extract: d => (d.ownedLand || []).length },
  { key: 'buildings',            extract: d => Object.values(d.plotBuildings || {}).reduce((s, arr) => s + (arr ? arr.length : 0), 0) },
  { key: 'storeSalesCount',      extract: d => d.storeSalesCount || 0 },
  { key: 'installedApps',        extract: d => (d.installedApps || []).length },
];
async function getLeaderboard() {
  const docs = await usersCol.find({}, { projection: { _id: 1, data: 1 } }).toArray();
  const result = {};
  LEADERBOARD_STATS.forEach(stat => {
    let best = null;
    for (const doc of docs) {
      const value = stat.extract(doc.data || {});
      if (value > 0 && (!best || value > best.value)) best = { holder: doc._id, value };
    }
    result[stat.key] = best || { holder: null, value: 0 };
  });
  return result;
}

// ─── REAL-MONEY PAYMENTS — Stripe. Every price is looked up SERVER-SIDE from the tables below
// (never trusted from the client), so nobody can tamper with what they're charged. One-time
// purchases (currency bundles, item unlocks, the VIP discount) use Checkout in 'payment' mode;
// vehicle rentals use 'subscription' mode, billed weekly until cancelled — cancel anytime and it
// just stops renewing, no separate "end rental" call needed. Grants land in a SEPARATE
// `entitlements` field on the user document, never inside `data` — `data` gets wholesale-
// replaced by the client's normal save (POST /api/user/:name), so writing a grant directly into
// `data` would risk a save landing moments later and silently overwriting it, the exact race
// this codebase already got burned by once (see the file-header comment). `entitlements` is
// server/webhook-owned only; the client only ever reads it, it never writes it back wholesale.
const Stripe = require('stripe');
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// One-time purchases — prices mirror CURRENCY_SHOP_PACKAGES (game-alignment.js) exactly; keep
// the two in sync if a price ever changes there. sip/elite credit directly (per the user's own
// rule documented alongside that catalog: real money in, currency in the wallet immediately —
// never routed through the Earnings-tab collectible-delay system real gameplay rewards use).
const ONE_TIME_PRODUCTS = {
  sip100:       { cents: 500,  name: '100 S.I.P.',         grant: { sip: 100 } },
  sip500:       { cents: 800,  name: '500 S.I.P.',         grant: { sip: 500 } },
  sip1000:      { cents: 1000, name: '1,000 S.I.P.',       grant: { sip: 1000 } },
  sip5000:      { cents: 1500, name: '5,000 S.I.P.',       grant: { sip: 5000 } },
  sip10000:     { cents: 2000, name: '10,000 S.I.P.',      grant: { sip: 10000 } },
  sip25000:     { cents: 2100, name: '25,000 S.I.P.',      grant: { sip: 25000 } },
  sip50000:     { cents: 2200, name: '50,000 S.I.P.',      grant: { sip: 50000 } },
  sip100000:    { cents: 2500, name: '100,000 S.I.P.',     grant: { sip: 100000 } },
  sip1000000:   { cents: 3500, name: '1,000,000 S.I.P.',   grant: { sip: 1000000 } },
  elite100:     { cents: 500,  name: '100 Elite Coins',    grant: { elite: 100 } },
  elite500:     { cents: 800,  name: '500 Elite Coins',    grant: { elite: 500 } },
  elite1000:    { cents: 1000, name: '1,000 Elite Coins',  grant: { elite: 1000 } },
  elite5000:    { cents: 1500, name: '5,000 Elite Coins',  grant: { elite: 5000 } },
  elite25000:   { cents: 2000, name: '25,000 Elite Coins', grant: { elite: 25000 } },
  elite50000:   { cents: 2500, name: '50,000 Elite Coins', grant: { elite: 50000 } },
  elite100000:  { cents: 3500, name: '100,000 Elite Coins',grant: { elite: 100000 } },
  elite1000000: { cents: 4500, name: '1,000,000 Elite Coins', grant: { elite: 1000000 } },
  starter:      { cents: 800,  name: 'Starter Pack',       grant: { sip: 1000, elite: 100 } },
  vip:          { cents: 2500, name: 'VIP Package',        grant: { sip: 100000, elite: 5000 } },
  vip_discount: { cents: 500,  name: 'VIP Discount',       grant: { discountPct: 20 } },
  mega:         { cents: 6000, name: 'Mega Bundle',        grant: { sip: 2000000, elite: 2000000 } },
  super_tank:       { cents: 1000, name: 'Super Tank',       grant: { item: 'super_tank' } },
  super_armor:      { cents: 1000, name: 'Super Armor',      grant: { item: 'super_armor' } },
  super_jet:        { cents: 1500, name: 'Super Jet',        grant: { item: 'super_jet' } },
  super_motorcycle: { cents: 800,  name: 'Super Motorcycle', grant: { item: 'super_motorcycle' } },
  future_jet:       { cents: 199,  name: 'Future Jet',       grant: { item: 'future_jet' } },
  super_package:    { cents: 3500, name: 'Super Package',    grant: { sip: 10000, elite: 1000, items: ['super_tank','super_jet','super_motorcycle'] } },
};

// Mirrors game-admin.js's own ADMIN_ACCOUNTS exactly (case-insensitive compare, same reasoning:
// the real account is stored capitalized). Used ONLY to gate /api/checkout/create-custom-session
// below — every other endpoint in this file already just trusts whatever name the client sends
// (this whole server has no real login-session/token system), but that endpoint mints a Stripe
// session for an ARBITRARY amount, so without this check anyone who found the URL could hit it
// directly and check out for $0.01 while asking to be granted any sip/elite amount they typed in.
const ADMIN_ACCOUNTS = ['cubby explosion', 'gurnaldst'];
function isAdminName(name) { return ADMIN_ACCOUNTS.includes(String(name || '').trim().toLowerCase()); }

// The admin NAMES above are public (they ship in the game's own client code), so a name check on
// its own can't tell a real admin from anyone typing that name into a hand-made request. The
// custom-session endpoint therefore ALSO needs a shared secret that only exists as a server
// environment variable (ADMIN_CHECKOUT_SECRET, set in the host's dashboard — never in the repo or
// the client bundle). Fails CLOSED: with no secret configured, the endpoint refuses everyone.
const ADMIN_CHECKOUT_SECRET = process.env.ADMIN_CHECKOUT_SECRET || '';
function isAdminRequest(b) {
  if (!ADMIN_CHECKOUT_SECRET || !isAdminName(b.adminName) || typeof b.adminSecret !== 'string') return false;
  const crypto = require('crypto');
  const a = Buffer.from(b.adminSecret), s = Buffer.from(ADMIN_CHECKOUT_SECRET);
  return a.length === s.length && crypto.timingSafeEqual(a, s);
}

// Weekly rentals — new alongside the one-time unlocks above: cheaper, temporary access to the
// same vehicles, billed weekly until cancelled. "Active" just means "this subscription is
// currently live", tracked via subscriptionId + updated by the webhook below when it's created
// or cancelled — no hand-rolled expiry timer to keep in sync with Stripe's own billing clock.
const RENTAL_PRODUCTS = {
  rent_super_tank:       { cents: 300, name: 'Super Tank (weekly rental)',       vehicle: 'super_tank' },
  rent_super_jet:        { cents: 400, name: 'Super Jet (weekly rental)',        vehicle: 'super_jet' },
  rent_super_motorcycle: { cents: 250, name: 'Super Motorcycle (weekly rental)', vehicle: 'super_motorcycle' },
  rent_future_jet:       { cents: 350, name: 'Future Jet (weekly rental)',       vehicle: 'future_jet' },
};

async function getEntitlements(name) {
  const doc = await usersCol.findOne({ _id: name }, { projection: { entitlements: 1 } });
  return (doc && doc.entitlements) || { pendingGrants: [], unlockedItems: [], discountPct: 0, rentals: {} };
}
async function applyOneTimeGrant(name, grant) {
  const update = { $push: { 'entitlements.pendingGrants': { sip: grant.sip || 0, elite: grant.elite || 0, ts: Date.now(), claimed: false } } };
  if (grant.discountPct) update.$set = { 'entitlements.discountPct': grant.discountPct };
  const items = grant.items || (grant.item ? [grant.item] : []);
  if (items.length) update.$addToSet = { 'entitlements.unlockedItems': { $each: items } };
  await usersCol.updateOne({ _id: name }, update, { upsert: true });
}
async function setRentalActive(name, vehicle, subscriptionId, active) {
  await usersCol.updateOne(
    { _id: name },
    { $set: { [`entitlements.rentals.${vehicle}`]: { active, subscriptionId } } },
    { upsert: true }
  );
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
// Exgun's own presence table — deliberately separate from `presence` above (different game,
// different account namespace) and keyed the same way, but filtered by mapId on read since a
// player only ever needs to see the ~dozen other people on their OWN one of the 100 maps, not
// everyone online across all of them.
const exgunPresence = {};  // name -> {..., mapId, lastSeen}
const EXGUN_PRESENCE_TIMEOUT_SEC = 8;
const minigameState = {};  // name -> {game, data, lastSeen}
const MINIGAME_TIMEOUT_SEC = 8;
const mailbox = {};        // name -> [{type, from, data}]
let currentEvent = null;   // {type, startedBy, startedAt, endsAt, data}

// ─── CHAT — user's own ask: messages shouldn't disappear for everyone just because Render's
// free instance spun down from inactivity and restarted. Originally an in-memory array like the
// ephemeral state above, but that meant a routine restart silently wiped the whole conversation
// out from under every player, which reads as "messages disappearing" with no obvious cause.
// Persisted the same way land/shops/stocks are (worldCol, one shared document), so it survives
// restarts exactly like real account data does — the ONLY thing that resets it now is the
// CHAT_HISTORY_MAX cap below trimming the oldest messages, never a server restart.
const CHAT_HISTORY_MAX = 100; // caps storage growth on a long-running server; old messages just fall off the end
const CHAT_TEXT_MAX = 10000; // user's own ask — raised from 200
async function addChatMessage(from, text) {
  const msg = { from, text: String(text).slice(0, CHAT_TEXT_MAX), ts: Date.now() };
  // $push + $slice is one atomic operation — keeps only the last CHAT_HISTORY_MAX messages with
  // no separate read-modify-write step, so two messages landing at the same instant can't race.
  await worldCol.updateOne(
    { _id: 'chat' },
    { $push: { value: { $each: [msg], $slice: -CHAT_HISTORY_MAX } } },
    { upsert: true }
  );
}
async function getChatMessages(sinceTs) {
  const doc = await worldCol.findOne({ _id: 'chat' });
  return ((doc && doc.value) || []).filter(m => m.ts > sinceTs);
}

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

// ── CONTACT INBOX (the owner's website: messages + photos from visitors) ─────────────────────────
// Visitors can only SEND (POST /api/contact). Nobody can read anything except the owner, who unlocks the inbox with the secret
// CONTACT_OWNER_KEY (set it in the host's environment variables — never in the repo). Reading/deleting uses POST so the key
// never appears in a URL or a log line. Photos arrive as small base64 images (the website shrinks them first) and are validated here.
const CONTACT_OWNER_KEY = process.env.CONTACT_OWNER_KEY || '';
const contactHits = {};   // ip -> [timestamps]
function contactBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0, chunks = [], dead = false;
    req.on('data', c => { size += c.length; if (size > maxBytes) { dead = true; resolve(null); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (dead) return; try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}
function contactOwnerOk(key) {
  if (!CONTACT_OWNER_KEY || typeof key !== 'string') return false;
  const a = Buffer.from(key), s = Buffer.from(CONTACT_OWNER_KEY);
  return a.length === s.length && require('crypto').timingSafeEqual(a, s);
}
function contactRateOk(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(), list = (contactHits[ip] || []).filter(t => now - t < 3600000);
  if (list.length >= 6) { contactHits[ip] = list; return false; }
  list.push(now); contactHits[ip] = list;
  if (Object.keys(contactHits).length > 5000) Object.keys(contactHits).forEach(k => { if (!contactHits[k].some(t => now - t < 3600000)) delete contactHits[k]; });
  return true;
}
const CONTACT_PHOTO_RE = /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/;

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

    if (p === '/api/contact' && method === 'POST') {                       // a visitor sends the owner a message (+ up to 3 photos)
      if (!contactCol) return sendJson(res, { ok: false, error: 'not ready' }, 503);
      if (!contactRateOk(req)) return sendJson(res, { ok: false, error: 'Too many messages — try again later.' }, 429);
      const b = await contactBody(req, 5 * 1024 * 1024);
      if (!b) return sendJson(res, { ok: false, error: 'Bad or too-large message.' }, 400);
      const message = String(b.message || '').trim().slice(0, 2000);
      if (!message) return sendJson(res, { ok: false, error: 'Write a message first.' }, 400);
      const photos = (Array.isArray(b.photos) ? b.photos : []).slice(0, 3);
      if (photos.some(ph => typeof ph !== 'string' || ph.length > 1500000 || !CONTACT_PHOTO_RE.test(ph))) return sendJson(res, { ok: false, error: 'A photo was not valid or was too big.' }, 400);
      // 'ticket' is an unguessable private code the sender keeps, so they (and only they) can read the owner's replies to THIS message
      const ticket = require('crypto').randomBytes(12).toString('hex');
      await contactCol.insertOne({ at: Date.now(), name: String(b.name || '').trim().slice(0, 60), reply: String(b.reply || '').trim().slice(0, 120), message, photos, ticket, replies: [] });
      return sendJson(res, { ok: true, ticket });
    }
    if (p === '/api/contact/replies' && method === 'POST') {               // a sender checks the replies to their own messages
      const b = await contactBody(req, 4096);
      const tickets = b && Array.isArray(b.tickets) ? b.tickets.filter(t => typeof t === 'string' && /^[a-f0-9]{24}$/.test(t)).slice(0, 10) : [];
      if (!tickets.length) return sendJson(res, { ok: true, threads: [] });
      const rows = await contactCol.find({ ticket: { $in: tickets } }).toArray();
      return sendJson(res, { ok: true, threads: rows.map(r => ({ ticket: r.ticket, at: r.at, message: String(r.message).slice(0, 300), replies: r.replies || [] })) });
    }
    if (p === '/api/contact/reply' && method === 'POST') {                 // owner only: answer a message
      const b = await contactBody(req, 8192);
      if (!b || !contactOwnerOk(b.key)) return sendJson(res, { ok: false, error: 'Wrong key.' }, 403);
      const text = String(b.text || '').trim().slice(0, 2000);
      if (!text) return sendJson(res, { ok: false, error: 'Write a reply first.' }, 400);
      let oid; try { oid = new ObjectId(String(b.id)); } catch (e) { return sendJson(res, { ok: false }, 400); }
      const r = await contactCol.updateOne({ _id: oid }, { $push: { replies: { at: Date.now(), text } } });
      return sendJson(res, { ok: r.matchedCount > 0 });
    }
    if (p === '/api/contact/inbox' && method === 'POST') {                 // owner only
      const b = await contactBody(req, 4096);
      if (!CONTACT_OWNER_KEY) return sendJson(res, { ok: false, error: 'The owner key is not set on the server yet.' }, 503);
      if (!b || !contactOwnerOk(b.key)) return sendJson(res, { ok: false, error: 'Wrong key.' }, 403);
      const rows = await contactCol.find({}).sort({ at: -1 }).limit(200).toArray();
      return sendJson(res, { ok: true, messages: rows.map(r => ({ id: String(r._id), at: r.at, name: r.name, reply: r.reply, message: r.message, photos: r.photos || [], replies: r.replies || [] })) });
    }
    if (p === '/api/contact/delete' && method === 'POST') {                // owner only
      const b = await contactBody(req, 4096);
      if (!b || !contactOwnerOk(b.key)) return sendJson(res, { ok: false, error: 'Wrong key.' }, 403);
      let oid; try { oid = new ObjectId(String(b.id)); } catch (e) { return sendJson(res, { ok: false }, 400); }
      await contactCol.deleteOne({ _id: oid });
      return sendJson(res, { ok: true });
    }

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

    if (p === '/api/chat' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.from || !b.text) return sendJson(res, { ok: false }, 400);
      await addChatMessage(b.from, b.text);
      return sendJson(res, { ok: true });
    }
    if (p === '/api/chat' && method === 'GET') {
      // `since` lets a client only ask for what it hasn't seen yet (its own last-seen timestamp)
      // instead of re-downloading the whole history every poll.
      const since = Number(q.since) || 0;
      return sendJson(res, await getChatMessages(since));
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

    // ─── DEATH DROPS — stretch goal for the client's new death-penalty system (game-social.js's
    // applyDeathLossAndDrop()/spawnDeathDropPile()): lets OTHER real players see and loot a
    // death pile too ("finders keepers" on someone else's death drop), not just the owner who
    // died. Purely additive — new routes only, same atomic per-key `worldCol` pattern as
    // territories/bosses/land/shops above, nothing existing touched. One shared 'deathDrops'
    // document, keyed by a client-generated dropId so two different piles never collide.
    if (p === '/api/deathdrops' && method === 'GET') return sendJson(res, await getWorldValue('deathDrops', {}));
    if (p === '/api/deathdrops' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.dropId || !b.owner || typeof b.x !== 'number' || typeof b.z !== 'number' || !b.loot) return sendJson(res, { ok: false }, 400);
      await worldCol.updateOne(
        { _id: 'deathDrops' },
        { $set: { [`value.${b.dropId}`]: { owner: b.owner, x: b.x, z: b.z, loot: b.loot, createdAt: Date.now() } } },
        { upsert: true }
      );
      return sendJson(res, { ok: true });
    }
    // Claiming is a real race between however many clients might reach for the same pile at
    // once (the owner walking back to their own drop, or another player finding it first) — a
    // plain read-then-delete would let two people both grab it. findOneAndUpdate's atomic
    // $unset, checked against the BEFORE snapshot, means only the request that actually removed
    // the key gets the loot back; every other request (or a stale/reloaded pile) gets a clean
    // "already claimed" instead of granting the same currency/items twice.
    if (p === '/api/deathdrops/claim' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.dropId) return sendJson(res, { ok: false }, 400);
      const before = await worldCol.findOneAndUpdate(
        { _id: 'deathDrops' },
        { $unset: { [`value.${b.dropId}`]: '' } },
        { returnDocument: 'before' }
      );
      // Same defensive (result.value || result) unwrap as /api/territories/hit above, for the
      // same reason: driver versions differ on whether findOneAndUpdate's result is wrapped.
      const beforeDoc = (before && before.value) ? before.value : before;
      const existed = beforeDoc && beforeDoc.value && beforeDoc.value[b.dropId];
      if (!existed) return sendJson(res, { ok: false, error: 'already claimed' }, 404);
      return sendJson(res, { ok: true, loot: existed.loot, owner: existed.owner });
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
    if (p === '/api/leaderboard' && method === 'GET') return sendJson(res, await getLeaderboard());

    if (p === '/api/signup' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.pw) return sendJson(res, { ok: false, error: 'missing name/pw' }, 400);
      try {
        const now = Date.now();
        await usersCol.insertOne({ _id: b.name, pw: b.pw, data: {}, signupAt: now, lastPlayedAt: now });
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
        // lastPlayedAt updates on every real save; signupAt only gets set if this save is what
        // actually CREATES the document (an account that reached here without ever calling
        // /api/signup) — an existing account's real original signupAt is never overwritten.
        const now = Date.now();
        await usersCol.updateOne(
          { _id: name },
          { $set: { data: b, lastPlayedAt: now }, $setOnInsert: { pw: null, signupAt: now } },
          { upsert: true }
        );
        return sendJson(res, { ok: true });
      }
      if (method === 'DELETE') {
        await usersCol.deleteOne({ _id: name });
        return sendJson(res, { ok: true });
      }
    }

    // ─── ANIMATOR PROJECTS — its own collection, separate from the main-game `users` doc's
    // `data` blob on purpose: the main game POSTs a full-document replace of `data` on every
    // save, so if the Animator shared that same field, a save from one racing against a save
    // from the other could silently wipe whichever landed second (the exact bug the per-
    // document rewrite above was built to avoid). Keeping animator projects in their own
    // document per user means an Animator save can never collide with a real game save. ─────
    if (p.startsWith('/api/animator/')) {
      const name = decodeURIComponent(p.slice('/api/animator/'.length));
      if (method === 'GET') {
        const doc = await animatorCol.findOne({ _id: name });
        return sendJson(res, (doc && doc.projects) ? doc.projects : {});
      }
      if (method === 'POST') {
        const b = await readBody(req);
        if (!b || typeof b !== 'object') return sendJson(res, { ok: false }, 400);
        await animatorCol.updateOne({ _id: name }, { $set: { projects: b, updatedAt: Date.now() } }, { upsert: true });
        return sendJson(res, { ok: true });
      }
    }

    // ─── EXGUN — a separate RPG, its own account namespace (own collection, own signup/login,
    // never touches `users`/`usersCol` above) so it can never collide with a real Explox account
    // or save. Same per-document-per-player model as the main game for the same reason (one
    // write only ever touches one player's own document), and the same free-form
    // POST-whatever-the-client-sends /api/*/presence pattern as Explox's own `presence` above,
    // just in its own table and filtered by mapId (100 maps; only same-map players matter). ────
    if (p === '/api/exgun/signup' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.pw) return sendJson(res, { ok: false, error: 'missing name/pw' }, 400);
      try {
        await exgunUsersCol.insertOne({ _id: b.name, pw: b.pw, data: {}, signupAt: Date.now() });
      } catch (e) {
        if (e && e.code === 11000) return sendJson(res, { ok: false, error: 'taken' }, 409);
        throw e;
      }
      return sendJson(res, { ok: true });
    }
    if (p === '/api/exgun/login' && method === 'POST') {
      const b = await readBody(req);
      const doc = b && b.name ? await exgunUsersCol.findOne({ _id: b.name }) : null;
      return sendJson(res, { ok: !!(doc && doc.pw === b.pw) });
    }
    if (p.startsWith('/api/exgun/user/')) {
      const name = decodeURIComponent(p.slice('/api/exgun/user/'.length));
      if (method === 'GET') {
        const doc = await exgunUsersCol.findOne({ _id: name });
        return (doc && doc.data) ? sendJson(res, doc.data) : sendJson(res, { error: 'not found' }, 404);
      }
      if (method === 'POST') {
        const b = await readBody(req);
        await exgunUsersCol.updateOne(
          { _id: name },
          { $set: { data: b, lastPlayedAt: Date.now() }, $setOnInsert: { pw: null, signupAt: Date.now() } },
          { upsert: true }
        );
        return sendJson(res, { ok: true });
      }
      if (method === 'DELETE') {
        await exgunUsersCol.deleteOne({ _id: name });
        return sendJson(res, { ok: true });
      }
    }
    if (p === '/api/exgun/presence' && method === 'POST') {
      const b = await readBody(req);
      if (!b || !b.name || !b.mapId) return sendJson(res, { ok: false }, 400);
      exgunPresence[b.name] = Object.assign({}, b, { lastSeen: nowSec() });
      return sendJson(res, { ok: true });
    }
    if (p === '/api/exgun/presence' && method === 'GET') {
      pruneStale(exgunPresence, EXGUN_PRESENCE_TIMEOUT_SEC);
      const exclude = q.exclude, mapId = q.mapId;
      const list = Object.values(exgunPresence).filter(v => v.name !== exclude && (!mapId || v.mapId === mapId));
      return sendJson(res, list);
    }

    if (p === '/api/checkout/create-session' && method === 'POST') {
      if (!stripe) return sendJson(res, { ok: false, error: 'payments not configured yet' }, 503);
      const b = await readBody(req);
      if (!b || !b.name || !b.productId || !b.returnUrl) return sendJson(res, { ok: false, error: 'missing fields' }, 400);
      const oneTime = ONE_TIME_PRODUCTS[b.productId];
      const rental = RENTAL_PRODUCTS[b.productId];
      if (!oneTime && !rental) return sendJson(res, { ok: false, error: 'unknown product' }, 404);
      try {
        const base = b.returnUrl.split('?')[0];
        const lineItem = oneTime
          ? { price_data: { currency: 'usd', product_data: { name: oneTime.name }, unit_amount: oneTime.cents }, quantity: 1 }
          : { price_data: { currency: 'usd', product_data: { name: rental.name }, recurring: { interval: 'week' }, unit_amount: rental.cents }, quantity: 1 };
        // managed_payments explicitly disabled — the account defaults to it, but it charges an
        // extra 3.5% and requires a tax code on every product; the user's own choice ("self-
        // handle" during onboarding, "i dont wanr to pY" the extra fee) was to opt out of it.
        const common = {
          mode: oneTime ? 'payment' : 'subscription',
          line_items: [lineItem],
          metadata: { name: b.name, productId: b.productId },
          managed_payments: { enabled: false },
        };
        if (!oneTime) common.subscription_data = { metadata: { name: b.name, productId: b.productId } };
        // Embedded mode — user's own ask, using the publishable key to mount Stripe's own
        // Checkout UI directly inside the game instead of redirecting to a separate page. Same
        // session/webhook/entitlements plumbing underneath either way; only ui_mode and which of
        // return_url vs success_url+cancel_url differs (embedded has one combined return_url,
        // hosted needs both since Stripe itself does the redirecting there).
        if (b.embedded) {
          common.ui_mode = 'embedded';
          common.return_url = base + '?stripe=success';
        } else {
          common.success_url = base + '?stripe=success';
          common.cancel_url = base + '?stripe=cancel';
        }
        const session = await stripe.checkout.sessions.create(common);
        return sendJson(res, b.embedded ? { ok: true, clientSecret: session.client_secret } : { ok: true, url: session.url });
      } catch (e) {
        console.error('checkout session error:', e.message);
        return sendJson(res, { ok: false, error: 'stripe error' }, 500);
      }
    }

    // Custom Bundle — user's own ask: a real player picks an item + a currency amount + submits
    // an idea, an ADMIN reviews the idea and either rejects it (player gets a flat 10,000 S.I.P.
    // instead, handled entirely client-side via a normal mailbox grant — no server involvement
    // needed for that path) or quotes it a real complication-based price; ONLY the quoted-and-
    // accepted path reaches here. Unlike /api/checkout/create-session above, there's no fixed
    // catalog entry to look up since the total is different for every request — the amount and
    // what to grant both travel in the request body instead, computed client-side by the admin's
    // own console command (adminCreateBundleCheckout(), game-admin.js) from numbers the admin
    // explicitly typed, and isAdminRequest() below (admin name + server-only secret) is the one
    // thing stopping a non-admin from ever reaching this path directly with a self-picked
    // amount/grant.
    if (p === '/api/checkout/create-custom-session' && method === 'POST') {
      if (!stripe) return sendJson(res, { ok: false, error: 'payments not configured yet' }, 503);
      const b = await readBody(req);
      if (!b || !b.name || !b.returnUrl || !Number.isFinite(b.amountCents) || b.amountCents <= 0) return sendJson(res, { ok: false, error: 'missing fields' }, 400);
      if (!isAdminRequest(b)) return sendJson(res, { ok: false, error: 'not authorized' }, 403);
      try {
        const base = b.returnUrl.split('?')[0];
        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: [{ price_data: { currency: 'usd', product_data: { name: b.description || 'Custom Bundle' }, unit_amount: Math.round(b.amountCents) }, quantity: 1 }],
          metadata: { name: b.name, custom: '1', sip: String(b.grantSip || 0), elite: String(b.grantElite || 0), item: b.grantItem || '' },
          managed_payments: { enabled: false },
          success_url: base + '?stripe=success',
          cancel_url: base + '?stripe=cancel',
        });
        return sendJson(res, { ok: true, url: session.url });
      } catch (e) {
        console.error('custom checkout session error:', e.message);
        return sendJson(res, { ok: false, error: 'stripe error' }, 500);
      }
    }

    if (p === '/api/checkout/webhook' && method === 'POST') {
      if (!stripe || !STRIPE_WEBHOOK_SECRET) return sendJson(res, { ok: false }, 503);
      const rawBody = await readRawBody(req);
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
      } catch (e) {
        console.error('Webhook signature verification failed:', e.message);
        return sendJson(res, { error: 'bad signature' }, 400);
      }
      try {
        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const name = session.metadata && session.metadata.name;
          const productId = session.metadata && session.metadata.productId;
          const oneTime = productId && ONE_TIME_PRODUCTS[productId];
          const rental = productId && RENTAL_PRODUCTS[productId];
          if (session.metadata && session.metadata.custom === '1') {
            // Custom Bundle checkout (create-custom-session above) — grant exactly what the
            // admin's own quote baked into the session's metadata at creation time, same
            // applyOneTimeGrant() every other one-time purchase already uses.
            if (name) await applyOneTimeGrant(name, {
              sip: Number(session.metadata.sip) || 0,
              elite: Number(session.metadata.elite) || 0,
              item: session.metadata.item || undefined,
            });
          } else if (name && oneTime) await applyOneTimeGrant(name, oneTime.grant);
          else if (name && rental) await setRentalActive(name, rental.vehicle, session.subscription, true);
        } else if (event.type === 'customer.subscription.deleted') {
          const sub = event.data.object;
          const name = sub.metadata && sub.metadata.name;
          const productId = sub.metadata && sub.metadata.productId;
          const rental = productId && RENTAL_PRODUCTS[productId];
          if (name && rental) await setRentalActive(name, rental.vehicle, sub.id, false);
        }
      } catch (e) {
        console.error('Webhook handling error:', e.message);
      }
      return sendJson(res, { received: true });
    }

    if (p.startsWith('/api/entitlements/')) {
      const parts = p.slice('/api/entitlements/'.length).split('/');
      const name = decodeURIComponent(parts[0]);
      const isClaim = parts[1] === 'claim';
      if (method === 'GET' && !isClaim) return sendJson(res, await getEntitlements(name));
      if (method === 'POST' && isClaim) {
        const doc = await usersCol.findOne({ _id: name }, { projection: { entitlements: 1 } });
        const grants = (doc && doc.entitlements && doc.entitlements.pendingGrants) || [];
        const toClaim = grants.filter(g => !g.claimed);
        if (toClaim.length) {
          await usersCol.updateOne({ _id: name }, { $set: { 'entitlements.pendingGrants': grants.map(g => ({ ...g, claimed: true })) } });
        }
        return sendJson(res, { claimed: toClaim });
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
  animatorCol = dbHandle.collection('animator_projects');
  exgunUsersCol = dbHandle.collection('exgun_users');
  contactCol = dbHandle.collection('contact_messages');
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
