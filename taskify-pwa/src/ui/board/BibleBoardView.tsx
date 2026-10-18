import type { ComponentProps, RefObject } from "react";
import { BibleTracker } from "../../components/BibleTracker";
import { ScriptureMemoryCard } from "../../components/ScriptureMemoryCard";

export type BibleBoardViewProps = {
  scrollerRef: RefObject<HTMLDivElement | null>;
  tracker: ComponentProps<typeof BibleTracker>;
  /** null when scripture memory is turned off in Settings. */
  scriptureMemory: ComponentProps<typeof ScriptureMemoryCard> | null;
};

/** The Bible board: the reading tracker and, when enabled, scripture memory, side by side. */
export function BibleBoardView({ scrollerRef, tracker, scriptureMemory }: BibleBoardViewProps) {
  return (
    <div ref={scrollerRef} className="overflow-x-auto pb-4 w-full" style={{ WebkitOverflowScrolling: "touch" }}>
      <div className="flex min-w-max items-start gap-4">
        <div className="surface-panel board-column w-[360px] shrink-0 overflow-hidden">
          <div className="p-4">
            <BibleTracker {...tracker} />
          </div>
        </div>
        {scriptureMemory ? (
          <ScriptureMemoryCard {...scriptureMemory} />
        ) : (
          <div className="surface-panel board-column w-[360px] shrink-0 p-4 text-sm text-secondary">
            Enable scripture memory from Settings to start adding passages you want to review.
          </div>
        )}
      </div>
    </div>
  );
}
