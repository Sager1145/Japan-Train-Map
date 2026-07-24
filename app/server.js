"use strict";

const { createApp } = require("./server/create-app");

const PORT = process.env.PORT || 3000;
const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`N02 Train Manager running at http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api`);
  console.log(`  Frontend: http://localhost:${PORT}/`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Pick another port, e.g. PORT=3001 npm start.`,
    );
    process.exit(1);
  }
  throw err;
});
