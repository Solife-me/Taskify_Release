import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
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
  RuntimeNostrSession,
  type NostrOutboxMutation,
  type NostrOutboxStore,
} from "taskify-runtime-nostr";
import type { TaskifyConfig } from "../config.js";

export const NOSTR_OUTBOX_PATH = join(homedir(), ".taskify-cli", "nostr-outbox.json");

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
  options: { outboxPath?: string; verbose?: boolean } = {},
): { session: CliNostrSession; relays: string[]; secretKeyHex: string | null } {
  let secretKeyHex: string | null = null;
  try {
    secretKeyHex = secretKeyHexFromNsec(config.nsec);
  } catch {
    // Read-only board traffic can still work without an account identity. NIP-42
    // auth and account-backup discovery remain unavailable until one is set.
  }
  const relays = collectCliRelayUrls(config);
  const session = new RuntimeNostrSession<undefined>(relays, {
    relayInfoCache: new RelayInfoCache(),
    relayHealth: new RelayHealthTracker(),
    createAuthManager: (ndk) => new RelayAuthManager(ndk, {
      loadSecretKeyHex: () => secretKeyHex,
    }),
    createWalletClient: () => undefined,
    outboxStore: new FileNostrOutboxStore(options.outboxPath),
    isDev: options.verbose,
  });
  return { session, relays, secretKeyHex };
}
