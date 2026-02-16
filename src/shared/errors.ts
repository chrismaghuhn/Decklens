// ==================== GLOBAL ERROR HANDLER (Audit Report Â§4 Score 15) ====================
// Source: yugioh.html lines 765-775
// Extracted for reuse across all entry points (index, mtg, ygo)

/**
 * Initialize global error handlers for uncaught errors and promise rejections.
 * Shows toast notification to user and logs to console.
 */
export function initGlobalErrorHandler(): void {
  window.addEventListener('error', (e) => {
    console.error('[global error]', e.error || e.message);
    // Ignore cross-origin script errors
    if (!e.message?.includes('Script error')) {
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = 'Something went wrong. Please reload.';
        toast.classList.add('active');
        setTimeout(() => toast.classList.remove('active'), 5000);
      }
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandled promise]', e.reason);
    // Don't show toast for every promise rejection - many are intentional
  });
}
