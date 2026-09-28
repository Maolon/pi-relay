import { assertJson } from './canonical.js';
import { invariant, fail } from './errors.js';
/** Duplicate member names are invalid; JSON.parse alone silently accepts them. */
export function parseJson(text: string): unknown {
  let i = 0,
    nodes = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(text[i] ?? 'x')) i++;
  };
  const str = (): string => {
    const start = i;
    invariant(text[i++] === '"');
    while (i < text.length) {
      const c = text[i++];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') {
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          fail('invalid_payload');
        }
      }
    }
    fail('invalid_payload');
  };
  const value = (depth: number): unknown => {
    invariant(depth <= 32 && ++nodes <= 8192);
    ws();
    const c = text[i];
    if (c === '"') return str();
    if (c === '{') {
      i++;
      const out: Record<string, unknown> = Object.create(null);
      ws();
      if (text[i] === '}') {
        i++;
        return out;
      }
      while (i < text.length) {
        ws();
        const key = str();
        invariant(!Object.hasOwn(out, key));
        ws();
        invariant(text[i++] === ':');
        out[key] = value(depth + 1);
        ws();
        const end = text[i++];
        if (end === '}') return out;
        invariant(end === ',');
      }
      fail('invalid_payload');
    }
    if (c === '[') {
      i++;
      const out: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return out;
      }
      while (i < text.length) {
        out.push(value(depth + 1));
        ws();
        const end = text[i++];
        if (end === ']') return out;
        invariant(end === ',');
      }
      fail('invalid_payload');
    }
    const start = i;
    while (i < text.length && !/[\x20\t\r\n,}\]]/.test(text[i])) i++;
    invariant(i > start);
    let primitive: unknown;
    try {
      primitive = JSON.parse(text.slice(start, i));
    } catch {
      fail('invalid_payload');
    }
    invariant(primitive === null || typeof primitive === 'number' || typeof primitive === 'boolean');
    return primitive;
  };
  const out = value(0);
  ws();
  invariant(i === text.length);
  assertJson(out);
  return out;
}
