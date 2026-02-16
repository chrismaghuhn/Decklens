// ==================== Landing Page Entry Point ====================
// Extracted from index.html inline <script> block for CSP compliance.
// CSP: script-src 'self' forbids inline scripts.

document.addEventListener('DOMContentLoaded', () => {
  const legalModal = document.getElementById('legalModal');
  const legalContent = document.getElementById('legalContent');

  // Close modal via X button
  const closeBtn = legalModal?.querySelector('.modal-close');
  closeBtn?.addEventListener('click', () => {
    if (legalModal) legalModal.style.display = 'none';
  });

  // Close modal via backdrop click
  legalModal?.addEventListener('click', (e) => {
    if (e.target === legalModal) {
      legalModal.style.display = 'none';
    }
  });

  // Close modal via Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && legalModal?.style.display === 'flex') {
      legalModal.style.display = 'none';
    }
  });

  // Impressum link
  document.getElementById('linkImpressum')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (legalContent) {
      legalContent.textContent = '';
      const h2 = document.createElement('h2');
      h2.textContent = 'Impressum';
      const p = document.createElement('p');
      p.textContent = 'DeckLens is an open-source project for deck viewing and analysis.';
      legalContent.appendChild(h2);
      legalContent.appendChild(p);
    }
    if (legalModal) legalModal.style.display = 'flex';
  });

  // Datenschutz link
  document.getElementById('linkDatenschutz')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (legalContent) {
      legalContent.textContent = '';
      const h2 = document.createElement('h2');
      h2.textContent = 'Privacy Policy';
      const p = document.createElement('p');
      p.textContent =
        'DeckLens stores data locally in your browser. No data is transmitted to external servers except for card data APIs (Scryfall, YGOProDeck).';
      legalContent.appendChild(h2);
      legalContent.appendChild(p);
    }
    if (legalModal) legalModal.style.display = 'flex';
  });
});
