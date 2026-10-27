// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";
import {
  CashuContext,
  WalletUnavailableError,
  publishedCashu,
  useCashu,
  useNwc,
  useP2PK,
} from "./walletContexts";
import type { CashuContextType } from "./CashuContext";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  publishedCashu.set(null);
});

async function readHooks(wrap?: (node: React.ReactNode) => React.ReactNode) {
  const seen: { cashu?: CashuContextType; nwc?: ReturnType<typeof useNwc>; p2pk?: ReturnType<typeof useP2PK> } = {};
  function Probe() {
    seen.cashu = useCashu();
    seen.nwc = useNwc();
    seen.p2pk = useP2PK();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(wrap ? wrap(<Probe />) : <Probe />));
  return { seen, unmount: () => act(async () => root.unmount()) };
}

test("without the wallet running, hooks return an unavailable wallet whose actions fail clearly", async () => {
  const { seen, unmount } = await readHooks();
  expect(seen.cashu?.ready).toBe(false);
  expect(seen.cashu?.totalBalance).toBe(0);
  await expect(seen.cashu!.receiveToken("cashuA")).rejects.toBeInstanceOf(WalletUnavailableError);
  expect(seen.nwc?.wallets).toEqual([]);
  expect(seen.p2pk?.getPrivateKeyForPubkey("x")).toBeNull();
  expect(() => seen.p2pk!.generateKeypair()).toThrow(WalletUnavailableError);
  await unmount();
});

test("outside the runtime, hooks follow the value the runtime publishes", async () => {
  const { seen, unmount } = await readHooks();
  const running = { ready: true, totalBalance: 21 } as CashuContextType;
  await act(async () => publishedCashu.set(running));
  expect(seen.cashu).toBe(running);
  await act(async () => publishedCashu.set(null));
  expect(seen.cashu?.ready).toBe(false);
  await unmount();
});

test("inside the runtime, the nearest provider wins", async () => {
  publishedCashu.set({ ready: true, totalBalance: 1 } as CashuContextType);
  const provided = { ready: true, totalBalance: 5 } as CashuContextType;
  const { seen, unmount } = await readHooks((node) => <CashuContext.Provider value={provided}>{node}</CashuContext.Provider>);
  expect(seen.cashu).toBe(provided);
  await unmount();
});
