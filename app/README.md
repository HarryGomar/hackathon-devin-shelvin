# Shelvin app

The iPhone app (Expo SDK 58, React Native 0.88, Expo Router, TypeScript strict). It also runs in a browser with
`npx expo start --web`. It identifies the product on the phone and talks to the backend (`../backend`) for page
search, scraper builds and scrapes.

## Run it

```bash
npm install
cp .env.example .env    # then fill it in; every variable is explained there
npx expo start          # i: iOS Simulator · w: web · or scan the QR code with Expo Go
```

Without a `.env` the app runs on its mock API and mock identification: free, no backend needed. For the real
backend set `EXPO_PUBLIC_API_MODE=live`, `EXPO_PUBLIC_API_BASE_URL` and `EXPO_PUBLIC_API_TOKEN` (the three lines
`scripts/dev-up.sh` prints). Running on someone's phone: [../docs/phone/expo-go.md](../docs/phone/expo-go.md).

## Screens

| Route (`src/app/`) | Screen |
|---|---|
| `index.tsx` | Home: scan, type a barcode, recent scans |
| `scan.tsx` | Camera: barcode and photo |
| `confirm.tsx` | Confirm the product (brand, name, flavor, size) and what to search |
| `sources.tsx`, `add-source.tsx` | Pages found, blocked sites, build scrapers; add a page by hand |
| `results.tsx` | Scrape progress, then listings per store and the brand's catalog |
| `product/[id].tsx`, `listing/[id].tsx` | Saved listings of a product; one listing with every field |
| `builds/index.tsx`, `builds/[id].tsx` | Every build and installed scraper; one build's attempts, trace and gate reports |
| `console.tsx` | Scraper console: build board, trace, Devin's decisions, diff and gate |

## Code

| Folder (`src/`) | What |
|---|---|
| `app/` | Routes (Expo Router); most render a screen from `features/` |
| `features/<screen>/` | Screen components, their hooks, formatting and strings |
| `api/` | The backend contract (`types.ts`), the HTTP client and the mock backend |
| `services/` | Identification (Open Food Facts + Claude), product photos, the in-app search |
| `state/`, `hooks/` | Session state across the flow; shared hooks |
| `ui/`, `theme/` | Shared components (ticket style), colors, type and appearance |

## Check it

```bash
npm run typecheck
npm run lint
npm test               # node's test runner over src/**/*.test.ts
npx expo export --platform web    # a production web build in dist/
```

