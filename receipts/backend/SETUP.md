# Household Receipts — what's done and what's left

**Done**
- App is live: **https://proespaul.github.io/feedcalc/receipts/** (served from this repo's `receipts/` folder).
- The join word `prairie482` is baked into the app and the backend — nothing to type on either phone.
- Backend = the "Household Receipts" Apps Script project (code in `receipts/backend/`), deployed as a web app (deployment `AKfycbwmez6dyUMTubrqBMnQ6ehYslyQbhS6mXGPGBAP5OJ8P4sU_OsZZJEDba2sKaIT5amI`); its `/exec` URL is baked into `index.html` as `DEFAULTS.url`.
- Sheet: https://docs.google.com/spreadsheets/d/18bVhLyeGozW-Z4pB32g_damnmpNo11LNLQa4V6h7HaE/edit · Photos: Drive folder "Household Receipts (photos)".

**Left**
1. Apps Script → Household Receipts → **Project Settings → Script Properties → Add**: `ANTHROPIC_API_KEY` = a Claude API key (console.anthropic.com → API Keys). Until it is set, receipts queue on the phones and the app says "Will retry".

**Phones**
- Paul (Android): open the link in Chrome → ⋮ → *Add to Home screen*. Once installed, "Receipts" also appears in the Share menu (screenshots and PDF receipts can be shared straight in).
- Hannah: open the same link; on iPhone, Share → *Add to Home Screen*. Pick her name under More once. If Safari asks about the camera every time, allow the camera for the site in Settings → Safari.

**Day to day**
- The app opens straight to the camera. Tap the shutter; it reads the lines and files them; no signal = queued until later.
- *Long receipt* mode: take the top, then the rest, tap Done — filed as one receipt.
- *Photo / PDF* button (or the share sheet): screenshots of online orders (long ones are sliced automatically) and PDF receipts from email.
- *Spending* tab: Month / Quarter / Year / All with ‹ › arrows, "vs last period", tap a category or store to drill in, tap a bar to jump to that period.
- *Needs a look* (top of Spending): receipts to check (one tap "Looks right"), possible duplicates (Remove / Keep both), and bank charges with no receipt.
- *Bank check* (bottom of Spending): upload a CSV export, a PDF statement, or screenshots of the banking app. Every charge is matched to a receipt by amount + date (+ store name). Charges with no receipt get "Add as expense" (with a category; "Always file this way" remembers a rule in the sheet's **Bank Rules** tab) or "Not spending" (transfers, card payments).
- *Budget* tab: proposes a monthly budget per category from the last 3 months, editable, saved to the sheet's **Budgets** tab; shows left / over and "on pace for" live through the month.

**Duplicates**
- Same photo twice: caught on the phone and on the server (hash).
- Same purchase from two phones or a photo + a screenshot: same store, date and total → if the printed time matches or the items match, it is filed as `duplicate` (not counted, "Keep both" undoes); if it can't be sure, it is counted but flagged "possible duplicate".

**Sheet tabs** — Receipts, Items, Bank, Bank Rules, Budgets, Categories (editable), Log.
Receipts with Source = `bank` are expenses filed from a statement; `superseded` means a real receipt replaced one later.

**If something's off**
- "Join word is wrong" → the backend's `APP_TOKEN` script property differs from the app; run `rotateJoinWord` only together with an app update.
- "did not answer as a web app" → deploy with access *Anyone* and use the `/exec` URL, not `/dev`.
- Stuck on "Will retry" → backend can't reach Claude (key missing/outage); it retries on its own, and the sheet's `Log` tab says why.
- Bank matching looks wrong → run `rematchAll` in the editor (safe any time).
- Updating the app: edit files in `receipts/`, bump `VERSION` in `sw.js` (and `APP_VERSION` in `index.html`); phones pick it up on next open. Updating the backend: paste `Code.gs`, then Deploy → Manage deployments → edit → New version (keeps the same URL).
