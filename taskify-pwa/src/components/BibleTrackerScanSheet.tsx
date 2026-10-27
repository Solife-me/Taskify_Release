import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BIBLE_BOOKS, type BibleTrackerProgress, type BibleTrackerState } from "../domains/scripture/bibleTrackerModel";
import { buildBiblePrintLayout, type BiblePrintLayout, type BiblePrintLayoutVersion } from "./BibleTrackerPrintLayout";
import { PRINT_PAPER_OPTIONS, type PrintPaperSize } from "./printPaper";
import { scanPage, type ScanMark, type ScanMarkGeometry } from "../domains/print/scanEngine";
import { scanPhotoFromCanvas } from "../domains/print/scanCanvas";

type ScanAnalysis = {
  progress: BibleTrackerProgress;
  filledCount: number;
  threshold: number;
  backgroundMedian: number;
  pageIndex: number;
  layoutVersion: BiblePrintLayoutVersion;
  pageIdDetected: boolean;
};

type ChapterKey = { bookId: string; chapter: number };

function formatChapterRanges(chapters: number[]): string {
  if (!chapters.length) return "";
  const sorted = Array.from(new Set(chapters)).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const value = sorted[i];
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    ranges.push([start, prev]);
    start = value;
    prev = value;
  }
  ranges.push([start, prev]);
  return ranges.map(([rangeStart, rangeEnd]) => (
    rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}-${rangeEnd}`
  )).join(", ");
}

/** The tracker's marks are the chapter boxes; the paper is sampled in the gaps around each. */
function bibleMarkGeometry(layout: BiblePrintLayout): ScanMarkGeometry {
  const boxSizeMm = layout.boxes.sizeMm;
  const gapMm = layout.boxes.gapMm;
  const offset = boxSizeMm * 0.5 + gapMm * 0.55;
  return {
    sampleRadiusMm: Math.max(0.55, boxSizeMm * 0.14),
    innerOffsetMm: boxSizeMm * 0.23,
    backgroundOffsets: [
      { x: offset, y: 0 },
      { x: -offset, y: 0 },
      { x: 0, y: offset },
      { x: 0, y: -offset },
      { x: offset, y: offset },
      { x: -offset, y: offset },
      { x: offset, y: -offset },
      { x: -offset, y: -offset },
    ],
    backgroundRadiusMm: Math.max(0.7, gapMm * 0.55),
  };
}

export function bibleScanMarks(layout: BiblePrintLayout, pageIndex: number): ScanMark<ChapterKey>[] {
  const size = layout.boxes.sizeMm;
  return layout.pages[pageIndex].boxes.map((box) => ({
    key: { bookId: box.bookId, chapter: box.chapter },
    centerMm: { x: box.x + size / 2, y: box.y + size / 2 },
  }));
}

function analyzeScanCanvas(
  canvas: HTMLCanvasElement,
  layout: BiblePrintLayout,
  pageSelection: number | "auto",
): ScanAnalysis {
  const result = scanPage(scanPhotoFromCanvas(canvas), layout, {
    pageSelection,
    pageCount: layout.pages.length,
    marksOnPage: (pageIndex) => bibleScanMarks(layout, pageIndex),
    geometry: bibleMarkGeometry(layout),
  });
  const progress: BibleTrackerProgress = {};
  for (const { bookId, chapter } of result.filled) {
    if (!progress[bookId]) progress[bookId] = [];
    progress[bookId].push(chapter);
  }
  return {
    progress,
    filledCount: result.filledCount,
    threshold: result.threshold,
    backgroundMedian: result.backgroundMedian,
    pageIndex: result.pageIndex,
    layoutVersion: layout.version as BiblePrintLayoutVersion,
    pageIdDetected: result.pageIdDetected,
  };
}

function analyzeScanCanvasAcrossLayouts(
  canvas: HTMLCanvasElement,
  layouts: BiblePrintLayout[],
  pageSelection: number | "auto",
): ScanAnalysis {
  const analyses: ScanAnalysis[] = [];
  const errors: unknown[] = [];
  for (const layout of layouts) {
    if (pageSelection !== "auto" && pageSelection >= layout.page.count) continue;
    try {
      analyses.push(analyzeScanCanvas(canvas, layout, pageSelection));
    } catch (err) {
      errors.push(err);
    }
  }
  if (!analyses.length) {
    const firstError = errors[0];
    if (firstError instanceof Error) throw firstError;
    throw new Error("Scan failed.");
  }
  return analyses.reduce((best, next) => {
    if (next.pageIdDetected && !best.pageIdDetected) return next;
    if (!next.pageIdDetected && best.pageIdDetected) return best;
    if (next.filledCount > best.filledCount) return next;
    if (next.filledCount < best.filledCount) return best;
    if (next.layoutVersion === "v3" && best.layoutVersion !== "v3") return next;
    return best;
  });
}

export function BibleTrackerScanPanel({
  state,
  onApply,
  paperSize,
  onPaperSizeChange,
}: {
  state: BibleTrackerState;
  onApply: (progress: BibleTrackerProgress) => void;
  paperSize: PrintPaperSize;
  onPaperSizeChange: (paperSize: PrintPaperSize) => void;
}) {
  const layouts = useMemo(() => {
    const versions: BiblePrintLayoutVersion[] = ["v3", "v2"];
    return versions.map((layoutVersion) => buildBiblePrintLayout(paperSize, { layoutVersion }));
  }, [paperSize]);
  const maxPageCount = useMemo(() => Math.max(...layouts.map((layout) => layout.page.count)), [layouts]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [pageSelection, setPageSelection] = useState<"auto" | number>("auto");
  const [detectedPageIndex, setDetectedPageIndex] = useState<number | null>(null);
  const [cameraActive, setCameraActive] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState<ScanAnalysis | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    setPageSelection((prev) => (prev === "auto" || prev < maxPageCount ? prev : "auto"));
    setDetectedPageIndex((prev) => (prev != null && prev < maxPageCount ? prev : null));
  }, [maxPageCount]);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!cameraActive) {
      stopCamera();
      return;
    }
    let cancelled = false;
    async function startCamera() {
      setCameraError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Camera unavailable.";
        setCameraError(message);
        setCameraActive(false);
      }
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("Camera not supported on this device.");
      setCameraActive(false);
      return;
    }
    startCamera();
    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [cameraActive, stopCamera]);

  useEffect(() => {
    setScanError(null);
    setScanResult(null);
    setPreviewUrl(null);
    setDetectedPageIndex(null);
    setCameraError(null);
    setCameraActive(true);
  }, [pageSelection]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const captureVideoFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return null;
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas;
  }, []);

  const analyzeCanvas = useCallback(
    async (
      canvas: HTMLCanvasElement,
      options?: {
        reportErrors?: boolean;
        setPreview?: boolean;
      }
    ) => {
      const reportErrors = options?.reportErrors !== false;
      const shouldSetPreview = options?.setPreview !== false;
      try {
        setScanBusy(true);
        if (reportErrors) setScanError(null);
        const result = analyzeScanCanvasAcrossLayouts(canvas, layouts, pageSelection);
        if (pageSelection === "auto") {
          setDetectedPageIndex(result.pageIndex);
        } else {
          setDetectedPageIndex(null);
        }
        setScanResult(result);
        if (shouldSetPreview) {
          setPreviewUrl(canvas.toDataURL("image/jpeg", 0.85));
        }
        return result;
      } catch (err) {
        if (reportErrors) {
          const message = err instanceof Error ? err.message : "Scan failed.";
          setScanError(message);
          setScanResult(null);
        }
        return null;
      } finally {
        setScanBusy(false);
      }
    },
    [layouts, pageSelection]
  );

  const handleCapture = useCallback(async () => {
    const canvas = captureVideoFrame();
    if (!canvas) {
      setScanError("Camera is not ready yet.");
      return;
    }
    const result = await analyzeCanvas(canvas, { reportErrors: true, setPreview: true });
    if (result) {
      setCameraActive(false);
    }
  }, [analyzeCanvas, captureVideoFrame]);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Unable to read the image."));
          img.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Unable to read the image.");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        await analyzeCanvas(canvas, { reportErrors: true, setPreview: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to read the image.";
        setScanError(message);
        setScanResult(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [analyzeCanvas]
  );

  const newChaptersByBook = useMemo(() => {
    if (!scanResult) return [];
    const progress = state.progress || {};
    return BIBLE_BOOKS.map((book) => {
      const chapters = scanResult.progress[book.id] || [];
      if (!chapters.length) return null;
      const existing = new Set(progress[book.id] || []);
      const nextChapters = chapters.filter((chapter) => !existing.has(chapter)).sort((a, b) => a - b);
      if (!nextChapters.length) return null;
      return { bookId: book.id, name: book.name, chapters: nextChapters };
    }).filter(Boolean) as Array<{ bookId: string; name: string; chapters: number[] }>;
  }, [scanResult, state.progress]);

  const newChapters = useMemo(
    () => newChaptersByBook.reduce((total, entry) => total + entry.chapters.length, 0),
    [newChaptersByBook],
  );

  const handleApply = useCallback(() => {
    if (!scanResult) return;
    onApply(scanResult.progress);
  }, [onApply, scanResult]);

  const showGuides = cameraActive;

  return (
    <div className="bible-scan-panel">
      <div className="text-xs text-secondary">
        <div className="flex flex-wrap items-center gap-2">
          <span>Paper size</span>
          <select
            className="print-paper-select"
            value={paperSize}
            onChange={(event) => onPaperSizeChange(event.target.value as PrintPaperSize)}
            aria-label="Paper size"
          >
            {PRINT_PAPER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="bible-scan-detect">
        <div className="text-xs font-semibold text-primary">Page detection</div>
        <div className="bible-scan-toggle" role="group" aria-label="Page detection">
          <button
            type="button"
            className="bible-scan-toggle__option pressable"
            data-active={pageSelection === "auto"}
            aria-pressed={pageSelection === "auto"}
            onClick={() => setPageSelection("auto")}
          >
            Auto
          </button>
          {Array.from({ length: maxPageCount }, (_, index) => (
            <button
              key={index}
              type="button"
              className="bible-scan-toggle__option pressable"
              data-active={pageSelection === index}
              aria-pressed={pageSelection === index}
              onClick={() => setPageSelection(index)}
            >
              Page {index + 1}
            </button>
          ))}
        </div>
        {pageSelection === "auto" && (
          <div className="bible-scan-status text-xs text-secondary">
            {detectedPageIndex != null
              ? `Auto detected: Page ${detectedPageIndex + 1}.`
              : "Auto detect is ready. Hold the full page in view."}
          </div>
        )}
      </div>

      <div className="wallet-scanner">
        <div className={`wallet-scanner__viewport${cameraError ? " wallet-scanner__viewport--error" : ""}`}>
          {cameraError ? (
            <div className="wallet-scanner__fallback">{cameraError}</div>
          ) : cameraActive ? (
            <video ref={videoRef} className="wallet-scanner__video" playsInline muted />
          ) : previewUrl ? (
            <img src={previewUrl} alt="Scan preview" className="bible-scan-preview__image" />
          ) : (
            <div className="wallet-scanner__fallback">Camera is off.</div>
          )}
          {showGuides && <div className="wallet-scanner__guide" aria-hidden="true" />}
        </div>
        <div className="wallet-scanner__hint text-xs text-secondary text-center">
          {cameraActive
            ? "Hold the full page in view and tap Capture."
            : "Use the camera or upload a photo with all four markers visible."}
        </div>
      </div>

      <div className="bible-scan-actions">
        {cameraActive && (
          <button
            type="button"
            className="accent-button button-sm pressable"
            onClick={handleCapture}
            disabled={scanBusy}
          >
            Capture
          </button>
        )}
        <label className="ghost-button button-sm pressable bible-scan-upload">
          Upload photo
          <input type="file" accept="image/*" onChange={handleFileChange} />
        </label>
        {cameraError && !cameraActive && (
          <button
            type="button"
            className="ghost-button button-sm pressable"
            onClick={() => {
              setCameraError(null);
              setCameraActive(true);
            }}
          >
            Retry camera
          </button>
        )}
      </div>

      {scanBusy && <div className="text-xs text-secondary">Analyzing scan...</div>}
      {scanError && <div className="text-sm text-rose-400">{scanError}</div>}

      {scanResult && (
        <div className="bible-scan-results">
          <div className="text-sm font-medium text-primary">
            Detected {scanResult.filledCount} filled chapters
          </div>
          <div className="text-xs text-secondary">
            Page {scanResult.pageIndex + 1} captured.
          </div>
          <div className="text-xs text-secondary">
            {newChapters > 0
              ? `${newChapters} new chapter${newChapters === 1 ? "" : "s"} to add.`
              : "No new chapters found."}
          </div>
          {newChapters > 0 && (
            <div className="bible-scan-chapters">
              <div className="text-xs font-semibold text-primary">Review new chapters</div>
              <div className="bible-scan-chapter-list">
                {newChaptersByBook.map((entry) => (
                  <div key={entry.bookId} className="bible-scan-chapter-row">
                    <span className="bible-scan-chapter-book text-xs text-primary">{entry.name}</span>
                    <span className="bible-scan-chapter-range text-xs text-secondary">
                      {formatChapterRanges(entry.chapters)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="bible-scan-actions">
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={handleApply}
              disabled={scanBusy}
            >
              Add to tracker
            </button>
            <button
              type="button"
              className="ghost-button button-sm pressable"
              onClick={() => {
                setScanResult(null);
                setPreviewUrl(null);
                setScanError(null);
                setDetectedPageIndex(null);
                setCameraActive(true);
              }}
              disabled={scanBusy}
            >
              Scan again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
