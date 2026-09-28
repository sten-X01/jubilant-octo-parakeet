/**
 * spawnExample.js
 *
 * Example of how a spawn + claim flow would use cardIndex.js. Adapt the
 * actual wiring to Marin MD's existing SpawnCacheSchema / spawn-scheduling
 * code — this just shows where correct data + correct image come from.
 */

const { pickRandomCard, getCardById, getImageForCard } = require('./cardIndex');

function formatCaption(card) {
  const lines = [`*${card.name}* (HP ${card.hp || '?'})`];
  for (const atk of card.attacks || []) {
    lines.push(`${(atk.cost || []).join('')} *${atk.name}*${atk.damage ? ` — ${atk.damage}` : ''}`);
  }
  return lines.join('\n');
}

// --- SPAWN: when your existing spawn timer fires ---
async function spawnCard(sock, chatId) {
  const card = pickRandomCard();          // random card from the FULL local catalog
  const image = getImageForCard(card);    // Buffer if downloaded, else {url:...} fallback

  await sock.sendMessage(chatId, {
    image,
    caption: `A wild *${card.name}* appeared!\n\n${formatCaption(card)}`,
  });

  // Store card.id (NOT the whole object) in your existing SpawnCacheSchema
  // doc for this chat, so .catch/.claim can look it up again by id later:
  //   await SpawnCache.updateOne({ chatId }, { $set: { cardId: card.id } }, { upsert: true });
}

// --- CLAIM: when a user tries to catch the currently spawned card ---
async function claimCard(spawnedCardId, userId) {
  const card = getCardById(spawnedCardId); // exact same data, guaranteed match
  // ... your existing inventory/DB logic to add `card.id` to the user's collection
  return card;
}

module.exports = { spawnCard, claimCard };
