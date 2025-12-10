# Jester

Ultra-lightweight realtime signal app for two phones:

1. **Control** page (Phone 1) with Home/Away buttons.
2. **Display** page (Phone 2) that flashes `HOME` or `AWAY` instantly.

Low latency is achieved with a dedicated WebSocket relay that both browsers connect to over the public internet, so the phones do not need to share a network.

## Project layout

```
.
├── public/            # Static assets for both phone experiences
│   ├── control.html   # Phone 1 (buttons)
│   └── display.html   # Phone 2 (big flashing screen)
├── src/
│   └── server.ts      # WebSocket relay
├── package.json
└── tsconfig.json
```

## Prerequisites

- Node.js 18+ (needed to run the relay and build TypeScript)

## Local development

1. Install dependencies.

   ```bash
   npm install
   ```

2. Start the relay.

   ```bash
   npm run dev
   ```

   The server listens on `PORT` (defaults to `8080`) and exposes a `/health` endpoint for simple uptime checks.

3. Serve the static files (any static server works). Example:

   ```bash
   npx serve public
   ```

4. Open `http://localhost:3000/control.html` on Phone 1 and `http://localhost:3000/display.html` on Phone 2.
   - Paste the WebSocket URL for the relay (e.g. `ws://YOUR_IP:8080`) into both pages. The control page shows the number of displays that are online and automatically disables buttons while disconnected.

## Kalshi betting module

The backend can optionally relay button presses into Kalshi trades so only the server (not the phone browsers) is visible to Kalshi.

### Credentials

Set the following env vars (locally or via Fly secrets) before starting the relay:

| Variable | Purpose |
| --- | --- |
| `KALSHI_ACCESS_KEY` | API key ID registered with Kalshi |
| `KALSHI_PRIVATE_KEY` | PEM string for the RSA private key paired with that API key |
| `KALSHI_API_BASE` *(optional)* | Override API host (defaults to `https://trading-api.kalshi.com`) |
| `KALSHI_CONFIG_PATH` *(optional)* | File that stores module settings (`kalshi.config.json` by default) |

Each API request is signed (RSA-PSS) using the private key, so Kalshi only sees calls from this module.

### Config UI

1. Deploy/serve `public/config.html` just like the other static pages.
2. Paste the relay URL (e.g. `https://jester.fly.dev`) into the top field and load settings.
3. Provide the league code (e.g. `NBA`), the team names you want to see in the UI, and their Kalshi codes (e.g. `DEN`, `LAL`). Set the bet unit size.
4. Toggle **Enable trading module** and save. Settings persist on the relay host (in `kalshi.config.json` unless you override the path).
5. Use **Test mode** to dry-run: when checked, trades are not sent to Kalshi. Logged requests appear in the Test Events box, so you can confirm the derived tickers before flipping test mode off.

During runtime, pressing **Home** or **Away** still updates the display instantly; additionally the server derives the moneyline ticker from the stored league/team codes and submits a limit order (50¢ bid) for that contract/quantity. Cancel actions never place trades. If credentials or metadata are missing, the module logs the issue and skips the trade without affecting the display UX.

## Deployment strategy

### 1. Deploy the relay

WebSockets need a server that supports long-lived TCP connections. Vercel is great for the static clients, but its serverless functions are not ideal for raw WebSocket relays, so deploy the relay to a host such as [Fly.io](https://fly.io), [Railway](https://railway.app) or any VPS.

Example Fly.io flow:

```bash
fly launch --name jester-relay --region iad --no-deploy
fly deploy
```

Fly generates a public URL like `https://jester-relay.fly.dev`. Convert this to WebSocket form by replacing the protocol with `wss://` (e.g. `wss://jester-relay.fly.dev`).

Set `PORT` via Fly secrets if you need a non-default port; otherwise the default works.

### 2. Deploy the static pages to Vercel

1. Create a new Vercel project and point it at this repository (or upload a ZIP).
2. Use the **Static Site** framework preset.
3. Set the build output directory to `public`.
4. Once deployed, you will have URLs such as `https://jester-control.vercel.app/control.html` and `/display.html`.

### 3. Wire everything up

1. Open the control page on Phone 1 and enter the WebSocket URL (e.g. `wss://jester-relay.fly.dev`). The value is stored locally so you only need to set it once per device.
2. Open the display page on Phone 2 and paste the same WebSocket URL.
3. Pressing **Home** or **Away** fires an event over the WebSocket relay, instantly updating the display page (no polling or HTTP requests). If the Kalshi module is enabled, the same press also drives moneyline orders.

## Operational notes

- The relay exposes a heartbeat mechanism: disconnected clients are purged automatically to keep the connection set clean.
- WebSocket messages are simple JSON payloads, making it easy to extend (e.g., add “Reset” or “Custom text” actions).
- For redundancy you can run multiple relay instances behind a load balancer; clients reconnect automatically if an instance restarts.
- The Kalshi module is isolated from the browsers; it uses its own credentials so Kalshi only sees the backend’s IP/fingerprint.

## Next steps / enhancements

- Add authentication tokens around the relay if you need to prevent unknown clients from connecting.
- Add audio or vibration cues on the display page for additional emphasis.
- Package the static clients as PWA shortcuts so each phone can launch directly from the home screen.
- Extend the Kalshi module to auto-discover spreads/orderbooks or to stream execution confirmations back to the control UI.
