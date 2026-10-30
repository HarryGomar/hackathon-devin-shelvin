# iPhone test checklist (Expo Go, mock data)

This guide is for running Shelvin on your own iPhone without building it. The app runs on mock data, so nothing is saved to a server and no paid AI calls are made.

## Part 1: Run the app on your iPhone

You need a Mac with this repository, and an iPhone. Put both on the same Wi-Fi network.

The Mac needs **Node.js 22.15 or newer**. To check, run `node --version` in Terminal. If it prints a lower number or "command not found", install the current LTS version from [nodejs.org](https://nodejs.org).

1. **On the iPhone:** install **Expo Go** from the App Store (it's free, by Expo).
2. **On the Mac:** open Terminal and go to the app folder:
   ```bash
   cd path/to/hackathon-devin-shelvin/app
   ```
3. Install dependencies. You only need this the first time, or after someone changes `package.json`:
   ```bash
   npm install
   ```
4. Start the development server:
   ```bash
   npx expo start
   ```
   After a few seconds a QR code appears in the Terminal.
5. **On the iPhone:** open the **Camera** app and point it at the QR code. Tap the banner that says "Open in Expo Go".
6. The first load takes up to a minute while the app is sent to the phone. Then the **Shelvin** Home screen appears.

**If the phone can't connect** (it spins, or says "Could not connect to development server"):
- Check that the Mac and the iPhone are on the **same Wi-Fi**. Guest or office networks often block this.
- Stop the server with `Ctrl+C` and start it in tunnel mode, which works across networks:
  ```bash
  npx expo start --tunnel
  ```
  Scan the new QR code. The first time, it may ask to install `@expo/ngrok`. Answer yes.
- In Expo Go, shake the phone and tap **Reload** to load the app again.

**To start over:** shake the phone and tap **Reload**, or close Expo Go and scan the QR code again.

## Part 2: Sample barcodes

These are fictional barcodes. They only work with the mock data. You can type them with **CODE** on Home, or show them on another screen and scan them. (You can generate an EAN-13 image of each code with any online barcode generator.)

| Barcode | What happens |
|---|---|
| `7500000000017` | Doritos Incógnita, high confidence |
| `7500000000024` | Takis Fuego |
| `7500000000000` | Identification fails, so you can test the error and manual entry |
| any other valid code | A low-confidence guess ("Check this") |

## Part 3: What to check on the device

These things can only be tested on a real iPhone, not in the web preview. Tick each box, and for anything that fails write down what you did and what you saw (a screenshot helps).

### Camera permission
- [ ] On the very first **Scan product**, iOS asks for camera access. The message explains why the camera is used. In Expo Go the request comes from Expo Go, so the wording is Expo Go's, not this app's. That's expected.
- [ ] Tap **Allow**: the live camera preview appears.
- [ ] Denied path: in iOS **Settings → Expo Go → Camera**, turn camera access off. Open **Scan product** again. You see "Camera access is off" with **Open Settings** and the sample buttons.
- [ ] **Open Settings** opens the iOS Settings page for Expo Go. Turn the camera back on, return to the app, and the camera works again (you may need to close and reopen the scan screen).
- [ ] With the camera off, **SAMPLE BARCODE** and **SAMPLE PHOTO** still take you to Confirm.

### Barcode scan
- [ ] Point the camera at a barcode. It's read within a couple of seconds, and the phone gives a short **success vibration**.
- [ ] The scan **fires only once**: you land on Confirm a single time, with no double screen and no second vibration, even if you keep the barcode in view.
- [ ] Confirm shows "Scanned barcode" with the digits you scanned.
- [ ] Try it on a real product too. Any EAN-13 barcode should be read, and unknown codes give a low-confidence guess.

### Photo
- [ ] On the scan screen, switch to **Photo**, frame a package, and tap the shutter. You see "Preparing photo…" and then Confirm, with your photo shown.
- [ ] On Home, **PHOTO** opens the camera directly in photo mode.
- [ ] On Home, **LIBRARY** opens the iOS photo library. Pick a picture and you land on Confirm with it. Cancelling the picker leaves you on Home with no error.
- [ ] **SAMPLE PHOTO** works on the phone (not only on web).

### Demo data is labelled
Without `app/.env` (or without an API key in it) the app runs on demo data. That must be obvious on every screen:
- [ ] Home: the status at the top right reads **DEMO DATA** in amber (or, with some parts live, e.g. **LIVE ID · LIVE SEARCH · DEMO SCRAPERS**; with everything live it reads **LIVE** in grey with a green square).
- [ ] Photograph anything (for example a tissue box) or type an unknown barcode. Confirm shows an amber **DEMO RESULT** strip above the product ("Not your product: this build has no API key…"), the product shows **DEMO · SAMPLE PRODUCT** instead of a % and "High", and the other matches show "—" instead of %.
- [ ] Pages found shows a **DEMO PAGES** strip under the product name when the web search is demo. Results, Saved listings and the listing receipt show a **DEMO LISTINGS** strip while the scrapers are demo (also with live search).

### Full flow
Do these steps in order. Each one starts where the step before it ended.

- [ ] On Home, tap **CODE**, type `7500000000017`, and tap **Look up**. Confirm shows Doritos Incógnita (62 g) with **95%** in large mono figures and a green **MATCH · HIGH** next to it.
- [ ] Tap **Find pages**. The progress steps run ("Searching the web", "Checking each page"…), then Pages found shows a strip of counts (FOUND / VERIFIED / UNSURE / REJECTED) and one table grouped **OFFICIAL**, **RETAILERS**, **SIMILAR · …** and **REJECTED**. The line under the product name reads "Doritos · Incógnita · 62 g · EAN 7500000000017".
- [ ] Edit after a search: press **Back** (top-left) to return to Confirm. Tap **Edit details**, change only the **Size** to `145 g`, and tap **Save**. Tap **Find pages** again. The progress steps **run again** from the start, and the line under the product name now shows "145 g". If the old list appears straight away with no progress steps, that's a failure.
- [ ] Find **Chedraui** in the list: its checkbox is a dashed square and the line under it reads "↳ no scraper yet · **build**". Tap **build**. A small spinner and "building scraper… · …" show for a few seconds. Then the line goes away and the row gets a **ticked aqua checkbox**.
- [ ] Find **La Comer** and tap **build**. **The first try fails on purpose** (this is mock data): the line turns red with the error and a **retry** link. Tap it. This time the build works and the row gets a **ticked checkbox**.
- [ ] Blocked sites: **Amazon México** (RETAILERS) reads "↳ **BLOCKED** · this site blocks AI agents" in red and "↳ instead: Amazon's Creators API …" in grey, with a dashed checkbox and **no build** link. Tap **REJECTED · 1**: **Mercado Libre** shows the same BLOCKED line and its own "instead:" line under its reason. **HEB México** and **Bodega Aurrera Despensa** are ticked like the other verified stores.
- [ ] Tap **+ ADD A PAGE**, paste `https://www.amazon.com.mx/dp/B0EXAMPLE1`, and tap **Build scraper**. After the progress, the red banner reads "Blocked by the site: this site blocks AI agents. No scraper is built for it." with **no Try again**, and **Build scraper** is greyed out until you change the URL. Tap **Cancel**.
- [ ] Tap **+ ADD A PAGE**, paste `https://www.example.com.mx/producto`, and tap **Build scraper**. The sheet shows progress, then closes, and the page is added to the list with the status **ADDED**.
- [ ] Tap **Scrape N pages** at the bottom. Results shows a green **SAVED ✓ … LISTINGS** line, then a store table per product (**LISTINGS** for the scanned product, then **SIMILAR · …** tables): store logo + name + stock, price per 100 g, and the price in MXN with **▼ LOW** in aqua under the cheapest and **+0.72**-style differences under the others. Open the **Soriana** row: on the receipt, **GTIN** reads `7500000115606` with no commas, while **Review count** reads `1,240` with a comma. Press **Back**.
- [ ] Below the listings on Results: **BLOCKED BY THE SITE · 1** lists **HEB México**, `heb.com.mx`, "↳ The site refused our requests" in red and the detail ("…403 Forbidden…") in grey, with no retry. Then **COULDN'T FETCH · 1** lists **Bodega Aurrera Despensa**, its URL, "↳ Couldn't load the page" in amber and "Timed out loading the page" in grey, under "You can try them again from Pages found". No button anywhere offers to get around a block.
- [ ] Open any listing from Results and tap **Open page** at the bottom. The page opens in a browser sheet inside the app. Close it, then press **Back** to Results.
- [ ] Tap **Scrape more sources**. You go back to Pages found **with no new search** (no progress steps), and the pages you scraped show "↳ scraped ✓ · saved listings" in green.
- [ ] Similar products: scroll down to **SIMILAR PRODUCTS** and tap the **Takis Fuego** row (marked COMPETITOR). You go back to Confirm showing Takis Fuego, and the "TYPED BARCODE 7500000000017" line is **not** shown above it.
- [ ] Press **Back** (top-left) once. You land on **Home**, not on a second Pages found.
- [ ] Scan another: type `7500000000024` and tap **Look up**. Confirm shows Takis Fuego. Tap **Find pages**, wait for the list, then tap **Scrape N pages**. On Results, tap **Scan another item**. You land on **Home**, and the RECENT SCANS table shows Takis Fuego with "Takis · today HH:MM", its listing count, and its lowest price with a store code (for example `24.00` over `WMT`). The totals line under the table adds up products and listings.
- [ ] Tap that recent scan row. It opens the saved listings for that product. Below the listings, the same **BLOCKED BY THE SITE** (HEB México) and **COULDN'T FETCH** (Bodega Aurrera) tables show, with "Try them again with Find more pages".
- [ ] Listing detail from Saved listings: tap any row of the store table. The **receipt** opens: the store's logo and name centered at the top with its website and scrape time, a dashed rule, the listing title (with the page's picture when there is one), **PRICE MXN** with the price in large mono figures (for example `$24.00`), dotted leader lines (PER 100 G, STOCK, RATING, SKU and every other field), **RETAILER CATEGORY** and **GOOGLE PRODUCT TAXONOMY** as numbered levels with the last one in bold, **SAME PRODUCT ELSEWHERE** with ▼ LOW and +differences, and the full page URL at the bottom. Tap **Open page** (with the website under it) at the bottom: the page opens in a browser sheet. Close it, then press **Back**: you are on Saved listings again.
- [ ] Retailers at a glance: on Saved listings, Results and Pages found, each row starts with a small **logo tile** (the site's icon, e.g. the yellow Walmart spark, the Soriana heart) next to the retailer name in bold. The brand's own site shows the brand name (for example **Takis**, without "(official site)") with a grey **OFFICIAL** word. Sites without an icon show a tinted tile with 1–2 letters; each site has its own tint. You can tell Walmart, Soriana, Chedraui, etc. apart at a glance. The receipt shows the same logo above the store name.
- [ ] Turn on **Airplane mode**, then open a product you haven't opened yet in Saved listings: the logo tiles show letters instead of icons and nothing breaks. Turn Airplane mode off.
- [ ] Find more pages: on Saved listings for **Takis Fuego**, note the listing count (for example "3 listings") and tap **Find more pages** at the bottom. Confirm opens showing Takis Fuego, with **no** "Typed barcode" card above it. Tap **Find pages**. On Pages found, every page that is already in Saved listings (for example Takis official site, Walmart Súper, Soriana) shows **"↳ scraped ✓"** and is **not** ticked; the others are ticked.
- [ ] Tap **Scrape N pages**. Results shows the new listings. Tap any row: the receipt opens at once (no loading), then press **Back** to Results. Tap **Scrape more sources**: Pages found now marks every scraped page "↳ scraped ✓".
- [ ] Press **Back** twice (Pages found → Confirm → Saved listings). Saved listings now shows **more listings** than before (the count on the right of **LISTINGS**), including the new retailers. Press **Back** to Home: Recent scans shows the new count.
- [ ] Repeat **Find more pages** on a product, scrape, and on Results tap **Scan another item**. You land on **Home**.
- [ ] Go back to Home, type `7500000000000`, and tap **Look up**. Confirm shows an identify error with **Retry** and **Enter details manually**. Tap **Enter details manually**, fill in a brand and a product name, and tap **Save**. **Find pages** now works.

### Feel and look
- [ ] The **main ink buttons** (a black block with small rounded corners in Light mode, an off-white block in Dark mode: Scan product, Look up, Find pages, Save, Scrape N pages, Scan another item, Open page) give a light **tap vibration** when pressed, and darken slightly while pressed. On **Scan product**, the printed barcode stripe on the left shifts by one point while pressed. Outlined buttons (EDIT DETAILS, + ADD A PAGE, SCRAPE MORE SOURCES) and text links don't vibrate. That's by design, not a failure. The barcode-scan vibration is checked separately above. (Haptics don't work in Low Power Mode, or when System Haptics is off in Settings → Sounds & Haptics.)
- [ ] Look: Light mode is warm paper (off-white) with near-black ink; Dark mode is **plain black** (no green or blue tint) with off-white text. Numbers, codes, prices and caps labels are in a monospaced font; sections are separated by **dashed** rules and table rows by thin solid lines. There are no glows, shadows around cards or pill-shaped badges; the only filled panel is the receipt on the listing detail. Aqua appears only on ticked checkboxes, ▼ LOW, the **build** links and the progress spinner.
- [ ] Turn on **Dark mode** (Control Center or Settings → Display & Brightness). All screens are readable, and nothing shows white-on-white or black-on-black. The camera screen is always dark. Switch back to **Light**.
- [ ] **Appearance setting:** on Home, tap the small round icon at the top right (◐), next to the data status (**DEMO DATA**). A menu shows **Automatic** (Follows your phone), **Light** and **Dark**, with a check on the current one. Pick **Dark** while the phone is in Light mode: the whole app turns dark, including the top bar and the keyboard, and the icon becomes a moon. Close Expo Go completely and reopen the app: it is still dark. Pick **Light** with the phone in Dark mode: the app stays light. Pick **Automatic** again: the app follows the phone, so switching the phone between Light and Dark changes the app.
- [ ] Motion is subtle: the receipt fades and slides in, progress steps tick over with a short fade, and loading placeholders pulse softly. Nothing glows or breathes. Then turn on **Reduce Motion** (Settings → Accessibility → Motion). The app reads this setting when it starts, so **reload the app** after switching it (shake the phone → **Reload**, or close and reopen Expo Go). After the reload, the receipt appears without sliding and placeholders stay still. Turn Reduce Motion off again and reload.
- [ ] Icons are iOS SF Symbols (clean system icons), not emoji or boxes.
- [ ] Nothing is hidden behind the notch, the Dynamic Island or the home bar, and bottom buttons sit above the home indicator.
- [ ] Larger text: Settings → Accessibility → Display & Text Size → Larger Text. Screens still fit and scroll.

## Reporting a problem

For each failure, note:
1. The step (copy the checkbox line).
2. What you expected, and what happened instead.
3. A screenshot (press the side button and volume up together).
4. If the app shows a red error screen, take a screenshot of it as well.
