import { useCallback, useEffect, useRef, useState } from "react";

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
  const showWallet = walletEnabled && activePage === "wallet";
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
  const [updateToastVisible, setUpdateToastVisible] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    function handleUpdateAvailable() {
      setUpdateToastVisible(true);
    }

    window.addEventListener("taskify:update-available", handleUpdateAvailable);
    return () => {
      window.removeEventListener("taskify:update-available", handleUpdateAvailable);
    };
  }, []);

  const handleReloadNow = useCallback(() => {
    setUpdateToastVisible(false);
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }, []);

  const handleReloadLater = useCallback(() => {
    setUpdateToastVisible(false);
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
