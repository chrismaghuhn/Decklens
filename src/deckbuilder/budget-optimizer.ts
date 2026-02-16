import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { findBudgetAlternatives } from './budget-alternatives.js';

interface ExpensiveCard {
  name: string;
  qty: number;
  eurPrice: number;
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getEurPrice(card: DeckbuilderSearchCard | undefined): number {
  if (!card?.prices?.eur) return 0;
  return parseFloat(card.prices.eur) || 0;
}

function getExpensiveCards(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  threshold: number,
): ExpensiveCard[] {
  const result: ExpensiveCard[] = [];
  for (const entry of deck.boards.mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    const eur = getEurPrice(card);
    if (eur >= threshold) {
      result.push({ name: entry.name, qty: entry.qty, eurPrice: eur });
    }
  }
  return result.sort((a, b) => b.eurPrice - a.eurPrice);
}

export interface BudgetSwapCallbacks {
  onSwap(cutName: string, addName: string): void;
}

export function renderBudgetOptimizer(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  callbacks: BudgetSwapCallbacks,
): void {
  container.textContent = '';

  if (deck.boards.mainboard.length === 0) return;

  // Total deck price (all cards)
  let totalDeckPrice = 0;
  for (const entry of deck.boards.mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    totalDeckPrice += getEurPrice(card) * entry.qty;
  }
  const totalPriceEl = document.createElement('div');
  totalPriceEl.className = 'budget-total-price';
  totalPriceEl.innerHTML = `<span>Total Deck Price</span><strong>\u20AC${totalDeckPrice.toFixed(2)}</strong>`;
  container.appendChild(totalPriceEl);

  const expensive = getExpensiveCards(deck, cardByName, 5);

  if (expensive.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'muted';
    msg.style.fontSize = '0.78rem';
    msg.style.marginTop = '8px';
    msg.textContent = 'No cards above \u20AC5 found. Your deck is already budget-friendly!';
    container.appendChild(msg);
    return;
  }

  // Total expensive cost
  const totalExpensive = expensive.reduce((s, c) => s + c.eurPrice * c.qty, 0);
  const summary = document.createElement('div');
  summary.className = 'budget-summary';
  summary.innerHTML = `<span>${expensive.length} cards above \u20AC5</span><strong>\u20AC${totalExpensive.toFixed(2)}</strong>`;
  container.appendChild(summary);

  // Table
  const table = document.createElement('div');
  table.className = 'budget-table';

  const headerRow = document.createElement('div');
  headerRow.className = 'budget-row budget-header';
  headerRow.innerHTML = '<span>Card</span><span>Price</span><span>Total</span>';
  table.appendChild(headerRow);

  for (const card of expensive.slice(0, 15)) {
    const row = document.createElement('div');
    row.className = 'budget-row';

    const name = document.createElement('span');
    name.className = 'budget-card-name';
    name.textContent = `${card.qty}x ${card.name}`;

    const price = document.createElement('span');
    price.className = 'budget-price';
    price.textContent = `€${card.eurPrice.toFixed(2)}`;

    const total = document.createElement('span');
    total.className = 'budget-price';
    total.style.fontWeight = '600';
    total.textContent = `€${(card.eurPrice * card.qty).toFixed(2)}`;

    row.append(name, price, total);
    table.appendChild(row);
  }

  if (expensive.length > 15) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.style.cssText = 'font-size:0.72rem; padding: 4px 0;';
    more.textContent = `... and ${expensive.length - 15} more`;
    table.appendChild(more);
  }

  container.appendChild(table);

  // ── Budget Target Slider ──
  const alternatives = findBudgetAlternatives(deck, cardByName, 5);
  const swappableCards = alternatives.filter((a) => a.alternatives.length > 0);

