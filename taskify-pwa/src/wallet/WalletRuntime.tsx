import { useEffect } from "react";
import { CashuProvider } from "../context/CashuContext";
import { NwcProvider } from "../context/NwcContext";
import { P2PKProvider } from "../context/P2PKContext";
import {
  publishedCashu,
  publishedNwc,
  publishedP2PK,
  useCashu,
  useNwc,
  useP2PK,
} from "../context/walletContexts";

/** Hands each provider's current value to the hooks used outside the runtime. */
function WalletPublisher() {
  const cashu = useCashu();
  const nwc = useNwc();
  const p2pk = useP2PK();
  useEffect(() => publishedCashu.set(cashu), [cashu]);
  useEffect(() => publishedNwc.set(nwc), [nwc]);
  useEffect(() => publishedP2PK.set(p2pk), [p2pk]);
  useEffect(
    () => () => {
      publishedCashu.set(null);
      publishedNwc.set(null);
      publishedP2PK.set(null);
    },
    [],
  );
  return null;
}

/**
 * The Taskify wallet: its providers and the Cashu SDK they load. `App` mounts this lazily, beside
 * itself, only on devices where the wallet is enabled (see `walletContexts`).
 */
export default function WalletRuntime() {
  return (
    <NwcProvider>
      <P2PKProvider>
        <CashuProvider>
          <WalletPublisher />
        </CashuProvider>
      </P2PKProvider>
    </NwcProvider>
  );
}
