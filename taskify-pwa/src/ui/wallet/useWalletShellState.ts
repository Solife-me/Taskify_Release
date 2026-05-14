import { useCallback, useEffect, useRef, useState } from "react";

type UseWalletShellStateParams = {
  activePage: string;
  loadWalletModal: () => Promise<unknown>;
  showToast: (message: string, duration?: number) => void;
};

export function useWalletShellState({
  activePage,
  loadWalletModal,
  showToast,
}: UseWalletShellStateParams) {
  const showWallet = activePage === "wallet";
  const showChat = activePage === "chat";
  const showWalletShell = showWallet || showChat;
  const walletModalPrefetchedRef = useRef(false);
  const prefetchWalletModal = useCallback(() => {
    if (walletModalPrefetchedRef.current) return;
    walletModalPrefetchedRef.current = true;
    loadWalletModal().catch((err) => {
      if ((import.meta as any)?.env?.DEV) console.warn("[wallet] prefetch failed", err);
      walletModalPrefetchedRef.current = false;
    });
  }, [loadWalletModal]);
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (showWalletShell || walletModalPrefetchedRef.current) return;
    const requestIdle = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number)
      | undefined;
    const cancelIdle = (window as any).cancelIdleCallback as ((id: number) => void) | undefined;
    let idleId: number | null = null;
    let timer: number | undefined;
    if (requestIdle) {
      idleId = requestIdle(() => prefetchWalletModal(), { timeout: 1200 });
    } else {
      timer = window.setTimeout(() => {
        prefetchWalletModal();
      }, 300);
    }
    return () => {
      if (idleId != null && cancelIdle) {
        cancelIdle(idleId);
      }
      if (typeof timer === "number") {
        window.clearTimeout(timer);
      }
    };
  }, [prefetchWalletModal, showWalletShell]);

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
