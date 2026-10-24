// Merch orders: pick a design, type a name to print on it, and pay with Stripe Checkout.
// Price = the item's base price + $5 for every LETTER of the name. The price is worked out HERE on the server, never trusted from the page.
// Stripe collects the delivery address and keeps the order (design, name, size) in the payment's details, so the seller can see every order in the Stripe dashboard.
// Like the rest of the shop it stays closed until EXWORLD_SHOP is set to "on", and it uses whatever Stripe key the server has (test or live).
module.exports = function createMerch(deps) {
  const { sendJson, getStripe } = deps;
  const ITEMS = { shirt: { label: 'T-shirt', cents: 2500 }, sticker: { label: 'Sticker', cents: 500 } };   // base prices: change them here
  const LETTER_CENTS = 500, MAX_LETTERS = 12, STICKER_ADDON_CENTS = 300;   // a shirt buyer can add the matching sticker for $3 (it is $5 alone)
  const BASES = [['cubby_shirt', 'Cubby Explosion shirt', 'shirt'], ['explox_shirt_1_character', 'Explox character shirt', 'shirt'], ['explox_shirt_2_vehicle', 'Explox vehicle shirt', 'shirt'], ['exgun_shirt_1_tank', 'EXGUN tank shirt', 'shirt'], ['sip_shirt_logo', 'S.I.P. logo shirt', 'shirt'], ['rich_shirt', 'RICH shirt', 'shirt'], ['death_shirt', 'DEATH shirt', 'shirt'],
    ['cubby_sticker', 'Cubby Explosion sticker', 'sticker'], ['rich_sticker', 'RICH sticker', 'sticker'], ['death_sticker', 'DEATH sticker', 'sticker'], ['explox_sticker_1_character', 'Explox character sticker', 'sticker'], ['explox_sticker_2_vehicle', 'Explox vehicle sticker', 'sticker'], ['exgun_sticker_1_tank', 'EXGUN tank sticker', 'sticker'], ['sip_sticker_logo', 'S.I.P. logo sticker', 'sticker']];
  const DESIGNS = {};   // every design comes in a dark and a light version
  ['dark', 'light'].forEach((m) => BASES.forEach((x) => { DESIGNS[x[0] + '_' + m] = [x[1] + ' (' + m + ')' + (x[0] === 'cubby_shirt' ? ', back says CUBBY EXPLOSION' : ''), x[2]]; }));

  const SIZES = ['S', 'M', 'L', 'XL'];
  const BAD = /(fuck|shit|bitch|cunt|dick|cock|pussy|asshole|bastard|nazi|hitler|rape|sex|porn|nigg|fag|slut|whore|kill|penis|vagina|boob|drug|weed)/i;
  function readJson(req, max) {
    return new Promise((resolve) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > max) { resolve(null); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
  const letters = (name) => String(name || '').replace(/[^A-Za-z]/g, '').length;
  function cleanName(raw) {   // letters and single spaces only, upper case
    const n = String(raw || '').toUpperCase().replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').trim();
    if (!n) return { ok: true, name: '' };
    if (letters(n) > MAX_LETTERS) return { ok: false, error: 'Names can have up to ' + MAX_LETTERS + ' letters.' };
    if (BAD.test(n.replace(/ /g, ''))) return { ok: false, error: 'That name cannot be printed. Please pick another.' };
    return { ok: true, name: n };
  }
  const price = (design, name) => ITEMS[DESIGNS[design][1]].cents + LETTER_CENTS * letters(name);

  return async function handle(req, res, p, method) {
    if (!p.startsWith('/api/merch/')) return false;
    const route = p.slice('/api/merch/'.length), on = process.env.EXWORLD_SHOP === 'on', st = on ? getStripe() : null;
    if (route === 'config' && method === 'GET') {
      return sendJson(res, { ok: true, enabled: !!st, test: String(process.env.EXWORLD_STRIPE_KEY || process.env.STRIPE_SECRET_KEY || '').startsWith('sk_test_'), letterCents: LETTER_CENTS, maxLetters: MAX_LETTERS, sizes: SIZES, items: ITEMS, designs: Object.keys(DESIGNS).map((k) => ({ id: k, label: DESIGNS[k][0], type: DESIGNS[k][1] })) }), true;
    }
    if (route === 'checkout' && method === 'POST') {
      if (!st) return sendJson(res, { ok: false, error: 'The merch shop is not open yet.' }, 503), true;
      const b = await readJson(req, 4096) || {}, design = String(b.design || '');
      if (!DESIGNS[design]) return sendJson(res, { ok: false, error: 'Pick a design first.' }, 400), true;
      const nm = cleanName(b.name); if (!nm.ok) return sendJson(res, { ok: false, error: nm.error }, 400), true;
      const type = DESIGNS[design][1], size = type === 'shirt' ? (SIZES.includes(String(b.size)) ? String(b.size) : null) : 'n/a';
      if (!size) return sendJson(res, { ok: false, error: 'Pick a size.' }, 400), true;
      let base; try { const u = new URL(String(b.returnUrl || '')); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x'); base = u.origin + u.pathname; } catch (e) { return sendJson(res, { ok: false, error: 'bad return address' }, 400), true; }
      const addSt = type === 'shirt' && b.addSticker === true, cents = price(design, nm.name) + (addSt ? STICKER_ADDON_CENTS : 0), title = DESIGNS[design][0] + (nm.name ? ' with the name ' + nm.name : '') + (addSt ? ' + matching sticker' : '');
      try {
        const session = await st.checkout.sessions.create({
          mode: 'payment', payment_method_types: ['card'], managed_payments: { enabled: false },
          line_items: [{ price_data: { currency: 'usd', product_data: { name: title }, unit_amount: cents }, quantity: 1 }],
          shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU'] },
          metadata: { merch: '1', design, name: nm.name, size, letters: String(letters(nm.name)), sticker: addSt ? 'yes' : 'no' },
          success_url: base + '?paid=1', cancel_url: base + '?cancel=1',
        });
        return sendJson(res, { ok: true, url: session.url, cents }), true;
      } catch (e) { console.error('merch checkout error:', e.message); return sendJson(res, { ok: false, error: 'Could not start the payment: ' + String(e.message || '').slice(0, 160) }, 500), true; }
    }
    if (route === 'tip' && method === 'POST') {   // a thank-you gift of $1 to $10; the amount is checked here, never trusted from the page
      if (!st) return sendJson(res, { ok: false, error: 'Tips are not open yet.' }, 503), true;
      const b = await readJson(req, 2048) || {}, dollars = Math.floor(Number(b.dollars));
      if (!(dollars >= 1 && dollars <= 10)) return sendJson(res, { ok: false, error: 'A tip can be from $1 to $10.' }, 400), true;
      let base; try { const u = new URL(String(b.returnUrl || '')); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('x'); base = u.origin + u.pathname; } catch (e) { return sendJson(res, { ok: false, error: 'bad return address' }, 400), true; }
      try {
        const session = await st.checkout.sessions.create({
          mode: 'payment', payment_method_types: ['card'], managed_payments: { enabled: false },
          line_items: [{ price_data: { currency: 'usd', product_data: { name: 'Tip (thank you!)' }, unit_amount: dollars * 100 }, quantity: 1 }],
          metadata: { tip: '1', dollars: String(dollars) },
          success_url: base + '?tip=1', cancel_url: base + '?cancel=1',
        });
        return sendJson(res, { ok: true, url: session.url }), true;
      } catch (e) { console.error('tip error:', e.message); return sendJson(res, { ok: false, error: 'Could not start the tip: ' + String(e.message || '').slice(0, 160) }, 500), true; }
    }
    return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
  };
};
