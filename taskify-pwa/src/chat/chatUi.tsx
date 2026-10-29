/** Chat UI pieces: thread rows, avatars, file bubbles, QR card and scanner, icons, date labels. */
import { contactInitials as avatarInitials } from "taskify-core";

export { contactInitials as avatarInitials } from "taskify-core";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QrScannerLib from "qr-scanner";
import { QRCodeCanvas } from "qrcode.react";
import {
  decryptMessengerAttachment,
  formatByteSize,
  isAudioMime,
  isImageMime,
  isVideoMime,
} from "../lib/messengerAttachmentCrypto";
import type { DownloadProgress } from "../lib/binary";

type ScanResult = QrScannerLib.ScanResult;

const WALLET_SCAN_TARGET_SIZE = 800;
const WALLET_SCAN_MAX_SCANS_PER_SECOND = 25;
const DM_THREAD_SWIPE_ACTION_WIDTH = 168;

export const CHAT_FILE_PICKER_ACCEPT =
  "application/*,text/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.json,.csv,.zip,.7z,.tar,.gz,.rtf";

export const AnimatedEllipsis = () => {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStep((current) => (current + 1) % 4);
    }, 350);

    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const dots = step === 0 ? "" : ".".repeat(step);

  return <span className="inline-block w-4 text-left">{dots}</span>;
};

export type GroupAvatarMember = {
  key: string;
  label: string;
  picture?: string;
};

