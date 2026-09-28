import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { TargetCore } from '../target/core.js';
/** File-entry means a complete matching entry was read, not fsync/power-loss durability. */
export async function observeFile(
  core: TargetCore,
  file: string | undefined,
  stillCurrent: () => boolean,
): Promise<void> {
  if (!file) return;
  const stream = createReadStream(file, { highWaterMark: 65536 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of lines) {
      if (!stillCurrent()) break;
      bytes += Buffer.byteLength(line);
      if (bytes > 67108864 || Buffer.byteLength(line) > 1048576) break;
      try {
        core.observe(JSON.parse(line), 'file-entry');
      } catch {
        /* unrelated/corrupt entry is not delivery evidence */
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  } finally {
    lines.close();
    stream.destroy();
  }
}
