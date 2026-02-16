// ============================================================
// Inventory Service — Track owned cards, reserve across decks
// ============================================================
// Manages a user's card collection (owned copies), with
// reservations for specific deck repos/branches.
// ============================================================

import type { InventoryEntry } from './types.js';
import { generateId, now } from './types.js';

// ==================== Types ====================

export interface InventoryReservation {
  id: string;
  inventoryId: string;
  repoId: string;
  branchId: string;
  qty: number;
  createdAt: string;
}

export interface ReservationResult {
  success: boolean;
  reserved: Array<{ name: string; qty: number; available: number }>;
  conflicts: Array<{ name: string; requested: number; available: number }>;
}

export interface AvailabilityReport {
  cards: Array<{
    name: string;
    owned: number;
    reserved: number;
    available: number;
    inDeck: number;
    shortage: number;   // positive = need more
  }>;
  totalOwned: number;
  totalNeeded: number;
  totalShortage: number;
}

// ==================== Service ====================

export class InventoryService {
  constructor(private db: D1Database) {}

  /**
   * Add or update cards in inventory.
   */
  async addCards(ownerId: string, cards: Array<{ name: string; qty: number }>): Promise<void> {
    for (const { name, qty } of cards) {
      const existing = await this.db.prepare(
        'SELECT id, qty_owned FROM shared_inventory WHERE owner_id = ? AND card_name = ?'
      ).bind(ownerId, name).first<{ id: string; qty_owned: number }>();

      if (existing) {
        await this.db.prepare(
          'UPDATE shared_inventory SET qty_owned = ? WHERE id = ?'
        ).bind(existing.qty_owned + qty, existing.id).run();
      } else {
        await this.db.prepare(
          'INSERT INTO shared_inventory (id, owner_id, card_name, qty_owned, qty_reserved, created_at) VALUES (?, ?, ?, ?, 0, ?)'
        ).bind(generateId(), ownerId, name, qty, now()).run();
      }
    }
  }

  /**
   * Set exact quantity for a card.
   */
  async setCardQty(ownerId: string, name: string, qty: number): Promise<void> {
    const existing = await this.db.prepare(
      'SELECT id FROM shared_inventory WHERE owner_id = ? AND card_name = ?'
    ).bind(ownerId, name).first<{ id: string }>();

    if (existing) {
      if (qty <= 0) {
        // Check if has reservations
        const reserved = await this.db.prepare(
          'SELECT SUM(qty) as total FROM inventory_reservations WHERE inventory_id = ?'
        ).bind(existing.id).first<{ total: number }>();
        if (reserved && reserved.total > 0) {
          throw new Error(`Cannot remove ${name}: ${reserved.total} copies are reserved`);
        }
        await this.db.prepare('DELETE FROM shared_inventory WHERE id = ?').bind(existing.id).run();
      } else {
        await this.db.prepare('UPDATE shared_inventory SET qty_owned = ? WHERE id = ?').bind(qty, existing.id).run();
      }
    } else if (qty > 0) {
      await this.db.prepare(
        'INSERT INTO shared_inventory (id, owner_id, card_name, qty_owned, qty_reserved, created_at) VALUES (?, ?, ?, ?, 0, ?)'
      ).bind(generateId(), ownerId, name, qty, now()).run();
    }
  }

  /**
   * Get full inventory for a user.
   */
  async getInventory(ownerId: string): Promise<InventoryEntry[]> {
    const rows = await this.db.prepare(
      'SELECT id, card_name, qty_owned, qty_reserved FROM shared_inventory WHERE owner_id = ? ORDER BY card_name'
    ).bind(ownerId).all();

    return (rows.results || []).map(r => ({
      id: r.id as string,
      cardName: r.card_name as string,
      qtyOwned: r.qty_owned as number,
      qtyReserved: r.qty_reserved as number,
    }));
  }

