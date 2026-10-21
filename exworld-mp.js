// Exworld multiplayer rooms. No extra packages: players send with POST and listen with server-sent events.
//
// Two modes:
//  1. HOST a server (paid, $19.99 a month): needs a server pass. Passes are made by the owner with the
//     admin secret (env EXWORLD_ADMIN_SECRET), so no payment processor is built in; the owner hands out a pass
//     after being paid. A pass starts its clock on first use and lasts `days` days (30 by default).
//  2. JOIN a friend's server (free): the host switches "allow friends" on and shares the room code.
//
// Rooms live in memory (they vanish if the server restarts; the host's game re-creates them). Only passes are stored.
const crypto = require('crypto');

module.exports = function createExworldMp(deps) {
  const { sendJson, getStore, setStore } = deps;
  const rooms = new Map();
  const MAX_PLAYERS = 8, MAX_EDITS = 300000, HOST_AWAY_MS = 3 * 60 * 1000, IDLE_MS = 15 * 60 * 1000;
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code6 = () => { let s = ''; for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)]; return s; };
  const hex = (n) => crypto.randomBytes(n).toString('hex');
  const clean = (t, n) => String(t == null ? '' : t).replace(/[^\w .\-']/g, '').trim().slice(0, n);
  const num = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
  const same = (a, b) => { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b); };

  function readJson(req, max) {
    return new Promise((resolve) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > max) { resolve(null); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
  const sse = (res, ev, data) => { try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n'); } catch (e) { } };
  const publicPlayers = (r) => [...r.players.entries()].map(([pid, p]) => ({ pid, name: p.name }));
  function broadcast(r, ev, data, exceptPid) { r.players.forEach((p, pid) => { if (p.res && pid !== exceptPid) sse(p.res, ev, data); }); }
  function closeRoom(r, why) { broadcast(r, 'closed', { why }); r.players.forEach((p) => { try { p.res && p.res.end(); } catch (e) { } }); rooms.delete(r.id); }
  const authPlayer = (r, pid, token) => { const p = r && r.players.get(String(pid)); return p && same(p.token, token) ? p : null; };

  async function passes() { return (await getStore('exworld_passes', {})) || {}; }

  setInterval(() => {   // 10 times a second: tell everyone where everyone is
    const now = Date.now();
    rooms.forEach((r) => {
      const snap = {}; let n = 0;
      r.players.forEach((p, pid) => { if (p.pos) { snap[pid] = p.pos; n++; } });
      if (n) broadcast(r, 'p', snap);
    });
    if (Math.floor(now / 100) % 100 === 0) rooms.forEach((r) => r.players.forEach((p) => { if (p.res) { try { p.res.write(': ka\n\n'); } catch (e) { } } }));
  }, 100);
  setInterval(() => {   // every 20 seconds: close rooms whose pass ran out, or that nobody is using
    const now = Date.now();
    rooms.forEach((r) => {
      const host = r.players.get(r.hostPid);
      if (r.expires && now > r.expires) return closeRoom(r, 'The server pass ran out');
      if (!host || !host.res) { if (now - r.hostGone > HOST_AWAY_MS) closeRoom(r, 'The host left'); }
      if (now - r.last > IDLE_MS) closeRoom(r, 'Nobody was here for a while');
    });
  }, 20000);

  return async function handle(req, res, p, method, q) {
    if (!p.startsWith('/api/exworld/mp/')) return false;
    const route = p.slice('/api/exworld/mp/'.length);

    // owner only: make server passes
    if (route === 'pass' && method === 'POST') {
      const secret = process.env.EXWORLD_ADMIN_SECRET || '';
      const b = await readJson(req, 4096);
      if (!secret || !b || !same(b.adminSecret, secret)) return sendJson(res, { ok: false, error: 'not allowed' }, 403), true;
      const days = Math.max(1, Math.min(366, Math.floor(+b.days) || 30)), count = Math.max(1, Math.min(20, Math.floor(+b.count) || 1)), db = await passes(), made = [];
      for (let i = 0; i < count; i++) { const code = 'EXP-' + code6() + '-' + code6(); db[code] = { days, expires: null, note: clean(b.note, 40), made: Date.now() }; made.push(code); }
      await setStore('exworld_passes', db);
      return sendJson(res, { ok: true, days, passes: made }), true;
    }

    // host a server (needs a pass)
    if (route === 'host' && method === 'POST') {
      const b = await readJson(req, 4096); if (!b) return sendJson(res, { ok: false, error: 'bad request' }, 400), true;
      const pass = String(b.pass || '').trim().toUpperCase().slice(0, 40), db = await passes(), e = db[pass];
      if (!e) return sendJson(res, { ok: false, error: 'That server pass is not valid.' }, 403), true;
      if (e.sub && deps.refreshPass) { const before = e.expires; await deps.refreshPass(e); if (e.expires !== before) await setStore('exworld_passes', db); }
      const now = Date.now(); if (!e.expires) { e.expires = now + e.days * 86400000; await setStore('exworld_passes', db); }
      if (now > e.expires) return sendJson(res, { ok: false, error: 'That server pass has run out. Get a new one to keep hosting.' }, 403), true;
      rooms.forEach((r) => { if (r.pass === pass) closeRoom(r, 'The host started a new server'); });
      let id; do { id = code6(); } while (rooms.has(id));
      const w = b.world || {}, hostPid = 'p' + hex(3), token = hex(16);
      const room = { id, pass, expires: e.expires, open: false, name: clean(b.name, 20) || 'Host', world: { seed: Math.floor(num(w.seed, -2147483648, 2147483647)), wt: clean(w.wt, 20) || 'normal', size: Math.floor(num(w.size, 16, 1e9)), mode: w.mode === 'survival' ? 'survival' : 'creative', time: num(w.time, 0, 240) }, edits: new Map(), players: new Map(), hostPid, hostGone: now, last: now };
      room.players.set(hostPid, { name: room.name, token, res: null, pos: null, seen: now });
      rooms.set(id, room);
      return sendJson(res, { ok: true, room: id, pid: hostPid, token, expires: e.expires, max: MAX_PLAYERS }), true;
    }

    const r = rooms.get(String(q.room || '').toUpperCase());

    // is this room open for friends?
    if (route === 'status' && method === 'GET') {
      if (!r) return sendJson(res, { ok: true, exists: false }), true;
      return sendJson(res, { ok: true, exists: true, open: r.open, host: r.name, players: r.players.size, max: MAX_PLAYERS }), true;
    }

    const b = method === 'POST' ? await readJson(req, route === 'send' ? 600000 : 4096) : null;
    const rid = String((b && b.room) || q.room || '').toUpperCase(), room = rooms.get(rid);

    if (route === 'open' && method === 'POST') {   // the host decides if friends may join
      const hp = room && b && authPlayer(room, b.pid, b.token); if (!hp || b.pid !== room.hostPid) return sendJson(res, { ok: false }, 403), true;
      room.open = !!b.open; room.last = Date.now(); broadcast(room, 'open', { open: room.open });
      return sendJson(res, { ok: true, open: room.open }), true;
    }

    // a friend joins for free (only if the host allows it)
    if (route === 'join' && method === 'POST') {
      if (!room) return sendJson(res, { ok: false, error: 'No server with that code.' }, 404), true;
      if (!room.open) return sendJson(res, { ok: false, error: 'That server is not open to friends right now.' }, 403), true;
      if (room.players.size >= MAX_PLAYERS) return sendJson(res, { ok: false, error: 'That server is full.' }, 403), true;
      const pid = 'p' + hex(3), token = hex(16), name = clean(b && b.name, 16) || 'Friend';
      room.players.set(pid, { name, token, res: null, pos: null, seen: Date.now() }); room.last = Date.now();
      const flat = []; room.edits.forEach((id, k) => { const a = k.split(','); flat.push(+a[0], +a[1], +a[2], id); });
      return sendJson(res, { ok: true, pid, token, world: room.world, host: room.name, edits: flat, players: publicPlayers(room) }), true;
    }

    // everybody listens here
    if (route === 'stream' && method === 'GET') {
      const pl = authPlayer(room || r, q.pid, q.token); const rm = room || r;
      if (!pl) return sendJson(res, { ok: false }, 403), true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' });
      if (pl.res) { try { pl.res.end(); } catch (e) { } }
      pl.res = res; pl.seen = Date.now(); if (q.pid === rm.hostPid) rm.hostGone = 1e18;
      sse(res, 'hello', { players: publicPlayers(rm), open: rm.open });
      broadcast(rm, 'join', { pid: q.pid, name: pl.name }, q.pid);
      req.on('close', () => {
        if (pl.res !== res) return; pl.res = null;
        if (q.pid === rm.hostPid) rm.hostGone = Date.now(); else { rm.players.delete(q.pid); broadcast(rm, 'leave', { pid: q.pid }); }
      });
      return true;
    }

    // positions, block changes and chat come in here
    if (route === 'send' && method === 'POST') {
      const pl = b && authPlayer(room, b.pid, b.token); if (!pl) return sendJson(res, { ok: false }, 403), true;
      room.last = Date.now();
      if (Array.isArray(b.pos) && b.pos.length >= 5) pl.pos = [num(b.pos[0], -1e7, 1e7), num(b.pos[1], -1e3, 1e4), num(b.pos[2], -1e7, 1e7), num(b.pos[3], -10, 10), num(b.pos[4], -2, 2), pl.name, clean(b.skin, 12)];
      if (Array.isArray(b.edits) && b.edits.length) {
        const out = [];
        for (const e of b.edits.slice(0, 3000)) { if (!Array.isArray(e) || e.length < 4) continue; const x = Math.floor(num(e[0], -1e7, 1e7)), y = Math.floor(num(e[1], -1e3, 1e4)), z = Math.floor(num(e[2], -1e7, 1e7)), id = Math.floor(num(e[3], 0, 60000)); if (room.edits.size < MAX_EDITS || room.edits.has(x + ',' + y + ',' + z)) { room.edits.set(x + ',' + y + ',' + z, id); out.push([x, y, z, id]); } }
        if (out.length) broadcast(room, 'e', out, b.pid);
      }
      if (b.chat) { const t = clean(b.chat, 200); if (t) broadcast(room, 'c', { name: pl.name, t }); }
      return sendJson(res, { ok: true }), true;
    }

    if (route === 'leave' && method === 'POST') {
      const pl = room && b && authPlayer(room, b.pid, b.token); if (!pl) return sendJson(res, { ok: true }), true;
      if (b.pid === room.hostPid) closeRoom(room, 'The host closed the server'); else { room.players.delete(b.pid); broadcast(room, 'leave', { pid: b.pid }); }
      return sendJson(res, { ok: true }), true;
    }
    return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
  };
};
