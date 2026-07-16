"use strict";

function createLiveEvents({
  now = () => new Date(),
  heartbeatMs = 25000,
} = {}) {
  const clients = new Set();

  function broadcastStoreChanged(detail = {}) {
    const payload = JSON.stringify({
      type: "store-changed",
      at: now().toISOString(),
      ...detail,
    });
    for (const res of clients) {
      try {
        res.write(`event: store-changed\ndata: ${payload}\n\n`);
      } catch (err) {
        // Best-effort: a dead socket is cleaned up by its own close handler.
      }
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    clients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (err) {
        // The close handler removes dead sockets.
      }
    }, heartbeatMs);

    req.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  }

  return {
    broadcastStoreChanged,
    handleEvents,
    get clientCount() {
      return clients.size;
    },
  };
}

module.exports = { createLiveEvents };
