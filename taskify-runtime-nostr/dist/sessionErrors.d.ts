/** A session or publisher was used after `shutdown()`. Shutdown is terminal; make a new session. */
export declare class RuntimeSessionClosedError extends Error {
    constructor(operation?: string);
}
