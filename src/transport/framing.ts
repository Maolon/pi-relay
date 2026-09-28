import { parseJson } from '../protocol/json.js';
export { parseJson } from '../protocol/json.js';
import { LIMITS } from '../protocol/validate.js';
import { invariant, fail } from '../protocol/errors.js';
export class Framer {
  private bytes = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    const out: unknown[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      const lf = chunk.indexOf(10, offset),
        end = lf < 0 ? chunk.length : lf;
      invariant(this.bytes.length + end - offset <= LIMITS.frameBytes, 'backpressure');
      this.bytes = Buffer.concat([this.bytes, chunk.subarray(offset, end)]);
      if (lf < 0) break;
      invariant(this.bytes.length > 0);
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes);
      } catch {
        fail('invalid_payload');
      }
      out.push(parseJson(text));
      this.bytes = Buffer.alloc(0);
      offset = lf + 1;
    }
    return out;
  }
  finish(): void {
    invariant(this.bytes.length === 0);
  }
}
