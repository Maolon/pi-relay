# Platform qualification

Qualified targets are macOS arm64 (Node 26.5.0) and Linux x64 (Node 22.16.0) on a local filesystem, with Pi 0.85.1 and Pi 1.0.0. Neither dependency installation nor the native gate alone certifies the complete application.

The real native gate passed on macOS arm64 / Node 26.5.0 and Linux x64 / Node 22.16.0. It exercises actual better-sqlite3 13.0.3 and fs-ext 2.1.1: exclusive locks, same-process duplicate ownership, contention while an owner is stopped, release after killing only a test-owned child, a fixed lock inode, SQLite WAL/FULL/foreign keys, rollback, busy refusal, reopen and disk-full refusal. The JSON report records precise runtime and dependency versions. It is not a physical power-loss durability test or a complete Pi lifecycle test.

Dependency review: better-sqlite3 13.0.3 is MIT, requires Node >=22, ships platform native modules and declares no install lifecycle script. fs-ext 2.1.1 is MIT and runs node-gyp configure build; its JS wrapper maps exnb to OS exclusive/nonblocking flock. Install the locked dependency graph with --ignore-scripts, then explicitly rebuild fs-ext. No global Node/Pi configuration is modified.

Sources: https://github.com/WiseLibs/better-sqlite3/tree/v13.0.3 and https://github.com/baudehlo/node-fs-ext.

CI runs native checks, type validation, automated real-Pi and process-fault tests, a 60-second stress run, package checks and a clean standalone consumer installation on both platforms.

Windows is not CI-qualified: a platform seam (`src/platform/os-interop.ts`) implements named pipes and an O_EXCL lock protocol and is unit-tested on every host, but the package is not published for Windows. Network filesystems, cross-host locks and heartbeat takeover are unsupported. No JS lockfile or alternate SQLite fallback is permitted.
