import dotenv from "dotenv";
import { createDemoApp } from "./app.js";
import { loadDemoConfig } from "./config.js";

dotenv.config({ path: new URL("../../../.env", import.meta.url), quiet: true });
const config = loadDemoConfig();
if (config.port === config.attackerPort) throw new Error("DEMO_PORT and DEMO_ATTACKER_PORT must be different.");
const app = createDemoApp(config);
const victimServer = app.listen(config.port, "127.0.0.1", () => {
  console.log(`Victim / Campus SNS: http://localhost:${config.port}/`);
});
const attackerServer = app.listen(config.attackerPort, "127.0.0.1", () => {
  console.log(`Attacker / Cookie Theft Demo: http://localhost:${config.attackerPort}/`);
});
const close = () => { victimServer.close(); attackerServer.close(); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
