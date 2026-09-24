/**
 * CollabConstraints — Team Budget Constraints for collaborative deck editing.
 *
 * Set constraints: max budget, max card price, power level.
 * Constraints influence smart-recs and budget optimizer.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';

// ───── Types ─────

export interface TeamConstraint {
  id: string;
  deck_id: string;
  constraint_type: string;
  constraint_value: string;
  set_by: string;
  created_at: string;
}

// ───── State ─────

let constraints: TeamConstraint[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let initialized = false;

// ───── Public API ─────

export function initConstraints(currentDeckId: string): void {
  if (initialized) return;
  initialized = true;
  deckId = currentDeckId;

  const mgr = getCollabManager();
  mgr.on('constraint-event', onConstraintEvent);
  loadConstraints();
}

export function toggleConstraintPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isConstraintPanelOpen(): boolean {
  return panelVisible;
}

export function refreshConstraints(): void {
  loadConstraints();
}

/** Get a constraint value by type */
export function getConstraint(type: string): string | null {
  const c = constraints.find((c) => c.constraint_type === type);
  return c ? c.constraint_value : null;
}

/** Get max budget (for smart-recs, budget optimizer) */
export function getMaxBudget(): number | null {
  const val = getConstraint('max_budget');
  if (!val) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Get max single card price */
export function getMaxCardPrice(): number | null {
  const val = getConstraint('max_card_price');
  if (!val) return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Get power level target (informational) */
export function getPowerLevel(): number | null {
  const val = getConstraint('power_level');
  if (!val) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

/** Cleanup */
export function resetConstraints(): void {
  constraints = [];
  initialized = false;
  if (panelEl) panelEl.remove();
  panelEl = null;
  panelVisible = false;
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadConstraints(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/constraints`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { constraints: TeamConstraint[] } };
    if (data.ok && data.data?.constraints) {
      constraints = data.data.constraints;
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

async function setConstraint(type: string, value: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/constraints`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ constraintType: type, constraintValue: value }),
    });
    if (resp.ok) {
      const mgr = getCollabManager();
      if (mgr.isConnected) {
        mgr.sendConstraintNotify('set', type, value);
      }
      await loadConstraints();
    }
  } catch { /* ignore */ }
}

async function removeConstraint(constraintId: string, constraintType: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/constraints/${constraintId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (resp.ok) {
      const mgr = getCollabManager();
      if (mgr.isConnected) {
        mgr.sendConstraintNotify('removed', constraintType);
      }
      await loadConstraints();
    }
  } catch { /* ignore */ }
}

// ───── Event Handlers ─────

