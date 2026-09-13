# PRO Feed Calculator

Sizes a feeder or circuit to the Canadian Electrical Code and puts a ball park price on it. Built to work
with no signal: it opens and calculates from what it already has, and looks for a fresher price
sheet in the background.

Files: `index.html` (the whole app), `sw.js`, `manifest.webmanifest`, `icons/`, and `Code.gs`
(the price feed, which lives in Google, not on the phone).

---

## 1. Put the price feed up (10 minutes, once)

1. Go to script.google.com and choose **New project**.
2. Delete what is in the editor and paste in all of `Code.gs`.
3. The sheet id near the top is already your **Materials Price List**. Change `ACCESS_KEY` if you
   want a different key, and keep a note of it.
4. **Deploy** > **New deployment** > gear icon > **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the **Web app URL**. It ends in `/exec`.

The script only reads. It never writes to the sheet. It sends every priced row, since the equipment
search needs the whole sheet; add `?wire=1` to the address if you ever want the wire and breakers only.

To check it before you leave the editor: run `testFeed` once and look at the log.

## 2. Put the app online

GitHub Pages, same as the timesheet app:

1. New repository, name it `voltagedrop`, public.
2. Upload `index.html`, `sw.js`, `manifest.webmanifest` and the `icons` folder into the root.
3. **Settings** > **Pages** > Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. A minute later it is live at `https://<your-user>.github.io/feedcalc/`.

## 3. Put it on the phone

Open that address in Chrome on the Pixel, menu > **Add to home screen**. It lands as **Feed Calc**
with the lightning icon (the icon label is short because Android cuts off anything longer), opens like an app, and works with no signal.

If you had an older version installed under a different name, delete that icon first: Android keeps
the name it was installed with, so a rename only shows up on a fresh install.

## 4. Point it at the feed

Open the app, tap the sliders icon, paste the Web app URL into **Price feed address**, put the key
in, tap **Test the feed now** to see the row count come back, then **Save**.

---

## How it behaves with no signal

- The app never waits on the network to show you a number. It calculates from the prices it already
  has and gives up on the feed after 4 seconds.
- Prices come from, in order: the last successful sync (kept on the phone), otherwise the built-in
  list read off the sheet on 11 September 2026.
- The pill under the title always says which it is used, and how old it is. Tap it to force a refresh.
- A price that came off the sheet is tagged **Price sheet**. A price worked out by scaling a similar
  item is tagged **Estimated**. Anything you type over is tagged **Your price**.

## Taking a line off the price

Every line on the price card has an **x** on the right. Tap it and that line stops counting: it stays
on screen greyed out and struck through so you can see what you dropped, the count at the top says
how many are off, and the plus puts it back. It works on anything, including labour if you are
quoting material only, and on each run separately when the subpanel is on. Lines you take off do not
appear in the customer copy at all; the internal copy lists them marked OFF THE PRICE so you can see
what was left out.

The consumables percentage follows along: drop the breaker and the 7% is taken on what is left.

## Two runs in one job

The **subpanel feeder** switch opens a second calculator underneath the first. It is a complete run
of its own: its own supply, load, length, cable, connectors, bonding, consumables and hours, sized
against the Code independently of the main run.

Where they meet is the price. The material from both runs plus any gear you added is totalled
before the markup tier is chosen, so a job that crosses a tier boundary gets the better rate on all
of it, the way your PO log works. Labour adds up too. The price card shows each run under its own
heading with its material subtotal, then one set of totals for the job.

Turn the switch off and the subpanel drops out of the price without losing what you typed.

## What it opens on

120/240 V 3-wire on ACWU90 aluminum, breaker mode, because that is most of what gets run. Change
any of it and the app remembers where you left it.

## What it works out

- **Voltage drop**, Rule 8-102: on the connected load when you know it, otherwise 80% of the breaker.
  3% on a branch or feeder, 5% service to load. The maths is Table D3: `VD = K x f x I x L / 1000`.
- **Ampacity**, Rule 4-004, Table 2 copper and Table 4 aluminum, corrected for ambient (Table 5A)
  and for more than three conductors (Table 5C).
