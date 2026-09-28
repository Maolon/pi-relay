import { createServer, type Server, type Socket } from 'node:net';
import { lstatSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Framer } from './framing.js';
import { canonical } from '../protocol/canonical.js';
import { LIMITS, validateWire } from '../protocol/validate.js';
import { safeError, fail } from '../protocol/errors.js';
import type { Request, Response } from '../protocol/types.js';
import { runtimeDir } from '../platform/private-paths.js';
import { transportEndpoint, secureEndpoint, removeEndpoint, isWindows } from '../platform/os-interop.js';
export type RequestHandler = (request: Request) => Promise<unknown> | unknown;
/** A fresh handler per socket owns authentication state. No shared producer role. */
export async function serve(
  factory: () => RequestHandler,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const dir = runtimeDir(),
    endpoint = transportEndpoint(process.platform, dir);
  const sockets = new Set<Socket>();
  let closing = false;
  const server: Server = createServer((socket) => {
    if (closing || sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const handle = factory(),
      framer = new Framer();
    let chain = Promise.resolve(),
      queued = 0;
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(10000, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      let frames: unknown[];
      try {
        frames = framer.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      if (queued + frames.length > 32) {
        socket.destroy();
        return;
      }
      for (const raw of frames) {
        queued++;
        chain = chain
          .then(async () => {
            if (closing || socket.destroyed) return;
            let requestId = 'invalid',
              response: Response;
            try {
              if (raw && typeof raw === 'object') {
                const r = raw as Record<string, unknown>;
                if (
                  typeof r.requestId === 'string' &&
                  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(r.requestId)
                )
                  requestId = r.requestId;
                if (r.protocol === 'pi-relay' && r.major !== 1) fail('unsupported_version');
              }
              const request = validateWire(raw);
              requestId = request.requestId;
              const result = await handle(request);
              response = {
                protocol: 'pi-relay',
                major: 1,
                minor: 1,
                requestId,
                ok: true,
                result: JSON.parse(canonical(result)),
              };
            } catch (error) {
              response = {
                protocol: 'pi-relay',
                major: 1,
                minor: 1,
                requestId,
                ok: false,
                error: safeError(error),
              };
            }
            const text = canonical(response) + '\n';
            if (
              Buffer.byteLength(text) > LIMITS.frameBytes ||
              socket.writableLength > LIMITS.frameBytes * 2
            ) {
              socket.destroy();
              return;
            }
            socket.write(text);
          })
          .catch(() => {
            socket.destroy();
          })
          .finally(() => {
            queued--;
          });
      }
    });
    socket.on('end', () => {
      try {
        framer.finish();
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const identity = secureEndpoint(endpoint);
  return {
    endpoint,
    close: async () => {
      if (closing) return;
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeEndpoint(endpoint, identity);
      try {
        rmdirSync(dir);
      } catch {}
    },
  };
}
