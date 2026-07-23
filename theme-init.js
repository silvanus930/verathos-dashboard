'use strict';

const savedTheme = localStorage.getItem('verathos-theme') || 'dark';
const resolvedTheme = savedTheme === 'system'
  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : savedTheme;

document.documentElement.classList.toggle('dark', resolvedTheme === 'dark');