function onConstraintEvent(_event: CollabEvent): void {
  loadConstraints();
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadConstraints(); return; }

  panelEl = h('div', { className: 'constraint-panel' },
    h('div', { className: 'constraint-header' },
 h('span', { className: 'constraint-title' }, ' Team Constraints'),
 h('button', { className: 'constraint-close', onClick: () => toggleConstraintPanel(), title: 'Close' }, '✕'),
    ),
    h('div', { className: 'constraint-body', id: '_constraintBody' }),
  );
  document.body.appendChild(panelEl);
  renderPanel();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderPanel(): void {
  const container = document.getElementById('_constraintBody');
  if (!container) return;

  const budgetVal = getConstraint('max_budget') || '';
  const cardPriceVal = getConstraint('max_card_price') || '';
  const powerVal = getConstraint('power_level') || '';

  const budgetConstraint = constraints.find((c) => c.constraint_type === 'max_budget');
  const cardPriceConstraint = constraints.find((c) => c.constraint_type === 'max_card_price');
  const powerConstraint = constraints.find((c) => c.constraint_type === 'power_level');

  container.replaceChildren(
    h('div', { className: 'constraint-info' },
      'Set constraints to guide deckbuilding decisions. These affect smart recommendations and budget suggestions for all team members.',
    ),

    // Max Budget
    h('div', { className: 'constraint-row' },
 h('label', { className: 'constraint-label' }, ' Max Total Budget (\u20AC)'),
      h('div', { className: 'constraint-input-row' },
        h('input', {
          type: 'number',
          className: 'constraint-input',
          id: '_conBudget',
          placeholder: 'e.g. 100',
          value: budgetVal,
          min: '0',
          step: '5',
        }),
        h('button', {
          className: 'constraint-set-btn',
          onClick: () => {
            const val = (document.getElementById('_conBudget') as HTMLInputElement)?.value?.trim();
            if (val) setConstraint('max_budget', val);
          },
        }, 'Set'),
        ...(budgetConstraint ? [
          h('button', {
            className: 'constraint-remove-btn',
            onClick: () => removeConstraint(budgetConstraint.id, 'max_budget'),
            title: 'Remove constraint',
 }, '✕'),
          h('span', { className: 'constraint-set-by' }, `by ${budgetConstraint.set_by}`),
        ] : []),
      ),
    ),

    // Max Card Price
    h('div', { className: 'constraint-row' },
 h('label', { className: 'constraint-label' }, ' Max Single Card Price (\u20AC)'),
      h('div', { className: 'constraint-input-row' },
        h('input', {
          type: 'number',
          className: 'constraint-input',
          id: '_conCardPrice',
          placeholder: 'e.g. 10',
          value: cardPriceVal,
          min: '0',
          step: '1',
        }),
        h('button', {
          className: 'constraint-set-btn',
          onClick: () => {
            const val = (document.getElementById('_conCardPrice') as HTMLInputElement)?.value?.trim();
            if (val) setConstraint('max_card_price', val);
          },
        }, 'Set'),
        ...(cardPriceConstraint ? [
          h('button', {
            className: 'constraint-remove-btn',
            onClick: () => removeConstraint(cardPriceConstraint.id, 'max_card_price'),
            title: 'Remove constraint',
 }, '✕'),
          h('span', { className: 'constraint-set-by' }, `by ${cardPriceConstraint.set_by}`),
        ] : []),
      ),
    ),

    // Power Level
    h('div', { className: 'constraint-row' },
 h('label', { className: 'constraint-label' }, '▲ Power Level Target (1-10)'),
      h('div', { className: 'constraint-input-row' },
        h('input', {
          type: 'number',
          className: 'constraint-input',
          id: '_conPower',
          placeholder: 'e.g. 7',
          value: powerVal,
          min: '1',
          max: '10',
          step: '1',
        }),
        h('button', {
          className: 'constraint-set-btn',
          onClick: () => {
            const val = (document.getElementById('_conPower') as HTMLInputElement)?.value?.trim();
            if (val) setConstraint('power_level', val);
          },
        }, 'Set'),
        ...(powerConstraint ? [
          h('button', {
            className: 'constraint-remove-btn',
            onClick: () => removeConstraint(powerConstraint.id, 'power_level'),
            title: 'Remove constraint',
 }, '✕'),
          h('span', { className: 'constraint-set-by' }, `by ${powerConstraint.set_by}`),
        ] : []),
      ),
    ),

    // Active Constraints summary
    constraints.length > 0
      ? h('div', { className: 'constraint-active-list' },
          h('div', { className: 'constraint-active-title' }, 'Active Constraints'),
          ...constraints.map((c) =>
            h('div', { className: 'constraint-active-item' },
              h('span', { className: 'constraint-active-type' }, formatConstraintType(c.constraint_type)),
              h('span', { className: 'constraint-active-value' }, formatConstraintValue(c.constraint_type, c.constraint_value)),
              h('span', { className: 'constraint-active-by' }, `set by ${c.set_by}`),
            ),
          ),
        )
      : h('div', { className: 'constraint-none' }, 'No constraints set yet.'),
  );
}

// ───── Utilities ─────

function formatConstraintType(type: string): string {
  const names: Record<string, string> = {
 max_budget: ' Budget',
 max_card_price: ' Max Card',
 power_level: '▲ Power',
  };
  return names[type] || type;
}

function formatConstraintValue(type: string, value: string): string {
  if (type === 'max_budget' || type === 'max_card_price') return `\u20AC${value}`;
  if (type === 'power_level') return `Level ${value}/10`;
  return value;
}
