// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  __resetWalletFlagsForTests,
  isWalletEnabled,
  isWalletRecoveryShown,
  LS_WALLET_REMOVAL_PREVIEW,
} from "./walletFlags";
import { LS_WALLET_ENABLED } from "../localStorageKeys";

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

test("a device that had the wallet keeps it until December 1, 2026, then shows only recovery", () => {
  localStorage.setItem(LS_WALLET_ENABLED, "1");
  __resetWalletFlagsForTests();
  vi.setSystemTime(new Date(2026, 10, 30, 12));
  expect(isWalletEnabled()).toBe(true);
  expect(isWalletRecoveryShown()).toBe(false);
  vi.setSystemTime(new Date(2026, 11, 1, 0, 1));
  expect(isWalletEnabled()).toBe(false);
  expect(isWalletRecoveryShown()).toBe(true);
});

test("a device that never had the wallet shows neither", () => {
  __resetWalletFlagsForTests();
  vi.setSystemTime(new Date(2027, 0, 1));
  expect(isWalletEnabled()).toBe(false);
  expect(isWalletRecoveryShown()).toBe(false);
});

test("the recovery view can be previewed before the date", () => {
  localStorage.setItem(LS_WALLET_ENABLED, "1");
  localStorage.setItem(LS_WALLET_REMOVAL_PREVIEW, "1");
  __resetWalletFlagsForTests();
  vi.setSystemTime(new Date(2026, 9, 19));
  expect(isWalletEnabled()).toBe(false);
  expect(isWalletRecoveryShown()).toBe(true);
});