export function GroupAvatar({
  members,
  className = "",
}: {
  members: GroupAvatarMember[];
  className?: string;
}) {
  const visibleMembers = members.slice(0, Math.min(4, members.length));
  const count = Math.max(visibleMembers.length, 1);
  return (
    <div className={`group-avatar group-avatar--count-${count}${className ? ` ${className}` : ""}`} aria-hidden="true">
      {visibleMembers.map((member, index) => (
        <div
          key={member.key}
          className={`group-avatar__item group-avatar__item--${index + 1}${member.picture ? " group-avatar__item--image" : ""}`}
          title={member.label}
        >
          {member.picture ? (
            <img src={member.picture} alt="" className="group-avatar__img" />
          ) : (
            <span className="group-avatar__initials">{avatarInitials(member.label)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function SwipeableDmThreadRow({
  children,
  onArchive,
  onDelete,
}: {
  children: React.ReactNode;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [transitionEnabled, setTransitionEnabled] = useState(true);
  const [dismissing, setDismissing] = useState<"archive" | "delete" | null>(null);
  const offsetRef = useRef(0);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffset: number;
    locked: "horizontal" | "vertical" | null;
    dragged: boolean;
  } | null>(null);
  useEffect(() => {
    return () => {
      if (suppressClickTimerRef.current != null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
    };
  }, []);
  const setRowOffset = useCallback((next: number) => {
    const bounded = Math.max(-DM_THREAD_SWIPE_ACTION_WIDTH, Math.min(0, Math.round(next)));
    offsetRef.current = bounded;
    setOffset(bounded);
  }, []);
  const close = useCallback(() => {
    setTransitionEnabled(true);
    setRowOffset(0);
  }, [setRowOffset]);
  const open = useCallback(() => {
    setTransitionEnabled(true);
    setRowOffset(-DM_THREAD_SWIPE_ACTION_WIDTH);
  }, [setRowOffset]);
  const revealRatio = Math.min(1, Math.abs(offset) / DM_THREAD_SWIPE_ACTION_WIDTH);
  const startSwipeGesture = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffset: offsetRef.current,
      locked: null,
      dragged: false,
    };
    setTransitionEnabled(false);
  }, []);
  const moveSwipeGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.locked) {
        if (Math.abs(dx) > Math.abs(dy) + 5) gesture.locked = "horizontal";
        else if (Math.abs(dy) > Math.abs(dx) + 5) gesture.locked = "vertical";
      }
      if (gesture.locked !== "horizontal") return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (Math.abs(dx) > 6) gesture.dragged = true;
      setRowOffset(gesture.startOffset + dx);
    },
    [setRowOffset],
  );
  const endSwipeGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      setTransitionEnabled(true);
      if (!gesture.dragged) return;
      suppressClickRef.current = true;
      if (suppressClickTimerRef.current != null) {
        window.clearTimeout(suppressClickTimerRef.current);
      }
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, 0);
      if (gesture.locked === "horizontal" && offsetRef.current < -DM_THREAD_SWIPE_ACTION_WIDTH * 0.35) {
        open();
      } else if (gesture.locked === "horizontal") {
        close();
      }
    },
    [close, open],
  );
  const cancelSwipeGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      gestureRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }
      close();
    },
    [close],
  );
  const suppressDraggedClick = useCallback((event: React.SyntheticEvent) => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    if (suppressClickTimerRef.current != null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  }, []);
  const runThreadAction = useCallback(
    (action: "archive" | "delete", handler: () => void) => {
      setTransitionEnabled(true);
      setRowOffset(-DM_THREAD_SWIPE_ACTION_WIDTH);
      setDismissing(action);
      window.setTimeout(handler, 180);
    },
    [setRowOffset],
  );

  return (
    <div
      className={`chat-thread-swipe${offset !== 0 ? " is-open" : ""}${dismissing ? " is-dismissing" : ""}`}
      onPointerDown={startSwipeGesture}
      onPointerMove={moveSwipeGesture}
      onPointerUp={endSwipeGesture}
      onPointerCancel={cancelSwipeGesture}
    >
      <div
        className="chat-thread-swipe__actions"
        aria-hidden={offset === 0}
        style={{
          opacity: revealRatio,
          pointerEvents: offset === 0 ? "none" : "auto",
        }}
      >
        <button
          type="button"
          className="chat-thread-swipe__action chat-thread-swipe__action--archive pressable"
          onClick={(event) => {
            if (suppressDraggedClick(event)) return;
            event.stopPropagation();
            runThreadAction("archive", onArchive);
          }}
          disabled={!!dismissing}
          tabIndex={offset === 0 || dismissing ? -1 : 0}
          aria-label="Archive thread"
          title="Archive"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="4" rx="1" />
            <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
          <span>Archive</span>
        </button>
        <button
          type="button"
          className="chat-thread-swipe__action chat-thread-swipe__action--delete pressable"
          onClick={(event) => {
            if (suppressDraggedClick(event)) return;
            event.stopPropagation();
            runThreadAction("delete", onDelete);
          }}
          disabled={!!dismissing}
          tabIndex={offset === 0 || dismissing ? -1 : 0}
          aria-label="Delete thread"
          title="Delete"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M9 3h6l1 1h5v2H3V4h5l1-1z" />
            <path d="M5 7h14l-1.5 13h-11L5 7z" />
          </svg>
          <span>Delete</span>
        </button>
      </div>
      <div
        className="chat-thread-swipe__content"
        style={{
          transform: `translateX(${offset}px)`,
          transition: transitionEnabled ? "transform 180ms ease" : "none",
        }}
        onClickCapture={(event) => {
          if (suppressDraggedClick(event)) {
            return;
          }
          if (offsetRef.current !== 0) {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}

export const ShareArrowIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    <path d="M14.5 6.5 9 10.5l5.5 4" />
    <circle cx="17.5" cy="4.5" r="2.25" />
    <circle cx="17.5" cy="19.5" r="2.25" />
    <circle cx="6.5" cy="12" r="2.25" />
  </svg>
);

export function BackIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="m14.75 6.75-6 5.25 6 5.25" />
    </svg>
  );
}

export function PencilIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L8.032 18.62a3.75 3.75 0 0 1-1.579 0.942l-2.469 0.74 0.74-2.47a3.75 3.75 0 0 1 0.943-1.578L16.862 4.487Z" />
      <path d="M16.862 4.487 19.5 7.125" />
    </svg>
  );
}

export function CloseIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

export function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="m6 12 4.5 4.5L18 8" />
    </svg>
  );
}

