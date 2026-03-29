/**
 * Onboarding gating logic tests.
 *
 * Validates the state logic that determines when the Welcome/Login overlay
 * should be shown and, critically, that background app content must be gated
 * (inert) while any onboarding modal is active.
 *
 * These tests are self-contained (no Vite/React imports) and mirror the
 * logic in App.tsx that drives showFirstRunOnboarding and the derived
 * isOnboardingActive gate.
 */
import { describe, expect, test } from "vitest";

// ---------------------------------------------------------------------------
// Inline mirror of the gating logic from App.tsx
// ---------------------------------------------------------------------------

const LS_NOSTR_SK = "nostr_sk";
const LS_FIRST_RUN_ONBOARDING_DONE = "taskify_onboarding_done_v1";

function makeStorage(entries: Record<string, string> = {}): { getItem: (k: string) => string | null } {
  return { getItem: (k: string) => entries[k] ?? null };
}

function onboardingNeedsKeySelection(storage: ReturnType<typeof makeStorage>): boolean {
  try {
    const raw = (storage.getItem(LS_NOSTR_SK) || "").trim();
    return !/^[0-9a-fA-F]{64}$/.test(raw);
  } catch {
    return true;
  }
}

function computeShowFirstRunOnboarding(storage: ReturnType<typeof makeStorage>): boolean {
  if (!onboardingNeedsKeySelection(storage)) return false;
  try {
    return storage.getItem(LS_FIRST_RUN_ONBOARDING_DONE) !== "done";
  } catch {
    return true;
  }
}

/** Mirrors the isOnboardingActive derived value in App.tsx */
function computeIsOnboardingActive(storage: ReturnType<typeof makeStorage>): boolean {
  return computeShowFirstRunOnboarding(storage);
}

const VALID_SK = "a".repeat(64); // 64 hex chars

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("showFirstRunOnboarding", () => {
  test("true for fresh install (no SK, no done flag)", () => {
    expect(computeShowFirstRunOnboarding(makeStorage({}))).toBe(true);
  });

  test("false when valid SK already exists", () => {
    expect(computeShowFirstRunOnboarding(makeStorage({ [LS_NOSTR_SK]: VALID_SK }))).toBe(false);
  });

  test("false when onboarding marked done (even without SK)", () => {
    expect(computeShowFirstRunOnboarding(makeStorage({ [LS_FIRST_RUN_ONBOARDING_DONE]: "done" }))).toBe(false);
  });
});

describe("isOnboardingActive", () => {
  test("true gates background when first-run onboarding is shown", () => {
    expect(computeIsOnboardingActive(makeStorage({}))).toBe(true);
  });

  test("false when user has valid SK (app mode, no gating needed)", () => {
    expect(computeIsOnboardingActive(makeStorage({ [LS_NOSTR_SK]: VALID_SK }))).toBe(false);
  });

  test("false when onboarding done flag is set", () => {
    expect(computeIsOnboardingActive(makeStorage({ [LS_FIRST_RUN_ONBOARDING_DONE]: "done" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nav-guard tests
// ---------------------------------------------------------------------------

type ActivePage = "boards" | "upcoming" | "wallet" | "wallet-bounties" | "contacts" | "settings";

function guardedNavigate(isOnboardingActive: boolean, currentPage: ActivePage, requestedPage: ActivePage): ActivePage {
  if (isOnboardingActive) return currentPage;
  return requestedPage;
}

function snapBackActivePage(isOnboardingActive: boolean, activePage: ActivePage): ActivePage {
  if (isOnboardingActive && activePage !== "boards") return "boards";
  return activePage;
}

describe("nav-guard", () => {
  test("navigation to 'settings' is blocked while onboarding active", () => {
    const active = computeIsOnboardingActive(makeStorage({}));
    expect(active).toBe(true);
    expect(guardedNavigate(active, "boards", "settings")).toBe("boards");
  });

  test("navigation to 'upcoming' is blocked while onboarding active", () => {
    const active = computeIsOnboardingActive(makeStorage({}));
    expect(guardedNavigate(active, "boards", "upcoming")).toBe("boards");
  });

  test("navigation to 'wallet' is blocked while onboarding active", () => {
    const active = computeIsOnboardingActive(makeStorage({}));
    expect(guardedNavigate(active, "boards", "wallet")).toBe("boards");
  });

  test("navigation to 'contacts' is blocked while onboarding active", () => {
    const active = computeIsOnboardingActive(makeStorage({}));
    expect(guardedNavigate(active, "boards", "contacts")).toBe("boards");
  });

  test("navigation is allowed after onboarding completes", () => {
    const storage = makeStorage({ [LS_NOSTR_SK]: VALID_SK });
    const active = computeIsOnboardingActive(storage);
    expect(active).toBe(false);
    expect(guardedNavigate(active, "boards", "settings")).toBe("settings");
  });
});

describe("snap-back", () => {
  test("activePage forced to 'boards' when onboarding becomes active", () => {
    expect(snapBackActivePage(true, "settings")).toBe("boards");
  });

  test("activePage forced to 'boards' from any non-boards page", () => {
    const pages: ActivePage[] = ["upcoming", "wallet", "wallet-bounties", "contacts", "settings"];
    for (const page of pages) {
      expect(snapBackActivePage(true, page)).toBe("boards");
    }
  });

  test("activePage unchanged when already 'boards' during onboarding", () => {
    expect(snapBackActivePage(true, "boards")).toBe("boards");
  });

  test("activePage unchanged when onboarding is not active", () => {
    expect(snapBackActivePage(false, "settings")).toBe("settings");
  });
});

describe("startupView guard", () => {
  function applyStartupView(
    isOnboardingActive: boolean,
    startupView: string | undefined,
    currentPage: ActivePage,
  ): ActivePage {
    if (isOnboardingActive) return currentPage;
    if (startupView === "wallet") return "wallet";
    return currentPage;
  }

  test("startupView redirect is skipped while onboarding active", () => {
    const active = computeIsOnboardingActive(makeStorage({}));
    expect(active).toBe(true);
    expect(applyStartupView(active, "wallet", "boards")).toBe("boards");
  });

  test("startupView redirect proceeds once onboarding done", () => {
    const active = computeIsOnboardingActive(makeStorage({ [LS_NOSTR_SK]: VALID_SK }));
    expect(active).toBe(false);
    expect(applyStartupView(active, "wallet", "boards")).toBe("wallet");
  });
});
