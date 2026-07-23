'use strict';

function isDashboardRoute() {
  return /^\/dashboard\/?$/.test(window.location.pathname);
}

function openEnhancedDashboard() {
  if (!isDashboardRoute()) return false;

  // A top-level extension page is not affected by verathos.ai's CSP. Using a
  // redirect here is substantially more reliable than embedding the extension
  // in an iframe inside the original page.
  window.location.replace(chrome.runtime.getURL('index.html'));
  return true;
}

// Handle a direct visit immediately. Continue watching other Verathos pages so
// client-side navigation to /dashboard is also intercepted.
if (!openEnhancedDashboard()) {
  const routeWatcher = window.setInterval(() => {
    if (openEnhancedDashboard()) {
      window.clearInterval(routeWatcher);
    }
  }, 250);
}
