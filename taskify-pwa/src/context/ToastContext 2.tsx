import React, { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastContextValue = {
  show: (message?: string, durationMs?: number) => void;
};

const ToastContext = createContext<ToastContextValue>({
  // no-op default; gets replaced by provider
  show: () => {},
});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [message, setMessage] = useState<string>("");
  const timerRef = useRef<number | null>(null);

  const show = useCallback((msg?: string, durationMs = 1000) => {
    const m = msg || "copied to clipboard";
    setMessage(m);
    setVisible(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setVisible(false), durationMs);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed left-1/2 top-3 z-[10000] -translate-x-1/2">
        <div
          className={
            "transition-opacity duration-200 " + (visible ? "opacity-100" : "opacity-0")
          }
        >
          <div className="rounded-md border border-neutral-700 bg-neutral-900/90 px-3 py-1 text-sm text-white shadow-lg">
            {message || "copied to clipboard"}
          </div>
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
