// Connects the chat read markers owned by the (lazily loaded) chat UI to the app-level chat
// state sync, without either side depending on the other being mounted.
//
// - The chat UI reports each read marker it advances; the sync hook folds it into what it
//   publishes.
// - The sync hook hands read markers learned from another device to whoever is listening.
//   It also writes them to storage itself, so a chat UI that mounts later starts from them.

type ReadThroughListener = (readThrough: Record<string, number>) => void;

const localListeners = new Set<ReadThroughListener>();
const remoteListeners = new Set<ReadThroughListener>();

export const chatStateSyncBus = {
  reportLocalReadThrough(readThrough: Record<string, number>) {
    localListeners.forEach((listener) => listener(readThrough));
  },
  onLocalReadThrough(listener: ReadThroughListener): () => void {
    localListeners.add(listener);
    return () => { localListeners.delete(listener); };
  },
  applyRemoteReadThrough(readThrough: Record<string, number>) {
    remoteListeners.forEach((listener) => listener(readThrough));
  },
  onRemoteReadThrough(listener: ReadThroughListener): () => void {
    remoteListeners.add(listener);
    return () => { remoteListeners.delete(listener); };
  },
};
