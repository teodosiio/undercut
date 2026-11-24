# Undercut

Undercut watches up to 20 Ultimate Team cards per account and sends a push notification when a card goes under the price you set. The same app runs in a desktop browser and installs on Android or iPhone as a PWA.

**Prices are simulated by default.** Set `PRICE_PROVIDER=futgenie` in `.env` for free real console and PC prices. See [Connect live prices](#connect-live-prices).

## Run it

Requires Node.js 22.13 or newer.

On Windows, double-click **Start Undercut.cmd**. Keep its window open, because alerts stop when it closes.

Or run it from a terminal, then open http://localhost:8787:

```powershell
npm install
npm start
```

Add a player, then press **Test drop** to trigger an alert.

```powershell
npm test
```

Locally, data is kept in a PGlite database (Postgres in WebAssembly) under `data/pgdata`.

## Deploy to Vercel

Vercel functions have no lasting disk or always-on process, so the deployed app works like this:

- **Pages:** files in `public/` are served by Vercel.
- **API:** every `/api/*` request goes to one function, `api/index.js`, which runs the same app as the local server.
- **Database:** a Neon Postgres database, added from Vercel's Marketplace, which sets `DATABASE_URL`.
- **Price checks:** the GitHub Actions workflow in `.github/workflows/check-prices.yml` calls `/api/cron` every 15 minutes, because Vercel's free plan allows cron jobs only once a day. GitHub can start scheduled runs a few minutes late, and pauses them in public repositories after 60 days without commits.

Set these on Vercel: `PRICE_PROVIDER=futgenie`, `MAX_ACCOUNTS=1` (so only your watchlist can exist), and a random `CRON_SECRET`. Set these as GitHub repository secrets: `UNDERCUT_URL` (the site address) and `UNDERCUT_CRON_SECRET` (the same value as `CRON_SECRET`).

With `MAX_ACCOUNTS=1`, the first person to press **Start my watchlist** owns the site's watchlist. A click is required, so link previews and Vercel's deployment screenshots cannot claim it. Use **Copy private link** to add your other devices.

## Install on a phone

Push notifications on a phone need an HTTPS address, such as the Vercel deployment.

- **Android:** open the site in Chrome, choose Install app, then turn on notifications in Settings.
- **iPhone (iOS 16.4+):** open the site in Safari, tap Share, choose Add to Home Screen, open Undercut from the Home Screen, then turn on notifications in Settings.

Use **Copy private link** to open the same watchlist on another device.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local server address |
| `PORT` | `8787` | Local server port |
| `DATA_DIR` | `./data` | Local database location, including push keys |
| `DATABASE_URL` | | Postgres connection string (set by the Neon integration on Vercel) |
| `CRON_SECRET` | | Required to call `/api/cron` for scheduled checks |
| `MAX_WATCHES` | `20` | Players per account |
| `MAX_ACCOUNTS` | `100` | Watchlists allowed on this server |
| `POLL_SECONDS` | `15` demo, `900` FUTGenie | Time between checks on the local server |
| `VAPID_SUBJECT` | site address on Vercel | `mailto:` or `https:` contact for push services |
| `PRICE_PROVIDER` | `simulated` | `simulated`, `futgenie`, `datafluxor` or `feed` |
| `DATAFLUXOR_API_KEY` | | Server-side key for real prices |
| `DATAFLUXOR_SANDBOX` | | Set to `1` for free fixed sample data |
| `PRICE_FEED_URL` | | Your authorized price API |
| `PRICE_FEED_TOKEN` | | Optional bearer token for that API |

## Connect live prices

### FUTGenie (free, console and PC)

Set `PRICE_PROVIDER=futgenie` in `.env` and restart. To add a player, find the card on [futgenie.gg/players](https://www.futgenie.gg/players), paste its link, and choose Console or PC.

- Undercut reads FUTGenie's public card pages and its filterable players list, which its robots.txt allows for all bots. Its terms do not forbid this, but there is no written permission, so stop if FUTGenie asks. Its internal API is not used.
- Requests identify Undercut, run one at a time at least 3 seconds apart, cover at most 20 checks, and repeat every 15 minutes.
- Checks pause for 30 minutes, or as long as FUTGenie asks, after an HTTP 403, 429 or 503 response.
- Prices are used only when FUTGenie recorded them within the last 3 hours. Console prices are usually under 2 hours old. Some PC prices are days old, and those cards show **No price** until FUTGenie updates them.
- The page format is not an API, so a FUTGenie redesign can stop prices. Affected cards then show **No price** instead of alerting on bad data.

### DataFluxor (paid, console and PC)

[DataFluxor FUT Data](https://datafluxor.com/fut-data) is a paid live source. It is a paid API, starting at $29 per month, and its terms allow using results inside your own product.

1. Subscribe and create an API key on DataFluxor.
2. Open `.env`, set `PRICE_PROVIDER=datafluxor`, and paste the key into `DATAFLUXOR_API_KEY`.
3. Restart Undercut. Adding a player now searches real cards.

Keep the key in `.env`. It must never be placed in client code or committed.

Things to know before paying:

- Prices update about every 8 minutes for the 5,700 most valuable cards and about every 25 minutes for the rest. A cheap listing can sell before an alert arrives.
- DataFluxor does not name its upstream source, and its card records include a `futbin_id`. Its data may depend on FUTBIN, so availability could change.
- Its terms make you responsible for following EA's rules. Do not resell the data or give others raw access to it.

### Other sites checked

FUT.GG and FUTZIP restrict scraping in their terms. FUT.GG, FUTWIZ, Fandifut and FUTZIP block price or API paths in robots.txt. FUTBIN and FUTNEXT refused automated requests for their terms. Undercut does not scrape any of them.

### Use a different authorized source

Set `PRICE_PROVIDER=feed` and point `PRICE_FEED_URL` at an endpoint that follows this contract, directly or through a small adapter:

```http
POST /your-endpoint
Authorization: Bearer <PRICE_FEED_TOKEN>
Content-Type: application/json

{ "items": [{ "key": "console:12345", "ref": "12345", "platform": "console" }] }
```

```json
{ "prices": { "console:12345": 118000 } }
```

`ref` is the card's ID in your source, entered as **Source ID** when adding a player. Missing or invalid prices are shown as stale and never trigger an alert.
