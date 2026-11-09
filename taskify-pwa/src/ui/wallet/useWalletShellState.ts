import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import {
  activateWaitingServiceWorker,
  dismissServiceWorkerUpdate,
  isServiceWorkerUpdateAvailable,
  subscribeServiceWorkerUpdate,
} from "../../pwa/serviceWorkerClient";

type UseWalletShellStateParams = {
  activePage: string;
  loadWalletModal: () => Promise<unknown>;
  showToast: (message: string, duration?: number) => void;
  walletEnabled: boolean;
};

export function useWalletShellState({
  activePage,
  loadWalletModal,
  showToast,
  walletEnabled,
}: UseWalletShellStateParams) {
  const showWallet = walletEnabled && (activePage === "wallet" || activePage === "wallet-move-out");
  const showChat = activePage === "chat";
  const showWalletShell = showWallet;
  const walletModalPrefetchedRef = useRef(false);
  const prefetchWalletModal = useCallback(() => {
    if (!walletEnabled) return;
    if (walletModalPrefetchedRef.current) return;
    walletModalPrefetchedRef.current = true;
    loadWalletModal().catch((err) => {
      if ((import.meta as any)?.env?.DEV) console.warn("[wallet] prefetch failed", err);
      walletModalPrefetchedRef.current = false;
    });
  }, [loadWalletModal, walletEnabled]);
  const [walletTokenStateResetNonce, setWalletTokenStateResetNonce] = useState(0);
  const updateToastVisible = useSyncExternalStore(
    subscribeServiceWorkerUpdate,
    isServiceWorkerUpdateAvailable,
    isServiceWorkerUpdateAvailable,
  );

  const handleReloadNow = useCallback(() => {
    dismissServiceWorkerUpdate();
    void activateWaitingServiceWorker();
  }, []);

  const handleReloadLater = useCallback(() => {
    dismissServiceWorkerUpdate();
  }, []);

  const handleResetWalletTokenTracking = useCallback(() => {
    setWalletTokenStateResetNonce((value) => value + 1);
    showToast("Background token tracking reset", 3000);
  }, [showToast]);

  return {
    handleReloadLater,
    handleReloadNow,
    handleResetWalletTokenTracking,
    prefetchWalletModal,
    showChat,
    showWallet,
    showWalletShell,
    updateToastVisible,
    walletTokenStateResetNonce,
  };
}
