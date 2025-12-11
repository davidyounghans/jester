const crypto = require("crypto");
const API_BASE = process.env.KALSHI_API_BASE || "https://trading-api.kalshi.com";
const KEY = process.env.KALSHI_ACCESS_KEY;
const PRIV = process.env.KALSHI_PRIVATE_KEY;
if (!KEY || !PRIV) { console.error("Missing env"); process.exit(1); }
const path = "/portfolio/balance";
const url = new URL(path, API_BASE);
const ts = Date.now().toString();
const body = "";
const payload = `${ts}GET${url.pathname}${url.search || ""}${body}`;
const signer = crypto.createSign("RSA-SHA256");
signer.update(payload);
signer.end();
const sig = signer.sign({ key: PRIV, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString("base64");
fetch(url, {
  method: "GET",
  headers: {
    "KALSHI-ACCESS-KEY": KEY,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "KALSHI-ACCESS-TIMESTAMP": ts
  }
}).then(async (res) => {
  const text = await res.text();
  console.log("status", res.status);
  console.log(text.slice(0, 500));
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
