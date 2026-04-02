// @ts-nocheck
import React, { useState, useCallback } from "react";
import {
  parseFileServers,
  serializeFileServers,
  normalizeFileServerUrl,
  DEFAULT_FILE_SERVERS,
  type FileServerEntry,
  type FileServerType,
} from "../../lib/fileStorage";

type Props = {
  fileStorageServer: string;
  fileServers: string;
  onSelectServer: (url: string) => void;
  onUpdateServers: (serialized: string) => void;
  addWarning?: (type: FileServerType | null) => string | null;
};

const DEFAULT_URLS = new Set(DEFAULT_FILE_SERVERS.map((s) => s.url));

function serverLabel(entry: FileServerEntry): string {
  if (entry.label) return entry.label;
  try {
    return new URL(entry.url).hostname;
  } catch {
    return entry.url;
  }
}

const TYPE_LABELS: Record<FileServerType, string> = {
  nip96: "NIP-96",
  blossom: "Blossom",
  originless: "Originless",
};

export function FileServersSection({ fileStorageServer, fileServers, onSelectServer, onUpdateServers, addWarning }: Props) {
  const servers = parseFileServers(fileServers);
  const selectedNorm = normalizeFileServerUrl(fileStorageServer) || fileStorageServer;

  const [addStep, setAddStep] = useState<"closed" | "type" | "url">("closed");
  const [addType, setAddType] = useState<FileServerType | null>(null);
  const [addUrl, setAddUrl] = useState("");
  const [addError, setAddError] = useState<string | null>(null);

  const resetAdd = useCallback(() => {
    setAddStep("closed");
    setAddType(null);
    setAddUrl("");
    setAddError(null);
  }, []);

  const handleSelect = useCallback(
    (url: string) => {
      onSelectServer(normalizeFileServerUrl(url) || url);
    },
    [onSelectServer],
  );

  const handleDelete = useCallback(
    (url: string) => {
      const next = servers.filter((s) => s.url !== url);
      onUpdateServers(serializeFileServers(next));
      // If we deleted the selected server, auto-select the first remaining one
      const deletedNorm = normalizeFileServerUrl(url) || url;
      if (deletedNorm === selectedNorm && next.length > 0) {
        onSelectServer(normalizeFileServerUrl(next[0].url) || next[0].url);
      }
    },
    [servers, selectedNorm, onUpdateServers, onSelectServer],
  );

  const handleAdd = useCallback(() => {
    setAddError(null);
    const normalized = normalizeFileServerUrl(addUrl.trim());
    if (!normalized) {
      setAddError("Enter a valid URL (e.g., https://nostr.build)");
      return;
    }
    const already = servers.find((s) => (normalizeFileServerUrl(s.url) || s.url) === normalized);
    if (already) {
      setAddError("This server is already in the list.");
      return;
    }
    let label: string | undefined;
    try {
      label = new URL(normalized).hostname;
    } catch {
      label = undefined;
    }
    const entry: FileServerEntry = { url: normalized, type: addType!, label };
    const next = [...servers, entry];
    onUpdateServers(serializeFileServers(next));
    onSelectServer(normalized);
    resetAdd();
  }, [addUrl, addType, servers, onUpdateServers, onSelectServer, resetAdd]);

  return (
    <div className="space-y-2">
      

      <div className="space-y-2">
        {servers.map((entry) => {
          const entryNorm = normalizeFileServerUrl(entry.url) || entry.url;
          const isSelected = entryNorm === selectedNorm;
          const isDefault = DEFAULT_URLS.has(entry.url);

          return (
            <div
              key={entry.url}
              className="flex items-center gap-3 px-3 py-2 rounded-xl glass-panel pressable"
              style={{ cursor: "pointer" }}
              onClick={() => handleSelect(entry.url)}
            >
              {/* Radio circle */}
              <div
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: "50%",
                  border: isSelected
                    ? "2px solid var(--color-accent)"
                    : "2px solid var(--color-border)",
                  background: isSelected ? "var(--color-accent)" : "transparent",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isSelected && (
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: "var(--color-on-accent, #fff)",
                    }}
                  />
                )}
              </div>

              {/* Label + URL + type badge */}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{serverLabel(entry)}</div>
                <div className="text-xs text-secondary truncate">{entry.url}</div>
              </div>

              {/* Type badge */}
              <div
                className="text-xs text-secondary"
                style={{ flexShrink: 0, opacity: 0.7 }}
              >
                {TYPE_LABELS[entry.type]}
              </div>

              {/* Delete button for non-default servers */}
              {!isDefault && (
                <button
                  className="ghost-button button-sm pressable"
                  style={{ color: "var(--color-rose, #f43f5e)", flexShrink: 0 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(entry.url);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Add server UI — step 1: choose type */}
      {addStep === "type" && (
        <div className="glass-panel rounded-xl p-3 space-y-3">
          <div className="text-xs text-secondary font-medium">Select server type</div>
          <div className="flex flex-col gap-2">
            {(["nip96", "blossom", "originless"] as FileServerType[]).map((t) => (
              <button
                key={t}
                className="ghost-button pressable text-left"
                style={{ justifyContent: "flex-start", padding: "0.5rem 0.75rem" }}
                onClick={() => { setAddType(t); setAddStep("url"); }}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <button className="ghost-button button-sm pressable" onClick={resetAdd}>
            Cancel
          </button>
        </div>
      )}

      {/* Add server UI — step 2: enter URL */}
      {addStep === "url" && (
        <div className="glass-panel rounded-xl p-3 space-y-2">
          <div className="text-xs text-secondary font-medium">
            {TYPE_LABELS[addType!]} server URL
          </div>
          {addWarning?.(addType) ? (
            <div className="text-xs text-amber-400">{addWarning(addType)}</div>
          ) : null}
          <div className="flex gap-2">
            <input
              className="pill-input flex-1"
              placeholder="https://example.com"
              value={addUrl}
              onChange={(e) => { setAddUrl(e.target.value); setAddError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              autoFocus
            />
            <button className="accent-button button-sm pressable" onClick={handleAdd}>
              Add
            </button>
          </div>
          {addError && (
            <div className="text-xs" style={{ color: "var(--color-rose, #f43f5e)" }}>
              {addError}
            </div>
          )}
          <button
            className="ghost-button button-sm pressable"
            onClick={() => { setAddStep("type"); setAddUrl(""); setAddError(null); }}
          >
            ← Back
          </button>
        </div>
      )}

      {addStep === "closed" && (
        <button
          className="ghost-button button-sm pressable"
          onClick={() => setAddStep("type")}
        >
          + Add server
        </button>
      )}

    </div>
  );
}
