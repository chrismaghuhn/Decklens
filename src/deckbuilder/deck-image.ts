import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

const CARD_W = 146;
const CARD_H = 204;
const COLS = 10;
const PAD = 16;
const GAP = 4;

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

export async function generateDeckImage(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): Promise<Blob> {
  const commander = deck.boards.commander[0];
  const mainCards = deck.boards.mainboard;

  // Expand entries by qty
  const allCards: { name: string; imgUrl: string }[] = [];
  for (const entry of mainCards) {
    const card = cardByName[normalizeNameKey(entry.name)];
    const imgUrl = card?.image_uris?.small || '';
    for (let i = 0; i < entry.qty; i++) allCards.push({ name: entry.name, imgUrl });
  }

  const rows = Math.ceil(allCards.length / COLS);
  const headerH = 60;
  const commanderH = commander ? 240 : 0;
  const gridH = rows * (CARD_H + GAP);
  const footerH = 40;
  const totalW = PAD * 2 + COLS * (CARD_W + GAP) - GAP;
  const totalH = PAD + headerH + commanderH + gridH + footerH + PAD;

  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext('2d')!;

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, totalH);
  grad.addColorStop(0, '#08090f');
  grad.addColorStop(0.5, '#12141e');
  grad.addColorStop(1, '#0c0e16');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, totalW, totalH);

  // Title
  ctx.fillStyle = '#e8c84a';
  ctx.font = 'bold 24px "Cinzel", serif';
  ctx.textBaseline = 'top';
  ctx.fillText(deck.name, PAD, PAD + 8);

  // Card count
  ctx.fillStyle = '#9a94a8';
  ctx.font = '14px "Outfit", sans-serif';
  const totalQty = mainCards.reduce((s, e) => s + e.qty, 0) + deck.boards.commander.reduce((s, e) => s + e.qty, 0);
  ctx.fillText(`${totalQty} cards`, PAD, PAD + 38);

  let yOff = PAD + headerH;

  // Commander (larger)
  if (commander) {
    const cmdCard = cardByName[normalizeNameKey(commander.name)];
    const cmdUrl = cmdCard?.image_uris?.normal || cmdCard?.image_uris?.small || '';
    if (cmdUrl) {
      try {
        const img = await loadImage(cmdUrl);
        const cmdW = 170;
        const cmdH = 237;
        ctx.drawImage(img, PAD, yOff, cmdW, cmdH);

        ctx.fillStyle = '#e8e2d6';
        ctx.font = 'bold 16px "Outfit", sans-serif';
        ctx.fillText(commander.name, PAD + cmdW + 12, yOff + 10);

        ctx.fillStyle = '#c9a84c';
        ctx.font = '12px "Outfit", sans-serif';
        ctx.fillText('COMMANDER', PAD + cmdW + 12, yOff + 32);
      } catch {
        // Skip if image fails
      }
    }
    yOff += commanderH;
  }

  // Grid of cards
  const loaded = await Promise.allSettled(
    allCards.map(({ imgUrl }) => imgUrl ? loadImage(imgUrl) : Promise.reject(new Error('no url')))
  );

  for (let i = 0; i < allCards.length; i++) {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const x = PAD + col * (CARD_W + GAP);
    const y = yOff + row * (CARD_H + GAP);

    const result = loaded[i];
    if (result.status === 'fulfilled') {
      ctx.drawImage(result.value, x, y, CARD_W, CARD_H);
    } else {
      // Placeholder
      ctx.fillStyle = '#1a1d2a';
      ctx.fillRect(x, y, CARD_W, CARD_H);
      ctx.fillStyle = '#706b7f';
      ctx.font = '10px "Outfit", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(allCards[i].name.slice(0, 18), x + 4, y + CARD_H / 2);
      ctx.textBaseline = 'top';
    }
  }

  // Footer
  const footerY = totalH - PAD - 16;
  ctx.fillStyle = '#706b7f';
  ctx.font = '11px "Outfit", sans-serif';
  ctx.fillText('Built with DeckLens', PAD, footerY);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Canvas toBlob failed'));
    }, 'image/png');
  });
}

export async function downloadDeckImage(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): Promise<void> {
  const blob = await generateDeckImage(deck, cardByName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${deck.name.replace(/[^a-zA-Z0-9\s-]/g, '').trim() || 'deck'}.png`;
  a.click();
  URL.revokeObjectURL(url);
}
