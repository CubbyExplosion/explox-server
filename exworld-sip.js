// Exworld ad reward: clicking the ad in Exworld gives a one-time code worth 100 S.I.P. in Explox.
// The player types the code and the NAME of any Explox account on the ad's popup, and the server adds 100 S.I.P. to that account
// the same way the Explox shop does (a pending grant that the Explox game claims). No passwords are used or sent.
//
// Limits: one code per device per day, and a few per internet address per day, so it cannot be farmed.
const crypto = require('crypto');

module.exports = function createExworldSip(deps) {
  const { sendJson, getStore, setStore, userByName, grant } = deps;
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', SIP = 100, IP_PER_DAY = 5;
  const code6 = () => { let s = ''; for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)]; return s; };
  const today = () => new Date().toISOString().slice(0, 10);
  const ipDay = new Map();   // ip -> { day, n }
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => { }); return p; };
  function readJson(req, max) {
    return new Promise((resolve) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > max) { resolve(null); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  return async function handle(req, res, p, method) {
    if (!p.startsWith('/api/exworld/sip/')) return false;
    const route = p.slice('/api/exworld/sip/'.length);
    if (method !== 'POST') return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
    const b = await readJson(req, 2048) || {};

    // the ad was clicked: make today's code for this device
    if (route === 'code') {
      const dev = String(b.device || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 40); if (dev.length < 8) return sendJson(res, { ok: false, error: 'bad request' }, 400), true;
      const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim(), day = today();
      const out = await serial(async () => {
        const days = (await getStore('exworld_sipdays', {})) || {}, codes = (await getStore('exworld_sipcodes', {})) || {};
        const rec = days[dev]; if (rec && rec.day === day) return { ok: false, error: 'You already got today\'s 100 S.I.P. code. Come back tomorrow!', code: codes[rec.code] && !codes[rec.code].used ? rec.code : null };
        const q = ipDay.get(ip); if (q && q.day === day && q.n >= IP_PER_DAY) return { ok: false, error: 'Too many codes from this connection today. Try again tomorrow.' };
        ipDay.set(ip, { day, n: (q && q.day === day ? q.n : 0) + 1 }); if (ipDay.size > 5000) ipDay.clear();
        const code = 'SIP-' + code6() + '-' + code6(); codes[code] = { sip: SIP, used: false, made: Date.now() }; days[dev] = { day, code };
        const keys = Object.keys(days); if (keys.length > 20000) keys.slice(0, 5000).forEach((k) => { delete days[k]; });
        await setStore('exworld_sipcodes', codes); await setStore('exworld_sipdays', days);
        return { ok: true, code, sip: SIP };
      });
      return sendJson(res, out, out.ok ? 200 : 429), true;
    }

    // send the code's S.I.P. to an Explox account
    if (route === 'redeem') {
      const code = String(b.code || '').trim().toUpperCase().slice(0, 40), name = String(b.name || '').trim().slice(0, 40);
      if (!code || !name) return sendJson(res, { ok: false, error: 'Type the code and the account name.' }, 400), true;
      const out = await serial(async () => {
        const codes = (await getStore('exworld_sipcodes', {})) || {}, e = codes[code];
        if (!e) return { ok: false, error: 'That code is not valid.' };
        if (e.used) return { ok: false, error: 'That code was already used.' };
        const user = await userByName(name); if (!user) return { ok: false, error: 'No Explox account has that name. Check the spelling (capital letters count).' };
        e.used = true; e.usedAt = Date.now(); e.to = user; await setStore('exworld_sipcodes', codes);
        await grant(user, e.sip);
        return { ok: true, sip: e.sip, name: user };
      });
      return sendJson(res, out, out.ok ? 200 : 400), true;
    }
    return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
  };
};
