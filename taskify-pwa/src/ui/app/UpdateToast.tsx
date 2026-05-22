type UpdateToastProps = {
  handleReloadLater: () => void;
  handleReloadNow: () => void;
  updateToastVisible: boolean;
};

export function UpdateToast({
  handleReloadLater,
  handleReloadNow,
  updateToastVisible,
}: UpdateToastProps) {
  if (!updateToastVisible) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-[10001] w-[calc(100%-2rem)] max-w-md -translate-x-1/2">
      <div className="rounded-xl border border-neutral-700 bg-neutral-900/95 p-4 text-sm text-white shadow-lg">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-base font-semibold">Update available</div>
            <div className="text-xs text-neutral-300">
              Reload to get the latest Taskify features.
            </div>
          </div>
          <div className="flex gap-2 sm:shrink-0">
            <button className="ghost-button button-sm pressable" onClick={handleReloadLater}>
              Later
            </button>
            <button className="accent-button button-sm pressable" onClick={handleReloadNow}>
              Reload
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
