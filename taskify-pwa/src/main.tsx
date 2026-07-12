import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

const root = createRoot(document.getElementById('root')!);

class RootErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Taskify runtime render error', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 20, fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif', color: '#111' }}>
          Taskify hit a runtime error and recovered safely. Please close and reopen once. If this repeats, contact support@solife.me.
        </div>
      );
    }
    return this.props.children;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise
      .then((value) => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

async function bootstrapApp(): Promise<void> {
  const [{ default: process }, { Buffer }] = await Promise.all([
    import('process'),
    import('buffer'),
  ]);

  // Provide minimal Node polyfills for browser-only dependencies (bc-ur -> bitcoinjs-lib).
  if (!(globalThis as any).process) {
    (globalThis as any).process = process;
  }
  if (!(globalThis as any).Buffer) {
    (globalThis as any).Buffer = Buffer;
  }
  if (!(globalThis as any).global) {
    (globalThis as any).global = globalThis;
  }

  // crypto.randomUUID is only available in secure contexts (HTTPS / localhost).
  // Polyfill for LAN dev access over plain HTTP.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    (crypto as any).randomUUID = function (): string {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant bits
      const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0'));
      return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
    };
  }

  await import('./storage/localStorageGuardrails');
  const [{ initializeStorageBoundaries }] = await Promise.all([
    import('./storage/storageBootstrap'),
  ]);

  const storagePromise = initializeStorageBoundaries();
  try {
    // Guard against occasional startup hangs in storage bootstrap.
    // 10s gives large backups (1000s of tasks) enough time to read from IDB on
    // slow mobile devices. Fast devices still boot instantly since the await
    // resolves as soon as IDB is ready — the timeout is only the upper bound.
    await withTimeout(storagePromise, 10_000);
  } catch (err) {
    // Never mount an editable empty app while IndexedDB is still loading: a
    // user edit in that state can reconcile the eventual real dataset as
    // deletions. Keep the UI read-only and wait for the original load instead.
    console.warn('Storage bootstrap is taking longer than expected', err);
    root.render(
      <div style={{ padding: 20, fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif', color: '#111' }}>
        Taskify is still loading your local data. Keep the app open; your data will appear as soon as storage is ready.
      </div>,
    );
    await storagePromise;
  }

  const [
    { default: App },
    { CashuProvider },
    { NwcProvider },
    { ToastProvider },
    { P2PKProvider },
  ] = await Promise.all([
    import('./App.tsx'),
    import('./context/CashuContext'),
    import('./context/NwcContext.tsx'),
    import('./context/ToastContext.tsx'),
    import('./context/P2PKContext.tsx'),
  ]);

  root.render(
    <StrictMode>
      <RootErrorBoundary>
        <ToastProvider>
          <NwcProvider>
            <P2PKProvider>
              <CashuProvider>
                <App />
              </CashuProvider>
            </P2PKProvider>
          </NwcProvider>
        </ToastProvider>
      </RootErrorBoundary>
    </StrictMode>,
  );

  setupServiceWorkers();
}
async function recoverFromBootstrapFailure(err: unknown): Promise<boolean> {
  const message = err instanceof Error ? err.message : String(err);
  const isChunkOrImportFailure = /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk/i.test(message);
  if (!isChunkOrImportFailure) return false;

  const RECOVERY_KEY = 'taskify_bootstrap_recovery_v1';
  try {
    const alreadyRecovered = sessionStorage.getItem(RECOVERY_KEY) === '1';
    if (alreadyRecovered) return false;
    sessionStorage.setItem(RECOVERY_KEY, '1');

    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((reg) => reg.unregister()));
      } catch {}
    }

    if (typeof caches !== 'undefined') {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith('taskify-cache-')).map((k) => caches.delete(k)));
      } catch {}
    }

    const busted = new URL(window.location.href);
    busted.searchParams.set('cache_bust', String(Date.now()));
    window.location.replace(busted.toString());
    return true;
  } catch {
    return false;
  }
}

void bootstrapApp().catch(async (err) => {
  console.error('Taskify bootstrap failed', err);
  const recovered = await recoverFromBootstrapFailure(err);
  if (recovered) return;

  const rootEl = document.getElementById('root');
  if (rootEl) {
    rootEl.innerHTML = '<div style="padding:20px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#111">Taskify failed to load. Please refresh once. If this persists, contact support@solife.me.</div>';
  }
});

async function cleanupDevServiceWorkers() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map((reg) => reg.unregister()));
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('taskify-cache-')).map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn('Failed to clean dev service workers', err);
  }
}

function setupServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.PROD) {
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
  } else {
    // Avoid SW caching during Vite dev which can break module reloads.
    cleanupDevServiceWorkers();
  }
}
