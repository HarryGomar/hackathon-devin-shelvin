# Run Shelvin on someone's iPhone with Expo Go

There is no App Store or TestFlight build. Shelvin runs from **the host's Mac**, the Mac with this repository and the
`app/.env` file. Anyone with an iPhone can open it through the free **Expo Go** app. The Mac builds the app's
JavaScript and sends it to the phone, so the app works only while the Mac is awake and `npx expo start` is running.

For device test steps, see [`iphone-checklist.md`](iphone-checklist.md). For the backend, see
[`backend-spec.md`](../backend-spec.md).

## What the iPhone owner needs

- An iPhone with **Expo Go** from the App Store (free, by Expo). Use the current version, which runs Expo SDK 58.
  An old Expo Go says the project is incompatible; update it from the App Store.
- To be on the **same Wi-Fi** as the Mac, or a tunnel link from the host (below).

That's all: no account, no code and no keys on the phone.

## On the Mac (host)

You need Node.js 22.15 or newer. To check, run `node --version`.

```bash
cd path/to/hackathon-devin-shelvin/app
```
```bash
npm install
```
```bash
npx expo start
```

A QR code appears in Terminal.
- **Same Wi-Fi:** the iPhone owner opens the iPhone **Camera**, points it at the QR code and taps "Open in Expo Go".
  The first load takes up to a minute.
- If macOS asks whether `node` may **accept incoming connections**, click Allow. Otherwise phones can't reach the Mac.
- Keep the Mac awake and the Terminal window open. If either stops, the app on the phone stops loading.
  To get back in: shake the phone → **Reload**, or scan the QR code again.

### When the phone can't connect: `--tunnel`

Guest, office and phone-hotspot networks often block phones from reaching a Mac on the same Wi-Fi. A friend somewhere
else is never on your network at all. For both cases, stop the server (`Ctrl+C`) and run:

```bash
npx expo start --tunnel
```

- The first time it asks to install `@expo/ngrok`; answer yes. That is an Expo CLI tool on your Mac, not a project
  dependency.
- Both the Mac and the phone need internet. Loading is slower than on Wi-Fi.
- The URL changes every time you start, so send the new QR code (or the `exp://…` link under it) each time.
- **Anyone with that link can load the app from your Mac, including everything bundled into it** (see "Keys" below).
  Share the link only with people you trust, and stop the tunnel when you're done.
- With a tunnel, the phone is usually not on your network, so a backend URL like `http://192.168.x.x:8791` won't reach
  it. Live backend mode then needs the backend on a public HTTPS URL.

## Which mode the phone sees

The mode comes from **`app/.env` on the host's Mac** when `npx expo start` begins. After you change `.env`, stop and
start it again; add `--clear` if the old values seem to stick. The status at the top right of Home names what is live
and what is demo (for example `DEMO DATA`, or `LIVE ID · LIVE SEARCH · DEMO SCRAPERS`).

| Mode | `app/.env` | What the phone does | Cost |
|---|---|---|---|
| **Demo** (default) | no `.env`, or `EXPO_PUBLIC_API_MODE=mock` and `EXPO_PUBLIC_IDENTIFY_MODE=mock` | Sample products and fixtures: the barcodes in the checklist, fake store pages, listings that are kept only until the app reloads. Nothing reaches a server. | Free |
| **In-app live** | `EXPO_PUBLIC_IDENTIFY_MODE=live`, optionally `EXPO_PUBLIC_SEARCH_MODE=claude`, plus `EXPO_PUBLIC_ANTHROPIC_API_KEY` | Real identification (Open Food Facts + Claude) and real store-page search, run from the phone. Scrapers and saved scans stay mocked. | Paid per scan and per search (about US$0.30 per search) |
| **Live backend** | `EXPO_PUBLIC_API_MODE=live`, `EXPO_PUBLIC_API_BASE_URL=https://…`, `EXPO_PUBLIC_API_TOKEN=…`, plus `EXPO_PUBLIC_IDENTIFY_MODE=live` and the key for real identification | Identification runs on the phone; search, scrapers and saved scans go to the backend, and saved scans are shared by everyone using it. | Identification paid per scan from the phone's key; search and builds paid on the backend |

In live backend mode the app sends the team token with every request and always calls the backend's `/search`, so
`EXPO_PUBLIC_SEARCH_MODE` is ignored. Without `EXPO_PUBLIC_IDENTIFY_MODE=live` and a key, identification stays on
sample data (the status reads `DEMO ID`). See [`backend-spec.md` §6](../backend-spec.md#6-identification-in-the-app-not-on-the-backend).

## Why a copy from GitHub runs in demo mode

`app/.env` is in `.gitignore`, so it is never committed. A fresh clone, or anyone else's Mac, has no `.env`. Every
`EXPO_PUBLIC_*` setting is then unset and the app falls back to demo mode with sample data. This is on purpose: the
API key never goes to GitHub, and the app still runs for anyone. To get live modes on another Mac, its owner needs their
own `.env` (copy `app/.env.example` and fill it in). That means a key and a spending limit of their own, or the
backend URL and team token.

## Keys: never share them

- Anything in `.env` that starts with `EXPO_PUBLIC_` is **bundled into the app** that the Mac sends to the phone. With
  live identification or in-app search, the Anthropic key is inside the app that every connected phone downloads.
  Anyone who loads it, including through a tunnel link, could pull the key out.
- So whenever the key is in `.env`, connect only phones of people you trust, prefer Wi-Fi to a shared tunnel link, and
  set a monthly **spending limit** on the key in the Anthropic console.
- Never paste `.env` or the key into chat, an issue, a screenshot or a commit. If it leaks, revoke it in the Anthropic
  console and make a new one.
- In live backend mode, search and scraper builds use the backend's own keys, which stay on the server. Identification
  still runs on the phone, so live identification still bundles the Anthropic key. The team token is bundled too:
  treat it as team-only, and rotate it if it leaks.
- To show the app to people outside the team, use **demo mode**, which needs no key at all.

## Quick fixes

| Problem | Fix |
|---|---|
| "Could not connect to development server" | Same Wi-Fi? Allow `node` in the macOS firewall prompt. Otherwise use `--tunnel`. |
| Spins forever on first load | Wait a minute. Then shake → Reload. Then restart `npx expo start`. |
| "Project is incompatible with this version of Expo Go" | Update Expo Go from the App Store. |
| Changed `.env` but nothing changed | Restart `npx expo start` (with `--clear`). |
| Live search says the key was rejected | The key in `app/.env` is wrong or revoked. Demo mode still works without it. |
