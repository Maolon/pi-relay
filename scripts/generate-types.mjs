import { compile, compileFromFile } from 'json-schema-to-typescript';
import { readFile, writeFile } from 'node:fs/promises';
const jobs = [
  {
    schema: 'src/protocol/schemas/contracts.json',
    path: 'src/protocol/types.ts',
    banner:
      '// Generated from schemas/contracts.json. Run npm run generate:types; do not edit.',
  },
  {
    // Managed delivery (wire 1.2) contract.
    // The root anyOf is a local generation aid (same convention as contracts.json);
    // the on-disk artifact stays untouched and only $defs are validated on the wire.
    schema: 'src/protocol/schemas/managed.json',
    path: 'src/protocol/managed-types.ts',
    banner:
      '// Generated from schemas/managed.json (managed delivery wire 1.2, approved delta-1). Run npm run generate:types; do not edit.',
    union: 'ManagedContract',
  },
  {
    // Managed internal transport (relay-internal ops + ManagedRoutePacket). Not part
    // of the public managed.json contract; namespaced 'internal.' ops only.
    schema: 'src/protocol/schemas/managed-internal.json',
    path: 'src/protocol/internal-types.ts',
    banner:
      '// Generated from schemas/managed-internal.json (relay-internal managed transport). Run npm run generate:types; do not edit.',
    union: 'ManagedInternalContract',
  },
];
for (const job of jobs) {
  const options = {
    bannerComment: job.banner,
    additionalProperties: false,
    ignoreMinAndMaxItems: true,
    style: { singleQuote: true, semi: true, printWidth: 110 },
  };
  let source;
  if (job.union) {
    const parsed = JSON.parse(await readFile(job.schema, 'utf8'));
    const wrapped = {
      ...parsed,
      anyOf: Object.keys(parsed.$defs).map((name) => ({ $ref: `#/$defs/${name}` })),
    };
    delete wrapped.description;
    wrapped.title = job.union; // union type name for generation; $id untouched for ref resolution
    source = await compile(wrapped, job.union, options);
  } else source = await compileFromFile(job.schema, options);
  if (process.argv.includes('--check')) {
    if ((await readFile(job.path, 'utf8')) !== source) throw new Error(`Generated types have drifted: ${job.path}`);
  } else await writeFile(job.path, source);
}
