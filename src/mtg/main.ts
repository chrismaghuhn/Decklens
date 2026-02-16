// ==================== MTG Main Entry Point ====================
// Entry point for mtg.html - binds events and initializes app

import * as app from './app.js';
import {
  initToolsDrawer,
  openDrawer as openToolsDrawer,
  closeDrawer as closeToolsDrawer,
  isDrawerOpen as isToolsDrawerOpen,
} from './tools-drawer.js';

const DEBUG_LOG_ENABLED = (globalThis as { DECKLENS_DEBUG?: boolean }).DECKLENS_DEBUG === true;
const debugLog = (...args: unknown[]): void => {
  if (DEBUG_LOG_ENABLED) {
    console.log(...args);
  }
};

// ==================== GLOBAL ERROR HANDLER ====================
window.addEventListener('error', (e: ErrorEvent) => {
  console.error('[global error]', e.error || e.message);
  if (!e.message?.includes('Script error')) {
    app.showToast('Something went wrong. Please reload.');
  }
});

window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  console.error('[unhandled promise]', e.reason);
});

// ==================== EVENT DELEGATION ====================
document.addEventListener('DOMContentLoaded', () => {
  debugLog('[MTG Main] DOMContentLoaded fired');
  
  // Initialize tools drawer first
  initToolsDrawer();
  
  // ==================== CLICK DELEGATION ====================
  document.body.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    
    if (actionEl) {
      e.preventDefault();
      const action = actionEl.getAttribute('data-action');
      handleAction(action || '', actionEl, e);
    }
  });

  // ==================== CARD HOVER PREVIEW ====================
  const getHoverCardElement = (target: EventTarget | null): HTMLElement | null => {
    const el = target instanceof HTMLElement
      ? (target.closest('[data-action="open-modal"][data-card]') as HTMLElement | null)
      : null;
    if (!el) return null;
    if (el.closest('#modal') || el.closest('#legalModal')) return null;
    return el;
  };

  const getSymbolToken = (target: EventTarget | null): HTMLElement | null => {
    return target instanceof HTMLElement
      ? (target.closest('.mtg-symbol-token') as HTMLElement | null)
      : null;
  };

  document.body.addEventListener('mouseover', (e: MouseEvent) => {
    const cardEl = getHoverCardElement(e.target);
    if (!cardEl) return;
    const related = e.relatedTarget as Node | null;
    if (related && cardEl.contains(related)) return;
    const cardName = cardEl.dataset.card || '';
    if (cardName) app.showPreview(cardName, e);
  });

  document.body.addEventListener('mousemove', (e: MouseEvent) => {
    app.movePreview(e);
    app.moveSymbolTooltip(e);
  });

  document.body.addEventListener('mouseout', (e: MouseEvent) => {
    const cardEl = getHoverCardElement(e.target);
    if (!cardEl) return;

    const related = e.relatedTarget as Node | null;
    if (related && cardEl.contains(related)) return;

    const nextCard = related instanceof HTMLElement
      ? (related.closest('[data-action="open-modal"][data-card]') as HTMLElement | null)
      : null;
    if (!nextCard) app.hidePreview();
  });

  document.body.addEventListener('mouseover', (e: MouseEvent) => {
    const token = getSymbolToken(e.target);
    if (!token) return;

    const related = e.relatedTarget as Node | null;
    if (related && token.contains(related)) return;

    const tip = token.dataset.tip || token.getAttribute('aria-label') || '';
    if (tip) app.showSymbolTooltip(tip, e, token);
  });

  document.body.addEventListener('mouseout', (e: MouseEvent) => {
    const token = getSymbolToken(e.target);
    if (!token) return;

    const related = e.relatedTarget as Node | null;
    if (related && token.contains(related)) return;

    const nextToken = related instanceof HTMLElement
      ? (related.closest('.mtg-symbol-token') as HTMLElement | null)
      : null;
    if (!nextToken) app.hideSymbolTooltip();
  });

  document.body.addEventListener('focusin', (e: FocusEvent) => {
    const token = getSymbolToken(e.target);
    if (!token) return;
    const tip = token.dataset.tip || token.getAttribute('aria-label') || '';
    if (tip) app.showSymbolTooltip(tip, undefined, token);
  });

  document.body.addEventListener('focusout', (e: FocusEvent) => {
    const token = getSymbolToken(e.target);
    if (!token) return;
    app.hideSymbolTooltip();
  });

  window.addEventListener('scroll', () => {
    app.hideSymbolTooltip();
  }, true);
  
  // Tools drawer button
  const btnToolsDrawer = document.getElementById('btnToolsDrawer');
  btnToolsDrawer?.addEventListener('click', openToolsDrawer);

  // Card modal close handlers
  const modal = document.getElementById('modal');
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      app.closeModal();
      app.hideSymbolTooltip();
    }
  });
  const recApplyModal = document.getElementById('recApplyModal');
  recApplyModal?.addEventListener('click', (e) => {
    app.closeRecommendationApplyOnOverlay(e.target);
  });
  const flowTop3Modal = document.getElementById('flowTop3Modal');
  flowTop3Modal?.addEventListener('click', (e) => {
    app.closeFlowTop3OnOverlay(e.target);
  });
  const flowAnalysisBackdrop = document.getElementById('flowAnalysisBackdrop');
  flowAnalysisBackdrop?.addEventListener('click', (e) => {
    app.closeFlowAnalysisOnBackdrop(e.target);
  });
  document.querySelectorAll('#modal .modal-close').forEach(btn => {
    btn.addEventListener('click', () => app.closeModal());
  });
  
  // ==================== FILE INPUT HANDLERS ====================
  const deckFileInput = document.getElementById('deckFileInput') as HTMLInputElement;
  debugLog('[MTG Main] deckFileInput found:', !!deckFileInput);
  if (deckFileInput) {
    deckFileInput.addEventListener('change', () => {
      debugLog('[MTG Main] deckFileInput changed, files:', deckFileInput.files?.length);
      if (deckFileInput.files?.[0]) {
        app.handleFile(deckFileInput.files[0]);
        deckFileInput.value = '';
      }
    });
  }
  
  // Dropzone drag & drop
  const dropzone = document.getElementById('dropzone');
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer?.files[0];
      if (file) {
        app.handleFile(file);
      }
    });
  }
  
  // ==================== IMPORT BUTTONS ====================
  const btnPaste = document.getElementById('btnImportPaste');
  debugLog('[MTG Main] btnImportPaste found:', !!btnPaste);
  btnPaste?.addEventListener('click', () => {
    debugLog('[MTG Main] btnImportPaste clicked');
    app.importPaste();
  });
  
  const btnUrl = document.getElementById('btnImportUrl');
  debugLog('[MTG Main] btnImportUrl found:', !!btnUrl);
  btnUrl?.addEventListener('click', () => {
    debugLog('[MTG Main] btnImportUrl clicked');
    app.importUrl();
  });

  const btnUrlAuto = document.getElementById('btnImportUrlAuto');
  debugLog('[MTG Main] btnImportUrlAuto found:', !!btnUrlAuto);
  btnUrlAuto?.addEventListener('click', () => {
    debugLog('[MTG Main] btnImportUrlAuto clicked');
    app.importUrlAutoPaste();
  });

  const btnPasteClipboardNow = document.getElementById('btnPasteClipboardNow');
  debugLog('[MTG Main] btnPasteClipboardNow found:', !!btnPasteClipboardNow);
  btnPasteClipboardNow?.addEventListener('click', () => {
    debugLog('[MTG Main] btnPasteClipboardNow clicked');
    app.importClipboardNow();
  });

  // Flow step controls
  document.getElementById('flowStepImport')?.addEventListener('click', () => app.goToFlowStep('import'));
  document.getElementById('flowStepAnalyze')?.addEventListener('click', () => app.goToFlowStep('analysis'));
  document.getElementById('flowStepRecommend')?.addEventListener('click', () => app.goToFlowStep('recommend'));
  document.getElementById('flowStepApply')?.addEventListener('click', () => app.goToFlowStep('apply'));
  document.getElementById('flowStepExport')?.addEventListener('click', () => app.goToFlowStep('export'));
  document.getElementById('btnFlowPrimaryCta')?.addEventListener('click', () => app.handleFlowPrimaryAction());
  document.getElementById('btnFlowRetry')?.addEventListener('click', () => app.retryLastImport());
  
  // ==================== THEME & PRINT ====================
  document.getElementById('btnTheme')?.addEventListener('click', () => app.toggleTheme());
  document.getElementById('btnPrint')?.addEventListener('click', () => window.print());
  
  // ==================== VIEW BUTTONS ====================
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view') || 'card';
      app.setView(view);
      // Update active state
      document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  
  // ==================== HAND SIMULATOR ====================
  document.getElementById('btnDrawHand')?.addEventListener('click', () => app.drawTestHand());
  document.getElementById('btnMulligan')?.addEventListener('click', () => app.handleMulligan());
  document.getElementById('btnKeep')?.addEventListener('click', () => app.keepHand());
  
  // ==================== SEARCH ====================
  const searchBox = document.getElementById('searchBox') as HTMLInputElement | null;
  searchBox?.addEventListener('input', (e) => {
    const term = (e.target as HTMLInputElement).value;
    app.filterCards(term);
  });
  
  // Clear search on Escape key
  searchBox?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      app.clearSearch();
      searchBox.blur();
    }
  });
  
  // ==================== MORE MENU ====================
  const btnMore = document.getElementById('btnMore');
  const headerMore = document.getElementById('headerMore');
  btnMore?.addEventListener('click', (e) => {
    e.stopPropagation();
    headerMore?.classList.toggle('open');
  });
  
  // Close more menu when clicking outside
  document.addEventListener('click', (e) => {
    if (headerMore && !headerMore.contains(e.target as Node)) {
      headerMore.classList.remove('open');
    }
  });
  
  // More menu item clicks
  document.querySelectorAll('[data-close-menu]').forEach(btn => {
    btn.addEventListener('click', () => {
      headerMore?.classList.remove('open');
      const panel = (btn as HTMLElement).dataset.panel;
      if (panel) {
        app.togglePanel(panel);
      }
    });
  });
  
  // ==================== EXPORT BUTTONS ====================
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      const format = btn.getAttribute('data-export') || 'text';
      app.exportDeck(format);
      // Update active state
      document.querySelectorAll('[data-export]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  
  // Export copy/download handlers
  document.getElementById('btnCopyExport')?.addEventListener('click', () => app.copyExport());
  document.getElementById('btnDownloadExport')?.addEventListener('click', () => app.downloadExport());
  document.getElementById('btnCloseExport')?.addEventListener('click', () => {
    const panel = document.getElementById('exportPanel');
    if (panel) panel.classList.remove('active');
  });
  
  // ==================== TOOLS PANEL TAB SWITCHING ====================
  document.querySelectorAll('.tools-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = tab.getAttribute('data-tool-tab');
      debugLog('[MTG Tools] Tab clicked:', tabId);
      if (!tabId) return;
      
      // Update tab active state
      document.querySelectorAll('.tools-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update content active state - CSS handles display via !important
      document.querySelectorAll('.tools-content').forEach(c => {
        c.classList.remove('active');
      });
      
      // Show selected content
      const content = document.getElementById(`tool-${tabId}`);
      if (content) {
        content.classList.add('active');
        debugLog('[MTG Tools] Showing content:', `tool-${tabId}`);
      }
    });
  });
  
  // ==================== HYPERGEOMETRIC CALCULATOR ====================
  document.getElementById('btnCalcHyper')?.addEventListener('click', () => {
    const deckSize = parseInt((document.getElementById('hyperDeck') as HTMLInputElement)?.value) || 60;
    const drawCount = parseInt((document.getElementById('hyperDraw') as HTMLInputElement)?.value) || 7;
    const copies = parseInt((document.getElementById('hyperCopies') as HTMLInputElement)?.value) || 4;
    const wantAtLeast = parseInt((document.getElementById('hyperWant') as HTMLInputElement)?.value) || 1;
    
    // Hypergeometric probability calculation
    const hypergeom = (N: number, K: number, n: number, k: number): number => {
      const choose = (a: number, b: number): number => {
        if (b > a || b < 0) return 0;
        if (b === 0 || b === a) return 1;
        let result = 1;
        for (let i = 0; i < b; i++) {
          result = result * (a - i) / (i + 1);
        }
        return result;
      };
      return (choose(K, k) * choose(N - K, n - k)) / choose(N, n);
    };
    
    let prob = 0;
    for (let k = wantAtLeast; k <= Math.min(copies, drawCount); k++) {
      prob += hypergeom(deckSize, copies, drawCount, k);
    }
    
    const resultEl = document.getElementById('hyperResult');
    if (resultEl) {
      resultEl.textContent = `Probability: ${(prob * 100).toFixed(2)}%`;
    }
  });
  
  // ==================== ADVANCED TOOLS EVENT LISTENERS ====================
  document.getElementById('btnCalcDNA')?.addEventListener('click', () => app.calculateDNA());
  document.getElementById('btnCalcPower')?.addEventListener('click', () => app.calculatePower());
  document.getElementById('btnCalcSalt')?.addEventListener('click', () => app.calculateSalt());
  document.getElementById('btnFindSynergies')?.addEventListener('click', () => app.findSynergies());
  document.getElementById('btnFindBudget')?.addEventListener('click', () => app.findBudgetAlternatives());
  document.getElementById('btnGetRecs')?.addEventListener('click', () => void app.getCardSuggestions());
  ['metaModeSelect', 'metaModeSelectPanel'].forEach((selectId) => {
    const selectEl = document.getElementById(selectId) as HTMLSelectElement | null;
    selectEl?.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value;
      app.setMetaMode(value);
    });
  });
  document.getElementById('btnGenerateMatchups')?.addEventListener('click', () => app.generateMatchupGuide());
  
  // ==================== DECK COMPARISON ====================
  document.getElementById('btnRunCompare')?.addEventListener('click', () => app.runDeckCompare());
  document.getElementById('btnRunCompare2')?.addEventListener('click', () => app.runDeckCompare());
  
  // ==================== PRINT PROXY ====================
  document.getElementById('btnProxy')?.addEventListener('click', () => app.openProxy());
  document.getElementById('btnProxyPrint')?.addEventListener('click', () => app.printProxy());
  document.getElementById('btnProxyClose')?.addEventListener('click', () => app.closeProxy());
  
  // ==================== SHARE ====================
  document.getElementById('btnCopyShare')?.addEventListener('click', () => app.copyShareUrl());
  
  // ==================== MOXFIELD EXPORT ====================
  document.getElementById('btnMoxfield')?.addEventListener('click', () => app.exportMoxfield());

  // ==================== BETA DASHBOARD + FEEDBACK ====================
  document.getElementById('btnRefreshBetaDashboard')?.addEventListener('click', () => void app.refreshBetaDashboard());
  document.getElementById('btnSubmitBetaFeedback')?.addEventListener('click', () => app.submitBetaFeedback());
  const betaFeedbackInput = document.getElementById('betaFeedbackInput') as HTMLTextAreaElement | null;
  betaFeedbackInput?.addEventListener('keydown', (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      app.submitBetaFeedback();
    }
  });
  
  // ==================== VERSION MANAGEMENT ====================
  document.getElementById('btnSaveVersion2')?.addEventListener('click', () => {
    app.saveVersion();
    app.renderVersionsList();
  });
  
  // ==================== COLLECTION MANAGEMENT ====================
  document.getElementById('btnImportColl')?.addEventListener('click', () => void app.importCollection());
  document.getElementById('btnImportColl2')?.addEventListener('click', () => void app.importCollection());
  document.getElementById('btnClearColl')?.addEventListener('click', () => app.clearCollection());
  document.getElementById('btnClearColl2')?.addEventListener('click', () => app.clearCollection());
  document.getElementById('btnMergeColl')?.addEventListener('click', () => void app.mergeCollection());
  document.getElementById('btnExportColl')?.addEventListener('click', () => app.exportCollection());
  document.getElementById('btnCollUpload')?.addEventListener('click', () => app.uploadCollectionFile());
  
  // Collection file input
  const collFileInput = document.getElementById('collFileInput') as HTMLInputElement;
  collFileInput?.addEventListener('change', () => {
    if (collFileInput.files?.[0]) {
      app.handleCollectionFile(collFileInput.files[0]);
      collFileInput.value = '';
    }
  });
  
  // ==================== DISABLED FEATURES (Coming Soon) ====================
  // Goldfish Simulator - needs full game engine implementation
  const goldfishBtns = ['btnGfStart', 'btnGfDraw', 'btnGfShuffle', 'btnGfNextPhase', 'btnGfNextTurn', 'btnGfUntapAll', 'btnStartGoldfish'];
  for (const id of goldfishBtns) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.classList.add('coming-soon');
      btn.setAttribute('data-soon', 'Soon');
      btn.title = 'Coming soon';
    }
  }
  
  // Wishlist - needs state management + persistence
  const wishlistBtns = ['btnAddWishlist', 'btnClearWishlist', 'btnAddMissingWishlist', 'btnBuyWishlist', 'btnExportWishlist'];
  for (const id of wishlistBtns) {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.classList.add('coming-soon');
      btn.setAttribute('data-soon', 'Soon');
      btn.title = 'Coming soon';
    }
  }

  ['goldfish', 'wishlist'].forEach(tabId => {
    const tab = document.querySelector(`[data-tool-tab="${tabId}"]`) as HTMLElement | null;
    tab?.classList.add('coming-soon-tab');
  });
  
  // Collection tab switching
  document.querySelectorAll('[data-coll-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabId = (tab as HTMLElement).dataset.collTab;
      document.querySelectorAll('.coll-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.coll-tab-content').forEach(c => c.classList.remove('active'));
      const content = document.getElementById(`collTab${tabId ? tabId.charAt(0).toUpperCase() + tabId.slice(1) : ''}`);
      if (content) content.classList.add('active');
    });
  });
  
  // Initialize app
  app.init();
});

