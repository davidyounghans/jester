const crypto = require('crypto');

const API = 'https://api.elections.kalshi.com/trade-api/v2';
const KEY = process.env.KALSHI_ACCESS_KEY;
const PRIV = process.env.KALSHI_PRIVATE_KEY;
const query = process.argv[2]?.toLowerCase() || '';

if (!KEY || !PRIV) {
  console.error('Missing KALSHI_ACCESS_KEY or KALSHI_PRIVATE_KEY');
  process.exit(1);
}

function sign(path, method, body = '') {
  const ts = Date.now().toString();
  const payload = `${ts}${method}${path}${body}`;
  const sig = crypto.createSign('RSA-SHA256')
    .update(payload).end()
    .sign({ key: PRIV, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
    .toString('base64');
  return { ts, sig };
}

(async () => {
  const path = '/events?league=NBA&status=open';
  const { ts, sig } = sign(path, 'GET');
  const res = await fetch(API + path, {
    headers: {
      'KALSHI-ACCESS-KEY': KEY,
      'KALSHI-ACCESS-SIGNATURE': sig,
      'KALSHI-ACCESS-TIMESTAMP': ts
    }
  });
  const data = await res.json();
  const events = data.events || [];
  const hits = query
    ? events.filter(e =>
        (e.title || '').toLowerCase().includes(query) ||
        (e.event_ticker || '').toLowerCase().includes(query))
    : events;
  if (!hits.length) {
    console.log('No matching events.');
    return;
  }
  hits.forEach(e => console.log(`${e.event_ticker}  —  ${e.title}`));
})();
