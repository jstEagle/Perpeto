# Contributing

Perpeto is in early implementation. Read the [vision](docs/vision.md), [build brief](docs/brief.md), and [current status](docs/status.md) before changing direction.

Keep proposals, implemented behavior, and verified outcomes distinct. Include a real workflow or failure case when proposing a change. New factory code lives outside `vendor/t3code`; deliberate changes to the imported foundation must include provenance and verification updates.

Run `npm test` for Perpeto code. Changes involving the inherited runtime also need `npm run test:upstream` and `npm run build`. Use `npm run verify:upstream` to check the original source import; update the recorded hashes only when an upstream change is intentional and explained.

Use configuration files for all non-secret settings. Environment variables and secret stores are reserved for credentials and private values. Never commit runtime state, pairing links, secrets, or private project data.

Code is licensed under MIT. Preserve upstream and third-party attribution.
