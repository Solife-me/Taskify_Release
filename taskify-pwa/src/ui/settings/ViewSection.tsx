// @ts-nocheck
import React, { useState, useCallback, useMemo, useRef } from "react";
import type { Settings } from "../../domains/tasks/settingsTypes";
import { ACCENT_CHOICES } from "../../domains/tasks/settingsTypes";
import type { Board, Weekday } from "../../domains/tasks/taskTypes";
import { prepareBackgroundImage, BackgroundImageError } from "../../theme/palette";
import { useToast } from "../../context/ToastContext";
import { pillButtonClass, WD_FULL } from "./settingsConstants";

export function ViewSection({
  settings,
  setSettings,
  boards,
}: {
  settings: Settings;
  setSettings: (s: Partial<Settings>) => void;
  boards: Board[];
}) {
  const { show: showToast } = useToast();
  const [viewExpanded, setViewExpanded] = useState(false);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundAccentHex = settings.backgroundAccent ? settings.backgroundAccent.fill.toUpperCase() : null;
  const photoAccents = settings.backgroundAccents ?? [];
  const visibleBoards = useMemo(() => boards.filter(b => !b.archived && !b.hidden), [boards]);

  const handleBackgroundImageSelection = useCallback(async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("Please choose an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast("Image too large. Please pick something under 8 MB.");
      return;
    }
    try {
      const { dataUrl, palettes } = await prepareBackgroundImage(file);
      const primary = palettes[0] ?? null;
      setSettings({
        backgroundImage: dataUrl,
        backgroundAccents: palettes,
        backgroundAccentIndex: primary ? 0 : null,
        backgroundAccent: primary,
        accent: primary ? "background" : "blue",
      });
      showToast("Background updated");
    } catch (err) {
      if (err instanceof BackgroundImageError) {
        showToast(err.message);
      } else {
        console.error("Failed to process background image", err);
        showToast("Could not load that image");
      }
    }
  }, [setSettings, showToast]);

  const clearBackgroundImage = useCallback(() => {
    setSettings({
      backgroundImage: null,
      backgroundAccent: null,
      backgroundAccents: null,
      backgroundAccentIndex: null,
      accent: "blue",
    });
    showToast("Background cleared");
  }, [setSettings, showToast]);

  const handleSelectPhotoAccent = useCallback((index: number) => {
    const palette = settings.backgroundAccents?.[index];
    if (!palette) return;
    setSettings({
      backgroundAccent: palette,
      backgroundAccentIndex: index,
      accent: "background",
    });
  }, [setSettings, settings.backgroundAccents]);

  function handleDailyStartBoardChange(day: Weekday, boardId: string) {
    const prev = settings.startBoardByDay;
    const next: Partial<Record<Weekday, string>> = { ...prev };
    if (!boardId) {
      if (prev[day] === undefined) return;
      delete next[day];
    } else {
      if (prev[day] === boardId) return;
      next[day] = boardId;
    }
    setSettings({ startBoardByDay: next });
  }

  return (
    <section className="wallet-section space-y-3">
      <button
        className="flex w-full items-center gap-2 mb-3 text-left"
        onClick={() => setViewExpanded((prev) => !prev)}
        aria-expanded={viewExpanded}
      >
        <div className="text-sm font-medium flex-1">View</div>
        <span className="text-xs text-tertiary">{viewExpanded ? "Hide" : "Show"}</span>
        <span className="text-tertiary">{viewExpanded ? "−" : "+"}</span>
      </button>
      {viewExpanded && (
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium mb-2">Add new tasks to</div>
            <div className="flex gap-2">
              <button className={pillButtonClass(settings.newTaskPosition === 'top')} onClick={() => setSettings({ newTaskPosition: 'top' })}>Top</button>
              <button className={pillButtonClass(settings.newTaskPosition === 'bottom')} onClick={() => setSettings({ newTaskPosition: 'bottom' })}>Bottom</button>
            </div>
          </div>
          <div>
            <div className="text-sm font-medium mb-2">Background</div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="accent-button button-sm pressable"
                onClick={() => backgroundInputRef.current?.click()}
              >
                Upload image
              </button>
              {settings.backgroundImage && (
                <button
                  className="ghost-button button-sm pressable"
                  onClick={clearBackgroundImage}
                >
                  Remove
                </button>
              )}
            </div>
            <input
              ref={backgroundInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files && event.target.files[0] ? event.target.files[0] : null;
                handleBackgroundImageSelection(file);
                event.currentTarget.value = "";
              }}
            />
            {settings.backgroundImage && (
              <div className="mt-3 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative w-16 h-12 overflow-hidden rounded-xl border border-surface bg-surface-muted">
                    <div
                      className="absolute inset-0"
                      style={{
                        backgroundImage: `url(${settings.backgroundImage})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                      }}
                    />
                  </div>
                  {settings.backgroundAccent && backgroundAccentHex && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-secondary">
                      <span className="inline-flex items-center gap-1 rounded-full border border-surface bg-surface-muted px-2 py-1">
                        <span
                          className="w-3 h-3 rounded-full"
                          style={{
                            background: settings.backgroundAccent.fill,
                            border: '1px solid rgba(255, 255, 255, 0.35)',
                          }}
                        />
                        <span>{backgroundAccentHex}</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="mt-3 space-y-3">
              <div>
                <div className="text-sm font-medium mb-2">Accent color</div>
                <div className="flex flex-wrap gap-3">
                  {[...ACCENT_CHOICES.map((choice) => ({
                    type: 'preset' as const,
                    key: choice.id,
                    label: choice.label,
                    fill: choice.fill,
                    ring: choice.ring,
                    border: choice.border,
                    borderActive: choice.borderActive,
                    shadow: choice.shadow,
                    shadowActive: choice.shadowActive,
                  })),
                  ...photoAccents.map((palette, index) => ({
                    type: 'photo' as const,
                    key: `photo-${index}`,
                    label: `Photo accent ${index + 1}`,
                    fill: palette.fill,
                    ring: palette.ring,
                    border: palette.border,
                    borderActive: palette.borderActive,
                    shadow: palette.shadow,
                    shadowActive: palette.shadowActive,
                    index,
                  }))].map((choice) => {
                    const active =
                      choice.type === 'photo'
                        ? settings.accent === 'background' && settings.backgroundAccentIndex === choice.index
                        : settings.accent === choice.key;

                    return (
                      <button
                        key={choice.key}
                        type="button"
                        className={`accent-swatch pressable ${active ? 'accent-swatch--active' : ''}`}
                        style={{
                          "--swatch-color": choice.fill,
                          "--swatch-ring": choice.ring,
                          "--swatch-border": choice.border,
                          "--swatch-border-active": choice.borderActive,
                          "--swatch-shadow": choice.shadow,
                          "--swatch-active-shadow": choice.shadowActive,
                        } as React.CSSProperties}
                        aria-label={choice.label}
                        aria-pressed={active}
                        onClick={() => {
                          if (choice.type === 'photo') {
                            handleSelectPhotoAccent(choice.index ?? 0);
                          } else {
                            setSettings({ accent: choice.key });
                          }
                        }}
                      >
                        <span className="sr-only">{choice.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            {settings.backgroundImage && (
              <div>
                <div className="text-xs text-secondary mb-1">Background clarity</div>
                <div className="flex gap-2">
                  <button
                    className={pillButtonClass(settings.backgroundBlur !== 'sharp')}
                    onClick={() => setSettings({ backgroundBlur: 'blurred' })}
                  >
                    Blurred
                  </button>
                  <button
                    className={pillButtonClass(settings.backgroundBlur === 'sharp')}
                    onClick={() => setSettings({ backgroundBlur: 'sharp' })}
                  >
                    Sharp
                  </button>
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Open app to</div>
            <div className="text-xs text-secondary mb-2">Choose which tab Taskify opens first.</div>
            <div className="flex flex-wrap gap-2">
              <button
                className={pillButtonClass(settings.startupView === "main")}
                onClick={() => setSettings({ startupView: "main" })}
              >
                Boards
              </button>
              <button
                className={pillButtonClass(settings.startupView === "upcoming")}
                onClick={() => setSettings({ startupView: "upcoming" })}
              >
                Upcoming
              </button>
              <button
                className={pillButtonClass(settings.startupView === "wallet")}
                onClick={() => setSettings({ startupView: "wallet" })}
              >
                Wallet
              </button>
              <button
                className={pillButtonClass(settings.startupView === "chat")}
                onClick={() => setSettings({ startupView: "chat" })}
              >
                Messages
              </button>
            </div>
          </div>
          <div className="space-y-4 pt-4 border-t border-neutral-800">
            <div>
              <div className="text-sm font-medium mb-1">Font size</div>
              <div className="text-xs text-secondary mb-2">Scales the entire UI. Defaults to a compact size.</div>
              <div className="flex flex-wrap gap-1">
                <button className={`${pillButtonClass(settings.baseFontSize == null)} button-xs`} onClick={() => setSettings({ baseFontSize: null })}>System</button>
                <button className={`${pillButtonClass(settings.baseFontSize === 14)} button-xs`} onClick={() => setSettings({baseFontSize: 14 })}>Sm</button>
                <button className={`${pillButtonClass(settings.baseFontSize === 20)} button-xs`} onClick={() => setSettings({baseFontSize: 20 })}>Lg</button>
                <button className={`${pillButtonClass(settings.baseFontSize === 22)} button-xs`} onClick={() => setSettings({baseFontSize: 22 })}>X-Lg</button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Hide completed subtasks</div>
              <div className="text-xs text-secondary mb-2">Keep finished subtasks out of cards. Open Edit to review them later.</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.hideCompletedSubtasks)}
                  onClick={() => setSettings({ hideCompletedSubtasks: !settings.hideCompletedSubtasks })}
                >
                  {settings.hideCompletedSubtasks ? "On" : "Off"}
                </button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Week starts on</div>
              <div className="text-xs text-secondary mb-2">Affects when weekly recurring tasks re-appear.</div>
              <div className="flex gap-2">
                <button className={pillButtonClass(settings.weekStart === 6)} onClick={() => setSettings({ weekStart: 6 })}>Saturday</button>
                <button className={pillButtonClass(settings.weekStart === 0)} onClick={() => setSettings({ weekStart: 0 })}>Sunday</button>
                <button className={pillButtonClass(settings.weekStart === 1)} onClick={() => setSettings({ weekStart: 1 })}>Monday</button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Show full week for recurring tasks</div>
              <div className="text-xs text-secondary mb-2">Display all occurrences for the current week at once.</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.showFullWeekRecurring)}
                  onClick={() => setSettings({ showFullWeekRecurring: !settings.showFullWeekRecurring })}
                >
                  {settings.showFullWeekRecurring ? "On" : "Off"}
                </button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Completed tab</div>
              <div className="text-xs text-secondary mb-2">Hide the completed tab and show a Clear completed button instead.</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.completedTab)}
                  onClick={() => setSettings({ completedTab: !settings.completedTab })}
                >
                  {settings.completedTab ? "On" : "Off"}
                </button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-1">Streaks</div>
              <div className="text-xs text-secondary mb-2">Track consecutive completions on recurring tasks.</div>
              <div className="flex gap-2">
                <button
                  className={pillButtonClass(settings.streaksEnabled)}
                  onClick={() => setSettings({ streaksEnabled: !settings.streaksEnabled })}
                >
                  {settings.streaksEnabled ? "On" : "Off"}
                </button>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">Board on app start</div>
              <div className="space-y-2">
                {WD_FULL.map((label, idx) => (
                  <div key={label} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                    <div className="text-xs uppercase tracking-wide text-secondary sm:w-28">{label}</div>
                    <select
                      className="pill-input flex-1"
                      value={settings.startBoardByDay[idx as Weekday] ?? ""}
                      onChange={(e) => handleDailyStartBoardChange(idx as Weekday, e.target.value)}
                    >
                      <option value="">Default (first visible)</option>
                      {visibleBoards.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <div className="text-xs text-secondary mt-2">
                Choose which board opens first for each day. Perfect for work boards on weekdays and personal lists on weekends.
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
