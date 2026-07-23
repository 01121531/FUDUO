# Fuduo SDK contract fixtures

This directory contains response envelopes used by automated contract tests.

## Evidence levels

- `synthetic-redacted`: built from the documented/static client contract. It proves the
  current SDK parser behavior, but it is not evidence that the live API still returns
  this exact shape.
- `observed-redacted`: captured from an authorized live request, then reviewed and
  redacted before commit.

Every fixture is registered in `manifest.json`. The initial fixtures are all synthetic
because no authorized, redacted live responses are present in this workspace.

## Redaction rules

- Remove `Authorization`, `Cookie`, and `Set-Cookie` headers entirely.
- Replace access tokens, cookies, session snapshots, order IDs, refund IDs, account IDs,
  shop IDs, names, phone numbers, and trace IDs with non-production fixture values.
- Keep field names, nullability, value types, nesting, and pagination metadata unchanged.
- Never commit a raw capture. Write the reviewed output directly into `fixtures/`.
- Run `pnpm --filter @fuduo/fuduo-sdk test` before changing a fixture or Schema.

An observed fixture must set `provenance` to `observed-redacted`,
`realResponseVerified` to `true`, and provide both `capturedAt` and
`observedClientVersion`.
