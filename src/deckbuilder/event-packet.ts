// ============================================================
// Event Packet — PDF/printable deck export
// ============================================================
// Generate a printable event registration packet:
// decklist, sideboard, commander info, combo notes,
// budget summary. Uses browser print CSS.
// ============================================================

import type { DeckbuilderBoards, DeckbuilderCardEntry, DeckBoard } from './types.js';

// ==================== Types ====================

export interface EventPacketOptions {
  deckName: string;
  playerName: string;
  format: string;
  eventName?: string;
  eventDate?: string;
  includeComboNotes?: boolean;
  includeBudget?: boolean;
  includeSections?: boolean;
  comboNotes?: string[];
  budgetTotal?: number;
  sectionMap?: Record<string, string[]>;  // sectionName → cardNames
}

export interface PacketCard {
  name: string;
  qty: number;
  board: DeckBoard;
  section?: string;
  price?: number;
}

// ==================== Generator ====================

/**
 * Generate an event packet as a printable HTML document.
 * Opens in a new window for printing.
 */
export function generateEventPacket(
  boards: DeckbuilderBoards,
  options: EventPacketOptions
): void {
  const html = buildPacketHTML(boards, options);
  const printWindow = window.open('', '_blank', 'width=800,height=1100');
  if (!printWindow) {
    alert('Please allow popups to print the event packet.');
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();

  // Auto-print after a short delay for rendering
  setTimeout(() => {
    printWindow.print();
  }, 500);
}

/**
 * Generate event packet HTML string (for embedding or download).
 */
export function buildPacketHTML(
  boards: DeckbuilderBoards,
  options: EventPacketOptions
): string {
  const allCards = collectCards(boards);
  const totalCards = allCards.reduce((sum, c) => sum + c.qty, 0);
  const commanderCards = boards.commander;
  const mainboardCards = boards.mainboard;
  const sideboardCards = boards.sideboard;

  const commanderNames = commanderCards.map(c => c.name).join(' / ');
  const mainboardCount = mainboardCards.reduce((s, c) => s + c.qty, 0);
  const sideboardCount = sideboardCards.reduce((s, c) => s + c.qty, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Event Packet — ${escapeHtml(options.deckName)}</title>
  <style>
    ${getPacketCSS()}
  </style>
</head>
<body>
  <div class="packet">
    <!-- Header -->
    <header class="packet-header">
      <div class="packet-header__left">
        <h1 class="packet-header__title">${escapeHtml(options.deckName)}</h1>
        ${commanderNames ? `<p class="packet-header__commander">Commander: ${escapeHtml(commanderNames)}</p>` : ''}
        <p class="packet-header__format">Format: ${escapeHtml(options.format)} · ${totalCards} cards</p>
      </div>
      <div class="packet-header__right">
        <p><strong>Player:</strong> ${escapeHtml(options.playerName)}</p>
        ${options.eventName ? `<p><strong>Event:</strong> ${escapeHtml(options.eventName)}</p>` : ''}
        ${options.eventDate ? `<p><strong>Date:</strong> ${escapeHtml(options.eventDate)}</p>` : ''}
      </div>
    </header>

    <hr>

    <!-- Commander -->
    ${commanderCards.length > 0 ? `
    <section class="packet-section">
      <h2 class="packet-section__title">Commander (${commanderCards.length})</h2>
      <div class="packet-cards">
        ${commanderCards.map(c => renderCardLine(c)).join('\n')}
      </div>
    </section>
    ` : ''}

    <!-- Mainboard -->
    <section class="packet-section">
      <h2 class="packet-section__title">Mainboard (${mainboardCount})</h2>
      ${options.includeSections && options.sectionMap
        ? renderBySections(mainboardCards, options.sectionMap)
        : renderCardList(mainboardCards)}
    </section>

    <!-- Sideboard -->
    ${sideboardCount > 0 ? `
    <section class="packet-section">
      <h2 class="packet-section__title">Sideboard (${sideboardCount})</h2>
      ${renderCardList(sideboardCards)}
    </section>
    ` : ''}

    <!-- Combo Notes -->
    ${options.includeComboNotes && options.comboNotes && options.comboNotes.length > 0 ? `
    <section class="packet-section packet-section--combos">
      <h2 class="packet-section__title">Combo Lines</h2>
      <ol class="packet-combos">
        ${options.comboNotes.map(note => `<li>${escapeHtml(note)}</li>`).join('\n')}
      </ol>
    </section>
    ` : ''}

    <!-- Budget Summary -->
    ${options.includeBudget && options.budgetTotal !== undefined ? `
    <section class="packet-section packet-section--budget">
      <h2 class="packet-section__title">Budget</h2>
      <p class="packet-budget">Estimated Total: <strong>$${options.budgetTotal.toFixed(2)}</strong></p>
    </section>
    ` : ''}

    <!-- Footer -->
    <footer class="packet-footer">
      <p>Generated by DeckLens · ${new Date().toLocaleDateString()}</p>
    </footer>
  </div>
</body>
</html>`;
}

// ==================== Card Rendering ====================

function renderCardLine(card: DeckbuilderCardEntry): string {
  return `<div class="packet-card">
    <span class="packet-card__qty">${card.qty}</span>
    <span class="packet-card__name">${escapeHtml(card.name)}</span>
    ${card.set ? `<span class="packet-card__set">(${escapeHtml(card.set)})</span>` : ''}
  </div>`;
}

function renderCardList(cards: DeckbuilderCardEntry[]): string {
  // Sort alphabetically
  const sorted = [...cards].sort((a, b) => a.name.localeCompare(b.name));

  // Split into columns
  const mid = Math.ceil(sorted.length / 2);
  const col1 = sorted.slice(0, mid);
  const col2 = sorted.slice(mid);

  return `<div class="packet-cards packet-cards--columns">
    <div class="packet-cards__col">
      ${col1.map(c => renderCardLine(c)).join('\n')}
    </div>
    <div class="packet-cards__col">
      ${col2.map(c => renderCardLine(c)).join('\n')}
    </div>
  </div>`;
}

function renderBySections(
  cards: DeckbuilderCardEntry[],
  sectionMap: Record<string, string[]>
): string {
  const sections: string[] = [];
  const assigned = new Set<string>();

  for (const [sectionName, cardNames] of Object.entries(sectionMap)) {
    const cardNameSet = new Set(cardNames.map(n => n.toLowerCase()));
    const sectionCards = cards.filter(c => {
      if (cardNameSet.has(c.name.toLowerCase())) {
        assigned.add(c.name.toLowerCase());
        return true;
      }
      return false;
    });

    if (sectionCards.length === 0) continue;

    const count = sectionCards.reduce((s, c) => s + c.qty, 0);
    sections.push(`
      <div class="packet-subsection">
        <h3 class="packet-subsection__title">${escapeHtml(sectionName)} (${count})</h3>
        <div class="packet-cards">
          ${sectionCards.sort((a, b) => a.name.localeCompare(b.name)).map(c => renderCardLine(c)).join('\n')}
        </div>
      </div>
    `);
  }

  // Unassigned cards
  const unassigned = cards.filter(c => !assigned.has(c.name.toLowerCase()));
  if (unassigned.length > 0) {
    const count = unassigned.reduce((s, c) => s + c.qty, 0);
    sections.push(`
      <div class="packet-subsection">
        <h3 class="packet-subsection__title">Other (${count})</h3>
        <div class="packet-cards">
          ${unassigned.sort((a, b) => a.name.localeCompare(b.name)).map(c => renderCardLine(c)).join('\n')}
        </div>
      </div>
    `);
  }

  return sections.join('\n');
}

// ==================== CSS ====================

function getPacketCSS(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Segoe UI', -apple-system, sans-serif;
      font-size: 10pt;
      color: #1a1a1a;
      background: #fff;
      line-height: 1.4;
    }

    .packet {
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
    }

    .packet-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 12px;
    }

    .packet-header__title {
      font-size: 16pt;
      font-weight: 700;
      color: #111;
    }

    .packet-header__commander {
      font-size: 11pt;
      color: #333;
      font-style: italic;
    }

    .packet-header__format {
      font-size: 9pt;
      color: #666;
    }

    .packet-header__right {
      text-align: right;
      font-size: 9pt;
    }

    hr {
      border: none;
      border-top: 1px solid #ccc;
      margin: 8px 0;
    }

    .packet-section {
      margin-bottom: 12px;
    }

    .packet-section__title {
      font-size: 11pt;
      font-weight: 700;
      border-bottom: 1px solid #ddd;
      padding-bottom: 2px;
      margin-bottom: 4px;
    }

    .packet-cards--columns {
      display: flex;
      gap: 20px;
    }

    .packet-cards__col {
      flex: 1;
    }

    .packet-card {
      display: flex;
      align-items: baseline;
      padding: 1px 0;
      font-size: 9pt;
    }

    .packet-card__qty {
      width: 18px;
      font-weight: 600;
      text-align: right;
      margin-right: 6px;
      color: #555;
    }

    .packet-card__name {
      flex: 1;
    }

    .packet-card__set {
      font-size: 8pt;
      color: #999;
      margin-left: 4px;
    }

    .packet-subsection {
      margin-bottom: 8px;
    }

    .packet-subsection__title {
      font-size: 9pt;
      font-weight: 600;
      color: #444;
      margin-bottom: 2px;
    }

    .packet-combos {
      padding-left: 20px;
      font-size: 9pt;
    }

    .packet-combos li {
      margin-bottom: 2px;
    }

    .packet-budget {
      font-size: 10pt;
    }

    .packet-footer {
      margin-top: 16px;
      padding-top: 8px;
      border-top: 1px solid #ddd;
      text-align: center;
      font-size: 8pt;
      color: #999;
    }

    /* Print styles */
    @media print {
      body { font-size: 9pt; }
      .packet { padding: 10px; max-width: none; }
      .packet-header__title { font-size: 14pt; }
      .packet-section__title { font-size: 10pt; }
      .packet-card { font-size: 8.5pt; }

      @page {
        margin: 1cm;
        size: letter;
      }
    }
  `;
}

// ==================== Helpers ====================

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function collectCards(boards: DeckbuilderBoards): PacketCard[] {
  const cards: PacketCard[] = [];
  for (const [board, list] of Object.entries(boards) as [DeckBoard, DeckbuilderCardEntry[]][]) {
    for (const card of list) {
      cards.push({
        name: card.name,
        qty: card.qty,
        board,
      });
    }
  }
  return cards;
}

// ==================== Download as HTML ====================

/**
 * Download the event packet as an HTML file.
 */
export function downloadPacketHTML(
  boards: DeckbuilderBoards,
  options: EventPacketOptions
): void {
  const html = buildPacketHTML(boards, options);
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `${options.deckName.replace(/\s+/g, '_')}_packet.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
