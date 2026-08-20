// =========================================================================
//  app-scheduling.js — cooperative yielding
//
//  This primitive was called `_statsYield` and lived in app-stats.js, which
//  made it read like an internal of the statistics panel. It is not: the
//  chunked rail-sections parse, the sliced station-index build, the store
//  operations and both stats modules all yield through it. A scheduler
//  primitive that five modules depend on belongs at the bottom of the stack
//  under a name that says what it does.
//
//  Behavior is unchanged — same MessageChannel, same setTimeout fallback.
// =========================================================================

// Yield one macrotask WITHOUT the background-tab timer clamp. setTimeout(0) is
// throttled to >= 1 s in hidden tabs, which stretched the chunked rail-sections
// parse (~85 yields) and the stats edge-index build (~170 yields) to MINUTES
// whenever the page loaded in a background tab or the user switched apps
// mid-load — extremely common on iPhone. MessageChannel messages are ordinary
// macrotasks (paint and input still interleave between slices) but are exempt
// from timer throttling, so hidden-tab loads run at full speed.
const yieldToEventLoop =
  typeof MessageChannel === "function"
    ? () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
          };
          channel.port2.postMessage(null);
        })
    : () => new Promise((resolve) => setTimeout(resolve, 0));
