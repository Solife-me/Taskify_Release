import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { currentIdentity } from "../identity/identity";
import { kvStorage } from "../storage/kvStorage";
import {
  applyBackupDataToStorage,
  parseBackupJsonPayload,
} from "../domains/backup/backupUtils";
import {
  boardEntityStore,
  calendarEventEntityStore,
  externalCalendarEventEntityStore,
  taskEntityStore,
} from "../storage/entityStore";
import { LS_FIRST_RUN_ONBOARDING_DONE, shouldShowFirstRun } from "./firstRunRules";

type ActivePage = "boards" | "upcoming" | "wallet" | "wallet-bounties" | "wallet-address" | "chat" | "settings";

type UseFirstRunOnboardingParams = {
  activePage: ActivePage;
  applyCustomNostrKey: (value: string, options?: { silent?: boolean }) => boolean;
  rotateNostrKey: () => string;
  setActivePage: Dispatch<SetStateAction<ActivePage>>;
};

export function useFirstRunOnboarding({
  activePage,
  applyCustomNostrKey,
  rotateNostrKey,
  setActivePage,
}: UseFirstRunOnboardingParams) {
  const isOnboardingActiveRef = useRef(false);
  // Asked once at startup: a device without an identity starts here.
  const [showFirstRunOnboarding, setShowFirstRunOnboarding] = useState(() => {
    let onboardingDone = false;
    try {
      onboardingDone = kvStorage.getItem(LS_FIRST_RUN_ONBOARDING_DONE) === "done";
    } catch {}
    return shouldShowFirstRun({ hasIdentity: !!currentIdentity(), onboardingDone });
  });
  const completeFirstRunOnboarding = useCallback(() => {
    try {
      kvStorage.setItem(LS_FIRST_RUN_ONBOARDING_DONE, "done");
    } catch {}
    setShowFirstRunOnboarding(false);
  }, []);
  /** Signs in with a key the user already has, then lands on their tasks. */
  const handleOnboardingUseExistingKey = useCallback((value: string) => {
    const ok = applyCustomNostrKey(value, { silent: true });
    if (ok) completeFirstRunOnboarding();
    return ok;
  }, [applyCustomNostrKey, completeFirstRunOnboarding]);
  /**
   * "Start using Taskify": makes the account key quietly and lands on the board. The key-backup
   * reminder asks the user to save it once they have tasks worth keeping.
   */
  const handleOnboardingStart = useCallback(() => {
    try {
      rotateNostrKey();
    } catch {
      return false;
    }
    completeFirstRunOnboarding();
    return true;
  }, [completeFirstRunOnboarding, rotateNostrKey]);
  const completeOnboardingWithReload = useCallback(() => {
    completeFirstRunOnboarding();
    if (typeof window !== "undefined") {
      window.setTimeout(() => window.location.reload(), 120);
    }
  }, [completeFirstRunOnboarding]);
  const handleOnboardingRestoreFromBackupFile = useCallback(async (file: File) => {
    const parsed = parseBackupJsonPayload(await file.text());
    await applyBackupDataToStorage(parsed);
    await Promise.all([
      taskEntityStore.flush(),
      boardEntityStore.flush(),
      calendarEventEntityStore.flush(),
      externalCalendarEventEntityStore.flush(),
    ]);
    completeOnboardingWithReload();
  }, [completeOnboardingWithReload]);
  const isOnboardingActive = showFirstRunOnboarding;

  isOnboardingActiveRef.current = isOnboardingActive;

  useEffect(() => {
    if (isOnboardingActive && activePage !== "boards") {
      startTransition(() => setActivePage("boards"));
    }
  }, [isOnboardingActive, activePage, setActivePage]);

  return {
    handleOnboardingRestoreFromBackupFile,
    handleOnboardingStart,
    handleOnboardingUseExistingKey,
    isOnboardingActive,
    isOnboardingActiveRef,
    showFirstRunOnboarding,
  };
}
