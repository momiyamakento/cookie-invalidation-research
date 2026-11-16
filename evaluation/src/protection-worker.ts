import { createProtectionFixture } from "./protection-fixture.js";
import { isBenchmarkServiceId } from "@cookie-research/protocol";

const serviceId = process.argv[2];
const secret = process.env.PROTECTION_FIXTURE_SECRET;
if (!serviceId || !isBenchmarkServiceId(serviceId) || !secret) throw new Error("Missing fixture configuration");
const server = createProtectionFixture(serviceId, secret).listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing listener");
  process.send?.({ port: address.port });
});
process.on("disconnect", () => { server.closeAllConnections(); server.close(); });
