/**
 * Stands in for `tseep` (NDK's event emitter) in the browser build; see `vite.config.ts`.
 *
 * tseep's default build compiles its dispatch functions with `eval`, which a CSP without
 * 'unsafe-eval' blocks. Its eval-free build caches the listener count during `emit`, so a
 * listener that removes itself (NDK's relay connect handlers do) leaves a hole and the next
 * call throws. The `events` package has the same API NDK uses, copies the listener list before
 * emitting, and needs no `eval`. Two differences from tseep are smoothed over here: no listener
 * limit, and an "error" event with no listener is dropped rather than thrown.
 */
import { EventEmitter as BaseEventEmitter } from "events";

export class EventEmitter extends BaseEventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === "error" && this.listenerCount("error") === 0) return false;
    return super.emit(event, ...args);
  }
}
