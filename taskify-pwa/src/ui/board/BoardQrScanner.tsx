import { useState, useEffect, useRef, useCallback } from "react";
import QrScannerLib from "qr-scanner";

type ScanResult = QrScannerLib.ScanResult;

export function BoardQrScanner({
  active,
  onDetected,
  onError,
}: {
  active: boolean;
  onDetected: (value: string) => boolean | Promise<boolean>;
  onError?: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scannerRef = useRef<QrScannerLib | null>(null);
  const stopRequestedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const reportError = useCallback((message: string) => {
    setError(message);
    if (onError) onError(message);
  }, [onError]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const calculateScanRegion = useCallback((video: HTMLVideoElement) => {
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const shortSide = Math.min(width, height);
    const scale = Math.min(QrScannerLib.DEFAULT_CANVAS_SIZE / shortSide, 1);
    return {
      x: 0,
      y: 0,
      width,
      height,
      downScaledWidth: Math.round(width * scale),
      downScaledHeight: Math.round(height * scale),
    };
  }, []);

  const stopScanner = useCallback(() => {
    const scanner = scannerRef.current;
    if (scanner) {
      try {
        scanner.stop();
      } catch (err) {
        console.warn("Failed to stop scanner", err);
      }
      scanner.destroy();
      scannerRef.current = null;
    }
    const video = videoRef.current;
    if (video && video.srcObject instanceof MediaStream) {
      video.srcObject.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!active) {
      stopRequestedRef.current = true;
      stopScanner();
      clearError();
      return;
    }

    stopRequestedRef.current = false;
    let cancelled = false;

    async function start() {
      try {
        const video = videoRef.current;
        if (!video || cancelled) return;
        clearError();
        const scanner = new QrScannerLib(
          video,
          async (result: ScanResult) => {
            const value = result?.data?.trim();
            if (!value || stopRequestedRef.current) return;
            try {
              const shouldClose = await onDetected(value);
              if (shouldClose) {
                stopRequestedRef.current = true;
                stopScanner();
              }
            } catch (err) {
              console.warn("QR handler failed", err);
            }
          },
          {
            returnDetailedScanResult: true,
            highlightScanRegion: false,
            highlightCodeOutline: false,
            calculateScanRegion,
            preferredCamera: "environment",
            maxScansPerSecond: 12,
            onDecodeError: (err) => {
              if (typeof err === "string" && err === QrScannerLib.NO_QR_CODE_FOUND) return;
            },
          },
        );

        video.setAttribute("playsinline", "true");
        video.setAttribute("muted", "true");
        video.setAttribute("autoplay", "true");
        video.playsInline = true;
        video.muted = true;

        scannerRef.current = scanner;
        await scanner.start();
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        reportError(message || "Unable to access camera");
        stopScanner();
      }
    }

    start();

    return () => {
      cancelled = true;
      stopRequestedRef.current = true;
      stopScanner();
    };
  }, [active, onDetected, reportError, stopScanner, clearError, calculateScanRegion]);

  return (
    <div className="wallet-scanner">
      <div className={`wallet-scanner__viewport${error ? " wallet-scanner__viewport--error" : ""}`}>
        {error ? (
          <div className="wallet-scanner__fallback">{error}</div>
        ) : (
          <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
        )}
        {!error && <div className="wallet-scanner__guide" aria-hidden="true" />}
      </div>
    </div>
  );
}
