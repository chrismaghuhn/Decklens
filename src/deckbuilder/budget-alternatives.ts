/**
 * Budget Alternatives Module for DeckLens
 * Suggests cheaper replacement cards for expensive cards in the deck.
 * Uses role-based matching (auto-categories) to find functional equivalents.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { categorizeCard, type CardCategory } from './auto-categories.js';

// ==================== Types ====================

export interface BudgetAlternative {
  name: string;
  eurPrice: number;
  role: CardCategory;
  reasoning: string;
}

export interface ExpensiveCardWithAlternatives {
  name: string;
  qty: number;
  eurPrice: number;
  roles: CardCategory[];
  alternatives: BudgetAlternative[];
}

// ==================== Curated Budget Mappings ====================
// Maps expensive staples → budget alternatives with role + reasoning.
// Key = lowercase card name, Value = array of alternatives.

const BUDGET_MAP: Record<string, { name: string; role: CardCategory; reasoning: string }[]> = {
  // ── Ramp ──
  'mana crypt': [
    { name: 'Sol Ring', role: 'Ramp', reasoning: 'Same fast mana, nearly free' },
    { name: 'Mind Stone', role: 'Ramp', reasoning: '2 mana rock with draw' },
    { name: 'Arcane Signet', role: 'Ramp', reasoning: 'Color-fixing 2-mana rock' },
  ],
  'mana vault': [
    { name: 'Worn Powerstone', role: 'Ramp', reasoning: 'Produces 2 colorless, no untap cost' },
    { name: 'Thran Dynamo', role: 'Ramp', reasoning: '3 colorless mana production' },
    { name: 'Basalt Monolith', role: 'Ramp', reasoning: '3 colorless, untaps for 3' },
  ],
  'chrome mox': [
    { name: 'Arcane Signet', role: 'Ramp', reasoning: 'Color-fixing without card disadvantage' },
    { name: 'Fellwar Stone', role: 'Ramp', reasoning: 'Cheap color-fixing rock' },
  ],
  'mox diamond': [
    { name: 'Arcane Signet', role: 'Ramp', reasoning: 'No land discard required' },
    { name: 'Talisman of Creativity', role: 'Ramp', reasoning: '2-mana color-fixing' },
  ],
  'jeweled lotus': [
    { name: 'Sol Ring', role: 'Ramp', reasoning: 'Fast mana every game' },
    { name: 'Command Tower', role: 'Land', reasoning: 'Perfect commander color fixing' },
  ],
  'grim monolith': [
    { name: 'Basalt Monolith', role: 'Ramp', reasoning: 'Same untap pattern, much cheaper' },
    { name: 'Thran Dynamo', role: 'Ramp', reasoning: '3 colorless, no untap cost' },
  ],

  // ── Draw ──
  'rhystic study': [
    { name: 'Mystic Remora', role: 'Draw', reasoning: 'Powerful early draw, budget-friendly' },
    { name: 'Fact or Fiction', role: 'Draw', reasoning: 'Instant-speed card selection' },
    { name: 'Windfall', role: 'Draw', reasoning: 'Mass draw for 3 mana' },
  ],
  'necropotence': [
    { name: 'Sign in Blood', role: 'Draw', reasoning: 'Simple 2-for-1 draw' },
    { name: 'Read the Bones', role: 'Draw', reasoning: 'Draw 2 + scry 2' },
    { name: 'Night\'s Whisper', role: 'Draw', reasoning: '2 cards for 2 mana' },
  ],
  'sylvan library': [
    { name: 'Enchantress\'s Presence', role: 'Draw', reasoning: 'Draw on enchantment casts' },
    { name: 'Beast Whisperer', role: 'Draw', reasoning: 'Draw on creature casts' },
    { name: 'Guardian Project', role: 'Draw', reasoning: 'Draw on nontoken creatures entering' },
  ],
  'esper sentinel': [
    { name: 'Thraben Inspector', role: 'Draw', reasoning: '1-mana creature + clue token' },
    { name: 'Spirited Companion', role: 'Draw', reasoning: 'ETB draw a card' },
  ],
  'mystic confluence': [
    { name: 'Fact or Fiction', role: 'Draw', reasoning: 'Instant-speed card selection for 5' },
    { name: 'Jace\'s Ingenuity', role: 'Draw', reasoning: 'Instant draw 3' },
  ],

  // ── Removal ──
  'fierce guardianship': [
    { name: 'Negate', role: 'Counter', reasoning: '2-mana hard counter for noncreature' },
    { name: 'An Offer You Can\'t Refuse', role: 'Counter', reasoning: '1-mana counter' },
    { name: 'Swan Song', role: 'Counter', reasoning: '1-mana counter for instants/sorceries/enchantments' },
  ],
  'force of will': [
    { name: 'Counterspell', role: 'Counter', reasoning: 'Hard counter for 2 mana' },
    { name: 'Arcane Denial', role: 'Counter', reasoning: '2-mana counter, opponent draws' },
    { name: 'Delay', role: 'Counter', reasoning: 'Suspends the spell for 3 turns' },
  ],
  'force of negation': [
    { name: 'Negate', role: 'Counter', reasoning: 'Same function, costs 2 mana' },
    { name: 'Spell Pierce', role: 'Counter', reasoning: '1-mana tax counter' },
  ],
  'teferi\'s protection': [
    { name: 'Cosmic Intervention', role: 'Protection', reasoning: 'Returns destroyed permanents' },
    { name: 'Eerie Interlude', role: 'Protection', reasoning: 'Blink creatures to dodge removal' },
    { name: 'Unbreakable Formation', role: 'Protection', reasoning: 'Indestructible until end of turn' },
  ],
  'cyclonic rift': [
    { name: 'Wash Out', role: 'Removal', reasoning: 'Bounce by color, 4 mana' },
    { name: 'River\'s Rebuke', role: 'Removal', reasoning: 'One-sided bounce target player' },
    { name: 'Evacuation', role: 'Removal', reasoning: 'Bounce all creatures, 5 mana instant' },
  ],
  'deadly rollick': [
    { name: 'Infernal Grasp', role: 'Removal', reasoning: '2-mana destroy any creature' },
    { name: 'Go for the Throat', role: 'Removal', reasoning: '2-mana destroy nonartifact creature' },
  ],

  // ── Tutors ──
  'demonic tutor': [
    { name: 'Diabolic Tutor', role: 'Tutor', reasoning: 'Same effect, 4 mana instead of 2' },
    { name: 'Mastermind\'s Acquisition', role: 'Tutor', reasoning: 'Tutor from library or outside game' },
  ],
  'vampiric tutor': [
    { name: 'Scheming Symmetry', role: 'Tutor', reasoning: '1-mana tutor, opponent also tutors' },
    { name: 'Diabolic Intent', role: 'Tutor', reasoning: 'Tutor with sacrifice cost' },
  ],
  'imperial seal': [
    { name: 'Scheming Symmetry', role: 'Tutor', reasoning: '1-mana tutor to top' },
    { name: 'Diabolic Tutor', role: 'Tutor', reasoning: 'Reliable 4-mana tutor' },
  ],
  'enlightened tutor': [
    { name: 'Open the Armory', role: 'Tutor', reasoning: 'Finds auras and equipment' },
    { name: 'Heliod\'s Pilgrim', role: 'Tutor', reasoning: 'ETB finds an aura' },
  ],
  'worldly tutor': [
    { name: 'Eldritch Evolution', role: 'Tutor', reasoning: 'Sacrifice creature to find bigger' },
    { name: 'Fauna Shaman', role: 'Tutor', reasoning: 'Repeatable creature tutor' },
  ],

  // ── Lands ──
  'fetch lands': [], // handled dynamically
  'smothering tithe': [
    { name: 'Monologue Tax', role: 'Ramp', reasoning: 'Similar treasure generation, less salt' },
    { name: 'Archaeomancer\'s Map', role: 'Ramp', reasoning: 'White ramp on opponents playing lands' },
    { name: 'Keeper of the Accord', role: 'Ramp', reasoning: 'Catches you up on lands' },
  ],
  'dockside extortionist': [
    { name: 'Professional Face-Breaker', role: 'Ramp', reasoning: 'Treasure on combat damage' },
    { name: 'Storm-Kiln Artist', role: 'Ramp', reasoning: 'Treasure on instants/sorceries' },
    { name: 'Captain Lannery Storm', role: 'Ramp', reasoning: 'Treasure on attack' },
  ],

  // ── Finishers & Value ──
  'craterhoof behemoth': [
    { name: 'Overwhelming Stampede', role: 'Finisher', reasoning: 'Similar overrun effect, sorcery' },
    { name: 'Triumph of the Hordes', role: 'Finisher', reasoning: 'Infect overrun, lower CMC' },
    { name: 'End-Raze Forerunners', role: 'Finisher', reasoning: 'Budget Craterhoof on a body' },
  ],
  'doubling season': [
    { name: 'Parallel Lives', role: 'Token Generator', reasoning: 'Token doubling only' },
    { name: 'Primal Vigor', role: 'Token Generator', reasoning: 'Double tokens + counters for all' },
    { name: 'Anointed Procession', role: 'Token Generator', reasoning: 'White token doubler' },
  ],
  'land tax': [
    { name: 'Tithe', role: 'Ramp', reasoning: 'Instant-speed plains search' },
    { name: 'Weathered Wayfarer', role: 'Ramp', reasoning: 'Repeatable land search' },
  ],
  'sensei\'s divining top': [
    { name: 'Soothsaying', role: 'Utility', reasoning: 'Top-deck manipulation for less' },
    { name: 'Scroll Rack', role: 'Utility', reasoning: 'Swap hand cards for top of library' },
  ],
  'the great henge': [
    { name: 'Beast Whisperer', role: 'Draw', reasoning: 'Draw on creature casts' },
    { name: 'Guardian Project', role: 'Draw', reasoning: 'Draw on nontoken creatures entering' },
    { name: 'Lifecrafter\'s Bestiary', role: 'Draw', reasoning: 'Scry + optional draw on creatures' },
  ],
};

// ==================== Helpers ====================

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getEurPrice(card: DeckbuilderSearchCard | undefined): number {
  if (!card?.prices?.eur) return 0;
  return parseFloat(card.prices.eur) || 0;
}

// ==================== Core Logic ====================

/**
 * Find budget alternatives for expensive cards in the deck.
 * Uses curated mappings first, then fallback heuristics based on role.
 */
