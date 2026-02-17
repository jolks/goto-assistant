import { createApp, createServer } from "./server.js";
import { isConfigured, loadConfig } from "./config.js";
import { runMigrations } from "./migrations.js";
import { startCronServer, stopCronServer } from "./cron.js";

runMigrations();

const app = createApp();
const server = createServer(app);

const port = isConfigured() ? loadConfig().server.port : 3000;

server.listen(port, () => {
  console.log(`goto-assistant running at http://localhost:${port}`);
  if (!isConfigured()) {
    console.log("First run detected — visit the URL above to configure.");
  } else {
    startCronServer().catch((err) =>
      console.error("Failed to start mcp-cron:", err)
    );
  }
});

function shutdown() {
  stopCronServer().then(() => {
    server.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
