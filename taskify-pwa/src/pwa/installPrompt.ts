export type InstallPromptOutcome = "accepted" | "dismissed" | "unavailable";

type InstallPromptEvent = {
  preventDefault: () => void;
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

let deferredPrompt: InstallPromptEvent | null = null;
let initializedWindow: Window | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function captureInstallPrompt(event: InstallPromptEvent): void {
  event.preventDefault();
  deferredPrompt = event;
  notify();
}

export function clearInstallPrompt(): void {
  if (!deferredPrompt) return;
  deferredPrompt = null;
  notify();
}

export function isInstallPromptAvailable(): boolean {
  return deferredPrompt !== null;
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function requestAppInstall(): Promise<InstallPromptOutcome> {
  const prompt = deferredPrompt;
  if (!prompt) return "unavailable";
  try {
    await prompt.prompt();
    const choice = await prompt.userChoice;
    return choice.outcome;
  } finally {
    clearInstallPrompt();
  }
}

export function initializeInstallPromptCapture(win: Window = window): void {
  if (initializedWindow === win) return;
  initializedWindow = win;
  win.addEventListener("beforeinstallprompt", (event) => {
    captureInstallPrompt(event as unknown as InstallPromptEvent);
  });
  win.addEventListener("appinstalled", clearInstallPrompt);
}