- **Terminations**, Rule 4-006: holds the size to the column your gear is marked for.
- **Continuous load**, Rule 8-104: 125% on the conductor and the breaker.
- **Breaker**, Rule 14-104 with the Table 13 round-up and the small-conductor caps.

- **Bonding**, Rule 10-616 with Table 16: sized on the breaker, or on the conductor ampacity when
  the conductors got upsized for drop, and never bigger than the circuit conductors. ACWU90, Teck,
  AC90 and Loomex carry their own bond so no separate line appears; PVC and RWU90 get one pulled;
  steel conduit is allowed to serve as the bond, and you can override any of it with the switch.
- **Connectors** are picked per end on a cable run, so a feeder can leave an indoor panel on a dry
  connector and land outside on a weatherproof teck gland. The weatherproof choice is made on the
  cable diameter against the range printed on the connector row itself, so it can tell you when a
  cable falls between two stocked sizes instead of quietly picking the wrong one. Either end can be
  overridden from the list. Conduit runs skip this: those fittings stay in the consumables line.
- **Grounding electrode** is an add-on: plate, two rods, or a water pipe clamp, each priced off the
  sheet along with the #6 conductor to it, with the hours to install it added to the labour.

The current-carrying conductor count follows the supply you pick, since that is what drives the
Table 5C derate. A neutral that only carries unbalanced current is not counted (Rule 4-004 3)); on
a 4-wire three-phase supply there is a switch for when it does count (Rule 4-004 4)).

- **Consumables** price at 7% of the cable, breaker, connectors and grounding, which sits safely
  above what the bits actually come to. The app still counts the real ones underneath: strapping at
  the Code spacing, ground bushings and plastic bushings at the ends, and a PVC sleeve when you ask
  for one, each priced off the sheet at the trade size the run works out to. If those count to more
  than the 7% (a long sleeve does it), the counted figure is what gets charged. The counts sit under
  "Bushings, sleeve and strapping" under each run, the standing percentage is in the sliders panel, and
  typing a figure into Fittings and consumables overrides both. That field takes either a dollar
  amount or a percentage: tap the **$** beside it to switch to **%**, the same way the length field
  switches between m and ft. Switching converts what is in the box, so the price does not jump, and
  clearing the field hands it back to automatic.
- **Equipment** is a switch: turn it on and you get a search over the price sheet, filtered to
  panels, disconnects, breakers, meter sockets or boxes and splitters. Tap the plus to drop gear into
  the price, set how many, and it lands on its own line. That is the part that turns this into an
  on-the-spot quote for a service change or a shop hookup.
  Behind the sheet sits a built-in catalogue of the gear that gets asked for most: QO, BR and THQL
  loadcentres from 60 A to 200 A, indoor and 3R outdoor, main breaker and main lug, the combination
  meter-socket panels, breakers from 15 A to 125 A in one, two and three pole plus GFCI, AFCI and
  tandems, and disconnects and splitter boxes. Those carry **typical** prices anchored to the rows
  your own sheet does have, and they say so: a dashed border in the search, a "Typical price" tag on
  the line. A real row off your sheet always ranks first and always wins.

Cable quantity follows your own takeoff rules: 15% waste, 75 m spools for #12 and smaller, nearest
5 m for #8 and up. Single conductors in conduit are counted per conductor, cable is counted once.
Markup is your tiered material markup, and it is never in the customer text.

**Check the tables once.** The ampacity and K tables are typed into the app so it runs with no
signal. Read them against your own book the first time out, and tell me if a cell disagrees.

**Not covered.** Alberta STANDATA amendments, conduit fill, harmonics on a shared neutral, motor
starting, and parallel runs.

## Changing the numbers

The **labour rate** sits right on the Job section, so you can change it on the spot for the job in
front of you. It sticks until you change it again, and the sliders panel shows the same figure.

Everything else in the sliders panel is yours to set: markup tiers, labour rate, free radius, truck
charge, permit fees, waste, GST, and whether the internal cost block shows on screen. It is kept
on the phone, not in the code.
