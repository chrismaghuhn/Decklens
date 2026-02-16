// ==================== YGO Entry Point ====================
// Source: yugioh.html event bindings + initialization
// This file bootstraps the YGO application and binds all events.

import { initGlobalErrorHandler } from '../shared/errors';
import {
  initToolsDrawer,
  openDrawer as openToolsDrawer,
  closeDrawer as closeToolsDrawer,
  isDrawerOpen as isToolsDrawerOpen,
} from './tools-drawer';
import {
  $,
  show,
  hide,
  showToast,
  initYgoApp,
  handleFile,
  importYDKE,
  importPaste,
  toggleTheme,
  loadRecentDeck,
  removeRecent,
  setTypeFilter,
  setView,
  applyFilters,
  cleanupChunkers,
  openModal,
  closeModal,
  showPreview,
  hidePreview,
  changeBanlist,
  drawTestHand,
  mulligan,
  markHand,
  resetHandStats,
  renderExport,
  copyExport,
  downloadExport,
  exportPdf,
  generatePdf,
  closePdfModal,
  exportDeckImage,
  showQrCode,
  exportProxy,
  toggleComparePanel,
  handleCompareFile,
  closeComparePanel,
  generateShareUrl,
  copyShareUrl,
  shareNative,
  renderCollection,
  adjustCollection,
  markAllOwned,
  clearCollection,
  saveVersion,
  renderVersions,
  loadVersion,
  removeVersion,
  addHyperCategory,
  removeHyperCategory,
  renderHyperCategories,
  updateHyperCat,
  calcHyperAll,
  togglePicker,
  filterPicker,
  toggleCardInCategory,
  addComboLine,
  removeComboLine,
  renderComboLines,
  updateComboName,
  updateComboReqType,
  addComboRequirement,
  removeComboRequirement,
  calcCombos,
  calcHand,
  toggleToolsPanel,
  setToolTab,
  processDeck,
  // New tool functions
  generateDNA,
  detectEngines,
  runHandGrade,
  calculateCraftCost,
  calculateSalt,
  // Step 2: Newly wired features
  generateDeckImagePreview,
  downloadDeckImage,
  downloadQrCode,
  exportCollectionCsv,
  importCollectionCsv,
  handleCollectionFile,
  buildCrossFormatMatrix,
  addTag,
  addFolder,
} from './app';

// ==================== WINDOW BINDINGS ====================
// Expose functions needed by inline event handlers
// These will be removed in DOM Policy step (Step B)
declare global {
  interface Window {
    _ygo: {
      loadRecentDeck: typeof loadRecentDeck;
      removeRecent: typeof removeRecent;
      updateHyperCat: typeof updateHyperCat;
      updateComboName: typeof updateComboName;
      updateComboReqType: typeof updateComboReqType;
      mulligan: typeof mulligan;
      filterPicker: typeof filterPicker;
    };
  }
}

window._ygo = {
  loadRecentDeck,
  removeRecent,
  updateHyperCat,
  updateComboName,
  updateComboReqType,
  mulligan,
  filterPicker,
};

