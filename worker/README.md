# Gearevo BI chatbot — Cloudflare Worker

Backend for the dashboard's chat panel. Runs on Cloudflare Workers (free
tier), not Firebase — see the chat with Claude in the main project history
for why. Holds no Firebase credentials: every request forwards the caller's
own Firebase Auth ID token straight to Firestore's REST API, so the existing
`firestore.rules` allowlist enforces access — nothing to duplicate or keep
in sync here.

## One-time setup

1. Create a free Cloudflare account at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) if you don't have one.
2. Install Wrangler (Cloudflare's CLI) and log in:
   ```bash
   npm install -g wrangler
   wrangler login
   ```
   This opens a browser window to authorize the CLI against your Cloudflare account.
3. From this `worker/` folder, set the Anthropic API key as a secret (never committed to git):
   ```bash
   wrangler secret put ANTHROPIC_API_KEY
   ```
   Paste your key when prompted.
4. Deploy:
   ```bash
   wrangler deploy
   ```
   This prints a URL like `https://gearevo-chatbot.YOUR_SUBDOMAIN.workers.dev`.
5. Copy that URL into `public/app.js`, replacing the `CHATBOT_WORKER_URL` placeholder near the top of the file.
6. Redeploy the dashboard: `firebase deploy --only hosting` (from the project root).

## Redeploying after code changes

```bash
cd worker
wrangler deploy
```
No need to touch secrets again — they persist across deploys.
