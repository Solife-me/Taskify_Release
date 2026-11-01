/**
 * "Support development": a Lightning tip to the developers, paid from whatever Lightning wallet
 * the user has. Taskify's own wallet is being phased out, so it plays no part here.
 */
import { useToast } from "../../context/ToastContext";

export const SUPPORT_LIGHTNING_ADDRESS = "dev@solife.me";

export function SupportSection({ embedded = false }: { embedded?: boolean }) {
  const { show: showToast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(SUPPORT_LIGHTNING_ADDRESS);
      showToast(`Copied ${SUPPORT_LIGHTNING_ADDRESS}`);
    } catch {
      showToast("Unable to copy the address");
    }
  };
  return (
    <section className="wallet-section space-y-3">
      {!embedded && <div className="text-sm font-medium">Support development</div>}
      <div className="text-xs text-secondary">
        Send a Lightning tip to {SUPPORT_LIGHTNING_ADDRESS} from any Lightning wallet.
      </div>
      <div className="flex gap-2">
        <a className="accent-button button-sm pressable" href={`lightning:${SUPPORT_LIGHTNING_ADDRESS}`}>
          Open Lightning wallet
        </a>
        <button type="button" className="ghost-button button-sm pressable" onClick={copy}>
          Copy address
        </button>
      </div>
    </section>
  );
}