export function VerifiedBadgeIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M10.788 3.21c.448-1.077 1.976-1.077 2.424 0l.967 2.329a1.125 1.125 0 0 0 1.304.674l2.457-.624c1.119-.285 2.114.71 1.829 1.829l-.624 2.457a1.125 1.125 0 0 0 .674 1.304l2.329.967c1.077.448 1.077 1.976 0 2.424l-2.329.967a1.125 1.125 0 0 0-.674 1.304l.624 2.457c.285 1.119-.71 2.114-1.829 1.829l-2.457-.624a1.125 1.125 0 0 0-1.304.674l-.967 2.329c-.448 1.077-1.976 1.077-2.424 0l-.967-2.329a1.125 1.125 0 0 0-1.304-.674l-2.457.624c-1.119.285-2.114-.71-1.829-1.829l.624-2.457a1.125 1.125 0 0 0-.674-1.304l-2.329-.967c-1.077-.448-1.077-1.976 0-2.424l2.329-.967a1.125 1.125 0 0 0 .674-1.304l-.624-2.457c-.285-1.119.71-2.114 1.829-1.829l2.457.624a1.125 1.125 0 0 0 1.304-.674l.967-2.329Z"
      />
      <path
        d="m9.4 12.75 1.9 1.9 3.85-3.85"
        fill="none"
        stroke="var(--surface-base)"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PersonIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <circle cx="12" cy="8.25" r="3.25" />
      <path d="M5.5 19c.25-3.2 3.1-5 6.5-5s6.25 1.8 6.5 5" />
    </svg>
  );
}

/** An animated QR: frames shown in turn, each a value to encode. */
export type QrAnimation = { version: number; digest: string; frames: Array<{ value: string }>; intervalMs: number };

