/**
 * AbortSignal helpers.
 *
 * The scanner shares one `AbortController` per scan with every request, probe
 * and ffmpeg run. Two problems come with attaching a native `abort` listener
 * per operation to such a long-lived signal:
 *
 *   1. `{ once: true }` only removes the listener when the abort *fires*, so a
 *      settled request keeps its listener (and the request object the listener
 *      captures) for the rest of the scan — a real leak.
 *   2. Even with cleanup, a parallel scan legitimately has many operations
 *      in flight at once (up to 8 MAC checks, each with up to 4 channel
 *      probes), which trips Node's EventTarget heuristic:
 *
 *        MaxListenersExceededWarning: Possible EventTarget memory leak
 *        detected. 11 abort listeners added to [AbortSignal]. MaxListeners
 *        is 10.
 *
 * `onAbort` solves both: any number of subscribers share a single native
 * listener per signal, and the returned disposer unregisters the subscriber as
 * soon as its operation settles. `abortSubscriberCount` exposes the number of
 * live subscribers so the test suites can prove nothing is left behind.
 */

type Subscriber = () => void;

const subscribersBySignal = new WeakMap<AbortSignal, Set<Subscriber>>();

const noop = (): void => {};

function notifyAndClear(signal: AbortSignal): void {
  const subscribers = subscribersBySignal.get(signal);
  subscribersBySignal.delete(signal);
  if (!subscribers) return;

  for (const subscriber of [...subscribers]) {
    try {
      subscriber();
    } catch {
      // One failing subscriber (a destroy() on an already-closed socket, an
      // already-dead child process) must not stop the others from aborting.
    }
  }
  subscribers.clear();
}

function subscribersOf(signal: AbortSignal): Set<Subscriber> {
  const existing = subscribersBySignal.get(signal);
  if (existing) return existing;

  const subscribers = new Set<Subscriber>();
  subscribersBySignal.set(signal, subscribers);
  // Exactly one native listener per signal, no matter how many operations
  // subscribe — this is what keeps Node's listener-limit warning away.
  signal.addEventListener("abort", () => notifyAndClear(signal), { once: true });
  return subscribers;
}

/**
 * Run `listener` when `signal` aborts and return a disposer that unregisters
 * it. Call the disposer when the operation settles (response ended, request
 * errored/timed out, child exited).
 *
 * - No signal → the listener is never registered and the disposer is a no-op.
 * - Already aborted → the listener runs immediately (a request cancelled
 *   before it starts) and the returned disposer is a no-op.
 */
export function onAbort(
  signal: AbortSignal | undefined | null,
  listener: () => void
): () => void {
  if (!signal) return noop;
  if (signal.aborted) {
    listener();
    return noop;
  }

  const subscribers = subscribersOf(signal);
  subscribers.add(listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers.delete(listener);
  };
}

/**
 * Number of operations currently subscribed to `signal`. Zero means every
 * settled operation detached again — the leak regression guard used by the
 * test suites.
 */
export function abortSubscriberCount(signal: AbortSignal): number {
  return subscribersBySignal.get(signal)?.size ?? 0;
}
