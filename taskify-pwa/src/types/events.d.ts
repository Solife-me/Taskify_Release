// The browser `events` package (Node's EventEmitter API) ships no types; this covers what
// `lib/eventEmitterShim.ts` uses.
declare module "events" {
  type Listener = (...args: any[]) => void;
  export class EventEmitter {
    on(event: string | symbol, listener: Listener): this;
    once(event: string | symbol, listener: Listener): this;
    off(event: string | symbol, listener: Listener): this;
    addListener(event: string | symbol, listener: Listener): this;
    removeListener(event: string | symbol, listener: Listener): this;
    removeAllListeners(event?: string | symbol): this;
    emit(event: string | symbol, ...args: unknown[]): boolean;
    listenerCount(event: string | symbol): number;
    listeners(event: string | symbol): Listener[];
    eventNames(): Array<string | symbol>;
    setMaxListeners(n: number): this;
    getMaxListeners(): number;
  }
  export default EventEmitter;
}
