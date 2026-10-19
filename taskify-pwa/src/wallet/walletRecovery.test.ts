import { describe, expect, test } from "vitest";
import { getDecodedToken } from "@cashu/cashu-ts";
import { collectRecoverableFunds, encodeCashuTokenV3 } from "./walletRecovery";

const MINT = "https://mint.example";
const KEYSET = "009a1f293253e41e";
const proof = (secret: string, amount: number) => ({ id: "009a1f293253e41e", amount, secret, C: `02${"ab".repeat(32)}` });

describe("wallet recovery", () => {
  test("a recovery token is a standard Cashu token another wallet decodes", () => {
    const token = encodeCashuTokenV3(MINT, [proof("s1", 8), proof("s2", 2)]);
    expect(token.startsWith("cashuA")).toBe(true);
    const decoded = getDecodedToken(token, [KEYSET]);
    expect(decoded.mint).toBe(MINT);
    expect(decoded.unit).toBe("sat");
    expect(decoded.proofs.map((p) => [p.secret, Number((p.amount as any)?.value ?? p.amount)])).toEqual([["s1", 8], ["s2", 2]]);
  });

  test("collects each mint's notes, saved tokens and unclaimed sent tokens, without the mint", () => {
    const funds = collectRecoverableFunds({
      proofStore: {
        [MINT]: [proof("a", 64), proof("b", 1), { secret: "broken" }],
        "https://empty.example": [],
      },
      pendingTokens: [{ id: "p1", mint: MINT, token: " cashuBsaved ", addedAt: 1, attempts: 0, amount: 21 }],
      history: [
        { id: "h1", direction: "out", revertToken: "cashuBsent", amountSat: 5, summary: "Token for 5 sats", tokenState: { lastState: "UNSPENT", mintUrl: MINT } },
        { id: "h2", direction: "out", revertToken: "cashuBclaimed", amountSat: 9, tokenState: { lastState: "SPENT" } },
        { id: "h3", direction: "in", revertToken: "cashuBin", amountSat: 7 },
      ],
    });
    expect(funds.mints).toHaveLength(1);
    expect(funds.mints[0]).toMatchObject({ mintUrl: MINT, sat: 65 });
    expect(getDecodedToken(funds.mints[0].token, [KEYSET]).proofs).toHaveLength(2);
    expect(funds.savedTokens).toEqual([{ id: "p1", mintUrl: MINT, sat: 21, token: "cashuBsaved", label: "Saved token" }]);
    expect(funds.sentTokens.map((t) => t.id)).toEqual(["h1"]);
    expect(funds.totalSat).toBe(86);
  });

  test("an empty wallet has nothing to recover", () => {
    expect(collectRecoverableFunds({ proofStore: {}, pendingTokens: [], history: null })).toEqual({
      mints: [], savedTokens: [], sentTokens: [], totalSat: 0,
    });
  });
});
