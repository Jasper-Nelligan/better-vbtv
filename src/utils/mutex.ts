// Serializes async read-modify-write sequences against the same storage key.
//
// `ext.storage.local` has no atomic update, so a naive `get` -> mutate -> `set`
// pair can lose writes when two callers interleave — which is easy to hit here,
// where a position save, a metadata refresh and a popup delete can all land at
// once. Chaining every mutation onto a single promise makes them run one after
// another within a context.
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // Swallow the predecessor's rejection so one failure can't poison the chain.
    const run = tail.catch(() => undefined).then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
