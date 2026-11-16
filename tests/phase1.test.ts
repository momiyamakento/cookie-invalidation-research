import { describe, expect, it } from "vitest";

import { COMPONENTS } from "@cookie-research/protocol";

describe("Phase 1 component configuration", () => {
  it("uses the ports defined by the research design", () => {
    expect(COMPONENTS.managementServer.defaultPort).toBe(4100);
    expect(COMPONENTS.siteA.defaultPort).toBe(3101);
    expect(COMPONENTS.siteB.defaultPort).toBe(3102);
    expect(COMPONENTS.siteC.defaultPort).toBe(3103);
  });

  it("assigns a unique id and port to every component", () => {
    const components = Object.values(COMPONENTS);
    expect(new Set(components.map(({ id }) => id)).size).toBe(components.length);
    expect(new Set(components.map(({ defaultPort }) => defaultPort)).size).toBe(
      components.length,
    );
  });
});