export function findBudgetAlternatives(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  threshold: number = 5,
): ExpensiveCardWithAlternatives[] {
  const result: ExpensiveCardWithAlternatives[] = [];

  for (const entry of deck.boards.mainboard) {
    const card = cardByName[normalizeKey(entry.name)];
    const eur = getEurPrice(card);
    if (eur < threshold) continue;

    // Get roles for this card
    const roles = card ? categorizeCard(card as any) : ['Utility' as CardCategory];

    // Look up curated alternatives
    const curatedKey = normalizeKey(entry.name);
    const curated = BUDGET_MAP[curatedKey];

    const alternatives: BudgetAlternative[] = [];

    if (curated && curated.length > 0) {
      for (const alt of curated) {
        const altCard = cardByName[normalizeKey(alt.name)];
        const altPrice = getEurPrice(altCard);
        // Only suggest if actually cheaper
        if (altPrice < eur || altPrice === 0) {
          alternatives.push({
            name: alt.name,
            eurPrice: altPrice,
            role: alt.role,
            reasoning: alt.reasoning,
          });
        }
      }
    }

    // Fallback: find cheap cards in the same role from the resolved card pool
    if (alternatives.length === 0 && card) {
      const primaryRole = roles[0];
      const fallbacks = findRoleBasedAlternatives(
        primaryRole,
        cardByName,
        eur,
        entry.name,
        deck,
      );
      alternatives.push(...fallbacks);
    }

    if (alternatives.length > 0 || eur >= threshold) {
      result.push({
        name: entry.name,
        qty: entry.qty,
        eurPrice: eur,
        roles,
        alternatives: alternatives.slice(0, 3), // Max 3 suggestions
      });
    }
  }

  return result.sort((a, b) => b.eurPrice - a.eurPrice);
}

