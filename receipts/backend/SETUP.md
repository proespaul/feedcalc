# Household Receipts — what's done and what's left

**Done**
- App is live: **https://proespaul.github.io/feedcalc/receipts/** (served from this repo's `receipts/` folder).
- The join word `prairie482` is baked into the app and the backend — nothing to type on either phone.

**Left (about 3 minutes, in the Google account that should own the sheet)**
1. script.google.com → **New project** → name it `Household Receipts`.
2. Replace `Code.gs` with `receipts/backend/Code.gs`. Then **Project Settings (gear) → tick "Show appsscript.json"** and replace that file with `receipts/backend/appsscript.json`.
3. **Project Settings → Script Properties → Add**: `ANTHROPIC_API_KEY` = the Claude API key the timesheet scanner uses.
4. Toolbar: pick **`setup`** → **Run** → accept permissions. (Creates the Sheet + photo folder.)
5. **Deploy → New deployment → Web app** → Execute as **Me**, Who has access **Anyone** → Deploy → copy the **Web app URL** (`…/exec`).
6. Send that URL to Claude, who bakes it into the app and pushes — after that both phones only need to open the link.

Until step 6, the URL can be pasted into the app's Settings by hand.

**Phones**
- Paul (Android): open the link in Chrome → ⋮ → *Add to Home screen*. Once installed, "Receipts" also appears in the Share menu.
- Hannah: open the same link; on iPhone, Share → *Add to Home Screen*. Pick her name in Settings once.

**Day to day** — snap; it reads the lines and files them; no signal = queued until later. *Spending* tab = where the money goes.
Receipts the reader wasn't sure about get a *check* badge and `Needs Review = YES` in the sheet with a note saying why.
Categories are editable in the sheet's `Categories` tab. Photos land in Drive as `date store $total`.

**If something's off**
- "Join word is wrong" → the backend's `APP_TOKEN` script property differs from the app; run `rotateJoinWord` only together with an app update.
- "did not answer as a web app" → deploy with access *Anyone* and use the `/exec` URL, not `/dev`.
- Stuck on "Will retry" → backend can't reach Claude (key missing/outage); it retries on its own, and the sheet's `Log` tab says why.
- Updating the app: edit files in `receipts/`, bump `VERSION` in `sw.js`; phones pick it up on next open.
