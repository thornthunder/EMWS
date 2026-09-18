// Hash routing (#/antenna). Deliberate: it needs no server-side rewrite rules, so EMWS
// runs from a plain IIS folder, a virtual directory, or any other static host as-is.

import { useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function currentPath(): string {
  const path = window.location.hash.replace(/^#/, '');
  return path === '' ? '/' : path;
}

export function useHashPath(): string {
  return useSyncExternalStore(subscribe, currentPath);
}
