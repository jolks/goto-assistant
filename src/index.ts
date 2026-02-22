import { createApp, createServer } from "./server.js";
import { isConfigured, loadConfig } from "./config.js";
import { runMigrations } from "./migrations.js";
import { startCronServer, stopCronServer } from "./cron.js";
import { startWhatsApp, stopWhatsApp } from "./whatsapp.js";

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
    const config = loadConfig();
    if (config.whatsapp?.enabled) {
      startWhatsApp().catch((err) =>
        console.error("Failed to start WhatsApp:", err)
      );
    }
  }
});

function shutdown() {
  Promise.all([stopCronServer(), stopWhatsApp()]).then(() => {
    server.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
