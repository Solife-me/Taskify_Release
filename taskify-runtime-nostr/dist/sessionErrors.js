/** A session or publisher was used after `shutdown()`. Shutdown is terminal; make a new session. */
export class RuntimeSessionClosedError extends Error {
    constructor(operation = "This operation") {
        super(`${operation} was called after the Nostr session shut down.`);
        this.name = "RuntimeSessionClosedError";
    }
}
