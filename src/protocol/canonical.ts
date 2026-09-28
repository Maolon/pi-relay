import canonicalize from 'canonicalize';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { invariant } from './errors.js';
/** JCS accepts IEEE754 finite numbers; this contract additionally rejects unsafe integers. */
export function assertJson(value: unknown, maxDepth = 32, maxNodes = 8192): void {
  let nodes = 0;
  const stack = new Set<object>();
  const string = (v: string) => {
    for (let i = 0; i < v.length; i++) {
      const n = v.charCodeAt(i);
      if (n >= 0xd800 && n <= 0xdbff) {
        const m = v.charCodeAt(++i);
        invariant(m >= 0xdc00 && m <= 0xdfff);
      } else invariant(n < 0xdc00 || n > 0xdfff);
    }
  };
  const visit = (v: unknown, depth: number): void => {
    invariant(++nodes <= maxNodes && depth <= maxDepth);
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      string(v);
      return;
    }
    if (typeof v === 'number') {
      invariant(Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)));
      return;
    }
    invariant(typeof v === 'object' && v !== null && !stack.has(v));
    invariant(
      Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null,
    );
    stack.add(v);
    if (Array.isArray(v)) for (const item of v) visit(item, depth + 1);
    else
      for (const [key, item] of Object.entries(v)) {
        string(key);
        invariant(!['__proto__', 'prototype', 'constructor'].includes(key));
        visit(item, depth + 1);
      }
    stack.delete(v);
  };
  visit(value, 0);
}
export function canonical(value: unknown): string {
  assertJson(value);
  const result = (canonicalize as unknown as (v: unknown) => string | undefined)(value);
  invariant(result !== undefined);
  return result;
}
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
export function digest(value: unknown): string {
  return sha256(canonical(value));
}
export function newId(prefix = 'id'): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}
export function secret(): string {
  return randomBytes(32).toString('hex');
}
export function equalSecret(a: string, b: string): boolean {
  const aa = Buffer.from(sha256(a)),
    bb = Buffer.from(sha256(b));
  return timingSafeEqual(aa, bb);
}
export function authenticate(token: string, expectedDigest: string): boolean {
  return equalSecret(sha256(token), expectedDigest);
}
export function proof(domain: string, value: unknown, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(domain + '\0')
    .update(canonical(value))
    .digest('hex');
}
export function withoutProof<T extends { proof: string }>(value: T): Omit<T, 'proof'> {
  const { proof: _, ...rest } = value;
  return rest;
}
