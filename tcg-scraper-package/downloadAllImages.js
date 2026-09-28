/**
 * downloadAllImages.js  (local-JSON version — no MongoDB)
 *
 * Downloads the ORIGINAL high-quality ("large") image for every card in the
 * pokemon-tcg-data dump (run importFromGithubDump.js first).
 *
 * Features:
 *   - Resumable: skips files that already exist on disk
 *   - Concurrency-limited (default 8 parallel downloads)
 *   - Fallback: if a card's images.scrydex.com URL fails (some 2026 sets
 *     point there), retries via the pokemontcg.io v2 API for that card id
 *   - Writes failures.json listing any cards it couldn't get
 *   - Patches each output/by-set/<setId>.json card entry with a
 *     "localImage" path once its file is downloaded — no database needed
 *
 * Usage:
 *   node downloadAllImages.js                  # everything, large images only
 *   node downloadAllImages.js --small-too       # also grab small thumbnails
 *   node downloadAllImages.js --set me55        # just one set (test run first!)
 *   node downloadAllImages.js --concurrency 4   # gentler on slow connections
 *
 * Env:
 *   POKEMONTCG_API_KEY=xxxx     (optional, used only for the fallback path)
 */

const fs = require('fs');
const path = require('path');

const REPO_DIR = path.join(__dirname, 'pokemon-tcg-data');
const CARDS_DIR = path.join(REPO_DIR, 'cards', 'en');
const SETS_FILE = path.join(REPO_DIR, 'sets', 'en.json');
const OUT_DIR = path.join(__dirname, 'output');
const BY_SET_DIR = path.join(OUT_DIR, 'by-set');
const IMG_DIR = path.join(OUT_DIR, 'images');
const API_KEY = process.env.POKEMONTCG_API_KEY || '';

function parseArgs() {
  const args = process.argv;
  const get = (flag, def) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : def;
  };
  return {
    smallToo: args.includes('--small-too'),
    onlySet: get('--set', null),
    concurrency: parseInt(get('--concurrency', '4'), 10),   // gentler default — this is what was hitting rate limits
  };
}

async function downloadTo(url, dest, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url);
    const contentType = res.headers.get('content-type') || '';

    // Cloudflare rate-limit pages (Error 1027 etc.) often come back as HTTP 200
    // with an HTML body instead of the image — content-type check catches
    // what a plain res.ok check would miss.
    if (res.ok && contentType.startsWith('image/')) {
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    }

    if (attempt < retries) {
      const wait = 3000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait)); // brief backoff, CDN rate-limits are often transient
      continue;
    }
    throw new Error(res.ok ? `non-image response (${contentType || 'unknown type'})` : `HTTP ${res.status}`);
  }
}