  if (swappableCards.length > 0) {
    let potentialSavings = 0;
    const swapPlan: Array<{ cut: string; add: string; savings: number }> = [];

    for (const exp of swappableCards) {
      const cheapest = exp.alternatives.filter((a) => a.eurPrice > 0).sort((a, b) => a.eurPrice - b.eurPrice)[0];
      if (cheapest && cheapest.eurPrice < exp.eurPrice) {
        const saving = (exp.eurPrice - cheapest.eurPrice) * exp.qty;
        potentialSavings += saving;
        swapPlan.push({ cut: exp.name, add: cheapest.name, savings: saving });
      }
    }

    // Sort by savings descending
    swapPlan.sort((a, b) => b.savings - a.savings);

    if (swapPlan.length > 0) {
      const divider = document.createElement('div');
      divider.style.cssText = 'margin-top: 12px; border-top: 1px solid var(--line); padding-top: 10px;';

      const sliderLabel = document.createElement('div');
      sliderLabel.className = 'budget-slider-label';
      sliderLabel.style.cssText = 'display:flex; justify-content:space-between; font-size:0.72rem; margin-bottom:4px;';

      const minBudget = Math.max(10, Math.round(totalDeckPrice - potentialSavings));
      const maxBudget = Math.round(totalDeckPrice);

      const labelLeft = document.createElement('span');
      labelLeft.style.color = 'var(--text-dim)';
      labelLeft.textContent = 'Target Budget';

      const labelRight = document.createElement('span');
      labelRight.style.cssText = "font-family:'JetBrains Mono',monospace; color:var(--gold);";
      labelRight.textContent = `€${maxBudget}`;

      sliderLabel.append(labelLeft, labelRight);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(minBudget);
      slider.max = String(maxBudget);
      slider.value = String(maxBudget);
      slider.className = 'budget-slider';
      slider.style.cssText = 'width:100%; accent-color:var(--gold, #e2b340);';

      const previewBox = document.createElement('div');
      previewBox.className = 'budget-slider-preview';

      const applyAllBtn = document.createElement('button');
      applyAllBtn.className = 'btn primary';
      applyAllBtn.style.cssText = 'margin-top:8px; width:100%; display:none;';
      applyAllBtn.textContent = 'Apply All Swaps';

      slider.addEventListener('input', () => {
        const target = parseInt(slider.value, 10);
        labelRight.textContent = `€${target}`;
        previewBox.textContent = '';

        if (target >= maxBudget) {
          applyAllBtn.style.display = 'none';
          return;
        }

        // Determine which swaps to apply to reach target
        const needed = totalDeckPrice - target;
        let accumulated = 0;
        const selectedSwaps: typeof swapPlan = [];

        for (const swap of swapPlan) {
          if (accumulated >= needed) break;
          selectedSwaps.push(swap);
          accumulated += swap.savings;
        }

        if (selectedSwaps.length === 0) {
          applyAllBtn.style.display = 'none';
          return;
        }

        for (const swap of selectedSwaps) {
          const row = document.createElement('div');
          row.style.cssText = 'font-size:0.72rem; padding:2px 0; display:flex; justify-content:space-between;';
          const left = document.createElement('span');
          left.style.color = 'var(--text-dim)';
          left.textContent = `${swap.cut} → ${swap.add}`;
          const right = document.createElement('span');
          right.style.cssText = "color:#34d399; font-family:'JetBrains Mono',monospace; font-size:0.68rem;";
          right.textContent = `-€${swap.savings.toFixed(2)}`;
          row.append(left, right);
          previewBox.appendChild(row);
        }

        applyAllBtn.style.display = '';
        applyAllBtn.textContent = `Apply ${selectedSwaps.length} Swap${selectedSwaps.length > 1 ? 's' : ''} (-€${accumulated.toFixed(2)})`;

        // Replace click handler
        applyAllBtn.onclick = () => {
          for (const swap of selectedSwaps) {
            callbacks.onSwap(swap.cut, swap.add);
          }
        };
      });

      divider.append(sliderLabel, slider, previewBox, applyAllBtn);
      container.appendChild(divider);
    }
  }
}
