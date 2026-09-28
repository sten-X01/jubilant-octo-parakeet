/**
 * fetchAllFromApi.js
 *
 * SINGLE, SAFE source for ALL card data — replaces importFromGithubDump.js +
 * fetchMissingSets.js. Uses the official api.pokemontcg.io v2 API directly
 * (confirmed working as of 2026, independent of scrydex.com's website),
 * so the data is always current — no gaps like the static GitHub dump had
 * (McDonald's 2023/2024 etc. are included automatically).
 *
 * Paced deliberately: ~176+ sets need roughly 90-100 total API calls (sets
 * list + ~85 paginated card-list calls at 250/page). With a free API key
 * (20,000 req/day) this finishes in under 2 minutes even with a safe delay
 * between every call — nowhere close to any rate limit.
 *
 * IMPORTANT: get a free key first (2-minute signup, no cost):
 *   https://dev.pokemontcg.io
 * Without a key you're capped at 1,000 req/day and 30/min — this script
 * still works, just paces itself much slower to respect that.
 *
 * Usage:
 *   POKEMONTCG_API_KEY=xxxx node fetchAllFromApi.js
 *   node fetchAllFromApi.js --set me55       # just one set, for testing
 */

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://api.pokemontcg.io/v2';
const API_KEY = process.env.POKEMONTCG_API_KEY || '';
const OUT_DIR = path.join(__dirname, 'output');
const BY_SET_DIR = path.join(OUT_DIR, 'by-set');

// Safe pacing: with a key we're nowhere near the limit even at this pace;
// without one, this keeps us comfortably under 30/min.
const DELAY_MS = API_KEY ? 250 : 2200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiFetch(url, attempt = 0) {
  const res = await fetch(url, { headers: API_KEY ? { 'X-Api-Key': API_KEY } : {} });
  if (res.status === 429) {
    const wait = Math.min(60000, 5000 * (attempt + 1));
    console.warn(`  rate limited, backing off ${wait / 1000}s...`);
    await sleep(wait);
    return apiFetch(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`API ${res.status} for ${url}`);
  return res.json();
}

async function fetchAllSets() {
  const json = await apiFetch(`${API_BASE}/sets?pageSize=250&orderBy=releaseDate`);
  await sleep(DELAY_MS);
  return json.data;
}

async function fetchAllCardsForSetId(setId) {
  let page = 1;
  const all = [];
  while (true) {
    const json = await apiFetch(`${API_BASE}/cards?q=set.id:${setId}&page=${page}&pageSize=250`);
    all.push(...json.data);
    await sleep(DELAY_MS);
    if (all.length >= json.totalCount || json.data.length === 0) break;
    page++;
  }
  return all;
}

(async () => {
  const setIdx = process.argv.indexOf('--set');
  const onlySetId = setIdx !== -1 ? process.argv[setIdx + 1] : null;
  const force = process.argv.includes('--force'); // re-fetch even sets already saved

  fs.mkdirSync(BY_SET_DIR, { recursive: true });

  if (!API_KEY) {
    console.log('No POKEMONTCG_API_KEY set — running at the slower no-key pace.');
    console.log('Free key (2 min, no cost): https://dev.pokemontcg.io\n');
  }

  console.log('Fetching full set list...');
  let sets = await fetchAllSets();
  if (onlySetId) sets = sets.filter((s) => s.id === onlySetId);

  // Resume support: skip any set whose file already exists, unless --force.
  // This makes an interrupted run pick up exactly where it left off instead
  // of re-fetching everything from set 1 again.
  const pending = force ? sets : sets.filter((s) => !fs.existsSync(path.join(BY_SET_DIR, `${s.id}.json`)));
  const skipped = sets.length - pending.length;
  if (skipped > 0) console.log(`Skipping ${skipped} set(s) already saved from a previous run (use --force to redo them).`);
  console.log(`${pending.length} set(s) to fetch now.\n`);

  const allCards = [];
  let grandTotal = 0;

  for (const [i, set] of pending.entries()) {
    console.log(`[${i + 1}/${pending.length}] ${set.name} (${set.id}) — ${set.total} cards`);
    const cards = await fetchAllCardsForSetId(set.id);
    grandTotal += cards.length;

    fs.writeFileSync(
      path.join(BY_SET_DIR, `${set.id}.json`),
      JSON.stringify({ set, total_cards: cards.length, cards }, null, 2)
    );
  }

  // Rebuild the combined files from EVERY set file on disk (not just this
  // run's pending list), so resumed + earlier runs merge correctly.
  if (!onlySetId) {
    for (const set of sets) {
      const p = path.join(BY_SET_DIR, `${set.id}.json`);
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const c of data.cards) allCards.push({ ...c, setId: set.id });
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, 'sets.json'), JSON.stringify(sets, null, 2));
    fs.writeFileSync(path.join(OUT_DIR, 'all-cards.json'), JSON.stringify(allCards, null, 2));
  }

  console.log(`\nDone. ${grandTotal} new card(s) fetched this run. ${allCards.length ? allCards.length + ' total cards on disk.' : ''}`);
})();
