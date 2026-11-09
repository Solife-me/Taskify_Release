import { beforeEach, expect, test, vi } from "vitest";
import {
  captureInstallPrompt,
  clearInstallPrompt,
  isInstallPromptAvailable,
  requestAppInstall,
} from "./installPrompt";

beforeEach(() => clearInstallPrompt());

test("captures Chromium's install prompt until the user makes a choice", async () => {
  const preventDefault = vi.fn();
  const prompt = vi.fn(async () => {});
  captureInstallPrompt({
    preventDefault,
    prompt,
    userChoice: Promise.resolve({ outcome: "dismissed", platform: "web" }),
  });

  expect(preventDefault).toHaveBeenCalledOnce();
  expect(isInstallPromptAvailable()).toBe(true);
  expect(await requestAppInstall()).toBe("dismissed");
  expect(prompt).toHaveBeenCalledOnce();
  expect(isInstallPromptAvailable()).toBe(false);
});

test("does nothing on browsers such as iOS Safari that provide no install event", async () => {
  expect(isInstallPromptAvailable()).toBe(false);
  expect(await requestAppInstall()).toBe("unavailable");
});
