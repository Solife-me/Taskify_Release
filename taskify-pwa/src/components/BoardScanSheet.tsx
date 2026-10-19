import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buildBoardPrintLayout, type BoardPrintJob, type BoardPrintLayout, type BoardPrintTask } from "./BoardPrintLayout";
import { scanPage, type ScanMark, type ScanMarkGeometry } from "../domains/print/scanEngine";
import { scanPhotoFromCanvas } from "../domains/print/scanCanvas";

type ScanAnalysis = {
  taskIds: string[];
  filledCount: number;
  threshold: number;
  backgroundMedian: number;
  pageIndex: number;
};

const PRINT_DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatPrintDate(iso: string): string {
  try {
    return PRINT_DATE_FORMATTER.format(new Date(iso));
  } catch {
    return iso;
  }
}

/** A board sheet's marks are the task circles; the paper is sampled beside and between rows. */
function boardMarkGeometry(layout: BoardPrintLayout): ScanMarkGeometry {
  const circleSizeMm = layout.circle.sizeMm;
  const backgroundOffsetX = Math.max(circleSizeMm * 0.8, 2);
  const backgroundOffsetY = Math.max(layout.rows.heightMm * 0.45, circleSizeMm * 0.6);
  return {
    sampleRadiusMm: Math.max(0.55, circleSizeMm * 0.16),
    innerOffsetMm: circleSizeMm * 0.25,
    backgroundOffsets: [
      { x: -backgroundOffsetX, y: 0 },
      { x: -backgroundOffsetX, y: -backgroundOffsetY },
      { x: -backgroundOffsetX, y: backgroundOffsetY },
      { x: 0, y: -backgroundOffsetY },
      { x: 0, y: backgroundOffsetY },
    ],
    backgroundRadiusMm: Math.max(0.7, circleSizeMm * 0.25),
  };
}

export function boardScanMarks(layout: BoardPrintLayout, pageIndex: number): ScanMark<string>[] {
  const size = layout.circle.sizeMm;
  return layout.pages[pageIndex].rows.flatMap((row) =>
    row.kind === "task" ? [{ key: row.taskId, centerMm: { x: row.circleX + size / 2, y: row.circleY + size / 2 } }] : [],
  );
}

function analyzeScanCanvas(
  canvas: HTMLCanvasElement,
  layout: BoardPrintLayout,
  pageSelection: number | "auto",
): ScanAnalysis {
  const result = scanPage(scanPhotoFromCanvas(canvas), layout, {
    pageSelection,
    pageCount: layout.pages.length,
    marksOnPage: (pageIndex) => boardScanMarks(layout, pageIndex),
    geometry: boardMarkGeometry(layout),
  });
  return { taskIds: result.filled, filledCount: result.filledCount, threshold: result.threshold, backgroundMedian: result.backgroundMedian, pageIndex: result.pageIndex };
}

export function BoardScanPanel({
  job,
  onApply,
}: {
  job: BoardPrintJob;
  onApply: (taskIds: string[]) => void;
}) {
  const layout = useMemo(
    () => buildBoardPrintLayout(job.tasks, { layoutVersion: job.layoutVersion, paperSize: job.paperSize }),
    [job.layoutVersion, job.paperSize, job.tasks],
  );
  const printedDate = useMemo(() => formatPrintDate(job.printedAtISO), [job.printedAtISO]);
  const taskLookup = useMemo(
    () => new Map(job.tasks.map((task) => [task.id, task])),
    [job.tasks],
  );
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
        const result = analyzeScanCanvas(canvas, layout, pageSelection);
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
    [layout, pageSelection]
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

  const detectedTasks = useMemo(() => {
    if (!scanResult) return [] as BoardPrintTask[];
    return scanResult.taskIds
      .map((id) => taskLookup.get(id))
      .filter(Boolean) as BoardPrintTask[];
  }, [scanResult, taskLookup]);

  const handleApply = useCallback(() => {
    if (!scanResult) return;
    onApply(scanResult.taskIds);
  }, [onApply, scanResult]);

  if (!job.tasks.length) {
    return (
      <div className="board-scan-panel">
        <div className="text-sm text-secondary">This print has no tasks to scan.</div>
      </div>
    );
  }

  const showGuides = cameraActive;

  return (
    <div className="board-scan-panel">
      <div className="board-scan-meta text-xs text-secondary">
        Using print from {printedDate} for {job.boardName || "board"}.
      </div>
      <div className="board-scan-detect">
        <div className="text-xs font-semibold text-primary">Page detection</div>
        <div className="board-scan-toggle" role="group" aria-label="Page detection">
          <button
            type="button"
            className="board-scan-toggle__option pressable"
            data-active={pageSelection === "auto"}
            aria-pressed={pageSelection === "auto"}
            onClick={() => setPageSelection("auto")}
          >
            Auto
          </button>
          {Array.from({ length: layout.page.count }, (_, index) => (
            <button
              key={index}
              type="button"
              className="board-scan-toggle__option pressable"
              data-active={pageSelection === index}
              aria-pressed={pageSelection === index}
              onClick={() => setPageSelection(index)}
            >
              Page {index + 1}
            </button>
          ))}
        </div>
        {pageSelection === "auto" && (
          <div className="board-scan-status text-xs text-secondary">
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
            <img src={previewUrl} alt="Scan preview" className="board-scan-preview__image" />
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

      <div className="board-scan-actions">
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
        <label className="ghost-button button-sm pressable board-scan-upload">
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
        <div className="board-scan-results">
          <div className="text-sm font-medium text-primary">
            Detected {scanResult.filledCount} filled task{scanResult.filledCount === 1 ? "" : "s"}
          </div>
          <div className="text-xs text-secondary">
            Page {scanResult.pageIndex + 1} captured.
          </div>
          <div className="text-xs text-secondary">
            {detectedTasks.length > 0
              ? `${detectedTasks.length} task${detectedTasks.length === 1 ? "" : "s"} ready to update.`
              : "No tasks found on this page."}
          </div>
          {detectedTasks.length > 0 && (
            <div className="board-scan-tasks">
              <div className="text-xs font-semibold text-primary">Review detected tasks</div>
              <div className="board-scan-task-list">
                {detectedTasks.map((task) => (
                  <div key={task.id} className="board-scan-task-row">
                    {task.label ? (
                      <span className="board-scan-task-label text-xs">{task.label}</span>
                    ) : null}
                    <span className="board-scan-task-title text-sm">{task.title}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="board-scan-actions">
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={handleApply}
              disabled={scanBusy || detectedTasks.length === 0}
            >
              Mark complete
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
