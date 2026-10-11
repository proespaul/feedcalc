# Household Receipts — setup (about 10 minutes, once)

Snap a receipt on either phone → it's read line by line → everything lands in a Google Sheet
(`Receipts` + `Items` tabs) → the app's **Spending** tab shows where the money goes.
Works with no signal: photos queue on the phone and send themselves when a connection is back.

## A. Backend (Google Apps Script) — do this in whichever Google account should own the sheet

1. Go to **script.google.com → New project**. Name it `Household Receipts`.
2. Replace the contents of `Code.gs` with the `Code.gs` in `backend/`.
   Then **Project Settings (gear) → tick "Show appsscript.json"**, open it in the editor and replace it with `backend/appsscript.json`
   (this sets Mountain Time and the permissions).
3. **Project Settings → Script Properties → Add**: `ANTHROPIC_API_KEY` = the same Claude API key the timesheet scanner uses.
4. Back in the editor: pick the function **`setup`** in the toolbar and press **Run**. Accept the permissions prompt.
   Open **Execution log** — it prints the Sheet link, the photo folder link and your **join word**.
5. **Deploy → New deployment → type: Web app** → Execute as **Me**, Who has access **Anyone** → Deploy.
   Copy the **Web app URL** (ends in `/exec`).

Optional: *Triggers → Add trigger → `retryErrors` → time-driven → every hour* re-reads any receipt the reader couldn't handle the first time.

## B. Host the app (GitHub Pages, same as your other apps)

1. github.com → **New repository** named `receipts` (public). Upload everything inside the `app/` folder
   (`index.html`, `core.js`, `sw.js`, `manifest.json`, the four `.png` icons) to the repo root.
2. Repo **Settings → Pages → Source: Deploy from a branch → main / (root) → Save**.
3. A minute later the app is live at **https://proespaul.github.io/receipts/**

## C. Phones

**Paul (Android):** open the link in Chrome → Settings tab → choose **Paul**, paste the Web app URL and the join word → **Save & test** (should say Connected ✓).
Then ⋮ menu → **Add to Home screen**. Once installed, "Receipts" also appears in the Android **Share** menu — so you can snap with the normal camera and share the photo straight into the app.

**Hannah:** in your app, Settings → **Share setup link to another phone** → text it to her. She opens it, picks **Hannah**, adds it to her home screen.
*If she's on iPhone:* after adding to the home screen, open the app from the home screen and paste the same link into Settings → "Got a setup link?" (iPhone keeps the browser and the installed app separate).

## Day to day

- **Snap a receipt** (or Choose from photos for several at once). It shows "Reading receipt…" then the store, total and every line.
- No signal? It says "Waiting for signal" and sends itself later. On Android it can even finish sending while the app is closed.
- **Spending** tab: month chips, total, by category / by store / biggest items, Paul vs Hannah. Works offline from the last refresh.
- A receipt the reader wasn't sure about gets a **check** badge and `Needs Review = YES` in the sheet, with a note saying why. Fix it in the sheet; the dashboard follows the sheet.
- Categories are editable: the `Categories` tab in the sheet is the list the reader picks from.
- Photos go to the Drive folder **Household Receipts (photos)**, named `date store $total`. The phone deletes its copy once filed.

## If something's off

- "Join word is wrong" → check Settings on that phone (case doesn't matter).
- "The backend URL did not answer as a web app" → you pasted the `/dev` URL or deployed with access *Only myself*; redeploy as **Anyone** and use the `/exec` URL.
- Receipts stuck on "Will retry" → the backend can't reach Claude right now (key missing, or an outage). They keep retrying on their own; `Log` tab in the sheet says what happened.
- Updating the app later: re-upload the changed files to the repo; phones pick up the new version on the next open (bump `VERSION` in `sw.js`).