export function QrCodeCard({
  value,
  label,
  copyLabel = "Copy",
  onCopy,
  extraActions,
  size = 320,
  className,
  hideLabel = false,
  flat = false,
  enableNut16Animation = false,
  createAnimation,
  hideCopyButton = false,
  copyOnQrClick = false,
}: {
  value: string;
  label?: string;
  copyLabel?: string;
  onCopy?: () => void | Promise<void>;
  extraActions?: React.ReactNode;
  size?: number;
  className?: string;
  hideLabel?: boolean;
  flat?: boolean;
  enableNut16Animation?: boolean;
  /**
   * Splits a long value into an animated QR (the wallet passes NUT-16 for Cashu tokens). Chat
   * has none, so its codes are static.
   */
  createAnimation?: (
    value: string,
    options: { chunkSize: number; intervalMs: number },
  ) => QrAnimation | null;
  hideCopyButton?: boolean;
  copyOnQrClick?: boolean;
}) {
  const trimmed = value?.trim();
  const [animSpeed, setAnimSpeed] = useState<"S" | "M" | "F">("F");
  const [animDensity, setAnimDensity] = useState<"S" | "M" | "L">("L");
  const [copied, setCopied] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const animation = useMemo(() => {
    if (!enableNut16Animation || !createAnimation) return null;
    const chunkSizeMap: Record<typeof animDensity, number> = { S: 140, M: 200, L: 260 };
    const intervalMap: Record<typeof animSpeed, number> = { F: 30, M: 60, S: 90 };
    return createAnimation(trimmed, {
      chunkSize: chunkSizeMap[animDensity],
      intervalMs: intervalMap[animSpeed],
    });
  }, [enableNut16Animation, createAnimation, trimmed, animSpeed, animDensity]);
  const animationKey = animation
    ? `${animation.version}:${animation.digest}:${animation.frames.length}`
    : trimmed;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    setFrameIndex(0);
  }, [animationKey]);

  useEffect(() => {
    if (!animation || animation.frames.length <= 1) return;
    const { frames, intervalMs } = animation;
    const delay = Math.max(250, Number.isFinite(intervalMs) ? intervalMs : 450);
    const timer = setInterval(() => {
      setFrameIndex((idx) => (idx + 1) % frames.length);
    }, delay);
    return () => clearInterval(timer);
  }, [animation]);

  if (!trimmed) return null;

  async function handleCopy() {
    try {
      if (onCopy) {
        await onCopy();
      } else {
        await navigator.clipboard?.writeText(trimmed);
      }
      setCopied(true);
    } catch (e) {
      console.warn("Copy failed", e);
      setCopied(false);
    }
  }

  const classes = ["wallet-qr-card"];
  if (flat) classes.push("wallet-qr-card--flat");
  if (className) classes.push(className);

  const currentFrame = animation
    ? animation.frames[Math.min(frameIndex, Math.max(animation.frames.length - 1, 0))]
    : null;
  const qrValue = currentFrame?.value ?? trimmed;

  const qrByteLength = (() => {
    if (!qrValue) return 0;
    try {
      return typeof TextEncoder !== "undefined"
        ? new TextEncoder().encode(qrValue).length
        : qrValue.length;
    } catch (error) {
      console.warn("Failed to measure QR payload", error);
      return qrValue.length;
    }
  })();

  const isQrTooLong = qrByteLength > 2953;

  const showControls = !!animation && animation.frames.length > 1;
  const qrCanvasClass = [
    "wallet-qr-card__canvas",
    copyOnQrClick ? "wallet-qr-card__canvas--pressable pressable" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const qrCanvasContent = isQrTooLong ? (
    <div className="wallet-qr-card__fallback" role="status">
      QR code unavailable
    </div>
  ) : (
    <QRCodeCanvas value={qrValue} size={size} includeMargin={false} className="wallet-qr-card__qr" />
  );

  return (
    <div className={classes.join(" ")}>
      {(showControls || (!hideLabel && label)) && (
        <div className="wallet-qr-card__header">
          {!hideLabel && label && <div className="wallet-qr-card__label">{label}</div>}
          {showControls && (
            <div className="wallet-qr-card__controls wallet-qr-card__controls--compact">
              <button
                type="button"
                className="wallet-qr-card__control-pill"
                onClick={() => setAnimSpeed((prev) => (prev === "S" ? "M" : prev === "M" ? "F" : "S"))}
                aria-label={`QR speed ${animSpeed}`}
              >
                Speed: {animSpeed}
              </button>
              <button
                type="button"
                className="wallet-qr-card__control-pill"
                onClick={() => setAnimDensity((prev) => (prev === "S" ? "M" : prev === "M" ? "L" : "S"))}
                aria-label={`QR size ${animDensity}`}
              >
                Size: {animDensity}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="wallet-qr-card__code" aria-live="polite">
        {copyOnQrClick ? (
          <button
            type="button"
            className={qrCanvasClass}
            aria-label={`Copy ${(label || "code").toLowerCase()}`}
            onClick={handleCopy}
          >
            {qrCanvasContent}
          </button>
        ) : (
          <div className={qrCanvasClass} aria-hidden={isQrTooLong ? undefined : true}>
            {qrCanvasContent}
          </div>
        )}
      </div>
      {isQrTooLong && (
        <div className="wallet-qr-card__helper" role="status">
          This code is too long to display as a QR code. Use the copy button to share it instead.
        </div>
      )}
      <div className="wallet-qr-card__actions">
        {extraActions}
        {!hideCopyButton && (
          <button
            className="ghost-button button-sm pressable"
            onClick={handleCopy}
            aria-label={`Copy ${(label || "code").toLowerCase()}`}
          >
            {copied ? "Copied" : copyLabel}
          </button>
        )}
      </div>
    </div>
  );
}

export function QrScanner({
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
    const targetSize = Math.min(WALLET_SCAN_TARGET_SIZE, shortSide);
    const scale = Math.min(targetSize / shortSide, 1);
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

    const video = videoRef.current;
    if (!video) return;
    const videoElement: HTMLVideoElement = video;

    stopRequestedRef.current = false;
    let cancelled = false;

    async function start() {
      try {
        clearError();
        const scanner = new QrScannerLib(
          videoElement,
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
            maxScansPerSecond: WALLET_SCAN_MAX_SCANS_PER_SECOND,
            onDecodeError: (err) => {
              if (typeof err === "string" && err === QrScannerLib.NO_QR_CODE_FOUND) return;
            },
          },
        );

        videoElement.setAttribute("playsinline", "true");
        videoElement.setAttribute("muted", "true");
        videoElement.setAttribute("autoplay", "true");
        videoElement.playsInline = true;
        videoElement.muted = true;

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
    <div className="wallet-scanner space-y-3">
      <div className={`wallet-scanner__viewport${error ? " wallet-scanner__viewport--error" : ""}`}>
        {error ? (
          <div className="wallet-scanner__fallback">{error}</div>
        ) : (
          <>
            <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
          </>
        )}
        {!error && <div className="wallet-scanner__guide" aria-hidden="true" />}
      </div>
      <div className="wallet-scanner__hint text-xs text-secondary text-center">
        {error ? "Camera unavailable. Try entering the code manually." : "Point your camera at a QR code to scan."}
      </div>
    </div>
  );
}

export function ChatBubbleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="3.5" y="6" width="17" height="12" rx="2" ry="2" />
      <path d="M4 8l8 5 8-5" />
    </svg>
  );
}

export function formatShortDate(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  if (sameYear) return `${month}-${day}`;
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatDmDay(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDmTime(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDmDateSeparator(tsSeconds: number): string {
  if (!Number.isFinite(tsSeconds) || tsSeconds <= 0) return "";
  const date = new Date(tsSeconds * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear) return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function truncatePreview(value: string, limit = 72): string {
  const trimmed = (value || "").trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}…`;
}

export function parseDateLikeToUnixSeconds(
  value: string | null | undefined,
  fallback = Math.floor(Date.now() / 1000),
): number {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = new Date(value);
  const millis = parsed.getTime();
  if (Number.isNaN(millis) || millis <= 0) return fallback;
  return Math.floor(millis / 1000);
}

export function shortenNpubDisplay(npub: string | null | undefined, lead = 8, tail = 6): string {
  if (!npub) return "";
  const value = npub.trim();
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function tryParseJson<T = any>(value: string | null | undefined): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export type MessengerFileDescriptor = {
  url: string;
  mimeType: string;
  filename?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  algorithm: string;
  keyHex: string;
  nonceHex: string;
};

function attachmentLoadLabel(progress: DownloadProgress | null | undefined): string {
  if (!progress || progress.fraction == null) return "Downloading…";
  if (progress.fraction >= 1) return "Decrypting…";
  return `Downloading ${Math.round(progress.fraction * 100)}%`;
}

function AttachmentLoadProgress({ progress }: { progress: DownloadProgress | null }) {
  const fraction = progress?.fraction;
  return (
    <div className="chat-file__loading">
      <div style={{ display: "flex", width: "9rem", flexDirection: "column", alignItems: "center", gap: "0.5rem" }}>
        {fraction == null ? <div className="chat-sending-spinner" /> : null}
        <span className="chat-file__progress-label">{attachmentLoadLabel(progress)}</span>
        {fraction != null ? (
          <div className="chat-file__progress-track" style={{ width: "100%" }}>
            <div className="chat-file__progress-bar" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function MessengerFileBubble({
  descriptor,
  isIncoming,
}: {
  descriptor: MessengerFileDescriptor;
  isIncoming: boolean;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading"; progress: DownloadProgress | null }
    | { kind: "ready"; objectUrl: string; blob: Blob }
    | { kind: "error"; message: string }
  >(() => ({ kind: "idle" }));
  const mimeLc = (descriptor.mimeType || "").toLowerCase();
  const isImage = isImageMime(mimeLc);
  const isVideo = isVideoMime(mimeLc);
  const isAudio = isAudioMime(mimeLc);
  const filename = descriptor.filename || "attachment";
  const sizeLabel = formatByteSize(descriptor.size ?? 0);
  const progress = state.kind === "loading" ? state.progress : null;

  const loadDescriptor = useCallback(async () => {
    setState({ kind: "loading", progress: null });
    try {
      const result = await decryptMessengerAttachment({
        url: descriptor.url,
        mimeType: descriptor.mimeType,
        keyHex: descriptor.keyHex,
        nonceHex: descriptor.nonceHex,
        algorithm: descriptor.algorithm,
      }, {
        onProgress: (next) => setState({ kind: "loading", progress: next }),
      });
      setState({ kind: "ready", objectUrl: result.objectUrl, blob: result.blob });
    } catch (err: any) {
      setState({ kind: "error", message: err?.message || "Failed to decrypt attachment" });
    }
  }, [descriptor.url, descriptor.mimeType, descriptor.keyHex, descriptor.nonceHex, descriptor.algorithm]);

  useEffect(() => {
    if (isImage || isVideo || isAudio) {
      void loadDescriptor();
    }
  }, [isImage, isVideo, isAudio, loadDescriptor]);

  const handleDownload = useCallback(async () => {
    let url: string | null = null;
    if (state.kind === "ready") {
      url = state.objectUrl;
    } else {
      setState({ kind: "loading", progress: null });
      try {
        const result = await decryptMessengerAttachment({
          url: descriptor.url,
          mimeType: descriptor.mimeType,
          keyHex: descriptor.keyHex,
          nonceHex: descriptor.nonceHex,
          algorithm: descriptor.algorithm,
        }, {
          onProgress: (next) => setState({ kind: "loading", progress: next }),
        });
        url = result.objectUrl;
        setState({ kind: "ready", objectUrl: result.objectUrl, blob: result.blob });
      } catch (err: any) {
        setState({ kind: "error", message: err?.message || "Failed to decrypt attachment" });
        return;
      }
    }
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [state, descriptor, filename]);

  const aspectStyle = (() => {
    const w = descriptor.width ?? 0;
    const h = descriptor.height ?? 0;
    if (w > 0 && h > 0) return { aspectRatio: `${w} / ${h}` } as React.CSSProperties;
    return undefined;
  })();

  if (isImage) {
    return (
      <div className={`chat-bubble__card chat-bubble__card--file chat-bubble__card--image${isIncoming ? " chat-bubble__card--in" : " chat-bubble__card--out"}`}>
        <div className="chat-file__image-frame" style={aspectStyle}>
          {state.kind === "ready" ? (
            <img src={state.objectUrl} alt={filename} className="chat-file__image" />
          ) : state.kind === "error" ? (
            <div className="chat-file__error">
              <span>{state.message}</span>
              <button type="button" className="ghost-button button-sm pressable" onClick={loadDescriptor}>
                Retry
              </button>
            </div>
          ) : (
            <AttachmentLoadProgress progress={progress} />
          )}
        </div>
      </div>
    );
  }

  if (isVideo) {
    return (
      <div className={`chat-bubble__card chat-bubble__card--file chat-bubble__card--video${isIncoming ? " chat-bubble__card--in" : " chat-bubble__card--out"}`}>
        <div className="chat-file__video-frame" style={aspectStyle}>
          {state.kind === "ready" ? (
            <video src={state.objectUrl} controls className="chat-file__video" />
          ) : state.kind === "error" ? (
            <div className="chat-file__error">
              <span>{state.message}</span>
              <button type="button" className="ghost-button button-sm pressable" onClick={loadDescriptor}>
                Retry
              </button>
            </div>
          ) : (
            <AttachmentLoadProgress progress={progress} />
          )}
        </div>
      </div>
    );
  }

  if (isAudio) {
    return (
      <div className={`chat-bubble__card chat-bubble__card--file chat-bubble__card--audio${isIncoming ? " chat-bubble__card--in" : " chat-bubble__card--out"}`}>
        {state.kind === "ready" ? (
          <audio src={state.objectUrl} controls className="chat-file__audio" />
        ) : state.kind === "error" ? (
          <div className="chat-file__error">
            <span>{state.message}</span>
            <button type="button" className="ghost-button button-sm pressable" onClick={loadDescriptor}>
              Retry
            </button>
          </div>
        ) : (
          <div style={{ position: "relative", minHeight: "4rem" }}>
            <AttachmentLoadProgress progress={progress} />
          </div>
        )}
        <div className="chat-file__meta">
          <div className="chat-file__name" title={filename}>{filename}</div>
          {sizeLabel && <div className="chat-file__size">{sizeLabel}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className={`chat-bubble__card chat-bubble__card--file chat-bubble__card--doc${isIncoming ? " chat-bubble__card--in" : " chat-bubble__card--out"}`}>
      <button
        type="button"
        className="chat-file__doc pressable"
        onClick={handleDownload}
        disabled={state.kind === "loading"}
      >
        <div className="chat-file__doc-icon">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
        </div>
        <div className="chat-file__doc-body">
          <div className="chat-file__name" title={filename}>{filename}</div>
          <div className="chat-file__size">
            {state.kind === "loading"
              ? attachmentLoadLabel(progress)
              : state.kind === "error"
                ? state.message
                : sizeLabel || "Download"}
          </div>
          {state.kind === "loading" && progress?.fraction != null ? (
            <div className="chat-file__progress-track chat-file__progress-track--doc">
              <div className="chat-file__progress-bar" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
          ) : null}
        </div>
        <div className="chat-file__doc-action">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
      </button>
    </div>
  );
}
