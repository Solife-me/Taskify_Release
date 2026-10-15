import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  configureStandaloneRelayAccess,
  MAX_PROOF_OF_WORK_DIFFICULTY,
  RelayInfoCache,
  type ProofOfWorkHashFactory,
  type RelayInfoStorage,
  type RuntimeProofOfWorkSettings,
} from "taskify-runtime-nostr";

/** Per-relay NIP-11 limits and learned NIP-13 targets, kept between runs. */
export function relayInfoPath(): string {
  return join(homedir(), ".taskify-cli", "relay-info.json");
}

/** Mining a relay's target can take a while on a laptop; give it two minutes unless told otherwise. */
export const DEFAULT_POW_TIMEOUT_MS = 120_000;
/** Below this, mining finishes in well under a second and isn't worth announcing. */
const ANNOUNCE_POW_FROM = 18;

/** Node's native SHA-256 mines several times faster than the portable fallback. */
export const nodeProofOfWorkHashFactory: ProofOfWorkHashFactory = (prefix, suffix) => {
  const head = createHash("sha256").update(prefix, "utf8");
  const tail = Buffer.from(suffix, "utf8");
  return (nonce) => head.copy().update(nonce, "latin1").update(tail).digest();
};

class FileRelayInfoStorage implements RelayInfoStorage {
  private values: Record<string, string> | null = null;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private load(): Record<string, string> {
    if (this.values) return this.values;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as unknown;
      this.values = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string")) as Record<string, string>
        : {};
    } catch {
      this.values = {};
    }
    return this.values;
  }

  getItem(key: string): string | null {
    return this.load()[key] ?? null;
  }

  setItem(key: string, value: string): void {
    const values = this.load();
    values[key] = value;
    // A cache: a failed write only costs a NIP-11 fetch next run.
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(values), { mode: 0o600 });
      renameSync(temporary, this.filePath);
      chmodSync(this.filePath, 0o600);
    } catch {
      // ignore
    }
  }
}

let relayInfoCache: RelayInfoCache | null = null;
let settings: RuntimeProofOfWorkSettings = baseSettings();

export function cliRelayInfoCache(): RelayInfoCache {
  relayInfoCache ??= new RelayInfoCache({ storage: new FileRelayInfoStorage(relayInfoPath()) });
  return relayInfoCache;
}

export function parsePowDifficulty(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PROOF_OF_WORK_DIFFICULTY) return null;
  return value;
}

function powTimeoutMs(): number {
  const raw = Number(process.env.TASKIFY_POW_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POW_TIMEOUT_MS;
}

const announced = new Set<number>();

function announceMining(difficulty: number, relays: string[]): void {
  // Only an interactive terminal is told: agents read stdout and shouldn't see progress noise.
  if (difficulty < ANNOUNCE_POW_FROM || !process.stderr.isTTY || announced.has(difficulty)) return;
  announced.add(difficulty);
  const target = relays.length === 1 ? relays[0] : `${relays.length} relays`;
  process.stderr.write(`Mining proof of work (difficulty ${difficulty}) for ${target}…\n`);
}

function baseSettings(minDifficulty = 0): RuntimeProofOfWorkSettings {
  return {
    hashFactory: nodeProofOfWorkHashFactory,
    timeoutMs: powTimeoutMs(),
    minDifficulty,
    onMine: announceMining,
  };
}

/** Proof-of-work settings for the active profile (applied by `loadConfig`). */
export function cliProofOfWorkSettings(): RuntimeProofOfWorkSettings {
  return settings;
}

/**
 * Applies a profile's relay settings to every relay client in this process: the persistent
 * relay-info cache, native-speed mining and the profile's own NIP-13 floor (`powDifficulty`).
 */
export function applyCliRelaySettings(profile: { powDifficulty?: number }): void {
  settings = baseSettings(parsePowDifficulty(profile.powDifficulty) ?? 0);
  configureStandaloneRelayAccess({ relayInfoCache: cliRelayInfoCache(), proofOfWork: settings });
}
