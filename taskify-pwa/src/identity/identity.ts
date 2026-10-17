/**
 * Who the user is on Nostr: their public key and the signer that acts for them. This is the only
 * place that knows where the key lives. Code that signs or encrypts asks for the signer
 * (`currentIdentity()?.signer` or `useIdentity()`); code that only needs the public key asks for
 * that (`currentPubkey()`).
 *
 * The raw secret key is available only through `revealLocalSecretKey`, for the few features that
 * cannot work through a signer: showing or backing up the key, and the Taskify wallet (being
 * phased out), whose keys and token encryption are derived from it. Those features are
 * unavailable when the key is held by an extension or a remote signer.
 */
import { useSyncExternalStore } from "react";
import {
  clearSk as clearStoredSecretKey,
  getSkSync as storedSecretKeyHex,
  isLoaded as isSecretKeyStoreLoaded,
  setSk as storeSecretKey,
  whenLoaded as whenSecretKeyStoreLoaded,
} from "../lib/nostrSkStore";
import { createStateStore, type StateStore } from "../state/stateStore";
import { LocalKeySigner, type NostrSigner } from "./signer";

export type Identity = {
  pubkey: string;
  signer: NostrSigner;
};

let store: StateStore<Identity | null> | null = null;

function localIdentity(secretKeyHex: string): Identity {
  const signer = new LocalKeySigner(secretKeyHex);
  return { pubkey: signer.pubkey, signer };
}

function readStoredIdentity(): Identity | null {
  try {
    const stored = storedSecretKeyHex().trim();
    return stored ? localIdentity(stored) : null;
  } catch {
    return null;
  }
}

/**
 * The identity store, loaded on first use from the key stored on this device. If it is first used
 * before the key store has finished loading, it fills in once loading completes.
 */
export function identityStore(): StateStore<Identity | null> {
  if (!store) {
    const created = createStateStore(readStoredIdentity());
    store = created;
    if (!isSecretKeyStoreLoaded()) {
      void whenSecretKeyStoreLoaded().then(() => {
        if (store === created && !created.get()) created.set(readStoredIdentity());
      });
    }
  }
  return store;
}

export function currentIdentity(): Identity | null {
  return identityStore().get();
}

/** The signed-in user's public key (hex), or null before sign-in. */
export function currentPubkey(): string | null {
  return currentIdentity()?.pubkey ?? null;
}

export function useIdentity(): Identity | null {
  const identityState = identityStore();
  return useSyncExternalStore(identityState.subscribe, identityState.get, identityState.get);
}

/** Signs in with a key held in this browser, storing it (encrypted at rest) for next time. */
export async function adoptLocalSecretKey(secretKeyHex: string): Promise<Identity> {
  const identity = localIdentity(secretKeyHex);
  // The key store updates its cache at once and encrypts in the background; so does the identity.
  const persisted = storeSecretKey((identity.signer as LocalKeySigner).secretKeyHex());
  identityStore().set(identity);
  await persisted;
  return identity;
}

/** Forgets the identity and the stored key on this device. */
export async function signOut(): Promise<void> {
  await clearStoredSecretKey();
  identityStore().set(null);
}

/**
 * The secret key held in this browser, or null when there is none or another signer holds it.
 * Only for showing or backing up the key and for the Taskify wallet; everything else signs and
 * encrypts through the signer.
 */
export function revealLocalSecretKey(): string | null {
  const signer = currentIdentity()?.signer;
  return signer instanceof LocalKeySigner ? signer.secretKeyHex() : null;
}

/** Drops the loaded identity so the next use reads storage again. Tests only. */
export function resetIdentityForTests(): void {
  store = null;
}
