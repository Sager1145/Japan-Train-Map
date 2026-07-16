"use strict";

const { createApp } = require("./server/create-app");

const PORT = process.env.PORT || 3000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`N02 Train Manager running at http://localhost:${PORT}`);
  console.log(`  API:      http://localhost:${PORT}/api`);
  console.log(`  Frontend: http://localhost:${PORT}/`);
});
