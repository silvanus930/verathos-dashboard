'use strict';

function isDashboardUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === 'https://verathos.ai' && /^\/dashboard\/?$/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

async function setTabBadge(tabId, text, color, title) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color });
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

async function enhanceDashboard(tabId, frameId, url) {
  if (frameId !== 0 || !isDashboardUrl(url)) return;

  const target = { tabId, frameIds: [0] };

  try {
    const injection = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      files: ['override-dashboard.js']
    });
    const replaced = Boolean(injection[0] && injection[0].result);

    if (replaced) {
      await chrome.scripting.insertCSS({
        target,
        files: ['style.css']
      });
      await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        files: ['theme-init.js', 'app.js']
      });
    }

    await setTabBadge(tabId, 'ON', '#16803c', 'Verathos Dashboard Plus is active');
  } catch (error) {
    console.error('Could not enhance Verathos dashboard:', error);
    await setTabBadge(tabId, 'ERR', '#b42318', 'Verathos Dashboard Plus failed — inspect extension errors');
  }
}

chrome.webNavigation.onCommitted.addListener((details) => {
  enhanceDashboard(details.tabId, details.frameId, details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  enhanceDashboard(details.tabId, details.frameId, details.url);
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://verathos.ai/dashboard' });
});

// Extension reloads happen after an existing tab's navigation event. Enhance
// any dashboard tabs that are already open so the user does not have to guess
// whether another hard refresh is required.
chrome.tabs.query({ url: ['https://verathos.ai/dashboard', 'https://verathos.ai/dashboard/'] })
  .then((tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && tab.url) enhanceDashboard(tab.id, 0, tab.url);
    });
  })
  .catch((error) => {
    console.error('Could not scan existing Verathos dashboard tabs:', error);
  });
