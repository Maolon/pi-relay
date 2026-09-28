import { createConnection, type Socket } from 'node:net';
import type { ConnectRequest, ConnectResult, Request, Response } from '../protocol/types.js';
import { newId, canonical } from '../protocol/canonical.js';
import { LIMITS, validate, validateWire } from '../protocol/validate.js';
import { RelayError, invariant, type ErrorCode } from '../protocol/errors.js';
import { Framer } from './framing.js';
export type RequestBody = Request extends infer R
  ? R extends Request
    ? Omit<R, 'protocol' | 'major' | 'minor' | 'requestId'>
    : never
  : never;
export class RpcClient {
  private socket?: Socket;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  constructor(
    readonly endpoint: string,
    readonly timeoutMs = 3000,
  ) {}
  async open(
    connect: Omit<ConnectRequest, 'protocol' | 'major' | 'minor' | 'requestId' | 'op'>,
  ): Promise<ConnectResult> {
    invariant(!this.closed && !this.socket, 'invalid_state');
    this.socket = createConnection(this.endpoint);
    this.socket.on('error', () => this.failAll());
    this.socket.on('close', () => this.failAll());
    const framer = new Framer();
    this.socket.on('data', (chunk: Buffer) => {
      try {
        for (const raw of framer.push(chunk)) {
          const response = validate('Response', raw);
          const waiter = this.pending.get(response.requestId);
          if (!waiter) continue;
          this.pending.delete(response.requestId);
          clearTimeout(waiter.timer);
          if (response.ok) waiter.resolve(response.result);
          else
            waiter.reject(
              new RelayError((response.error?.code ?? 'transport_unavailable') as ErrorCode, {
                retryAfterMs: response.error?.retryAfterMs,
                currentRevision: response.error?.currentRevision,
              }),
            );
        }
      } catch {
        this.socket?.destroy();
        this.failAll();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const socket = this.socket!;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RelayError('transport_unavailable'));
      }, this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', () => {
        clearTimeout(timer);
        reject(new RelayError('transport_unavailable'));
      });
    });
    return validate('ConnectResult', await this.call({ op: 'connect', ...connect }));
  }
  async call(body: RequestBody, minor: 1 | 2 = 1): Promise<unknown> {
    invariant(!this.closed && this.socket && !this.socket.destroyed, 'transport_unavailable');
    invariant(this.pending.size < 32, 'backpressure');
    const request = {
      protocol: 'pi-relay' as const,
      major: 1 as const,
      minor,
      requestId: newId('req'),
      ...body,
    } as Request;
    if (minor === 1) validate('Request', request);
    else validateWire(request);
    const text = canonical(request) + '\n';
    invariant(Buffer.byteLength(text) <= LIMITS.frameBytes);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new RelayError('admission_unknown'));
        this.dispose();
      }, this.timeoutMs);
      this.pending.set(request.requestId, { resolve, reject, timer });
      this.socket!.write(text);
    });
  }
  private failAll(): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RelayError('transport_unavailable'));
    }
    this.pending.clear();
  }
  dispose(): void {
    this.closed = true;
    this.socket?.destroy();
    this.failAll();
  }
}
