import { RelayAuthManager as RuntimeRelayAuthManager } from "taskify-runtime-nostr";
import { currentIdentity } from "../identity/identity";

/** Answers relay AUTH challenges with the user's signer (none while signed out). */
export class RelayAuthManager extends RuntimeRelayAuthManager {
  constructor(ndk: ConstructorParameters<typeof RuntimeRelayAuthManager>[0]) {
    super(ndk, {
      loadAccountSigner: () => {
        const identity = currentIdentity();
        if (!identity) return null;
        return { pubkey: identity.pubkey, sign: (template) => identity.signer.sign(template) as never };
      },
    });
  }
}
