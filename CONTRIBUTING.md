# Contributing

## Branches

| Branch | Role |
| --- | --- |
| `dev` | integration branch; all work lands here first |
| `main` | release branch; every push runs the full test matrix and publishes to npm when `package.json` has a new version |
| `feat/*`, `fix/*`, `docs/*` | short-lived branches off `dev`, merged back by pull request |

## Release

1. On `dev`, bump the version: `npm version <patch|minor> --no-git-tag-version`,
   and commit `package.json` plus `package-lock.json`.
2. Open a pull request `dev` → `main` and merge it once CI is green.
3. The `Release` workflow tests again, publishes `@maolon/pi-relay` through npm
   trusted publishing (OIDC, no token; provenance attached) and creates the `vX.Y.Z` GitHub release. A push to `main` without
   a version bump runs the tests and publishes nothing.

## Checks

```sh
npm ci --ignore-scripts && npm rebuild fs-ext --foreground-scripts
npm run test:ci      # native gate, typecheck, build, import boundaries, full suite
npm run test:stress  # 60-second real-Pi progress stress
npm run pack:check && npm run test:package
```

Never commit credentials, relay state directories or session files. Tests
must use temporary directories and the loopback fake provider.
