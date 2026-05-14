import { nip19 } from "nostr-tools";
import { ActionSheet } from "../../components/ActionSheet";
import { kvStorage } from "../../storage/kvStorage";
import type { FinalTask } from "../../nostr/useVoiceSession";
import { VoiceDictationModal } from "../../components/VoiceDictationModal";

type InlineTaskOverlaysProps = {
  addMenuKey: string | null;
  currentBoardId?: string;
  handleVoiceSave: (key: string, finalTasks: FinalTask[]) => void;
  nostrPK: string;
  openInlineTaskEditorDirect: (key: string) => void;
  setAddMenuKey: (key: string | null) => void;
  setVoiceDictationKey: (key: string | null) => void;
  voiceDictationKey: string | null;
  workerBaseUrl: string;
};

export function InlineTaskOverlays({
  addMenuKey,
  currentBoardId,
  handleVoiceSave,
  nostrPK,
  openInlineTaskEditorDirect,
  setAddMenuKey,
  setVoiceDictationKey,
  voiceDictationKey,
  workerBaseUrl,
}: InlineTaskOverlaysProps) {
  const npub = nostrPK ? (() => {
    try {
      return typeof (nip19 as any).npubEncode === "function"
        ? (nip19 as any).npubEncode(nostrPK)
        : nostrPK;
    } catch {
      return nostrPK;
    }
  })() : "";

  return (
    <>
      <ActionSheet
        open={addMenuKey !== null && voiceDictationKey === null}
        onClose={() => setAddMenuKey(null)}
        title="Add Task"
      >
        <div className="space-y-1 pb-1">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[var(--color-surface-hover)] transition-colors pressable"
            onClick={() => {
              const key = addMenuKey!;
              setAddMenuKey(null);
              openInlineTaskEditorDirect(key);
            }}
          >
            <span className="text-lg leading-none">＋</span>
            <span className="text-sm font-medium">New Task</span>
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left hover:bg-[var(--color-surface-hover)] transition-colors pressable"
            onClick={() => {
              setVoiceDictationKey(addMenuKey);
            }}
          >
            <span className="text-lg leading-none">🎙</span>
            <span className="text-sm font-medium">Dictate</span>
          </button>
        </div>
      </ActionSheet>

      {voiceDictationKey !== null && (
        <VoiceDictationModal
          isOpen={true}
          onClose={() => {
            setVoiceDictationKey(null);
            setAddMenuKey(null);
          }}
          onSave={(tasks) => {
            if (voiceDictationKey !== null) {
              handleVoiceSave(voiceDictationKey, tasks);
            }
          }}
          workerBaseUrl={workerBaseUrl}
          npub={npub}
          testingMode={kvStorage.getItem("taskify.voice.testInput.enabled") === "true"}
          defaultBoardId={currentBoardId}
        />
      )}
    </>
  );
}
