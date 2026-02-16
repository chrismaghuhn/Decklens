/**
 * Card Renderer — Creates card DOM elements for all zones.
 * Uses Scryfall image API for card images.
 */

import type { Card, Permanent } from '@mtg/game-engine';
import { isCreature } from '@mtg/game-engine';

const SCRYFALL_IMG = 'https://api.scryfall.com/cards/named';

/** Get Scryfall image URL for a card */
export function getCardImageUrl(cardName: string, version: 'normal' | 'small' = 'normal'): string {
  return `${SCRYFALL_IMG}?exact=${encodeURIComponent(cardName)}&format=image&version=${version}`;
}

/** Create a card element for the hand zone */
export function renderHandCard(card: Card, onClick?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pvb-card';
  el.dataset.cardId = card.id;
  el.dataset.cardName = card.name;

  const img = document.createElement('img');
  img.src = getCardImageUrl(card.name, 'normal');
  img.alt = card.name;
  img.loading = 'lazy';
  img.onerror = () => {
    img.remove();
    el.appendChild(createNameFallback(card.name));
  };
  el.appendChild(img);

  if (onClick) el.addEventListener('click', onClick);
  addHoverPreview(el, card.name);

  return el;
}

/** Create a card element for the battlefield */
export function renderBattlefieldCard(
  perm: Permanent,
  onClick?: () => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pvb-card';
  if (perm.tapped) el.classList.add('tapped');
  el.dataset.permanentId = perm.id;
  el.dataset.cardName = perm.name;

  const img = document.createElement('img');
  img.src = getCardImageUrl(perm.name, 'normal');
  img.alt = perm.name;
  img.loading = 'lazy';
  img.onerror = () => {
    img.remove();
    el.appendChild(createNameFallback(perm.name));
  };
  el.appendChild(img);

  // P/T badge for creatures
  if (isCreature(perm)) {
    const pt = document.createElement('span');
    pt.className = 'pt-badge';
    pt.textContent = `${perm.currentPower ?? perm.power}/${perm.currentToughness ?? perm.toughness}`;
    el.appendChild(pt);
  }

  // Summoning sickness indicator
  if (isCreature(perm) && perm.summoningSick) {
    const sick = document.createElement('span');
    sick.className = 'summoning-sick';
    sick.textContent = 'ZZZ';
    el.appendChild(sick);
  }

  if (onClick) el.addEventListener('click', onClick);
  addHoverPreview(el, perm.name);

  return el;
}

/** Create a commander card element (small, with gold border) */
export function renderCommanderCard(card: Card): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pvb-opp-commander';
  const img = document.createElement('img');
  img.src = getCardImageUrl(card.name, 'small');
  img.alt = card.name;
  img.loading = 'lazy';
  el.appendChild(img);
  addHoverPreview(el, card.name);
  return el;
}

/** Render card backs for opponent's hand */
export function renderCardBacks(count: number): HTMLElement[] {
  return Array.from({ length: count }, () => {
    const el = document.createElement('div');
    el.className = 'pvb-card-back';
    return el;
  });
}

/** Render a visible opponent card (perfect information — small card with image) */
export function renderVisibleOpponentCard(card: Card): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pvb-opp-visible-card';
  el.dataset.cardName = card.name;

  const img = document.createElement('img');
  img.src = getCardImageUrl(card.name, 'small');
  img.alt = card.name;
  img.loading = 'lazy';
  img.onerror = () => {
    img.remove();
    const fallback = document.createElement('span');
    fallback.className = 'pvb-opp-card-name';
    fallback.textContent = card.name;
    el.appendChild(fallback);
  };
  el.appendChild(img);
  addHoverPreview(el, card.name);
  return el;
}

/** Name-only fallback when image fails to load */
function createNameFallback(name: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'pvb-card-name-fallback';
  el.textContent = name;
  return el;
}

/** Attach hover preview behavior to an element */
function addHoverPreview(el: HTMLElement, cardName: string): void {
  el.addEventListener('mouseenter', (e) => showPreview(cardName, e));
  el.addEventListener('mousemove', (e) => movePreview(e));
  el.addEventListener('mouseleave', hidePreview);
}

// === Card Preview ===
let previewEl: HTMLElement | null = null;

function getPreview(): HTMLElement | null {
  if (!previewEl) previewEl = document.getElementById('card-preview');
  return previewEl;
}

function showPreview(cardName: string, e: MouseEvent): void {
  const preview = getPreview();
  if (!preview) return;
  const img = preview.querySelector('img');
  if (img) {
    img.src = getCardImageUrl(cardName, 'normal');
    img.alt = cardName;
  }
  movePreview(e);
  preview.classList.add('visible');
}

function movePreview(e: MouseEvent): void {
  const preview = getPreview();
  if (!preview) return;
  const w = 250;
  const h = 350;
  let left = e.clientX + 16;
  let top = e.clientY - h / 2;
  if (left + w > window.innerWidth) left = e.clientX - w - 16;
  if (top < 8) top = 8;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}

function hidePreview(): void {
  const preview = getPreview();
  if (preview) preview.classList.remove('visible');
}
