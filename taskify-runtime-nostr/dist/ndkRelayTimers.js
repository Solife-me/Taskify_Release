import { NDKRelay } from "@nostr-dev-kit/ndk";
/**
 * NDK 3.0.3 re-arms a referenced 30-second timer in every relay's `updateValidationRatio` and keeps
 * no handle to it, so a process that ever made a relay can never exit by itself, and nothing can
 * stop it. This replaces the method once with the same calculation, keeping the timer on the
 * relay, unreferenced (a statistics refresh never holds a process open), and stoppable. Remove it
 * when NDK stores or clears the timer itself.
 */
const INSTALLED = Symbol.for("taskify.ndkRelayTimerFix");
const TIMER = Symbol.for("taskify.ndkValidationTimer");
const STOPPED = Symbol.for("taskify.ndkValidationStopped");
export function installNdkRelayTimerFix() {
    const prototype = NDKRelay.prototype;
    if (prototype[INSTALLED])
        return;
    prototype[INSTALLED] = true;
    prototype.updateValidationRatio = function () {
        if (this[STOPPED])
            return;
        if (this.validationRatioFn && this.validatedEventCount > 0) {
            this.targetValidationRatio = this.validationRatioFn(this, this.validatedEventCount, this.nonValidatedEventCount);
        }
        const timer = setTimeout(() => this.updateValidationRatio(), 30_000);
        timer.unref?.();
        this[TIMER] = timer;
    };
}
/** Stops a relay's validation-ratio refresh for good (on shutdown). */
export function stopNdkRelayTimers(relay) {
    const patched = relay;
    patched[STOPPED] = true;
    if (patched[TIMER])
        clearTimeout(patched[TIMER]);
    patched[TIMER] = undefined;
}
