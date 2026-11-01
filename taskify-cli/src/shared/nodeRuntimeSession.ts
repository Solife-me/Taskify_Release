import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { DEFAULT_NOSTR_RELAYS } from "taskify-core";
import {
  collectRuntimeRelayUrls,
  RelayAuthManager,
  RelayHealthTracker,
  RelayInfoCache,
  RelayPublishBudget,
  RuntimeNostrSession,
  withStandaloneSession as withRuntimeStandaloneSession,
  type RelayPublishBudgetSnapshot,
  type RelayPublishBudgetStateStore,
  type StandaloneNostrSession,
  type StandaloneSessionOptions,
  type RuntimeProofOfWorkSettings,
  type NostrOutboxMutation,
  type NostrOutboxStore,
} from "taskify-runtime-nostr";
import type { TaskifyConfig } from "../config.js";

export const NOSTR_OUTBOX_PATH = join(homedir(), ".taskify-cli", "nostr-outbox.json");
export const RELAY_PUBLISH_BUDGET_PATH = join(homedir(), ".taskify-cli", "relay-publish-budget.json");

type StoredOutbox = {
  version: 1;
  mutations: NostrOutboxMutation[];
};

function missing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readMutations(filePath: string): Promise<NostrOutboxMutation[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as Partial<StoredOutbox>;
    if (!Array.isArray(parsed.mutations)) return [];
    return parsed.mutations.filter((row): row is NostrOutboxMutation =>
      !!row && typeof row === "object" && typeof row.id === "string" && row.kind === "nostr.publish");
  } catch (error) {
    if (missing(error)) return [];
    throw new Error(`Nostr outbox is malformed: ${filePath}`, { cause: error });
  }
}

async function lockFile(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (!(error instanceof Error)
        || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    }
  }
  throw new Error("Timed out waiting for the Nostr outbox lock.");
}

async function writeMutations(filePath: string, mutations: NostrOutboxMutation[]): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, mutations }, null, 2), "utf-8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export class FileNostrOutboxStore implements NostrOutboxStore {
  private readonly filePath: string;

  constructor(filePath = NOSTR_OUTBOX_PATH) {
    this.filePath = filePath;
  }

  async get(id: string): Promise<NostrOutboxMutation | undefined> {
    return (await readMutations(this.filePath)).find((row) => row.id === id);
  }

  async put(mutation: NostrOutboxMutation): Promise<void> {
    await this.update((rows) => [...rows.filter((row) => row.id !== mutation.id), mutation]);
  }

  async delete(id: string): Promise<void> {
    await this.update((rows) => rows.filter((row) => row.id !== id));
  }

  async listPending(): Promise<NostrOutboxMutation[]> {
    return readMutations(this.filePath);
  }

  private async update(
    operation: (mutations: NostrOutboxMutation[]) => NostrOutboxMutation[],
  ): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockFile(`${this.filePath}.lock`);
    try {
      await writeMutations(this.filePath, operation(await readMutations(this.filePath)));
    } finally {
      await release();
    }
  }
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireSyncLock(lockPath: string): () => void {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600);
      return () => {
        try { closeSync(descriptor); } finally { try { unlinkSync(lockPath); } catch {} }
      };
    } catch (error) {
      if (!(error instanceof Error)
        || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A killed CLI must not permanently strand every later publish.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 5_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      sleepSync(15);
    }
  }
  throw new Error("Timed out waiting for the relay publish budget lock.");
}

function readBudgetSnapshot(filePath: string): RelayPublishBudgetSnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as RelayPublishBudgetSnapshot;
    return parsed?.version === 1 && parsed.relays && typeof parsed.relays === "object" ? parsed : null;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Cross-process state for the CLI's Damus-safe token bucket and rejection backoff. */
export class FileRelayPublishBudgetStateStore implements RelayPublishBudgetStateStore {
  private readonly filePath: string;

  constructor(filePath = RELAY_PUBLISH_BUDGET_PATH) {
    this.filePath = filePath;
  }

  update(operation: (snapshot: RelayPublishBudgetSnapshot | null) => RelayPublishBudgetSnapshot): RelayPublishBudgetSnapshot {
    const directory = dirname(this.filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const release = acquireSyncLock(`${this.filePath}.lock`);
    try {
      const snapshot = operation(readBudgetSnapshot(this.filePath));
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(snapshot, null, 2), "utf-8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        renameSync(temporary, this.filePath);
        chmodSync(this.filePath, 0o600);
      } catch (error) {
        try { closeSync(descriptor); } catch {}
        try { unlinkSync(temporary); } catch {}
        throw error;
      }
      return snapshot;
    } finally {
      release();
    }
  }
}

export function createCliRelayPublishBudget(filePath?: string): RelayPublishBudget {
  return new RelayPublishBudget({
    stateStore: new FileRelayPublishBudgetStateStore(filePath),
  });
}

/** One-off CLI publishers share the same cross-process budget as normal task writes. */
export function withCliStandaloneSession<T>(
  options: StandaloneSessionOptions,
  work: (session: StandaloneNostrSession) => Promise<T>,
): Promise<T> {
  return withRuntimeStandaloneSession(
    { ...options, publishBudget: options.publishBudget ?? createCliRelayPublishBudget() },
    work,
  );
}

export function secretKeyHexFromNsec(nsec: string | undefined): string {
  const value = nsec?.trim();
  if (!value) throw new Error("No nsec configured for the active profile.");
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLocaleLowerCase();
  const decoded = nip19.decode(value);
  if (decoded.type !== "nsec") throw new Error("Invalid nsec for the active profile.");
  return bytesToHex(decoded.data as Uint8Array);
}

export type CliNostrSession = RuntimeNostrSession<undefined>;

export function collectCliRelayUrls(config: Pick<TaskifyConfig, "relays" | "boards">): string[] {
  return collectRuntimeRelayUrls([...DEFAULT_NOSTR_RELAYS, ...config.relays], config.boards);
}

export function createCliNostrSession(
  config: TaskifyConfig,
  options: {
    outboxPath?: string;
    publishBudgetPath?: string;
    verbose?: boolean;
    /** Persistent NIP-11 / learned-PoW cache (see `cliRelayInfoCache`). */
    relayInfoCache?: RelayInfoCache;
    proofOfWork?: RuntimeProofOfWorkSettings;
  } = {},
): { session: CliNostrSession; relays: string[]; secretKeyHex: string | null } {
  let secretKeyHex: string | null = null;
  try {
    secretKeyHex = secretKeyHexFromNsec(config.nsec);
  } catch {
    // Read-only board traffic can still work without an account identity. Relays that
    // demand NIP-42 auth are answered with a throwaway key until one is set.
  }
  const relays = collectCliRelayUrls(config);
  const session = new RuntimeNostrSession<undefined>(relays, {
    relayInfoCache: options.relayInfoCache ?? new RelayInfoCache(),
    relayHealth: new RelayHealthTracker(),
    createAuthManager: (ndk) => new RelayAuthManager(ndk, {
      loadSecretKeyHex: () => secretKeyHex,
      allowEphemeralKey: true,
    }),
    createWalletClient: () => undefined,
    outboxStore: new FileNostrOutboxStore(options.outboxPath),
    publishBudget: createCliRelayPublishBudget(options.publishBudgetPath),
    isDev: options.verbose,
    proofOfWork: options.proofOfWork,
    // The CLI always names its relays; don't also dial NDK's discovery relays.
    enableOutboxModel: false,
  });
  return { session, relays, secretKeyHex };
}
