import { useEffect, useRef, useState } from "react";

type RuntimeConfig = {
  workerBaseUrl: string | null;
  vapidPublicKey: string | null;
};

export function useRuntimeConfig({
  fallbackVapidPublicKey,
  fallbackWorkerBaseUrl,
}: {
  fallbackVapidPublicKey: string;
  fallbackWorkerBaseUrl: string;
}) {
  const [workerBaseUrl, setWorkerBaseUrl] = useState<string>(fallbackWorkerBaseUrl);
  const [vapidPublicKey, setVapidPublicKey] = useState<string>(fallbackVapidPublicKey);
  const runtimeConfigPromiseRef = useRef<Promise<RuntimeConfig | null> | null>(null);

  if (typeof window !== "undefined") {
    (window as any).__TASKIFY_WORKER_BASE_URL__ = workerBaseUrl;
  }

  useEffect(() => {
    let cancelled = false;
    if (!runtimeConfigPromiseRef.current) {
      runtimeConfigPromiseRef.current = loadRuntimeConfig();
    }

    runtimeConfigPromiseRef.current
      ?.then((data) => {
        if (cancelled) return;
        if (data?.workerBaseUrl) {
          setWorkerBaseUrl(data.workerBaseUrl);
        } else if (!fallbackWorkerBaseUrl && typeof window !== "undefined") {
          setWorkerBaseUrl(window.location.origin);
        }
        if (data?.vapidPublicKey) {
          setVapidPublicKey(data.vapidPublicKey);
        }
      })
      .catch(() => {
        if (cancelled) return;
        if (!fallbackWorkerBaseUrl && typeof window !== "undefined") {
          setWorkerBaseUrl(window.location.origin);
        }
      })
      .finally(() => {
        runtimeConfigPromiseRef.current = null;
      });
    return () => { cancelled = true; };
  }, [fallbackWorkerBaseUrl]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (!workerBaseUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        if (cancelled) return;
        registration.active?.postMessage({ type: "TASKIFY_CONFIG", workerBaseUrl });
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: "TASKIFY_CONFIG", workerBaseUrl });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [workerBaseUrl]);

  return { vapidPublicKey, workerBaseUrl };
}

async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const response = await fetch("/api/config", { method: "GET" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") || "";

    let data: any = null;
    try {
      if (/json/i.test(contentType)) {
        data = await response.json();
      } else {
        const text = await response.text();
        try {
          data = JSON.parse(text);
        } catch {
          return null;
        }
      }
    } catch {
      return null;
    }

    if (!data || typeof data !== "object") return null;
    return {
      workerBaseUrl:
        typeof data.workerBaseUrl === "string" && data.workerBaseUrl.trim()
          ? data.workerBaseUrl.trim().replace(/\/$/, "")
          : null,
      vapidPublicKey:
        typeof data.vapidPublicKey === "string" && data.vapidPublicKey.trim()
          ? data.vapidPublicKey.trim()
          : null,
    };
  } catch (err) {
    console.warn("Failed to load runtime config", err);
    return null;
  }
}
