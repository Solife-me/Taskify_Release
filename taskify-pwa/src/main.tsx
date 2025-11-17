import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { CashuProvider } from './context/CashuContext.tsx'
import { NwcProvider } from './context/NwcContext.tsx'
import { ToastProvider } from './context/ToastContext.tsx'
import { P2PKProvider } from './context/P2PKContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <NwcProvider>
        <P2PKProvider>
          <CashuProvider>
            <App />
          </CashuProvider>
        </P2PKProvider>
      </NwcProvider>
    </ToastProvider>
  </StrictMode>,
)
if ('serviceWorker' in navigator) {
  const emitUpdateAvailable = () => {
    window.dispatchEvent(new CustomEvent('taskify:update-available'));
  };

  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (data && typeof data === 'object' && data.type === 'UPDATE_AVAILABLE') {
      emitUpdateAvailable();
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((registration) => {
        if (registration.waiting) {
          emitUpdateAvailable();
        }
      })
      .catch((err) => {
        console.warn('Service worker registration failed', err);
      });
  });
}
