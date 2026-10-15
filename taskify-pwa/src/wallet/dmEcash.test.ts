import { describe, expect, it } from "vitest";
import { isPaymentRequestPayment } from "./dmEcash";

describe("isPaymentRequestPayment", () => {
  it("accepts NUT-18 payloads with proofs", () => {
    expect(
      isPaymentRequestPayment({
        id: "abc",
        mint: "https://mint.example",
        unit: "sat",
        proofs: [{ amount: 1, secret: "s", C: "c", id: "k" }],
      }),
    ).toBe(true);
    expect(isPaymentRequestPayment({ mint: "https://mint.example", unit: "sat", proofs: [{ amount: 1 }] })).toBe(true);
  });

  it("rejects tokens pasted into a DM", () => {
    expect(isPaymentRequestPayment("cashuBo2F0gaJhaUgA")).toBe(false);
    expect(isPaymentRequestPayment({ token: "cashuBo2F0gaJhaUgA" })).toBe(false);
    expect(isPaymentRequestPayment({ proofs: [] })).toBe(false);
    expect(isPaymentRequestPayment(null)).toBe(false);
  });
});