/**
 * Fallback: find cards in the resolved pool that share the same primary role
 * and are significantly cheaper.
 */
function findRoleBasedAlternatives(
  role: CardCategory,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  expensivePrice: number,
  excludeName: string,
  deck: DeckbuilderDeck,
): BudgetAlternative[] {
  const candidates: BudgetAlternative[] = [];
  const deckCardNames = new Set(deck.boards.mainboard.map((e) => normalizeKey(e.name)));

  for (const [key, card] of Object.entries(cardByName)) {
    if (!card) continue;
    if (key === normalizeKey(excludeName)) continue;
    // Skip cards already in deck
    if (deckCardNames.has(key)) continue;

    const price = getEurPrice(card);
    // Must be meaningfully cheaper (at most 40% of the expensive card's price)
    if (price >= expensivePrice * 0.4 || price === 0) continue;

    const cardRoles = categorizeCard(card as any);
    if (cardRoles.includes(role)) {
      candidates.push({
        name: card.name,
        eurPrice: price,
        role,
        reasoning: `${role} alternative, ${price > 0 ? `€${price.toFixed(2)}` : 'price unknown'}`,
      });
    }
  }

  // Sort by EDHREC rank (popularity) if available, otherwise by price
  candidates.sort((a, b) => {
    const cardA = cardByName[normalizeKey(a.name)];
    const cardB = cardByName[normalizeKey(b.name)];
    const rankA = cardA?.edhrec_rank ?? 99999;
    const rankB = cardB?.edhrec_rank ?? 99999;
    return rankA - rankB;
  });

  return candidates.slice(0, 3);
}

