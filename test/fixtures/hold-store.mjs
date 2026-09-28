import { fork } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../dist/store/database.js';
const dir = process.argv[2];
mkdirSync(dir, { recursive: true, mode: 0o700 });
const store = new Store(dir, 'target', 'holder', 'test');
store.setMeta('durable-marker', 'survives-kill');
process.stdout.write('READY\n');
setTimeout(() => process.stdout.write('MARKED\n'), 50);
setInterval(() => {}, 1000); // hold the flock until killed