// ==================== EVENT BINDINGS ====================
function bindEvents(): void {
  // Theme toggle
  $('btnTheme')?.addEventListener('click', toggleTheme);

  // Print button
  $('btnPrint')?.addEventListener('click', () => window.print());

  // File dropzone
  const dropzone = $('dropzone');
  const fileInput = $('fileInput') as HTMLInputElement | null;

  dropzone?.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone?.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) handleFile(file);
  });
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
  });

  // Import buttons (fixed IDs to match HTML)
  $('btnImportYdke')?.addEventListener('click', importYDKE);
  $('btnImportPaste')?.addEventListener('click', importPaste);

  // Filter buttons (chip-btn with data-filter or data-type-filter)
  document.querySelectorAll('.chip-btn[data-filter], .chip-btn[data-type-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.getAttribute('data-filter') || btn.getAttribute('data-type-filter') || 'all';
      setTypeFilter(filter);
      // Update active state for filter buttons only
      document.querySelectorAll('.chip-btn[data-filter], .chip-btn[data-type-filter]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // View buttons (icon-btn with data-view)
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view') || 'cards';
      setView(view);
      // Update active state for view buttons only
      document.querySelectorAll('[data-view]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Banlist selector
  $('banlistSelect')?.addEventListener('change', changeBanlist);

  // Sort selector
  $('sortSelect')?.addEventListener('change', applyFilters);

  // Search box
  $('searchBox')?.addEventListener('input', applyFilters);
  $('searchEffect')?.addEventListener('change', applyFilters);

  // Modal close
  $('modalClose')?.addEventListener('click', closeModal);
  $('cardModal')?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('modal-overlay')) closeModal();
  });

  // Export
  $('exportFormat')?.addEventListener('change', renderExport);
  $('btnCopyExport')?.addEventListener('click', copyExport);
  $('btnDownloadExport')?.addEventListener('click', downloadExport);
  
  // Special Export buttons
  $('btnOpenPdfExport')?.addEventListener('click', exportPdf);
  $('btnGenPdf')?.addEventListener('click', generatePdf);
  
  // PDF Modal close
  const pdfModal = $('pdfModal');
  pdfModal?.querySelector('.modal-close')?.addEventListener('click', closePdfModal);
  pdfModal?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).classList.contains('modal-overlay')) closePdfModal();
  });
  
  $('btnExportDeckImg')?.addEventListener('click', exportDeckImage);
  $('btnShowQR')?.addEventListener('click', showQrCode);
  $('btnExportProxy')?.addEventListener('click', exportProxy);
  $('btnToggleCompare')?.addEventListener('click', toggleComparePanel);

  // Compare panel - file input and close button
  const compareDrop = $('compareDrop');
  const compareFile = $('compareFile') as HTMLInputElement | null;
  
  compareDrop?.addEventListener('click', () => compareFile?.click());
  compareDrop?.addEventListener('dragover', (e) => {
    e.preventDefault();
    compareDrop.classList.add('dragover');
  });
  compareDrop?.addEventListener('dragleave', () => compareDrop.classList.remove('dragover'));
  compareDrop?.addEventListener('drop', (e) => {
    e.preventDefault();
    compareDrop.classList.remove('dragover');
    const file = (e as DragEvent).dataTransfer?.files[0];
    if (file) handleCompareFile(file);
  });
  compareFile?.addEventListener('change', () => {
    const file = compareFile.files?.[0];
    if (file) handleCompareFile(file);
  });
  $('btnCloseCompare')?.addEventListener('click', closeComparePanel);

  // Share (fixed ID to match HTML)
  $('btnCopyShare')?.addEventListener('click', copyShareUrl);
  $('btnShareNative')?.addEventListener('click', shareNative);

  // Test Hand Simulator - Draw buttons
  document.querySelectorAll('[data-draw-hand]').forEach(btn => {
    btn.addEventListener('click', () => {
      const handSize = parseInt(btn.getAttribute('data-draw-hand') || '5');
      drawTestHand(handSize);
    });
  });

  // Test Hand Simulator - Mark buttons
  document.querySelectorAll('[data-mark-hand]').forEach(btn => {
    btn.addEventListener('click', () => {
      const grade = btn.getAttribute('data-mark-hand') || '';
      markHand(grade);
    });
  });

  // Test hands (fixed ID to match HTML)
  $('btnMulligan')?.addEventListener('click', mulligan);
  $('btnResetHandStats')?.addEventListener('click', resetHandStats);

  // Calculator inputs
  $('calcDeck')?.addEventListener('input', calcHand);
  $('calcHand')?.addEventListener('input', calcHand);
  $('calcCopies')?.addEventListener('input', calcHand);
  $('calcWant')?.addEventListener('input', calcHand);

  // Collection
  $('btnMarkAllOwned')?.addEventListener('click', markAllOwned);
  $('btnClearColl')?.addEventListener('click', clearCollection);
  $('btnExportColl')?.addEventListener('click', exportCollectionCsv);
  $('btnImportColl')?.addEventListener('click', importCollectionCsv);
  
  // Collection file import handler
  const collImportFile = $('collImportFile') as HTMLInputElement | null;
  collImportFile?.addEventListener('change', () => {
    if (collImportFile.files?.[0]) {
      handleCollectionFile(collImportFile.files[0]);
      collImportFile.value = '';
    }
  });

  // Deck Image Export
  $('btnGenDeckImg')?.addEventListener('click', generateDeckImagePreview);
  $('btnDownloadDeckImg')?.addEventListener('click', downloadDeckImage);
  
  // QR Code Download
  $('btnDownloadQR')?.addEventListener('click', downloadQrCode);
  
  // Cross-Format Matrix
  $('btnCrossFormat')?.addEventListener('click', buildCrossFormatMatrix);
  
  // Tags & Folders (Coming Soon)
  $('btnAddTag')?.addEventListener('click', addTag);
  $('btnAddFolder')?.addEventListener('click', addFolder);

  // Versions
  $('btnSaveVersion')?.addEventListener('click', saveVersion);

  // Hypergeometric Calculator
  $('btnAddHyperCat')?.addEventListener('click', addHyperCategory);
  $('btnCalcHyper')?.addEventListener('click', calcHyperAll);

  // Going first/second toggle
  document.querySelectorAll('[data-go-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-go-toggle]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Combos
  $('btnAddCombo')?.addEventListener('click', addComboLine);
  $('btnCalcCombos')?.addEventListener('click', calcCombos);
  
  // Tool-specific buttons
  $('btnGenDNA')?.addEventListener('click', () => {
    console.log('[YGO] Generate DNA clicked');
    generateDNA();
  });
  
  $('btnDetectEngines')?.addEventListener('click', () => {
    console.log('[YGO] Detect Engines clicked');
    detectEngines();
  });
  
  $('btnRunHandGrade')?.addEventListener('click', () => {
    console.log('[YGO] Run Hand Grade clicked');
    runHandGrade();
  });
  
  $('btnCalcCraft')?.addEventListener('click', () => {
    console.log('[YGO] Calculate Craft clicked');
    calculateCraftCost();
  });
  
  $('btnCalcSalt')?.addEventListener('click', () => {
    console.log('[YGO] Calculate Salt clicked');
    calculateSalt();
  });

  // Tools panel tabs (data-tool-tab)
  document.querySelectorAll('[data-tool-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.getAttribute('data-tool-tab');
      console.log('[YGO] Tool tab clicked:', tabName);
      if (tabName) {
        // Remove active from all tabs and contents
        document.querySelectorAll('.tools-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tools-content').forEach(c => c.classList.remove('active'));
        // Add active to clicked tab and its content
        tab.classList.add('active');
        const content = $(`tool-${tabName}`);
        if (content) {
          content.classList.add('active');
          console.log('[YGO] Tool content activated:', `tool-${tabName}`);
        } else {
          console.warn('[YGO] Tool content not found:', `tool-${tabName}`);
        }
      }
    });
  });
  
  console.log('[YGO] Found tool tabs:', document.querySelectorAll('[data-tool-tab]').length);

  // Tools Drawer toggle button (toggle, not just open)
  $('btnToolsDrawer')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[YGO] Tools Drawer clicked, currently open:', isToolsDrawerOpen());
    if (isToolsDrawerOpen()) {
      closeToolsDrawer();
    } else {
      openToolsDrawer();
    }
  });
  
  // Action Group Buttons - Panel toggles
  const btnAnalysis = $('btnShowAnalysis');
  const btnExport = $('btnShowExport');
  const btnTools = $('btnTools');
  
  console.log('[YGO Init] btnShowAnalysis:', btnAnalysis);
  console.log('[YGO Init] btnShowExport:', btnExport);
  console.log('[YGO Init] btnTools:', btnTools);
  
  btnAnalysis?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[YGO] Analysis button clicked');
    const panel = $('analysisPanel');
    console.log('[YGO] analysisPanel element:', panel);
    if (panel) {
      const wasActive = panel.classList.contains('active');
      console.log('[YGO] Analysis panel was active:', wasActive);
      if (wasActive) {
        panel.classList.remove('active');
      } else {
        panel.classList.add('active');
      }
      console.log('[YGO] Analysis panel now active:', panel.classList.contains('active'));
    }
  });
  
  btnExport?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[YGO] Export button clicked');
    const panel = $('exportPanel');
    console.log('[YGO] exportPanel element:', panel);
    if (panel) {
      const wasActive = panel.classList.contains('active');
      console.log('[YGO] Export panel was active:', wasActive);
      if (wasActive) {
        panel.classList.remove('active');
      } else {
        panel.classList.add('active');
      }
      console.log('[YGO] Export panel now active:', panel.classList.contains('active'));
    }
  });
  
  btnTools?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('[YGO] Tools Panel button clicked');
    const panel = $('toolsPanel');
    console.log('[YGO] toolsPanel element:', panel);
    if (panel) {
      const wasActive = panel.classList.contains('active');
      console.log('[YGO] Tools panel was active:', wasActive);
      if (wasActive) {
        panel.classList.remove('active');
        // Inline style fallback reset
        panel.style.maxHeight = '';
        panel.style.opacity = '';
        panel.style.overflow = '';
      } else {
        panel.classList.add('active');
        // Inline style fallback for visibility
        panel.style.maxHeight = '3000px';
        panel.style.opacity = '1';
        panel.style.overflow = 'visible';
      }
      console.log('[YGO] Tools panel now active:', panel.classList.contains('active'));
    } else {
      console.error('[YGO] ERROR: toolsPanel element not found!');
    }
  });
  
  $('btnCloseExport')?.addEventListener('click', () => {
    console.log('[YGO] Close Export clicked');
    const panel = $('exportPanel');
    if (panel) panel.classList.remove('active');
  });
  
  // Export buttons with data-export attribute
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const format = btn.getAttribute('data-export') || 'ydk';
      console.log('[YGO] Export format clicked:', format);
      
      // Set the format in the hidden select
      const formatSelect = $('exportFormat') as HTMLSelectElement | null;
      if (formatSelect) {
        formatSelect.value = format;
        console.log('[YGO] Format select set to:', format);
      }
      
      // Highlight active button
      document.querySelectorAll('[data-export]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      // Render the export
      renderExport();
    });
  });
  
  console.log('[YGO] Found export buttons:', document.querySelectorAll('[data-export]').length);

  // Escape key to close modal and drawers
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Close drawer first if open
      if (isToolsDrawerOpen()) {
        closeToolsDrawer();
        return;
      }
      closeModal();
      toggleToolsPanel(false);
      hide($('cardPicker'));
    }
  });
}

