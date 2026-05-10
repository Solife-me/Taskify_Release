import type { Proof, ProofState } from "@cashu/cashu-ts";
import type { MintConnection } from "./MintConnection";

type PendingRequest = {
  proofs: Proof[];
  resolve: (states: ProofState[]) => void;
  reject: (err: unknown) => void;
};

function proofKey(proof: Proof): string {
  if (!proof) return "invalid";
  if (proof.secret) return `secret:${proof.secret}`;
  const amount = (proof as any).amount;
  const amountKey =
    amount && typeof amount === "object" && typeof amount.toString === "function"
      ? amount.toString()
      : String(amount ?? 0);
  return `key:${proof.C ?? ""}|${proof.id ?? ""}|${amountKey}`;
}

export class StateCheckManager {
  private readonly connection: MintConnection;
  private queue: PendingRequest[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(connection: MintConnection) {
    this.connection = connection;
  }

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 25);
  }

  private async flush() {
    const batch = this.queue.splice(0);
    this.timer = null;
    if (!batch.length) return;

    const merged = batch.flatMap((item) => item.proofs || []);
    const unique: Proof[] = [];
    const seen = new Set<string>();
    for (const proof of merged) {
      const key = proofKey(proof);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(proof);
    }

    try {
      const requestKey = this.connection.requestCache.buildKey(
        "POST",
        "checkstate",
        unique.map((p) => proofKey(p)),
      );
      const states = await this.connection.runWithRateLimit(
        requestKey,
        () => this.connection.checkProofStates(unique),
        { ttlMs: 750, slow: true },
      );
      const stateMap = new Map<string, ProofState>();
      unique.forEach((proof, idx) => {
        stateMap.set(proofKey(proof), states[idx]);
      });
      batch.forEach((req) => {
        const mapped = req.proofs.map(
          (proof) =>
            stateMap.get(proofKey(proof)) ??
            ({ state: "UNKNOWN" as ProofState["state"] } as unknown as ProofState),
        );
        req.resolve(mapped);
      });
    } catch (err) {
      batch.forEach((req) => req.reject(err));
    }
  }

  async checkStates(proofs: Proof[]): Promise<ProofState[]> {
    if (!proofs?.length) return [];
    return new Promise<ProofState[]>((resolve, reject) => {
      this.queue.push({ proofs, resolve, reject });
      this.scheduleFlush();
    });
  }
}
