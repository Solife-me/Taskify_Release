import { useEffect } from "react";

export function useClipboardWriteToast(showToast: () => void) {
  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const clip: any = (navigator as any).clipboard;
    if (!clip || typeof clip.writeText !== "function") return;
    const original = clip.writeText.bind(clip);
    const patched = (text: string) => {
      try {
        const result = original(text);
        if (result && typeof result.then === "function") {
          result.then(() => showToast()).catch(() => {});
        } else {
          showToast();
        }
        return result;
      } catch {
        try { return original(text); } catch {}
      }
    };
    try { clip.writeText = patched; } catch {}
    return () => { try { clip.writeText = original; } catch {} };
  }, [showToast]);
}
