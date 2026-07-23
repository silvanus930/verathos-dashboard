'use strict';

(() => {
  if (!/^\/dashboard\/?$/.test(window.location.pathname)) return false;
  if (document.documentElement.dataset.verathosEnhanced === 'true') return false;

  window.stop();

  // Load the packaged HTML synchronously so theme-init.js and app.js receive a
  // complete dashboard DOM when the service worker injects them next.
  const request = new XMLHttpRequest();
  request.open('GET', chrome.runtime.getURL('index.html'), false);
  request.send();

  if (request.status !== 200 && request.status !== 0) {
    throw new Error(`Could not load packaged dashboard HTML (${request.status})`);
  }

  const template = new DOMParser().parseFromString(request.responseText, 'text/html');

  // Chrome injects these files in the isolated extension world. Removing their
  // HTML tags prevents the original site's CSP from evaluating them again.
  template.querySelectorAll('script, link[rel="stylesheet"]').forEach((node) => node.remove());
  template.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach((node) => {
    const source = node.getAttribute('href');
    if (source) node.setAttribute('href', chrome.runtime.getURL(source));
  });

  const enhancedRoot = document.importNode(template.documentElement, true);
  enhancedRoot.dataset.verathosEnhanced = 'true';
  document.replaceChild(enhancedRoot, document.documentElement);
  return true;
})();
