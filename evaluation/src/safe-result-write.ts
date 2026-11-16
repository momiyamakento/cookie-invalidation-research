import { randomUUID } from "node:crypto";
import { open, rename, copyFile, unlink } from "node:fs/promises";

const transient = (error: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "");
export interface ReplaceOperations {
  rename: typeof rename; copyFile: typeof copyFile; unlink: typeof unlink;
  pause: (ms: number) => Promise<void>;
}
const operations: ReplaceOperations = { rename, copyFile, unlink, pause: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Retry filesystem operations only: never repeat a measured trial. */
export async function replaceResultFile(temporary: string, target: string, ops = operations) {
  for (let attempt = 0; ; attempt++) {
    try { await ops.rename(temporary, target); return; }
    catch (error) {
      if (!transient(error)) throw error;
      if (attempt === 5) break;
      await ops.pause(50 * (attempt + 1));
    }
  }
  // Windows may deny replacement-by-rename while allowing overwriting contents.
  // Keep the synced temporary file if copying fails; never delete the destination.
  for (let attempt = 0; ; attempt++) {
    try { await ops.copyFile(temporary, target); break; }
    catch (error) {
      if (!transient(error) || attempt === 5) throw error;
      await ops.pause(50 * (attempt + 1));
    }
  }
  try { await ops.unlink(temporary); } catch { /* Harmless completed temporary copy. */ }
}

export async function safeWriteResult(path: string, contents: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  await replaceResultFile(temporary, path);
}
