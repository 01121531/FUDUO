# PDD SDK contract fixtures

The PDD SDK currently provides an allowlisted transport and session validation only.
No concrete PDD business endpoint or response Schema has been approved in the project,
so the fixture in this directory covers only the exported generic
`request({ schema })` parser.

The fixture is completely synthetic and uses explicit redaction placeholders. It is
not evidence of any live PDD endpoint or response shape. `manifest.json` records the
remaining evidence gaps; do not promote this fixture to `observed-redacted`.

When a PDD endpoint is introduced:

1. Capture an authorized response through the configured cloud/proxy route.
2. Remove all Cookie, Set-Cookie, token, user, shop, order, and device identifiers.
3. Add an endpoint-specific Zod Schema and an `observed-redacted` fixture.
4. Record client version, capture time, and proxy-binding result in the manifest.
5. Add a contract test that parses the complete response envelope.
