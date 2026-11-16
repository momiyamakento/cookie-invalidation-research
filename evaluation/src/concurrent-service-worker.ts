import { isBenchmarkServiceId } from "@cookie-research/protocol";
import { createConcurrentFixture } from "./concurrent-fixture.js";

const serviceId = process.argv[2];
const secret = process.env.CONCURRENT_SECRET;
if (!serviceId || !isBenchmarkServiceId(serviceId) || !secret) throw new Error("Invalid configuration");
const fixture = createConcurrentFixture(serviceId, secret);
const server = fixture.app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  process.send?.({ id: "ready", data: { port: address.port } });
});
process.on("message", (raw: unknown) => {
  const message = raw as { id: string; command: string; data: { path: string; users: Array<{ principalId: string; localUserId: string }> } };
  try {
    const data = message.command === "reset" ? fixture.reset(message.data.path, message.data.users)
      : message.command === "finish" ? fixture.finish() : null;
    process.send?.({ id: message.id, data });
  } catch (error) { process.send?.({ id: message.id, error: String(error) }); }
});
process.on("disconnect", () => { server.closeAllConnections(); server.close(); fixture.close(); });
