/**
 * Card/tcgcard.js  (adapt path/exports to Marin MD's command loader convention)
 *
 * .tcgcard <name>   -> searches your scraped TcgCard collection and sends
 *                      the card image with full details as caption.
 *
 * Assumes the TcgCard mongoose model from scrapeTcgSet.js is already
 * populated (run the scraper once per set, then this just reads from Mongo —
 * no live scraping happens on every command call).
 */

const mongoose = require('mongoose');
const fs = require('fs');

// Re-declare or import the same schema/model used by the scraper.
const TcgCard = mongoose.models.TcgCard;

function formatCaption(card) {
  const lines = [];
  lines.push(`*${card.name}* ${card.hp ? `(HP ${card.hp})` : ''}`);
  if (card.subtypes?.length) lines.push(`_${card.subtypes.join(' | ')}_`);
  if (card.evolvesFrom) lines.push(`Evolves from: ${card.evolvesFrom}`);
  lines.push('');

  for (const ab of card.abilities || []) {
    lines.push(`*Ability — ${ab.name}*`);
    lines.push(ab.text);
    lines.push('');
  }

  for (const atk of card.attacks || []) {
    const cost = (atk.cost || []).join('');
    lines.push(`${cost ? `[${cost}] ` : ''}*${atk.name}* ${atk.damage ? `— ${atk.damage}` : ''}`);
    if (atk.text) lines.push(atk.text);
    lines.push('');
  }

  const wk = (card.weaknesses || []).map(w => `${w.type} ${w.value}`).join(', ');
  const rs = (card.resistances || []).map(r => `${r.type} ${r.value}`).join(', ');
  if (wk) lines.push(`Weakness: ${wk}`);
  if (rs) lines.push(`Resistance: ${rs}`);
  if (card.retreatCost?.length) lines.push(`Retreat: ${card.retreatCost.length}`);

  lines.push('');
  lines.push(`${card.set?.name || ''} #${card.number}/${card.set?.total || ''} · ${card.rarity || ''}`);
  if (card.artist) lines.push(`Illus. ${card.artist}`);

  return lines.filter(Boolean).join('\n');
}

module.exports = {
  name: 'tcgcard',
  category: 'Pokemon',
  desc: 'Look up a scraped Pokemon TCG card by name and send its image + details',

  // Adapt this signature (sock, m, args) to whatever Marin MD's command
  // dispatcher actually passes — this mirrors a typical Baileys handler.
  async execute(sock, m, args) {
    const query = args.join(' ').trim();
    if (!query) {
      return sock.sendMessage(m.chat, { text: 'Usage: .tcgcard <card name>' }, { quoted: m });
    }

    const card = await TcgCard.findOne({ name: new RegExp(`^${query}$`, 'i') })
      || await TcgCard.findOne({ name: new RegExp(query, 'i') });

    if (!card) {
      return sock.sendMessage(m.chat, { text: `No card found matching "${query}".` }, { quoted: m });
    }

    const caption = formatCaption(card);

    // If you downloaded images locally with --download-images, send the buffer.
    // Otherwise just point Baileys at the pokemontcg.io hosted image URL directly.
    let imagePayload;
    if (card.localImage && fs.existsSync(card.localImage)) {
      imagePayload = fs.readFileSync(card.localImage);
    } else {
      imagePayload = { url: card.images?.large || card.images?.small };
    }

    return sock.sendMessage(
      m.chat,
      { image: imagePayload, caption },
      { quoted: m }
    );
  },
};