async function fallbackUrlFromApi(cardId) {
  const res = await fetch(`https://api.pokemontcg.io/v2/cards/${cardId}`, {
    headers: API_KEY ? { 'X-Api-Key': API_KEY } : {},
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data?.images?.large || json.data?.images?.small || null;
}

// Independent third source: TCGdex (open-source, own CDN, no key, unrelated
// to Scrydex's infra) — best-effort match by exact card name + set name,
// since TCGdex uses its own set/card id scheme.
async function fallbackUrlFromTcgdex(name, setName) {
  try {
    const res = await fetch(`https://api.tcgdex.net/v2/en/cards?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const list = await res.json();
    for (const brief of list) {
      const detailRes = await fetch(`https://api.tcgdex.net/v2/en/cards/${brief.id}`);
      if (!detailRes.ok) continue;
      const card = await detailRes.json();
      if (card.set?.name?.toLowerCase() === (setName || '').toLowerCase()) {
        return `${card.image}/high.png`; // TCGdex urls need quality+ext appended
      }
    }
  } catch {
    /* ignore, this is a last-resort best-effort fallback */
  }
  return null;
}

async function runPool(items, worker, concurrency) {
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
}

(async () => {
  const { smallToo, onlySet, concurrency } = parseArgs();

  if (!fs.existsSync(REPO_DIR)) {
    console.error('pokemon-tcg-data not found — run importFromGithubDump.js first (it clones the repo).');
    process.exit(1);
  }
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.mkdirSync(BY_SET_DIR, { recursive: true });

  const files = onlySet ? [`${onlySet}.json`] : fs.readdirSync(CARDS_DIR).filter((f) => f.endsWith('.json'));
  const sets = JSON.parse(fs.readFileSync(SETS_FILE, 'utf8'));
  const setsById = Object.fromEntries(sets.map((s) => [s.id, s]));
  const failures = [];
  let done = 0;
  let grandTotal = 0;

  for (const file of files) {
    const filePath = path.join(CARDS_DIR, file);
    if (!fs.existsSync(filePath)) continue;
    const setId = file.replace(/\.json$/, '');
    const cards = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const setImgDir = path.join(IMG_DIR, setId);
    fs.mkdirSync(setImgDir, { recursive: true });
    grandTotal += cards.length;

    // will hold updated card objects (with localImage) to write back to by-set/<id>.json
    const cardById = new Map(cards.map((c) => [c.id, c]));

    await runPool(
      cards,
      async (card) => {
        const targets = [{ key: 'large', url: card.images?.large }];
        if (smallToo) targets.push({ key: 'small', url: card.images?.small });

        for (const t of targets) {
          // even if the dump itself has no URL for this card (rare data gaps,
          // e.g. an empty "images": {}), still try the live API as a fallback
          // instead of silently skipping it.
          const ext = t.url ? (path.extname(new URL(t.url).pathname) || '.png') : '.png';
          const dest = path.join(setImgDir, `${card.id}${t.key === 'small' ? '-small' : ''}${ext}`);

          if (!fs.existsSync(dest)) {
            try {
              if (!t.url) throw new Error('no URL in dump');
              await downloadTo(t.url, dest);
            } catch (e1) {
              try {
                const alt = await fallbackUrlFromApi(card.id);
                if (alt) {
                  await downloadTo(alt, dest);
                } else {
                  throw e1;
                }
              } catch (e2) {
                try {
                  const tcgdexUrl = await fallbackUrlFromTcgdex(card.name, setsById[setId]?.name);
                  if (tcgdexUrl) {
                    await downloadTo(tcgdexUrl, dest);
                  } else {
                    throw e2;
                  }
                } catch (e3) {
                  failures.push({ cardId: card.id, name: card.name, url: t.url || '(missing in dump)', error: e3.message });
                  continue;
                }
              }
            }
          }

          if (t.key === 'large') {
            const c = cardById.get(card.id);
            c.localImage = dest;
          }
        }

        done++;
        if (done % 500 === 0) console.log(`  ${done}/${grandTotal} done...`);
        await new Promise((r) => setTimeout(r, 150)); // small pacing gap — avoids bursting the CDN
      },
      concurrency
    );

    // write back the per-set JSON with localImage paths added, preserving any existing set-level metadata
    const bySetFile = path.join(BY_SET_DIR, `${setId}.json`);
    let setMeta = { id: setId };
    if (fs.existsSync(bySetFile)) {
      setMeta = JSON.parse(fs.readFileSync(bySetFile, 'utf8')).set || setMeta;
    }
    fs.writeFileSync(
      bySetFile,
      JSON.stringify({ set: setMeta, total_cards: cards.length, cards: Array.from(cardById.values()) }, null, 2)
    );

    console.log(`${setId}: images done, by-set JSON updated with localImage paths.`);
  }

  fs.writeFileSync(path.join(OUT_DIR, 'failures.json'), JSON.stringify(failures, null, 2));
  console.log(`\nDone. ${grandTotal - failures.length}/${grandTotal} images saved to ${IMG_DIR}`);
  if (failures.length) {
    console.log(`${failures.length} failed — see output/failures.json. Re-run with --set <id> to retry just those sets.`);
  }
})();