// ==================== Rendering ====================

export interface BudgetAlternativesCallbacks {
  onSwap(cutName: string, addName: string): void;
}

export function renderBudgetAlternatives(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  callbacks: BudgetAlternativesCallbacks,
): void {
  container.textContent = '';

  if (deck.boards.mainboard.length === 0) return;

  const expensive = findBudgetAlternatives(deck, cardByName, 5);

  if (expensive.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'muted';
    msg.style.fontSize = '0.78rem';
    msg.textContent = 'No expensive cards found — your deck is already budget-friendly!';
    container.appendChild(msg);
    return;
  }

  // Potential savings
  let totalSavings = 0;
  for (const exp of expensive) {
    if (exp.alternatives.length > 0) {
      const cheapest = Math.min(...exp.alternatives.filter((a) => a.eurPrice > 0).map((a) => a.eurPrice));
      if (cheapest < exp.eurPrice) {
        totalSavings += (exp.eurPrice - cheapest) * exp.qty;
      }
    }
  }

  if (totalSavings > 0) {
    const savingsBanner = document.createElement('div');
    savingsBanner.className = 'budget-savings-banner';
    savingsBanner.innerHTML = `<span>💰 Potential Savings</span><strong>€${totalSavings.toFixed(2)}</strong>`;
    container.appendChild(savingsBanner);
  }

  // Render each expensive card with expandable alternatives
  for (const exp of expensive.slice(0, 12)) {
    const card = document.createElement('div');
    card.className = 'budget-alt-card';

    // Header row: card name + price
    const header = document.createElement('div');
    header.className = 'budget-alt-header';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'budget-alt-name';
    nameSpan.textContent = `${exp.qty}x ${exp.name}`;

    const roleSpan = document.createElement('span');
    roleSpan.className = 'budget-alt-role';
    roleSpan.textContent = exp.roles[0];

    const priceSpan = document.createElement('span');
    priceSpan.className = 'budget-alt-price';
    priceSpan.textContent = `€${exp.eurPrice.toFixed(2)}`;

    header.append(nameSpan, roleSpan, priceSpan);

    if (exp.alternatives.length > 0) {
      header.style.cursor = 'pointer';
      const arrow = document.createElement('span');
      arrow.className = 'budget-alt-arrow';
      arrow.textContent = '▸';
      header.appendChild(arrow);

      const altList = document.createElement('div');
      altList.className = 'budget-alt-list collapsed';

      for (const alt of exp.alternatives) {
        const altRow = document.createElement('div');
        altRow.className = 'budget-alt-row';

        const altInfo = document.createElement('div');
        altInfo.className = 'budget-alt-info';

        const altName = document.createElement('span');
        altName.className = 'budget-alt-suggestion-name';
        altName.textContent = alt.name;

        const altReason = document.createElement('span');
        altReason.className = 'budget-alt-reason';
        altReason.textContent = alt.reasoning;

        altInfo.append(altName, altReason);

        const altPrice = document.createElement('span');
        altPrice.className = 'budget-alt-suggestion-price';
        altPrice.textContent = alt.eurPrice > 0 ? `€${alt.eurPrice.toFixed(2)}` : '—';

        const swapBtn = document.createElement('button');
        swapBtn.className = 'btn budget-swap-btn';
        swapBtn.textContent = 'Swap';
        swapBtn.title = `Replace ${exp.name} with ${alt.name}`;
        swapBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          callbacks.onSwap(exp.name, alt.name);
        });

        altRow.append(altInfo, altPrice, swapBtn);
        altList.appendChild(altRow);
      }

      header.addEventListener('click', () => {
        const isCollapsed = altList.classList.contains('collapsed');
        altList.classList.toggle('collapsed', !isCollapsed);
        arrow.textContent = isCollapsed ? '▾' : '▸';
      });

      card.append(header, altList);
    } else {
      card.appendChild(header);
    }

    container.appendChild(card);
  }

  if (expensive.length > 12) {
    const more = document.createElement('div');
    more.className = 'muted';
    more.style.cssText = 'font-size:0.72rem; padding: 4px 0;';
    more.textContent = `... and ${expensive.length - 12} more expensive cards`;
    container.appendChild(more);
  }
}
