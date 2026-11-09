let updateAvailable = false;
const updateListeners = new Set<() => void>();

function setUpdateAvailable(next: boolean): void {
  if (next === updateAvailable) return;
  updateAvailable = next;
  updateListeners.forEach((listener) => listener());
}

export function isServiceWorkerUpdateAvailable(): boolean {
  return updateAvailable;
}

export function subscribeServiceWorkerUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => updateListeners.delete(listener);
}

export function dismissServiceWorkerUpdate(): void {
  setUpdateAvailable(false);
}

export function watchServiceWorkerRegistration(
  registration: ServiceWorkerRegistration,
  container: ServiceWorkerContainer = navigator.serviceWorker,
): void {
  if (registration.waiting) setUpdateAvailable(true);

  const watchInstalling = (worker: ServiceWorker | null): void => {
    if (!worker) return;
    const handleStateChange = () => {
      if (worker.state !== "installed") return;
      if (!container.controller) return;
      setUpdateAvailable(true);
    };
    worker.addEventListener("statechange", handleStateChange);
    handleStateChange();
  };

  watchInstalling(registration.installing);
  registration.addEventListener("updatefound", () => watchInstalling(registration.installing));
}

export async function activateWaitingServiceWorker(
  container: ServiceWorkerContainer = navigator.serviceWorker,
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  const registration = await container.getRegistration();
  const waiting = registration?.waiting;
  if (!waiting) {
    reload();
    return;
  }

  let reloaded = false;
  container.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  }, { once: true });
  waiting.postMessage({ type: "SKIP_WAITING" });
}
