# Pokemon TCG Scraper — for Marin MD

Zero external npm dependencies. Requires Node.js >= 18 (built-in `fetch`).

## Files

- `fetchAllFromApi.js` — fetches EVERY set and EVERY card, live, from the
  official `api.pokemontcg.io` API. Fully automatic (discovers sets itself,
  no hardcoded list), fully resumable (skips sets already saved unless
  `--force`). No API key required (works at 1,000 req/day; a free key from
  dev.pokemontcg.io raises that to 20,000/day, but isn't needed for this
  catalog's size — the whole run is ~90 requests).
- `downloadAllImages.js` — downloads the original high-res image for every
  card to `output/images/<setId>/`. Resumable. 3-level fallback if a CDN URL
  fails: pokemontcg.io API -> TCGdex (fully independent open-source source).
  Gentle pacing by default (concurrency 4, small delay per file).
- `cardIndex.js` — loads `output/all-cards.json` into memory once at bot
  startup, for instant random-pick / by-id lookup at spawn time (no network
  calls during spawns).
- `spawnExample.js` — example of wiring `cardIndex.js` into a spawn/claim
  flow. Adapt to Marin MD's actual `SpawnCacheSchema` / command-loader code.
- `tcgcard.js` — example WhatsApp command (`.tcgcard <name>`) that looks up
  a card and replies with its image + formatted details.

## Usage

```bash
# 1. Test on one set first
node fetchAllFromApi.js --set me55
node downloadAllImages.js --set me55

# 2. Full run — all sets, all cards, current (no manual set list, no gaps)
node fetchAllFromApi.js
node downloadAllImages.js

# 3. If interrupted at any point, just re-run the same command — both
#    scripts skip everything already saved and continue from there.

# 4. Later, to pick up newly released sets:
node fetchAllFromApi.js
```

## Output layout

```
output/
  sets.json                 -> metadata for every set
  all-cards.json            -> every card, flattened, one file
  by-set/<setId>.json       -> { set, total_cards, cards: [...] } per set
                                (cards get "localImage" once downloaded)
  images/<setId>/<cardId>.png
  failures.json             -> any image downloads that failed, for retry
```

## Timing (rough)

- Data: ~90 total API calls for the whole catalog → a few minutes.
- Images: ~20,000+ files → roughly 40 min to a few hours depending on your
  VPS's connection and how often the fallback chain gets used. Resumable,
  so an interrupted run never restarts from zero.
