import NDK from "@nostr-dev-kit/ndk";
import { RelayAuthManager as RuntimeRelayAuthManager } from "taskify-runtime-nostr";
import { getSkSync as nostrSkSync } from "../lib/nostrSkStore";

export class RelayAuthManager extends RuntimeRelayAuthManager {
  constructor(ndk: NDK) {
    super(ndk, {
      loadSecretKeyHex: () => {
        const raw = nostrSkSync().trim();
        return raw || null;
      },
    });
  }
}
