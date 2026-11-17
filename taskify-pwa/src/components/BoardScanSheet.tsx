import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BOARD_PRINT_MODERN_LAYOUT_VERSION, buildBoardPrintLayout, type BoardPrintJob, type BoardPrintTask } from "./BoardPrintLayout";
import { identifyBoardScan } from "../domains/print/boardScan";
import { captureScanPhoto, loadScanPhoto, SCAN_CAMERA_CONSTRAINTS, scanPhotoFromCanvas } from "../domains/print/scanCanvas";
import { applyableScanIds, defaultSelectedScanIds, reviewTasksForScan } from "../domains/print/scanReviewState";

export function BoardScanPanel({
  job,
  boardName,
  catalog,
  onApply,
}: {
  job: BoardPrintJob | null;
  boardName: string;
  catalog: BoardPrintTask[];
  onApply: (taskIds: string[]) => void;
}) {
  const layout = useMemo(
    () => job ? buildBoardPrintLayout(job.tasks, {
      layoutVersion: job.layoutVersion, paperSize: job.paperSize, jobId: job.id,
    }) : null,
    [job],
  );
  const ocrLayout = useMemo(
    () => buildBoardPrintLayout([], { paperSize: job?.paperSize ?? "letter", layoutVersion: BOARD_PRINT_MODERN_LAYOUT_VERSION }),
    [job?.paperSize],
  );
  const taskLookup = useMemo(() => new Map(catalog.map((task) => [task.id, task])), [catalog]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [pageSelection, setPageSelection] = useState<"auto" | number>("auto");
  const [detectedPageIndex, setDetectedPageIndex] = useState<number | null>(null);
  const [cameraActive, setCameraActive] = useState(true);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState<ReturnType<typeof identifyBoardScan> | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [reviewIds, setReviewIds] = useState<string[]>([]);
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<string>>(() => new Set());

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
          video: SCAN_CAMERA_CONSTRAINTS,
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

  const analyzeCanvas = useCallback(async (canvas: HTMLCanvasElement) => {
    const photo = scanPhotoFromCanvas(canvas);
    const { readChecklistText } = await import("../domains/print/scanOcr");
    const lines = await readChecklistText(photo, ocrLayout);
    const result = identifyBoardScan(photo, lines, catalog, boardName, job, layout, pageSelection);
    if (pageSelection === "auto") {
      setDetectedPageIndex(result.pageIndex);
    } else {
      setDetectedPageIndex(null);
    }
    setScanResult(result);
    const detectedTasks = reviewTasksForScan(result.taskIds, taskLookup);
    setReviewIds((current) => [...new Set([...current, ...result.taskIds])]);
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      defaultSelectedScanIds(detectedTasks).forEach((id) => {
        if (!reviewIds.includes(id)) next.add(id);
      });
      return next;
    });
    setPreviewUrl(canvas.toDataURL("image/jpeg", 0.85));
    return result;
  }, [boardName, catalog, job, layout, ocrLayout, pageSelection, reviewIds, taskLookup]);

  const scanCapture = useCallback(async (getCanvas: () => Promise<HTMLCanvasElement>) => {
    setScanBusy(true);
    setScanError(null);
    setScanResult(null);
    try {
      const result = await analyzeCanvas(await getCanvas());
      if (result) {
        setCameraError(null);
        setCameraActive(false);
      }
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "Unable to read the photo.");
    } finally {
      setScanBusy(false);
    }
  }, [analyzeCanvas]);

  const handleCapture = useCallback(
    () => scanCapture(() => captureScanPhoto(videoRef.current, streamRef.current)),
    [scanCapture],
  );

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void scanCapture(() => loadScanPhoto(file));
  }, [scanCapture]);

  const reviewTasks = useMemo(
    () => reviewTasksForScan(reviewIds, taskLookup),
    [reviewIds, taskLookup],
  );
  const selectableReviewIds = useMemo(
    () => defaultSelectedScanIds(reviewTasks),
    [reviewTasks],
  );
  const selectedApplyableIds = useMemo(
    () => applyableScanIds(reviewTasks, selectedReviewIds),
    [reviewTasks, selectedReviewIds],
  );

  const toggleReviewTask = useCallback((task: BoardPrintTask) => {
    if (task.completed) return;
    setSelectedReviewIds((current) => {
      const next = new Set(current);
      if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    if (!selectedApplyableIds.length) return;
    onApply(selectedApplyableIds);
  }, [onApply, selectedApplyableIds]);

  const showGuides = cameraActive;

  return (
    <div className="board-scan-panel">
      {layout && layout.page.count > 1 && (
        <div className="board-scan-detect">
          <div className="text-xs font-semibold text-primary">Page detection</div>
          <div className="board-scan-toggle" role="group" aria-label="Page detection">
            <button
              type="button"
              className="board-scan-toggle__option pressable"
              data-active={pageSelection === "auto"}
              aria-pressed={pageSelection === "auto"}
              disabled={scanBusy}
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
                disabled={scanBusy}
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
      )}

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
        {navigator.maxTouchPoints > 0 && (
          <label className="ghost-button button-sm pressable board-scan-upload">
            Take photo
            <input type="file" accept="image/*" capture="environment" onChange={handleFileChange} disabled={scanBusy} />
          </label>
        )}
        <label className="ghost-button button-sm pressable board-scan-upload">
          Upload photo
          <input type="file" accept="image/*" onChange={handleFileChange} disabled={scanBusy} />
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
            Detected {scanResult.taskIds.length} filled mark{scanResult.taskIds.length === 1 ? "" : "s"}
            {scanResult.pageIndex != null ? ` on page ${scanResult.pageIndex + 1}` : ""}
          </div>
          <div className="text-xs text-secondary">
            {reviewTasks.length} unique task{reviewTasks.length === 1 ? "" : "s"} in this review. Select the changes to apply.
          </div>
          {reviewTasks.length > 0 && (
            <div className="board-scan-tasks">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold text-primary">Verify detected tasks</div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-secondary hover:text-primary pressable"
                    onClick={() => setSelectedReviewIds(new Set(selectableReviewIds))}
                    disabled={scanBusy || !selectableReviewIds.size}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    className="text-xs text-secondary hover:text-primary pressable"
                    onClick={() => setSelectedReviewIds(new Set())}
                    disabled={scanBusy || !selectedReviewIds.size}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="board-scan-task-list">
                {reviewTasks.map((task) => {
                  const checked = !task.completed && selectedReviewIds.has(task.id);
                  return (
                    <label key={task.id} className={`board-scan-task-row${task.completed ? " is-completed" : ""}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={scanBusy || task.completed}
                        onChange={() => toggleReviewTask(task)}
                      />
                      {task.label ? (
                        <span className="board-scan-task-label text-xs">{task.label}</span>
                      ) : null}
                      <span className="board-scan-task-title text-sm">{task.title}</span>
                      {task.completed ? <span className="text-xs text-tertiary">Already completed</span> : null}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="board-scan-actions">
            <button
              type="button"
              className="accent-button button-sm pressable"
              onClick={handleApply}
              disabled={scanBusy || selectedApplyableIds.length === 0}
            >
              Apply {selectedApplyableIds.length || ""} completed mark{selectedApplyableIds.length === 1 ? "" : "s"}
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
              Scan another page
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
