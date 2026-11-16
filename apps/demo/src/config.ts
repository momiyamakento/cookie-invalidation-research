export interface DemoSite {
  id: string; name: string; baseUrl: string; username: string; password: string;
  sessionCookie: string; decoyCookie: string; localUserId: string;
}
export interface DemoConfig { port: number; attackerPort: number; managementBaseUrl: string; managementAuthTokens: Record<string, string>; sites: DemoSite[]; }
function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error("Invalid demo or site port.");
  return Number(value);
}
export function loadDemoConfig(env: NodeJS.ProcessEnv = process.env): DemoConfig {
  const management = new URL(env.MANAGEMENT_BASE_URL ?? "http://localhost:4100");
  if (!["http:", "https:"].includes(management.protocol) || management.username || management.password) throw new Error("Invalid MANAGEMENT_BASE_URL.");
  return {
    port: port(env.DEMO_PORT, 4200), attackerPort: port(env.DEMO_ATTACKER_PORT, 4201), managementBaseUrl: management.href.replace(/\/$/u, ""),
    managementAuthTokens: Object.fromEntries(["A", "B", "C", "D"].map((letter) => [
      `site-${letter.toLowerCase()}`,
      env[`SITE_${letter}_TO_MANAGER_TOKEN`] ?? "",
    ])),
    sites: [
      ["A", "alice-a", "user-a-001", 3101], ["B", "alice-b", "user-b-018", 3102],
      ["C", "alice-c", "user-c-105", 3103], ["D", "diana-d", "member-d-501", 3104],
    ].map(([letter, username, localUserId, defaultPort]) => {
      const key = String(letter); const lower = key.toLowerCase();
      return { id: `site-${lower}`, name: `Site ${key}`, username: String(username), localUserId: String(localUserId),
        baseUrl: `http://localhost:${port(env[`SITE_${key}_PORT`], Number(defaultPort))}`,
        password: env[`SITE_${key}_SEED_PASSWORD`] ?? "", sessionCookie: `sid_site_${lower}`, decoyCookie: `decoy_site_${lower}` };
    }),
  };
}
