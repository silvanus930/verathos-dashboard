'use strict';

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://verathos.ai/dashboard' });
});
