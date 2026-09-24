/**
 * Legal Footer Component
 *
 * Displays legal disclaimer for DeckLens
 */

export function renderLegalFooter(container: HTMLElement): void {
  container.innerHTML = `
    <footer class="legal-footer">
      <div class="legal-footer-content">
        <div class="legal-disclaimer">
          <p class="legal-title">Legal Disclaimer</p>
          <p class="legal-text">
            <strong>DeckLens</strong> is an unofficial fan-made project and is not affiliated with, endorsed by,
            or sponsored by Wizards of the Coast LLC, Hasbro, or Konami Digital Entertainment.
          </p>
          <p class="legal-text">
            <strong>Magic: The Gathering</strong> and all related card names, artwork, and game elements are
            trademarks and copyrights of Wizards of the Coast LLC, a subsidiary of Hasbro, Inc.
          </p>
          <p class="legal-text">
            <strong>Yu-Gi-Oh!</strong> and all related card names, artwork, and game elements are
            trademarks and copyrights of Konami Digital Entertainment.
          </p>
          <p class="legal-text legal-data-source">
            Card data provided by <a href="https://scryfall.com" target="_blank" rel="noopener">Scryfall</a>
            (MTG) and <a href="https://ygoprodeck.com" target="_blank" rel="noopener">YGOPRODeck</a> (Yu-Gi-Oh!).
            Combo data from <a href="https://commanderspellbook.com" target="_blank" rel="noopener">Commander Spellbook</a>.
          </p>
        </div>

        <div class="legal-links">
          <a href="https://github.com/yourusername/decklens" target="_blank" rel="noopener">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            GitHub
          </a>
          <span class="legal-separator">•</span>
          <a href="mailto:legal@decklens.app">Contact</a>
          <span class="legal-separator">•</span>
          <span class="legal-version">v26</span>
        </div>
      </div>
    </footer>
  `;
}

/**
 * Inject footer styles
 */
export function injectLegalFooterStyles(): void {
  if (document.getElementById('legal-footer-styles')) return;

  const style = document.createElement('style');
  style.id = 'legal-footer-styles';
  style.textContent = `
    .legal-footer {
      background: var(--void, #0a0e17);
      border-top: 1px solid var(--border, #2a2f3e);
      padding: 32px 20px 24px;
      margin-top: 60px;
      font-family: 'Outfit', sans-serif;
    }

    .legal-footer-content {
      max-width: 900px;
      margin: 0 auto;
    }

    .legal-disclaimer {
      margin-bottom: 24px;
    }

    .legal-title {
      font-family: 'Cinzel', serif;
      font-size: 14px;
      font-weight: 600;
      color: var(--cobalt, #c9a84c);
      margin: 0 0 12px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .legal-text {
      font-size: 12px;
      line-height: 1.6;
      color: var(--text-dim, #999);
      margin: 0 0 8px 0;
    }

    .legal-text strong {
      color: var(--text, #e0e0e0);
      font-weight: 600;
    }

    .legal-data-source {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--line-dim, #1a1f2e);
    }

    .legal-text a {
      color: var(--cobalt, #c9a84c);
      text-decoration: none;
      transition: color 0.2s;
    }

    .legal-text a:hover {
      color: #f0e68c;
      text-decoration: underline;
    }

    .legal-links {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      font-size: 12px;
      color: var(--text-dim, #999);
    }

    .legal-links a {
      color: var(--cobalt, #c9a84c);
      text-decoration: none;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: color 0.2s;
    }

    .legal-links a:hover {
      color: #f0e68c;
    }

    .legal-links svg {
      opacity: 0.8;
    }

    .legal-separator {
      color: var(--line-dim, #1a1f2e);
    }

    .legal-version {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      opacity: 0.6;
    }

    @media (max-width: 768px) {
      .legal-footer {
        padding: 24px 16px 20px;
      }

      .legal-text {
        font-size: 11px;
      }

      .legal-links {
        flex-wrap: wrap;
        gap: 8px;
      }
    }
  `;

  document.head.appendChild(style);
}
