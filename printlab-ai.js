// Print Lab chat helper: a kid-safe AI tutor for the Print Lab page.
// It stays CLOSED until a parent sets two environment variables on the host (Render):
//   PRINTLAB_AI_ON=on          turns it on
//   PRINTLAB_AI_KEY=...        the secret key of the AI service (never put it in code or on a web page)
// Optional: PRINTLAB_AI_MODEL (default below), PRINTLAB_AI_DAILY (most chats per day for everybody, default 400),
// PRINTLAB_AI_PER_HOUR (most chats per internet address per hour, default 30).
// Using the AI service costs real money (a few cents per chat), which is why the limits exist and why a parent turns it on.
module.exports = function createPrintlabAi(deps) {
  const { sendJson } = deps;
  const MODEL_DEFAULT = 'claude-haiku-5-5';
  const SYSTEM = [
    'You are Print Lab Helper, a friendly teacher and brainstorming buddy for a young person who loves games and 3D printing.',
    'Explain things simply and accurately, in short answers (usually under 150 words), with a little fun. Use examples about games, blocks, tanks and inventions when they help.',
    'You help with 3D printing, designing models, game ideas, maths, science, reading and learning in general. Brainstorm ("imagine") with them by asking one question at a time and building on their ideas.',
    'If you are not sure about a fact, say so. Never invent facts, numbers, links or sources.',
    'Keep everything family-friendly. Do not discuss sexual or romantic content, drugs, gambling, or real violence and gore; kindly say you cannot help with that and offer a safe idea instead.',
    'Safety first: for hot printers, tools, chemicals, electricity or anything risky, tell them to have an adult with them.',
    'Never ask for or accept personal information (real name, age, school, address, phone, email, photos, passwords or keys). If they share some, tell them not to share it and to tell a parent. If anyone online is pressuring them or asking them to keep secrets, tell them to stop replying and tell a parent straight away.',
    'Never help with spending money or signing up for accounts; say a parent must do that.',
  ].join(' ');
  const perIp = new Map(); let day = '', dayCount = 0;
  const today = () => new Date().toISOString().slice(0, 10);
  function readJson(req, max) {
    return new Promise((resolve) => {
      let n = 0; const parts = [];
      req.on('data', (c) => { n += c.length; if (n > max) { resolve(null); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }
  const enabled = () => process.env.PRINTLAB_AI_ON === 'on' && !!process.env.PRINTLAB_AI_KEY;

  return async function handle(req, res, p, method) {
    if (!p.startsWith('/api/printlab/')) return false;
    const route = p.slice('/api/printlab/'.length);
    if (route === 'status' && method === 'GET') return sendJson(res, { ok: true, enabled: enabled() }), true;
    if (route !== 'chat' || method !== 'POST') return sendJson(res, { ok: false, error: 'unknown route' }, 404), true;
    if (!enabled()) return sendJson(res, { ok: false, error: 'The chat helper is not turned on yet.' }, 503), true;
    const b = await readJson(req, 16000);
    let msgs = b && Array.isArray(b.messages) ? b.messages.slice(-10) : null;
    if (!msgs || !msgs.length) return sendJson(res, { ok: false, error: 'Type a question first.' }, 400), true;
    msgs = msgs.map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 1000) })).filter((m) => m.content.trim());
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return sendJson(res, { ok: false, error: 'Type a question first.' }, 400), true;
    // limits: per internet address per hour, and a daily cap for everybody (keeps the bill small)
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim(), now = Date.now(), hourCap = Number(process.env.PRINTLAB_AI_PER_HOUR) || 30, dayCap = Number(process.env.PRINTLAB_AI_DAILY) || 400;
    if (day !== today()) { day = today(); dayCount = 0; }
    if (dayCount >= dayCap) return sendJson(res, { ok: false, error: 'The helper is resting for today. Try again tomorrow!' }, 429), true;
    const q = (perIp.get(ip) || []).filter((t) => now - t < 3600000); if (q.length >= hourCap) return sendJson(res, { ok: false, error: 'You asked a lot of questions! Take a break and try again in a while.' }, 429), true;
    q.push(now); perIp.set(ip, q); if (perIp.size > 5000) perIp.clear(); dayCount++;
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.PRINTLAB_AI_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: process.env.PRINTLAB_AI_MODEL || MODEL_DEFAULT, max_tokens: 500, system: SYSTEM, messages: msgs }) });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j || !Array.isArray(j.content)) { console.error('printlab-ai error status', r.status); return sendJson(res, { ok: false, error: 'The helper could not answer right now. Try again in a moment.' }, 502), true; }
      const text = j.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim().slice(0, 3000);
      return sendJson(res, { ok: true, reply: text || 'Hmm, I do not have an answer for that. Can you ask it another way?' }), true;
    } catch (e) { console.error('printlab-ai fetch failed:', e.message); return sendJson(res, { ok: false, error: 'The helper could not answer right now. Try again in a moment.' }, 502), true; }
  };
};
