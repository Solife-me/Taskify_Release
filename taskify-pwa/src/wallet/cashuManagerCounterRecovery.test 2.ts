import { describe, expect, test } from "vitest";
import { CashuManager } from "./CashuManager";

// Regression coverage for the auto-recovery added in response to mints
// returning "outputs have already been signed before" during redeem.
//
// The detector must match every shape the mint can hand back:
//   - bare Error.message (cashu-ts often wraps this)
//   - `detail` field on a plain object (raw HTTP response)
//   - `response.data.detail` chain (axios/fetch wrappers)
//   - bare string (defensive code paths)
// It must NOT match unrelated errors that share substrings.

describe("CashuManager.isOutputsAlreadySignedError", () => {
  test("matches the canonical mint error message", () => {
    const error = new Error("outputs have already been signed before.");
    expect(CashuManager.isOutputsAlreadySignedError(error)).toBe(true);
  });

  test("matches the shorter phrasing some mints return", () => {
    const error = new Error("outputs already signed");
    expect(CashuManager.isOutputsAlreadySignedError(error)).toBe(true);
  });

  test("is case-insensitive", () => {
    const error = new Error("Outputs Have Already Been Signed before");
    expect(CashuManager.isOutputsAlreadySignedError(error)).toBe(true);
  });

  test("matches when message is in the `detail` field (raw HTTP body shape)", () => {
    const err = { detail: "outputs have already been signed before." };
    expect(CashuManager.isOutputsAlreadySignedError(err)).toBe(true);
  });

  test("matches when message is in response.data.detail (axios shape)", () => {
    const err = {
      message: "Request failed with status code 400",
      response: { data: { detail: "outputs already signed" } },
    };
    expect(CashuManager.isOutputsAlreadySignedError(err)).toBe(true);
  });

  test("matches when error is a bare string", () => {
    expect(
      CashuManager.isOutputsAlreadySignedError("outputs already signed"),
    ).toBe(true);
  });

  test("does NOT match unrelated mint errors", () => {
    expect(
      CashuManager.isOutputsAlreadySignedError(
        new Error("token already spent"),
      ),
    ).toBe(false);
    expect(
      CashuManager.isOutputsAlreadySignedError(
        new Error("Insufficient balance"),
      ),
    ).toBe(false);
    expect(
      CashuManager.isOutputsAlreadySignedError(
        new Error("network request failed"),
      ),
    ).toBe(false);
  });

  test("does NOT match falsy / unrecognised errors", () => {
    expect(CashuManager.isOutputsAlreadySignedError(null)).toBe(false);
    expect(CashuManager.isOutputsAlreadySignedError(undefined)).toBe(false);
    expect(CashuManager.isOutputsAlreadySignedError(0)).toBe(false);
    expect(CashuManager.isOutputsAlreadySignedError({})).toBe(false);
    expect(CashuManager.isOutputsAlreadySignedError({ foo: "bar" })).toBe(false);
  });
});

// Integration test for the retry behavior. We stub out the cashu-ts wallet
// surface area that `withCounterRecoveryRetry` and
// `advanceCounterPastSignedOutputs` actually touch:
//   - `keysetId` getter
//   - `counters.peekNext(keysetId)`
//   - `counters.advanceToAtLeast(keysetId, target)`
// `receiveToken` is the most user-visible entrypoint, so we drive the
// flow through it and assert the second attempt only fires after the
// counter is bumped by the expected amount.

describe("CashuManager.receiveToken counter recovery", () => {
  const KEYSET_ID = "009a1f293253e41e";

  function buildStubWallet(opts: {
    receiveBehavior: (callIndex: number) => Promise<unknown[]>;
  }) {
    let counter = 5;
    const calls = {
      receive: 0,
      peekNext: 0,
      advanceToAtLeast: 0,
      advancedTargets: [] as number[],
    };
    const wallet: any = {
      keysetId: KEYSET_ID,
      counters: {
        async peekNext(id: string) {
          if (id !== KEYSET_ID) throw new Error("unexpected keyset");
          calls.peekNext += 1;
          return counter;
        },
        async advanceToAtLeast(id: string, target: number) {
          if (id !== KEYSET_ID) throw new Error("unexpected keyset");
          calls.advanceToAtLeast += 1;
          calls.advancedTargets.push(target);
          if (target > counter) counter = target;
        },
      },
      async receive() {
        const index = calls.receive;
        calls.receive += 1;
        return opts.receiveBehavior(index);
      },
      // unused — present so optional-chained calls on `this.wallet.…` succeed
      async loadMint() {},
      async getKeys() {},
    };
    return { wallet, calls, getCounter: () => counter };
  }

  function buildManager(wallet: any): CashuManager {
    const manager = new CashuManager("https://mint.example.com");
    // Bypass init() — we don't want to construct a real cashu-ts Wallet
    (manager as any).wallet = wallet;
    return manager;
  }

  test("retries once after 'outputs already signed' and succeeds", async () => {
    const successProofs = [
      { id: KEYSET_ID, amount: 1, secret: "s", C: "c" },
    ];
    const { wallet, calls } = buildStubWallet({
      receiveBehavior: async (index) => {
        if (index === 0) {
          throw new Error("outputs have already been signed before.");
        }
        return successProofs;
      },
    });
    // Skip the proof-validation / merging side-effects that aren't under test
    const manager = buildManager(wallet);
    (manager as any).autoSignProofs = (proofs: unknown[]) => proofs;
    (manager as any).validateDleqProofs = () => {};
    (manager as any).mergeProofs = () => {};
    (manager as any).resolvePrivkeysForToken = () => new Map();

    const result = await manager.receiveToken("cashuB...");

    expect(result).toEqual(successProofs);
    expect(calls.receive).toBe(2); // initial + one retry
    expect(calls.advanceToAtLeast).toBe(1);
    // Counter starts at 5; bump amount is 10; expect advance to >= 15
    expect(calls.advancedTargets[0]).toBe(15);
  });

  test("does NOT retry when the failure is something other than 'outputs already signed'", async () => {
    const { wallet, calls } = buildStubWallet({
      receiveBehavior: async () => {
        throw new Error("token already spent");
      },
    });
    const manager = buildManager(wallet);
    (manager as any).autoSignProofs = (proofs: unknown[]) => proofs;
    (manager as any).validateDleqProofs = () => {};
    (manager as any).mergeProofs = () => {};
    (manager as any).resolvePrivkeysForToken = () => new Map();

    await expect(manager.receiveToken("cashuB...")).rejects.toThrow(
      "token already spent",
    );
    expect(calls.receive).toBe(1); // no retry
    expect(calls.advanceToAtLeast).toBe(0);
  });

  test("if the retry ALSO fails with 'outputs already signed', the error propagates and counter stays advanced", async () => {
    const { wallet, calls, getCounter } = buildStubWallet({
      receiveBehavior: async () => {
        throw new Error("outputs have already been signed before");
      },
    });
    const manager = buildManager(wallet);
    (manager as any).autoSignProofs = (proofs: unknown[]) => proofs;
    (manager as any).validateDleqProofs = () => {};
    (manager as any).mergeProofs = () => {};
    (manager as any).resolvePrivkeysForToken = () => new Map();

    await expect(manager.receiveToken("cashuB...")).rejects.toThrow(
      "outputs have already been signed",
    );
    // Recovery still ran once before giving up
    expect(calls.receive).toBe(2);
    expect(calls.advanceToAtLeast).toBe(1);
    // Counter is now advanced so a subsequent manual retry starts fresh
    expect(getCounter()).toBe(15);
  });
});
