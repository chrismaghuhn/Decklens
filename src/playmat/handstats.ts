// ==================== Opening Hand Statistics ====================
// Monte-Carlo opening hands over the mainboard: land distribution,
// average lands and mana value per 7-card hand.

export interface SimCard {
  isLand: boolean;
  mv: number;
}

export interface HandStats {
  hands: number;
  /** landHist[n] = hands that contained exactly n lands (0..7) */
  landHist: number[];
  avgLands: number;
  avgMv: number;
  /** percentage of hands with 2-4 lands (the classic keep window) */
  pct2to4: number;
}

const HAND_SIZE = 7;

export function simulateHands(
  library: SimCard[],
  hands = 1000,
  rng: () => number = Math.random,
): HandStats {
  const landHist = new Array(HAND_SIZE + 1).fill(0) as number[];
  if (library.length < HAND_SIZE || hands <= 0) {
    return { hands: 0, landHist, avgLands: 0, avgMv: 0, pct2to4: 0 };
  }

  const pool = [...library];
  let landSum = 0;
  let mvSum = 0;
  let mvCount = 0;

  for (let h = 0; h < hands; h++) {
    // partial Fisher-Yates: shuffle the first 7 positions
    for (let i = 0; i < HAND_SIZE; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let lands = 0;
    for (let i = 0; i < HAND_SIZE; i++) {
      const card = pool[i];
      if (card.isLand) {
        lands++;
      } else {
        mvSum += card.mv;
        mvCount++;
      }
    }
    landHist[lands]++;
    landSum += lands;
  }

  const kept = landHist[2] + landHist[3] + landHist[4];
  return {
    hands,
    landHist,
    avgLands: Math.round((landSum / hands) * 100) / 100,
    avgMv: mvCount > 0 ? Math.round((mvSum / mvCount) * 100) / 100 : 0,
    pct2to4: Math.round((kept / hands) * 1000) / 10,
  };
}
