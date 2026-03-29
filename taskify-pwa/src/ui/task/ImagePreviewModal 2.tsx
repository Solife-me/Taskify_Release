import React, { useEffect, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ImagePreviewModalProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function distance(a: React.Touch, b: React.Touch) {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function midpoint(a: React.Touch, b: React.Touch) {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

export function ImagePreviewModal({ src, alt, onClose }: ImagePreviewModalProps) {
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Track gesture state without re-renders
  const pinchRef = useRef<{
    startDist: number;
    startScale: number;
    startMid: { x: number; y: number };
    startTranslate: { x: number; y: number };
  } | null>(null);
  const panRef = useRef<{
    startX: number;
    startY: number;
    startTranslateX: number;
    startTranslateY: number;
  } | null>(null);
  const lastTapRef = useRef<number>(0);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown]);

  // Clamp translate so the image doesn't fly off screen
  const clampTranslate = useCallback((x: number, y: number, scale: number) => {
    const img = imgRef.current;
    if (!img) return { x, y };
    const rect = img.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scaledW = rect.width * (scale / transformRef.current.scale);
    const scaledH = rect.height * (scale / transformRef.current.scale);
    const maxX = Math.max(0, (scaledW - vw) / 2);
    const maxY = Math.max(0, (scaledH - vh) / 2);
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  }, []);

  // ── Touch events ────────────────────────────────────────────────────────────

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      // Pinch start
      pinchRef.current = {
        startDist: distance(e.touches[0], e.touches[1]),
        startScale: transformRef.current.scale,
        startMid: midpoint(e.touches[0], e.touches[1]),
        startTranslate: { x: transformRef.current.x, y: transformRef.current.y },
      };
      panRef.current = null;
    } else if (e.touches.length === 1) {
      // Pan start (only when zoomed) or double-tap
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        // Double-tap: toggle zoom
        const t = transformRef.current;
        if (t.scale > 1) {
          setTransform({ scale: 1, x: 0, y: 0 });
        } else {
          const touch = e.touches[0];
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const targetScale = 2.5;
          const x = (vw / 2 - touch.clientX) * (targetScale - 1);
          const y = (vh / 2 - touch.clientY) * (targetScale - 1);
          setTransform({ scale: targetScale, x, y });
        }
        lastTapRef.current = 0;
        return;
      }
      lastTapRef.current = now;
      panRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startTranslateX: transformRef.current.x,
        startTranslateY: transformRef.current.y,
      };
    }
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    if (e.touches.length === 2 && pinchRef.current) {
      const p = pinchRef.current;
      const currentDist = distance(e.touches[0], e.touches[1]);
      const rawScale = p.startScale * (currentDist / p.startDist);
      const newScale = clamp(rawScale, MIN_SCALE, MAX_SCALE);

      // Translate so the pinch midpoint stays fixed
      const mid = midpoint(e.touches[0], e.touches[1]);
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scaleFactor = newScale / p.startScale;
      const newX = mid.x - p.startMid.x + (p.startTranslate.x - (p.startMid.x - vw / 2)) * scaleFactor + (p.startMid.x - vw / 2);
      const newY = mid.y - p.startMid.y + (p.startTranslate.y - (p.startMid.y - vh / 2)) * scaleFactor + (p.startMid.y - vh / 2);

      const clamped = clampTranslate(newX, newY, newScale);
      setTransform({ scale: newScale, x: clamped.x, y: clamped.y });
    } else if (e.touches.length === 1 && panRef.current && transformRef.current.scale > 1) {
      const p = panRef.current;
      const dx = e.touches[0].clientX - p.startX;
      const dy = e.touches[0].clientY - p.startY;
      const newX = p.startTranslateX + dx;
      const newY = p.startTranslateY + dy;
      const clamped = clampTranslate(newX, newY, transformRef.current.scale);
      setTransform((prev) => ({ ...prev, x: clamped.x, y: clamped.y }));
    }
  }, [clampTranslate]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      if (pinchRef.current) {
        // Snap back to min scale if pinched below 1
        if (transformRef.current.scale <= 1) {
          setTransform({ scale: 1, x: 0, y: 0 });
        }
        pinchRef.current = null;
      }
    }
    if (e.touches.length === 0) {
      panRef.current = null;
    }
  }, []);

  // ── Mouse wheel zoom (desktop) ───────────────────────────────────────────────

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = clamp(transformRef.current.scale * delta, MIN_SCALE, MAX_SCALE);
    if (newScale === MIN_SCALE) {
      setTransform({ scale: 1, x: 0, y: 0 });
      return;
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scaleFactor = newScale / transformRef.current.scale;
    const newX = (transformRef.current.x - (e.clientX - vw / 2)) * scaleFactor + (e.clientX - vw / 2);
    const newY = (transformRef.current.y - (e.clientY - vh / 2)) * scaleFactor + (e.clientY - vh / 2);
    const clamped = clampTranslate(newX, newY, newScale);
    setTransform({ scale: newScale, x: clamped.x, y: clamped.y });
  }, [clampTranslate]);

  // ── Mouse drag (desktop) ─────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (transformRef.current.scale <= 1) return;
    e.preventDefault();
    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTranslateX: transformRef.current.x,
      startTranslateY: transformRef.current.y,
    };
    const handleMouseMove = (ev: MouseEvent) => {
      if (!panRef.current) return;
      const dx = ev.clientX - panRef.current.startX;
      const dy = ev.clientY - panRef.current.startY;
      const newX = panRef.current.startTranslateX + dx;
      const newY = panRef.current.startTranslateY + dy;
      const clamped = clampTranslate(newX, newY, transformRef.current.scale);
      setTransform((prev) => ({ ...prev, x: clamped.x, y: clamped.y }));
    };
    const handleMouseUp = () => {
      panRef.current = null;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [clampTranslate]);

  const isZoomed = transform.scale > 1;

  const portal = (
    <div
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/90 select-none"
      onClick={isZoomed ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      {/* Close button — always accessible above status bar */}
      <button
        type="button"
        className="absolute right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white text-xl leading-none pressable"
        style={{ top: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label="Close preview"
      >
        ×
      </button>

      {/* Reset zoom hint when zoomed */}
      {isZoomed && (
        <button
          type="button"
          className="absolute z-10 bottom-8 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-xs text-white pressable"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 2rem)" }}
          onClick={(e) => { e.stopPropagation(); setTransform({ scale: 1, x: 0, y: 0 }); }}
        >
          Reset zoom
        </button>
      )}

      {/* Image */}
      <img
        ref={imgRef}
        src={src}
        alt={alt ?? "Attachment preview"}
        className="max-h-[90vh] max-w-[95vw] rounded-xl object-contain shadow-2xl"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
          transformOrigin: "center center",
          transition: pinchRef.current || panRef.current ? "none" : "transform 0.15s ease",
          cursor: isZoomed ? "grab" : "default",
          touchAction: "none",
        }}
        draggable={false}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return typeof document !== "undefined"
    ? createPortal(portal, document.body)
    : null;
}
