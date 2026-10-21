// Exworld shop: ExIP packs and the multiplayer server pass, paid with Stripe Checkout.
//
// The shop is OFF until the environment variable EXWORLD_SHOP is set to the word on (a parent does this on Render after testing).
// Keys: this file never contains a key. It uses the `stripe` object that server.js builds from the environment
// variable STRIPE_SECRET_KEY. With a test key (sk_test_...) nothing real is charged; a parent switches to live by
// putting the live key into the host's environment settings (Render), with no code changes.
//
// Flow: the game asks /checkout for a Stripe Checkout page, the player pays there, Stripe sends them back to the
// game with ?exs=<session id>, and the game calls /claim. /claim asks Stripe whether that session really was paid,
// then makes a one-time code (ExIP pack) or a server pass (subscription). It does not need a webhook.
// Fixed packs, no random prizes.
const crypto = require('crypto');

module.exports = function createExworldPay(deps) {
  const { sendJson, getStore, setStore } = deps;
  const stripe = () => deps.getStripe();   // looked up on every call, so the key can arrive after start-up

  const PRODUCTS = {
    exip100: { name: '100 ExIP', cents: 300, kind: 'exip', amount: 100 },
    exip1000: { name: '1,000 ExIP', cents: 500, kind: 'exip', amount: 1000 },
    exip100000: { name: '100,000 ExIP', cents: 1000, kind: 'exip', amount: 100000 },
    mp_pass: { name: 'Multiplayer server pass (monthly)', cents: 1999, kind: 'pass' },
  };
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code6 = () => { let s = ''; for (let i = 0; i < 6; i++) s += A[crypto.randomInt(A.length)]; return s; };

  let chain = Promise.resolve();   // one change to the stored codes at a time
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => { }); return p; };

  function readJson(req, max) {
    return new Promise((resolve) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > max) { resolve(null); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
  const periodEnd = (sub) => { const t = sub && (sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end)); return t ? t * 1000 : 0; };

  // keep a pass in step with its subscription: each paid month pushes the end date on
  async function refreshPass(entry) {
    const st = stripe(); if (!st || !entry || !entry.sub) return;
    try {
      const sub = await st.subscriptions.retrieve(entry.sub);
      if (['active', 'trialing', 'past_due'].includes(sub.status)) { const end = periodEnd(sub); if (end > (entry.expires || 0)) entry.expires = end; }
    } catch (e) { /* if Stripe cannot be reached, keep the dates we already have */ }
  }

  async function handle(req, res, p, method, q) {
    if (!p.startsWith('/api/exworld/pay/')) return false;
    const route = p.slice('/api/exworld/pay/'.length), st = process.env.EXWORLD_SHOP === 'on' ? stripe() : null;   // the shop stays closed until a parent sets EXWORLD_SHOP=on

    if (route === 'config' && method === 'GET') {
      const key = process.env.EXWORLD_STRIPE_KEY || process.env.STRIPE_SECRET_KEY || '';
      return sendJson(res, { ok: true, enabled: !!st, test: key.startsWith('sk_test_'), products: Object.keys(PRODUCTS).map((id) => ({ id, name: PRODUCTS[id].name, cents: PRODUCTS[id].cents, kind: PRODUCTS[id].kind, amount: PRODUCTS[id].amount || 0 })) }), true;
    }
    if (method !== 'POST') return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
    const b = await readJson(req, 4096) || {};
    if (!st) return sendJson(res, { ok: false, error: 'The shop is not open yet.' }, 503), true;

    // start a payment
    if (route === 'checkout') {
      const prod = PRODUCTS[String(b.product || '')]; if (!prod) return sendJson(res, { ok: false, error: 'unknown product' }, 404), true;
      let base; try { const u = new URL(String(b.returnUrl || '')); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x'); base = u.origin + u.pathname; } catch (e) { return sendJson(res, { ok: false, error: 'bad return address' }, 400), true; }
      try {
        const item = { price_data: { currency: 'usd', product_data: { name: prod.name }, unit_amount: prod.cents }, quantity: 1 };
        if (prod.kind === 'pass') item.price_data.recurring = { interval: 'month' };
        const common = {
          mode: prod.kind === 'pass' ? 'subscription' : 'payment', line_items: [item], metadata: { exworld: '1', product: String(b.product) },
          managed_payments: { enabled: false },
          success_url: base + '?exs={CHECKOUT_SESSION_ID}', cancel_url: base + '?exs=cancel',
        };
        if (prod.kind === 'pass') common.subscription_data = { metadata: { exworld: '1', product: String(b.product) } };
        let session;
        try { session = await st.checkout.sessions.create(common); }
        catch (e1) {   // some Stripe accounts do not accept managed_payments: try again without it
          if (!/managed_payments/i.test(String(e1.message))) throw e1;
          delete common.managed_payments; session = await st.checkout.sessions.create(common);
        }
        return sendJson(res, { ok: true, url: session.url }), true;
      } catch (e) { console.error('exworld checkout error:', e.message); return sendJson(res, { ok: false, error: 'Could not start the payment: ' + String(e.message || 'unknown error').slice(0, 180) }, 500), true; }
    }

    // the player is back from Stripe: check it was really paid and hand over the code
    if (route === 'claim') {
      const sid = String(b.session || '').trim(); if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) return sendJson(res, { ok: false, error: 'bad session' }, 400), true;
      try {
        const out = await serial(async () => {
          const claims = (await getStore('exworld_claims', {})) || {};
          if (claims[sid]) return { ok: true, ...claims[sid], again: true };
          const session = await st.checkout.sessions.retrieve(sid);
          if (!session || !session.metadata || session.metadata.exworld !== '1') return { ok: false, error: 'That is not an Exworld payment.' };
          if (session.payment_status !== 'paid') return { ok: false, error: 'That payment is not finished yet.' };
          const prod = PRODUCTS[session.metadata.product]; if (!prod) return { ok: false, error: 'unknown product' };
          let res2;
          if (prod.kind === 'exip') {
            const codes = (await getStore('exworld_codes', {})) || {}, code = 'EXIP-' + code6() + '-' + code6();
            codes[code] = { amount: prod.amount, used: false, made: Date.now() }; await setStore('exworld_codes', codes);
            res2 = { kind: 'exip', code, amount: prod.amount };
          } else {
            const passes = (await getStore('exworld_passes', {})) || {}, code = 'EXP-' + code6() + '-' + code6(), subId = typeof session.subscription === 'string' ? session.subscription : (session.subscription && session.subscription.id) || '';
            const entry = { days: 31, expires: Date.now() + 31 * 86400000, sub: subId, note: 'stripe', made: Date.now() }; await refreshPass(entry);
            passes[code] = entry; await setStore('exworld_passes', passes);
            res2 = { kind: 'pass', code, expires: entry.expires };
          }
          claims[sid] = res2; await setStore('exworld_claims', claims);
          return { ok: true, ...res2 };
        });
        return sendJson(res, out, out.ok ? 200 : 402), true;
      } catch (e) { console.error('exworld claim error:', e.message); return sendJson(res, { ok: false, error: 'Could not check that payment.' }, 500), true; }
    }

    // turn an ExIP code into ExIP (works once)
    if (route === 'redeem') {
      const code = String(b.code || '').trim().toUpperCase().slice(0, 40);
      const out = await serial(async () => {
        const codes = (await getStore('exworld_codes', {})) || {}, e = codes[code];
        if (!e) return { ok: false, error: 'That code is not valid.' };
        if (e.used) return { ok: false, error: 'That code was already used.' };
        e.used = true; e.usedAt = Date.now(); await setStore('exworld_codes', codes);
        return { ok: true, amount: e.amount };
      });
      return sendJson(res, out, out.ok ? 200 : 400), true;
    }
    return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
  }
  handle.refreshPass = refreshPass;
  return handle;
};
