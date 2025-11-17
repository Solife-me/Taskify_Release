const MSATS_PER_BTC = 100_000_000_000n;

const BOLT11_AMOUNT_DIVISORS = {
  "": 1n,
  m: 1_000n,
  u: 1_000_000n,
  n: 1_000_000_000n,
  p: 1_000_000_000_000n,
} as const;

export type Bolt11AmountInfo = {
  amountMsat: bigint | null;
};

export function decodeBolt11Amount(invoice: string): Bolt11AmountInfo {
  const trimmed = invoice.trim();
  if (!trimmed) throw new Error("Missing invoice");
  const lower = trimmed.toLowerCase();
  const separatorIdx = lower.lastIndexOf("1");
  if (separatorIdx <= 2) throw new Error("Invalid BOLT11 invoice");
  const hrp = lower.slice(0, separatorIdx);
  if (!hrp.startsWith("ln")) throw new Error("Invalid BOLT11 invoice");
  const hrpBody = hrp.slice(2);
  let idx = 0;
  while (idx < hrpBody.length && /[a-z]/.test(hrpBody[idx])) idx++;
  const amountPart = hrpBody.slice(idx);
  if (!amountPart) return { amountMsat: null };
  const match = amountPart.match(/^(\d+)([a-z]?)$/);
  if (!match) throw new Error("Unsupported BOLT11 amount encoding");
  const [, valuePart, unitPart] = match;
  const value = BigInt(valuePart);
  const unitKey = (unitPart || "") as keyof typeof BOLT11_AMOUNT_DIVISORS;
  const divisor = BOLT11_AMOUNT_DIVISORS[unitKey];
  if (!divisor) throw new Error("Unsupported BOLT11 amount unit");
  const numerator = value * MSATS_PER_BTC;
  if (numerator % divisor !== 0n) {
    throw new Error("Invoice amount has unsupported precision");
  }
  const amountMsat = numerator / divisor;
  return { amountMsat };
}

export function formatMsatAsSat(amountMsat: bigint): string {
  const wholeSat = amountMsat / 1000n;
  const remainderMsat = amountMsat % 1000n;
  if (remainderMsat === 0n) {
    return `${wholeSat.toString()} sat`;
  }
  const decimals = remainderMsat.toString().padStart(3, "0").replace(/0+$/, "");
  return `${wholeSat.toString()}.${decimals} sat`;
}

export function estimateInvoiceAmountSat(invoice: string): number | null {
  try {
    const { amountMsat } = decodeBolt11Amount(invoice);
    if (amountMsat === null) return null;
    const sat = amountMsat / 1000n;
    return Number(sat);
  } catch {
    return null;
  }
}
