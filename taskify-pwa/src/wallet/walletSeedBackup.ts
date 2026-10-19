/**
 * The wallet seed in backups (the local file and the Nostr app backup), without loading wallet
 * code at startup. The seed module registers itself here when it loads, which happens only on
 * devices that hold wallet data. A backup carries the seed only if one exists: backing up never
 * creates one.
 */
import type { WalletSeedBackupPayload } from "./seed";

let provider: (() => WalletSeedBackupPayload | null) | null = null;

export function registerWalletSeedBackupProvider(next: () => WalletSeedBackupPayload | null): void {
  provider = next;
}

/** The seed to back up, or null when this device has none. */
export function walletSeedForBackup(): WalletSeedBackupPayload | null {
  return provider ? provider() : null;
}

/** Restores a seed found in a backup (loading the seed module to do it). */
export async function restoreWalletSeedFromBackup(payload: unknown): Promise<void> {
  const { initWalletSeedStore, restoreWalletSeedBackup } = await import("./seed");
  await initWalletSeedStore();
  restoreWalletSeedBackup(payload);
}

/** Test-only. */
export function __resetWalletSeedBackupForTests(): void {
  provider = null;
}
