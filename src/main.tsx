import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// The offline shell: built by scripts/build-sw.mjs, so it exists only in a real build.
// Service workers need a secure page (https or localhost); registered relative to the
// page so EMWS keeps working from any sub-folder. On plain http (http://emws.local) this
// quietly does nothing and the site behaves as it always has.
if (!import.meta.env.DEV && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // An old browser, a blocked registration: the site still works, just not offline.
    });
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
