import { createApp, createServer } from "./server.js";
import { isConfigured, loadConfig } from "./config.js";

const app = createApp();
const server = createServer(app);

const port = Number(process.env.PORT) || (isConfigured() ? loadConfig().server.port : 3000);

server.listen(port, () => {
  console.log(`goto-assistant running at http://localhost:${port}`);
  if (!isConfigured()) {
    console.log("First run detected — visit the URL above to configure.");
  }
});
