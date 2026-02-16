/**
 * EDHREC Synergy Panel
 * Displays high-synergy cards, staples, and trending cards for the active commander.
 */

import { h, replaceChildren } from '../shared/dom.js';
import { fetchEdhrecSynergies, type EDHRECSynergyResponse } from '../shared/api.js';
import { showToast } from './toast.js';

let cachedCommander: string | null = null;
let cachedData: EDHRECSynergyResponse | null = null;

export async function renderEdhrecPanel(
  container: HTMLElement,
  commanderName: string | undefined,
  deckCardNames: Set<string>,
  onAddCard: (name: string) => void,
): Promise<void> {
  container.textContent = '';

  if (!commanderName) {
    replaceChildren(
      container,
      h('div', { className: 'edhrec-empty' },
        h('p', { className: 'muted' }, 'Set a commander to see EDHREC synergy data.'),
      ),
    );
    return;
  }

  // Show loading skeleton
  replaceChildren(
    container,
    h('div', { className: 'edhrec-loading' },
      h('div', { className: 'skeleton skeleton-row', style: 'height:24px;width:60%;margin-bottom:12px;' }),
      ...Array.from({ length: 5 }, () =>
        h('div', { className: 'skeleton skeleton-row', style: 'height:40px;margin-bottom:8px;' }),
      ),
    ),
  );

  try {
    let data: EDHRECSynergyResponse;
    if (cachedCommander === commanderName && cachedData) {
      data = cachedData;
    } else {
      data = await fetchEdhrecSynergies(commanderName);
      cachedCommander = commanderName;
      cachedData = data;
    }

    container.textContent = '';

    // Themes & Tribes badges
    if (data.themes.length > 0 || data.tribes.length > 0) {
      const badges = h('div', { className: 'edhrec-badges' },
        ...data.themes.slice(0, 4).map((t) =>
          h('span', { className: 'edhrec-badge edhrec-badge--theme' }, t),
        ),
        ...data.tribes.slice(0, 3).map((t) =>
          h('span', { className: 'edhrec-badge edhrec-badge--tribe' }, t),
        ),
      );
      container.appendChild(badges);
    }

    // High Synergy Cards
    if (data.highSynergy.length > 0) {
      container.appendChild(
        renderSection('High Synergy Cards', data.highSynergy.map((card) => ({
          name: card.name,
          detail: `+${card.synergy}% synergy`,
          barValue: Math.min(100, Math.max(0, card.synergy + 50)),
          barColor: card.synergy > 30 ? '#34d399' : card.synergy > 10 ? '#e8c84a' : '#94a3b8',
          inDeck: deckCardNames.has(card.name.trim().toLowerCase().replace(/\s+/g, ' ')),
        })), onAddCard),
      );
    }

    // Staples
    if (data.staples.length > 0) {
      container.appendChild(
        renderSection('Color Staples', data.staples.slice(0, 8).map((name) => ({
          name,
          detail: 'Staple',
          inDeck: deckCardNames.has(name.trim().toLowerCase().replace(/\s+/g, ' ')),
        })), onAddCard),
      );
    }

    // Trending
    if (data.trending.length > 0) {
      container.appendChild(
        renderSection('Trending This Week', data.trending.slice(0, 6).map((card) => ({
          name: card.name,
          detail: card.delta > 0 ? `↑${card.delta} ranks` : `↓${Math.abs(card.delta)} ranks`,
          inDeck: deckCardNames.has(card.name.trim().toLowerCase().replace(/\s+/g, ' ')),
        })), onAddCard),
      );
    }

    if (data.highSynergy.length === 0 && data.staples.length === 0 && data.trending.length === 0) {
      replaceChildren(
        container,
        h('p', { className: 'muted' }, 'No EDHREC data available for this commander.'),
      );
    }
  } catch (error) {
    replaceChildren(
      container,
      h('div', { className: 'edhrec-error' },
        h('p', { className: 'muted' }, 'Could not load EDHREC data. The service may be temporarily unavailable.'),
        h('button', {
          className: 'btn btn-sm',
          onClick: () => {
            cachedCommander = null;
            cachedData = null;
            void renderEdhrecPanel(container, commanderName, deckCardNames, onAddCard);
          },
        }, 'Retry'),
      ),
    );
    showToast({ message: 'Failed to load EDHREC data.', type: 'warning', duration: 3000 });
  }
}

interface SectionItem {
  name: string;
  detail: string;
  barValue?: number;
  barColor?: string;
  inDeck: boolean;
}

function renderSection(
  title: string,
  items: SectionItem[],
  onAddCard: (name: string) => void,
): HTMLElement {
  return h('div', { className: 'edhrec-section' },
    h('h4', { className: 'edhrec-section-title' }, title),
    ...items.map((item) =>
      h('div', { className: `edhrec-card-row${item.inDeck ? ' edhrec-card-row--in-deck' : ''}` },
        h('div', { className: 'edhrec-card-info' },
          h('span', { className: 'edhrec-card-name' }, item.name),
          h('span', { className: 'edhrec-card-detail' }, item.detail),
        ),
        item.barValue !== undefined
          ? h('div', { className: 'edhrec-synergy-bar' },
              h('div', {
                className: 'edhrec-synergy-fill',
                style: `width:${item.barValue}%;background:${item.barColor || '#e8c84a'}`,
              }),
            )
          : null,
        item.inDeck
          ? h('span', { className: 'edhrec-in-deck-badge' }, 'In Deck')
          : h('button', {
              className: 'btn btn-sm edhrec-add-btn',
              onClick: () => onAddCard(item.name),
            }, '+ Add'),
      ),
    ),
  );
}

/**
 * Invalidate the cached EDHREC data (e.g., when commander changes).
 */
export function invalidateEdhrecCache(): void {
  cachedCommander = null;
  cachedData = null;
}
