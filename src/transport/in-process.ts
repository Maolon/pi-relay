import type { ConnectRequest, Request, Response } from '../protocol/types.js';
import { validate, LIMITS } from '../protocol/validate.js';
import { canonical } from '../protocol/canonical.js';
import { RelayError, safeError, invariant } from '../protocol/errors.js';
import type { RequestHandler } from './server.js';
export interface EventBus {
  on(event: string, listener: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}
export interface BusEnvelope {
  authentication: ConnectRequest;
  request: Request;
}
/** Each call has independent authentication state; one plugin cannot inherit another's connect. */
export function installBusEndpoint(
  bus: EventBus,
  channel: string,
  factory: () => RequestHandler,
): () => void {
  let active = true,
    inflight = 0;
  const off = bus.on(channel, (data) => {
    void (async () => {
      let id = 'invalid';
      let response: Response;
      let counted = false;
      try {
        invariant(active, 'attachment_stale');
        invariant(inflight < 32, 'backpressure');
        inflight++;
        counted = true;
        invariant(Buffer.byteLength(canonical(data)) <= LIMITS.frameBytes);
        const envelope = data as BusEnvelope;
        invariant(envelope && Object.keys(envelope).sort().join(',') === 'authentication,request');
        const authentication = validate('Request', envelope.authentication),
          request = validate('Request', envelope.request);
        id = request.requestId;
        invariant(authentication.op === 'connect', 'unauthorized');
        const handler = factory();
        const hello = await handler(authentication);
        invariant(active, 'attachment_stale');
        const result = request.op === 'connect' ? hello : await handler(request);
        response = {
          protocol: 'pi-relay',
          major: 1,
          minor: 1,
          requestId: id,
          ok: true,
          result: JSON.parse(canonical(result)),
        };
      } catch (e) {
        response = {
          protocol: 'pi-relay',
          major: 1,
          minor: 1,
          requestId: id,
          ok: false,
          error: safeError(e),
        };
      } finally {
        if (counted) inflight--;
      }
      if (active) bus.emit(channel + ':response', response);
    })();
  });
  return () => {
    active = false;
    off();
  };
}
/** Timeout means unknown admission, not success merely because emit found a listener. */
export function requestOnBus(
  bus: EventBus,
  channel: string,
  envelope: BusEnvelope,
  timeoutMs = 3000,
): Promise<Response> {
  validate('Request', envelope.authentication);
  validate('Request', envelope.request);
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const off = bus.on(channel + ':response', (data) => {
      try {
        const response = validate('Response', data);
        if (response.requestId === envelope.request.requestId) {
          clearTimeout(timer);
          off();
          resolve(response);
        }
      } catch {}
    });
    timer = setTimeout(() => {
      off();
      reject(new RelayError('admission_unknown'));
    }, timeoutMs);
    try {
      bus.emit(channel, envelope);
    } catch (e) {
      clearTimeout(timer);
      off();
      reject(e);
    }
  });
}