  /**
   * Reserve cards for a specific deck repo/branch.
   */
  async reserveForDeck(
    ownerId: string,
    repoId: string,
    branchId: string,
    cards: Array<{ name: string; qty: number }>
  ): Promise<ReservationResult> {
    const reserved: ReservationResult['reserved'] = [];
    const conflicts: ReservationResult['conflicts'] = [];

    for (const { name, qty } of cards) {
      const inv = await this.db.prepare(
        'SELECT id, qty_owned, qty_reserved FROM shared_inventory WHERE owner_id = ? AND card_name = ?'
      ).bind(ownerId, name).first<{ id: string; qty_owned: number; qty_reserved: number }>();

      if (!inv) {
        conflicts.push({ name, requested: qty, available: 0 });
        continue;
      }

      const available = inv.qty_owned - inv.qty_reserved;
      if (available < qty) {
        conflicts.push({ name, requested: qty, available });
        continue;
      }

      // Check if there's already a reservation for this deck/branch
      const existing = await this.db.prepare(
        'SELECT id, qty FROM inventory_reservations WHERE inventory_id = ? AND repo_id = ? AND branch_id = ?'
      ).bind(inv.id, repoId, branchId).first<{ id: string; qty: number }>();

      if (existing) {
        // Update existing reservation
        const newQty = existing.qty + qty;
        await this.db.prepare(
          'UPDATE inventory_reservations SET qty = ? WHERE id = ?'
        ).bind(newQty, existing.id).run();
      } else {
        // Create new reservation
        await this.db.prepare(
          'INSERT INTO inventory_reservations (id, inventory_id, repo_id, branch_id, qty, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(generateId(), inv.id, repoId, branchId, qty, now()).run();
      }

      // Update reserved count
      await this.db.prepare(
        'UPDATE shared_inventory SET qty_reserved = qty_reserved + ? WHERE id = ?'
      ).bind(qty, inv.id).run();

      reserved.push({ name, qty, available: available - qty });
    }

    return {
      success: conflicts.length === 0,
      reserved,
      conflicts,
    };
  }

  /**
   * Release a reservation.
   */
  async releaseReservation(reservationId: string): Promise<void> {
    const res = await this.db.prepare(
      'SELECT inventory_id, qty FROM inventory_reservations WHERE id = ?'
    ).bind(reservationId).first<{ inventory_id: string; qty: number }>();

    if (!res) throw new Error('Reservation not found');

    await this.db.prepare('DELETE FROM inventory_reservations WHERE id = ?').bind(reservationId).run();
    await this.db.prepare(
      'UPDATE shared_inventory SET qty_reserved = MAX(0, qty_reserved - ?) WHERE id = ?'
    ).bind(res.qty, res.inventory_id).run();
  }

  /**
   * Release all reservations for a deck repo/branch.
   */
  async releaseAllForDeck(repoId: string, branchId: string): Promise<number> {
    const reservations = await this.db.prepare(
      'SELECT id, inventory_id, qty FROM inventory_reservations WHERE repo_id = ? AND branch_id = ?'
    ).bind(repoId, branchId).all();

    let count = 0;
    for (const r of reservations.results || []) {
      await this.db.prepare('DELETE FROM inventory_reservations WHERE id = ?').bind(r.id).run();
      await this.db.prepare(
        'UPDATE shared_inventory SET qty_reserved = MAX(0, qty_reserved - ?) WHERE id = ?'
      ).bind(r.qty, r.inventory_id).run();
      count++;
    }

    return count;
  }

  /**
   * Check availability of cards against inventory.
   */
  async checkAvailability(
    ownerId: string,
    deckCards: Array<{ name: string; qty: number }>
  ): Promise<AvailabilityReport> {
    const report: AvailabilityReport = {
      cards: [],
      totalOwned: 0,
      totalNeeded: 0,
      totalShortage: 0,
    };

    for (const { name, qty } of deckCards) {
      const inv = await this.db.prepare(
        'SELECT qty_owned, qty_reserved FROM shared_inventory WHERE owner_id = ? AND card_name = ?'
      ).bind(ownerId, name).first<{ qty_owned: number; qty_reserved: number }>();

      const owned = inv?.qty_owned || 0;
      const reserved = inv?.qty_reserved || 0;
      const available = owned - reserved;
      const shortage = Math.max(0, qty - available);

      report.cards.push({
        name,
        owned,
        reserved,
        available,
        inDeck: qty,
        shortage,
      });

      report.totalOwned += owned;
      report.totalNeeded += qty;
      report.totalShortage += shortage;
    }

    return report;
  }

  /**
   * Get reservations for a specific inventory entry.
   */
  async getReservations(ownerId: string, cardName: string): Promise<InventoryReservation[]> {
    const inv = await this.db.prepare(
      'SELECT id FROM shared_inventory WHERE owner_id = ? AND card_name = ?'
    ).bind(ownerId, cardName).first<{ id: string }>();

    if (!inv) return [];

    const rows = await this.db.prepare(
      'SELECT id, inventory_id, repo_id, branch_id, qty, created_at FROM inventory_reservations WHERE inventory_id = ?'
    ).bind(inv.id).all();

    return (rows.results || []).map(r => ({
      id: r.id as string,
      inventoryId: r.inventory_id as string,
      repoId: r.repo_id as string,
      branchId: r.branch_id as string,
      qty: r.qty as number,
      createdAt: r.created_at as string,
    }));
  }
}
