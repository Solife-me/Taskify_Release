import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { getSkSync as nostrSkSync } from "../lib/nostrSkStore";
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
import { getWalletSeedMnemonic } from "../wallet/seed";
import { detectPushPlatformFromNavigator, type PushPlatform } from "../domains/push/pushUtils";

const LS_FIRST_RUN_ONBOARDING_DONE = "taskify_onboarding_done_v1";

type ActivePage = "boards" | "upcoming" | "wallet" | "wallet-bounties" | "wallet-address" | "chat" | "settings";

type UseFirstRunOnboardingParams = {
  activePage: ActivePage;
  applyCustomNostrKey: (value: string, options?: { silent?: boolean }) => boolean;
  enablePushNotifications: (platform: PushPlatform) => Promise<void>;
  pushPlatform?: PushPlatform | null;
  rotateNostrKey: () => string;
  setActivePage: Dispatch<SetStateAction<ActivePage>>;
  vapidPublicKey: string;
  workerBaseUrl: string;
};

export function useFirstRunOnboarding({
  activePage,
  applyCustomNostrKey,
  enablePushNotifications,
  pushPlatform,
  rotateNostrKey,
  setActivePage,
  vapidPublicKey,
  workerBaseUrl,
}: UseFirstRunOnboardingParams) {
  const isOnboardingActiveRef = useRef(false);
  const onboardingNeedsKeySelection = useMemo(() => {
    try {
      const raw = nostrSkSync().trim();
      return !/^[0-9a-fA-F]{64}$/.test(raw);
    } catch {
      return true;
    }
  }, []);
  const [showFirstRunOnboarding, setShowFirstRunOnboarding] = useState(() => {
    if (!onboardingNeedsKeySelection) return false;
    try {
      return kvStorage.getItem(LS_FIRST_RUN_ONBOARDING_DONE) !== "done";
    } catch {
      return true;
    }
  });
  const completeFirstRunOnboarding = useCallback(() => {
    try {
      kvStorage.setItem(LS_FIRST_RUN_ONBOARDING_DONE, "done");
    } catch {}
    setShowFirstRunOnboarding(false);
  }, []);
  const handleOnboardingUseExistingKey = useCallback((value: string) => {
    return applyCustomNostrKey(value, { silent: true });
  }, [applyCustomNostrKey]);
  const handleOnboardingGenerateNewKey = useCallback(() => {
    try {
      const nsec = rotateNostrKey();
      getWalletSeedMnemonic();
      return { nsec };
    } catch {
      return null;
    }
  }, [rotateNostrKey]);
  const completeOnboardingWithReload = useCallback(() => {
    completeFirstRunOnboarding();
    if (typeof window !== "undefined") {
      window.setTimeout(() => window.location.reload(), 120);
    }
  }, [completeFirstRunOnboarding]);
  const handleOnboardingRestoreFromBackupFile = useCallback(async (file: File) => {
    const parsed = parseBackupJsonPayload(await file.text());
    applyBackupDataToStorage(parsed);
    await Promise.all([
      taskEntityStore.flush(),
      boardEntityStore.flush(),
      calendarEventEntityStore.flush(),
      externalCalendarEventEntityStore.flush(),
    ]);
    completeOnboardingWithReload();
  }, [completeOnboardingWithReload]);
  const handleOnboardingEnableNotifications = useCallback(async () => {
    const platform = pushPlatform === "android" ? "android" : detectPushPlatformFromNavigator();
    await enablePushNotifications(platform);
  }, [enablePushNotifications, pushPlatform]);
  const onboardingPushSupported = typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && window.isSecureContext;
  const onboardingPushConfigured = !!workerBaseUrl && !!vapidPublicKey;
  const isOnboardingActive = showFirstRunOnboarding;

  isOnboardingActiveRef.current = isOnboardingActive;

  useEffect(() => {
    if (isOnboardingActive && activePage !== "boards") {
      startTransition(() => setActivePage("boards"));
    }
  }, [isOnboardingActive, activePage, setActivePage]);

  return {
    completeFirstRunOnboarding,
    handleOnboardingEnableNotifications,
    handleOnboardingGenerateNewKey,
    handleOnboardingRestoreFromBackupFile,
    handleOnboardingUseExistingKey,
    isOnboardingActive,
    isOnboardingActiveRef,
    onboardingPushConfigured,
    onboardingPushSupported,
    showFirstRunOnboarding,
  };
}
