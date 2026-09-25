import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { SessionStore } from './auth/store.js';
import { adoptDesktopSession } from './desktop/desktop.js';
import { migrateLegacyStorage } from './storage/legacy.js';
import './styles/app.css';

// Before anything reads a preference: keys from before the rename move once (ADR 0017).
migrateLegacyStorage();

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing');
// In the desktop app, a sign-in obtained by pairing this computer is stored first.
void adoptDesktopSession(
  new SessionStore(typeof localStorage === 'undefined' ? null : localStorage),
).finally(() =>
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
