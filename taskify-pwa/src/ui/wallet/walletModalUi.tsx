import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QrScannerLib from "qr-scanner";
import { QRCodeCanvas } from "qrcode.react";
import { createNut16Animation } from "../../wallet/nut16";
import {
  decryptMessengerAttachment,
  formatByteSize,
  isAudioMime,
  isImageMime,
  isVideoMime,
} from "../../lib/messengerAttachmentCrypto";

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

function avatarInitials(value: string): string {
  const parts = (value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const cp = parts[0].codePointAt(0) ?? 0;
  const isEmoji =
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff);
  if (isEmoji) return [...parts[0]][0] ?? "?";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  return `${[...parts[0]][0] ?? ""}${[...parts[parts.length - 1]][0] ?? ""}`.toUpperCase();
}

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

export function formatLightningAddressDisplay(address: string, baseMaxLength = 32): string {
  const ellipsis = "…";
  if (address.length <= baseMaxLength) return address;
  const atIndex = address.indexOf("@");
  if (atIndex <= 0) {
    return `${address.slice(0, baseMaxLength - 1)}${ellipsis}`;
  }

  const localPart = address.slice(0, atIndex);
  const domainPartWithAt = address.slice(atIndex);
  const dynamicMaxLength = Math.max(baseMaxLength, domainPartWithAt.length + 6);
  if (address.length <= dynamicMaxLength) return address;

  const maxLocalLength = Math.max(3, dynamicMaxLength - domainPartWithAt.length - ellipsis.length);
  return `${localPart.slice(0, maxLocalLength)}${ellipsis}${domainPartWithAt}`;
}

export function capitalizeWords(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function formatMintDisplayName(url: string): string {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^www\./i, "");
    const hostParts = hostname.split(".").filter(Boolean);
    const hostLabel = hostParts
      .slice(Math.max(0, hostParts.length - 2))
      .map((part) => capitalizeWords(part.replace(/[-_]+/g, " ")))
      .join(" ");
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    const lastSegment = pathSegments.length ? decodeURIComponent(pathSegments[pathSegments.length - 1]!) : "";
    if (lastSegment) {
      const formattedSegment = capitalizeWords(lastSegment.replace(/[-_]+/g, " "));
      return `${hostLabel || hostname} • ${formattedSegment}`.trim();
    }
    return hostLabel || hostname || url;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}

export function trimMintUrlScheme(url: string): string {
  return url.replace(/^https?:\/\//i, "");
}

export function LockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <rect x="5" y="9" width="10" height="7" rx="2" />
      <path d="M7.5 9V7a2.5 2.5 0 0 1 5 0v2" />
      <circle cx="10" cy="12.5" r="1" />
    </svg>
  );
}

export function ChevronDownIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M5.5 8.5 10 13l4.5-4.5" />
    </svg>
  );
}

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

export function QrCodeCard({
  value,
  label,
  copyLabel = "Copy",
  extraActions,
  size = 320,
  className,
  hideLabel = false,
  flat = false,
  enableNut16Animation = false,
  hideCopyButton = false,
}: {
  value: string;
  label?: string;
  copyLabel?: string;
  extraActions?: React.ReactNode;
  size?: number;
  className?: string;
  hideLabel?: boolean;
  flat?: boolean;
  enableNut16Animation?: boolean;
  hideCopyButton?: boolean;
}) {
  const trimmed = value?.trim();
  const [animSpeed, setAnimSpeed] = useState<"S" | "M" | "F">("F");
  const [animDensity, setAnimDensity] = useState<"S" | "M" | "L">("L");
  const [copied, setCopied] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const animation = useMemo(() => {
    if (!enableNut16Animation) return null;
    const chunkSizeMap: Record<typeof animDensity, number> = { S: 140, M: 200, L: 260 };
    const intervalMap: Record<typeof animSpeed, number> = { F: 30, M: 60, S: 90 };
    return createNut16Animation(trimmed, {
      chunkSize: chunkSizeMap[animDensity],
      intervalMs: intervalMap[animSpeed],
    });
  }, [enableNut16Animation, trimmed, animSpeed, animDensity]);
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
      await navigator.clipboard?.writeText(trimmed);
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
        <div className="wallet-qr-card__canvas" aria-hidden={isQrTooLong ? undefined : true}>
          {isQrTooLong ? (
            <div className="wallet-qr-card__fallback" role="status">
              QR code unavailable
            </div>
          ) : (
            <QRCodeCanvas value={qrValue} size={size} includeMargin={false} className="wallet-qr-card__qr" />
          )}
        </div>
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

    stopRequestedRef.current = false;
    let cancelled = false;

    async function start() {
      try {
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
            maxScansPerSecond: WALLET_SCAN_MAX_SCANS_PER_SECOND,
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

export function LightningGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      stroke="currentColor"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="11 2 4 11 9 11 7 18 14 9 9 9 11 2" />
    </svg>
  );
}

export function WalletGlyphIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="8" y1="8" x2="16" y2="8" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="8" y1="16" x2="16" y2="16" />
      <line x1="12" y1="2.75" x2="12" y2="5.25" />
      <line x1="12" y1="18.75" x2="12" y2="21.25" />
    </svg>
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

export function MessengerFileBubble({
  descriptor,
  isIncoming,
}: {
  descriptor: MessengerFileDescriptor;
  isIncoming: boolean;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; objectUrl: string; blob: Blob }
    | { kind: "error"; message: string }
  >(() => ({ kind: "idle" }));
  const mimeLc = (descriptor.mimeType || "").toLowerCase();
  const isImage = isImageMime(mimeLc);
  const isVideo = isVideoMime(mimeLc);
  const isAudio = isAudioMime(mimeLc);
  const filename = descriptor.filename || "attachment";
  const sizeLabel = formatByteSize(descriptor.size ?? 0);

  const loadDescriptor = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await decryptMessengerAttachment({
        url: descriptor.url,
        mimeType: descriptor.mimeType,
        keyHex: descriptor.keyHex,
        nonceHex: descriptor.nonceHex,
        algorithm: descriptor.algorithm,
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
      try {
        const result = await decryptMessengerAttachment({
          url: descriptor.url,
          mimeType: descriptor.mimeType,
          keyHex: descriptor.keyHex,
          nonceHex: descriptor.nonceHex,
          algorithm: descriptor.algorithm,
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
            <div className="chat-file__loading">
              <div className="chat-sending-spinner" />
            </div>
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
            <div className="chat-file__loading">
              <div className="chat-sending-spinner" />
            </div>
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
          <div className="chat-file__loading">
            <div className="chat-sending-spinner" />
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
              ? "Decrypting…"
              : state.kind === "error"
                ? state.message
                : sizeLabel || "Download"}
          </div>
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