// ==================== EVENT DELEGATION ====================
function bindDelegation(): void {
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const actionEl = target.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) return;

    const action = actionEl.dataset.action;
    const id = parseInt(actionEl.dataset.id || '0');
    const catId = actionEl.dataset.catId || '';
    const comboId = actionEl.dataset.comboId || '';
    const idx = parseInt(actionEl.dataset.idx || '0');
    const reqIdx = parseInt(actionEl.dataset.reqIdx || '0');
    const delta = parseInt(actionEl.dataset.delta || '0');

    switch (action) {
      case 'modal':
        if (id) openModal(id);
        break;
      case 'section-toggle': {
        const section = actionEl.dataset.section;
        const content = $(`section-${section}`);
        if (content) content.classList.toggle('collapsed');
        break;
      }
      case 'copy-export':
        copyExport();
        break;
      case 'dl-export':
        downloadExport();
        break;
      case 'hand-card':
        // Could implement card marking in hand
        break;
      case 'hyper-remove':
        if (catId) removeHyperCategory(catId);
        break;
      case 'combo-remove':
        if (comboId) removeComboLine(comboId);
        break;
      case 'combo-req-remove':
        if (comboId) removeComboRequirement(comboId, reqIdx);
        break;
      case 'combo-req-add':
        if (comboId) addComboRequirement(comboId);
        break;
      case 'combo-card-toggle':
        if (catId && id) toggleCardInCategory(catId, id);
        break;
      case 'picker-toggle':
        if (catId) togglePicker(catId);
        break;
      case 'adjust-coll':
        if (id && delta) adjustCollection(id, delta);
        break;
      case 'tag-toggle':
      case 'tag-remove':
      case 'folder-remove':
        // Tags/folders not fully implemented
        break;
      case 'version-load':
        loadVersion(idx);
        break;
      case 'version-remove':
        removeVersion(idx);
        break;
    }
  });

  // Card preview on hover
  document.addEventListener('mouseover', (e) => {
    const target = e.target as HTMLElement;
    const cardEl = target.closest('.ygo-card, .grid-card, .picker-card') as HTMLElement | null;
    if (cardEl) {
      const id = parseInt(cardEl.dataset.id || '0');
      if (id) showPreview(id, e as MouseEvent);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target as HTMLElement;
    const cardEl = target.closest('.ygo-card, .grid-card, .picker-card');
    if (cardEl) hidePreview();
  });
}

// ==================== BOOTSTRAP ====================
function bootstrap(): void {
  initGlobalErrorHandler();
  
  // Initialize tools drawer (before bindEvents for correct order)
  initToolsDrawer();
  
  bindEvents();
  bindDelegation();
  initYgoApp();
}

// Auto-init on DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
