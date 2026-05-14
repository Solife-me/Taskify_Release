import { RelayAuthManager as RuntimeRelayAuthManager } from "taskify-runtime-nostr";
import { getSkSync as nostrSkSync } from "../lib/nostrSkStore";

export class RelayAuthManager extends RuntimeRelayAuthManager {
  constructor(ndk: ConstructorParameters<typeof RuntimeRelayAuthManager>[0]) {
    super(ndk, {
      loadSecretKeyHex: () => {
        const raw = nostrSkSync().trim();
        return raw || null;
      },
    });
  }
}
