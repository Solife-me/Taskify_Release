import { expect, test, vi } from "vitest";
import {
  activateWaitingServiceWorker,
  dismissServiceWorkerUpdate,
  isServiceWorkerUpdateAvailable,
  watchServiceWorkerRegistration,
} from "./serviceWorkerClient";

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = "installing";
  postMessage = vi.fn();
}

test("announces an installed update without treating the first service worker as an update", () => {
  dismissServiceWorkerUpdate();
  const installing = new FakeWorker();
  const registration = new EventTarget() as ServiceWorkerRegistration;
  Object.defineProperties(registration, {
    installing: { configurable: true, get: () => installing },
    waiting: { configurable: true, get: () => null },
  });

  watchServiceWorkerRegistration(registration, { controller: {} } as ServiceWorkerContainer);
  registration.dispatchEvent(new Event("updatefound"));
  installing.state = "installed";
  installing.dispatchEvent(new Event("statechange"));
  expect(isServiceWorkerUpdateAvailable()).toBe(true);

  dismissServiceWorkerUpdate();
  const firstInstall = new FakeWorker();
  const firstRegistration = new EventTarget() as ServiceWorkerRegistration;
  Object.defineProperties(firstRegistration, {
    installing: { configurable: true, get: () => firstInstall },
    waiting: { configurable: true, get: () => null },
  });
  watchServiceWorkerRegistration(firstRegistration, { controller: null } as ServiceWorkerContainer);
  firstRegistration.dispatchEvent(new Event("updatefound"));
  firstInstall.state = "installed";
  firstInstall.dispatchEvent(new Event("statechange"));
  expect(isServiceWorkerUpdateAvailable()).toBe(false);
});

test("activates the waiting worker and reloads only after controllerchange", async () => {
  const waiting = new FakeWorker();
  const container = new EventTarget() as ServiceWorkerContainer;
  Object.defineProperty(container, "getRegistration", {
    value: vi.fn(async () => ({ waiting })),
  });
  const reload = vi.fn();

  await activateWaitingServiceWorker(container, reload);
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  expect(reload).not.toHaveBeenCalled();
  container.dispatchEvent(new Event("controllerchange"));
  container.dispatchEvent(new Event("controllerchange"));
  expect(reload).toHaveBeenCalledOnce();
});

test("reloads directly when no update is waiting", async () => {
  const container = new EventTarget() as ServiceWorkerContainer;
  Object.defineProperty(container, "getRegistration", {
    value: vi.fn(async () => undefined),
  });
  const reload = vi.fn();

  await activateWaitingServiceWorker(container, reload);
  expect(reload).toHaveBeenCalledOnce();
});
