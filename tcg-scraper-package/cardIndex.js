/**
 * cardIndex.js
 *
 * Loads the complete local card catalog (output/all-cards.json, produced by
 * importFromGithubDump.js) into memory ONCE at bot startup. No network calls
 * happen at spawn time — everything is served from RAM + local disk images.
 *
 * Wire this into Marin MD's existing spawn system (SpawnCacheSchema etc.) —
 * this file only replaces "where does the card data + image come from",
 * not your existing spawn scheduling / claim / album logic.
 */

const fs = require('fs');
const path = require('path');

const ALL_CARDS_FILE = path.join(__dirname, 'output', 'all-cards.json');

let cards = [];        // full array, for random picks
let cardsById = null;  // Map<id, card>, for O(1) lookup on claim

function loadIndex() {
  if (cardsById) return; // already loaded, don't reload every call
  const raw = JSON.parse(fs.readFileSync(ALL_CARDS_FILE, 'utf8'));
  cards = raw;
  cardsById = new Map(raw.map((c) => [c.id, c]));
  console.log(`[cardIndex] Loaded ${cards.length} cards into memory.`);
}

/** Pick one random card for a spawn. Optionally weight by rarity. */
function pickRandomCard() {
  loadIndex();
  return cards[Math.floor(Math.random() * cards.length)];
}

/** Look up a specific card by id (e.g. when a user claims a spawned card). */
function getCardById(id) {
  loadIndex();
  return cardsById.get(id) || null;
}

/**
 * Get the best available image source for a card:
 * - a locally downloaded file, if downloadAllImages.js already fetched it
 * - otherwise the remote URL as a graceful fallback (still works, just not
 *   fully offline for that one card until it's downloaded later)
 */
function getImageForCard(card) {
  if (card.localImage && fs.existsSync(card.localImage)) {
    return fs.readFileSync(card.localImage); // Buffer — pass directly to Baileys
  }
  return { url: card.images?.large || card.images?.small };
}

module.exports = { loadIndex, pickRandomCard, getCardById, getImageForCard };