function handleAction(action: string, el: HTMLElement, e: MouseEvent): void {
  debugLog('[MTG Action]', action, el.dataset);
  switch (action) {
    case 'import-paste': app.importPaste(); break;
    case 'import-url': app.importUrl(); break;
    case 'import-file': app.triggerFileInput(); break;
    case 'toggle-theme': app.toggleTheme(); break;
    case 'toggle-panel': app.togglePanel(el.dataset.panel || ''); break;
    case 'set-view': app.setView(el.dataset.view || 'card'); break;
    case 'open-modal': app.openModal(el.dataset.card || ''); break;
    case 'close-modal': app.closeModal(); break;
    case 'draw-hand': app.drawTestHand(); break;
    case 'mulligan': app.handleMulligan(); break;
    case 'keep-hand': app.keepHand(); break;
    case 'export-format': app.exportDeck(el.dataset.format || 'text', { trackEvent: true, trigger: 'format_button' }); break;
    case 'copy-deck': app.copyDeckToClipboard(); break;
    case 'move-zone': app.moveCardZone(el.dataset.card || '', el.dataset.from || '', el.dataset.to || ''); break;
    case 'card-qty': app.changeCardQty(el.dataset.card || '', el.dataset.zone || '', parseInt(el.dataset.delta || '0')); break;
    case 'remove-card': app.removeCard(el.dataset.card || '', el.dataset.zone || ''); break;
    case 'open-card-menu': app.openCardMenu(el.dataset.card || '', el.dataset.zone || '', el); break;
    case 'save-version': app.saveVersion(); break;
    case 'load-version': app.loadVersion(el.dataset.idx || ''); break;
    case 'delete-version': app.deleteVersion(el.dataset.idx || ''); break;
    case 'resolve-coll-row': void app.resolveCollectionRow(el.dataset.rowIndex || ''); break;
    case 'dismiss-coll-row': app.dismissCollectionRow(el.dataset.rowIndex || ''); break;
    case 'toggle-rec-apply': app.toggleRecommendationApplied(el.dataset.recId || ''); break;
    case 'toggle-rec-mode': app.setRecommendationApplyMode(el.dataset.mode || ''); break;
    case 'set-matchup-meta-mode': app.setMatchupMetaMode(el.dataset.mode || ''); break;
    case 'toggle-rec-missing': app.setRecommendationCollectionMode(el.dataset.mode || ''); break;
    case 'toggle-dynamic-discovery': void app.toggleDynamicDiscovery(el.dataset.mode || ''); break;
    case 'toggle-archetype-detection': void app.toggleArchetypeDetection(el.dataset.mode || ''); break;
    case 'feedback-thumbs-up': app.trackRecommendationFeedback(el.dataset.recId || '', el.dataset.cardName || '', 'up'); break;
    case 'feedback-thumbs-down': app.trackRecommendationFeedback(el.dataset.recId || '', el.dataset.cardName || '', 'down'); break;
    case 'confirm-rec-apply': app.confirmRecommendationApply(); break;
    case 'close-rec-apply-modal': app.cancelRecommendationApply(); break;
    case 'close-flow-top3-modal': app.closeFlowTop3Modal(); break;
    case 'flow-top3-continue': app.continueFlowFromTop3Modal(); break;
    case 'close-flow-analysis': app.closeFlowAnalysisSpotlight(); break;
    case 'show-trend-dashboard': app.showTrendDashboard(); break;
    case 'open-community-page': app.openCommunityPage(); break;
    case 'community-share-deck': void app.shareCurrentDeckToCommunity(); break;
    case 'community-refresh': void app.refreshCommunityFeatures(); break;
    case 'community-upvote': void app.upvoteCommunityDeckById(el.dataset.deckId || ''); break;
    case 'undo-rec-apply': app.undoLastRecommendationApply(); break;
    case 'refresh-beta-dashboard': void app.refreshBetaDashboard(); break;
    case 'submit-beta-feedback': app.submitBetaFeedback(); break;
    case 'card-hover': app.showPreview(el.dataset.card || '', e); break;
    case 'card-leave': app.hidePreview(); break;
    case 'show-share': void app.copyShareUrl(); break;
    default:
      console.warn('[action] Unknown:', action);
  }
}

// Keyboard shortcuts
document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    app.closeFlowTop3Modal();
    app.closeFlowAnalysisSpotlight();
    app.cancelRecommendationApply();
    // Close in order: card menu → drawer → modal
    // Try card menu first (most transient)
    app.closeCardMenu();
    if (isToolsDrawerOpen()) {
      closeToolsDrawer();
      return;
    }
    app.closeModal();
    app.hidePreview();
  }
});

// Export for debugging
declare global {
  interface Window {
    _mtg: typeof app;
  }
}
window._mtg = app;
