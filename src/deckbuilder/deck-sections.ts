// ============================================================
// Deck Sections / Packages — Named groups within boards
// ============================================================
// "Ramp Package", "Draw Suite", "Removal Package" etc.
// Cards can be assigned to sections for visual grouping.
// ============================================================

import { h } from '../shared/dom.js';
import type { DeckBoard, DeckbuilderCardEntry, CustomCategory } from './types.js';

// ==================== Types ====================

export interface DeckSection {
  id: string;
  name: string;
  color: string;
  board: DeckBoard;
  minCards?: number;           // Target minimum (e.g. "need 10 ramp")
  maxCards?: number;           // Target maximum
  description?: string;
}

export interface SectionStats {
  section: DeckSection;
  cardCount: number;
  totalQty: number;
  cards: DeckbuilderCardEntry[];
  isUnderMin: boolean;
  isOverMax: boolean;
}

// ==================== Default Sections ====================

export const DEFAULT_SECTIONS: Omit<DeckSection, 'id' | 'board'>[] = [
  { name: 'Ramp', color: '#34d399', minCards: 10, description: 'Mana acceleration' },
  { name: 'Draw', color: '#60a5fa', minCards: 10, description: 'Card advantage' },
  { name: 'Removal', color: '#f87171', minCards: 5, description: 'Targeted removal' },
  { name: 'Board Wipes', color: '#fbbf24', minCards: 2, description: 'Mass removal' },
  { name: 'Lands', color: '#a78bfa', minCards: 33, maxCards: 40, description: 'Mana base' },
  { name: 'Win Conditions', color: '#f472b6', minCards: 3, description: 'Ways to close the game' },
  { name: 'Protection', color: '#e2e8f0', description: 'Counterspells, hexproof, etc.' },
  { name: 'Utility', color: '#94a3b8', description: 'Flexible/toolbox cards' },
];

// ==================== Section Management ====================

let _sectionIdCounter = 0;

function generateSectionId(): string {
  return `sec_${Date.now()}_${++_sectionIdCounter}`;
}

/**
 * Create a new section.
 */
export function createSection(
  name: string,
  board: DeckBoard,
  color: string,
  options?: { minCards?: number; maxCards?: number; description?: string }
): DeckSection {
  return {
    id: generateSectionId(),
    name,
    board,
    color,
    minCards: options?.minCards,
    maxCards: options?.maxCards,
    description: options?.description,
  };
}

/**
 * Assign a card to a section (set its customCategoryId).
 */
export function assignCardToSection(
  entry: DeckbuilderCardEntry,
  sectionId: string
): DeckbuilderCardEntry {
  return { ...entry, customCategoryId: sectionId };
}

/**
 * Remove a card from its section.
 */
export function removeCardFromSection(
  entry: DeckbuilderCardEntry
): DeckbuilderCardEntry {
  const { customCategoryId: _, ...rest } = entry;
  return rest as DeckbuilderCardEntry;
}

// ==================== Section Statistics ====================

/**
 * Compute statistics for all sections in a board.
 */
export function computeSectionStats(
  sections: DeckSection[],
  cards: DeckbuilderCardEntry[],
  board: DeckBoard
): SectionStats[] {
  const boardSections = sections.filter(s => s.board === board);

  return boardSections.map(section => {
    const sectionCards = cards.filter(c => c.customCategoryId === section.id);
    const totalQty = sectionCards.reduce((sum, c) => sum + c.qty, 0);

    return {
      section,
      cardCount: sectionCards.length,
      totalQty,
      cards: sectionCards,
      isUnderMin: section.minCards !== undefined && totalQty < section.minCards,
      isOverMax: section.maxCards !== undefined && totalQty > section.maxCards,
    };
  });
}

/**
 * Get cards not assigned to any section ("Unsorted").
 */
export function getUnsortedCards(
  cards: DeckbuilderCardEntry[],
  sections: DeckSection[]
): DeckbuilderCardEntry[] {
  const sectionIds = new Set(sections.map(s => s.id));
  return cards.filter(c => !c.customCategoryId || !sectionIds.has(c.customCategoryId));
}

// ==================== Auto-Assign by Tags ====================

/**
 * Auto-assign cards to sections based on their tags.
 */
export function autoAssignByTags(
  cards: DeckbuilderCardEntry[],
  sections: DeckSection[],
  tagToSection: Record<string, string> // tag name -> section ID
): DeckbuilderCardEntry[] {
  return cards.map(card => {
    if (card.customCategoryId) return card; // Already assigned

    for (const tag of card.tags) {
      const sectionId = tagToSection[tag.toLowerCase()];
      if (sectionId) {
        return { ...card, customCategoryId: sectionId };
      }
    }

    return card;
  });
}

/**
 * Get default tag-to-section mapping.
 */
export function getDefaultTagMapping(sections: DeckSection[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const section of sections) {
    const nameLower = section.name.toLowerCase();
    // Map common tags to sections
    if (nameLower === 'ramp') {
      mapping['ramp'] = section.id;
      mapping['mana_dork'] = section.id;
      mapping['mana_rock'] = section.id;
    } else if (nameLower === 'draw') {
      mapping['draw'] = section.id;
      mapping['card_advantage'] = section.id;
      mapping['card_draw'] = section.id;
    } else if (nameLower === 'removal') {
      mapping['removal'] = section.id;
      mapping['targeted_removal'] = section.id;
      mapping['destroy'] = section.id;
      mapping['exile'] = section.id;
    } else if (nameLower === 'board wipes') {
      mapping['board_wipe'] = section.id;
      mapping['sweeper'] = section.id;
      mapping['mass_removal'] = section.id;
    } else if (nameLower === 'lands') {
      mapping['land'] = section.id;
    } else if (nameLower === 'protection') {
      mapping['counterspell'] = section.id;
      mapping['protection'] = section.id;
      mapping['hexproof'] = section.id;
    }
  }
  return mapping;
}

// ==================== Section UI Helpers ====================

/**
 * Render section header with progress bar.
 */
export function renderSectionHeader(stats: SectionStats): HTMLElement {
  const { section, totalQty, isUnderMin, isOverMax } = stats;

  const progressPct = section.minCards
    ? Math.min(100, (totalQty / section.minCards) * 100)
    : 100;

  const statusClass = isUnderMin ? 'section-header--under' :
                      isOverMax ? 'section-header--over' : 'section-header--ok';

  return h('div', { className: `section-header ${statusClass}` },
    h('div', {
      className: 'section-header__color',
      style: `background-color: ${section.color}`,
    }),
    h('span', { className: 'section-header__name' }, section.name),
    h('span', { className: 'section-header__count' },
      section.minCards ? `${totalQty}/${section.minCards}` : String(totalQty),
    ),
    section.minCards ? h('div', { className: 'section-header__progress' },
      h('div', {
        className: 'section-header__progress-bar',
        style: `width: ${progressPct}%; background-color: ${section.color}`,
      }),
    ) : null,
  );
}

// ==================== Convert CustomCategory ↔ DeckSection ====================

/**
 * Convert CustomCategories (existing type) to DeckSections.
 */
export function fromCustomCategories(
  categories: CustomCategory[],
  board: DeckBoard
): DeckSection[] {
  return categories.map(cat => ({
    id: cat.id,
    name: cat.name,
    color: cat.color,
    board,
  }));
}

/**
 * Convert DeckSections back to CustomCategories.
 */
export function toCustomCategories(sections: DeckSection[]): CustomCategory[] {
  return sections.map(s => ({
    id: s.id,
    name: s.name,
    color: s.color,
  }));
}
