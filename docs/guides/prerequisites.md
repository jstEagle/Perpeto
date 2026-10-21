# Prerequisites

- GitHub repository: configured at `jstEagle/Perpeto`; push access verified.
- Local development: Node 24 and pnpm available. The vendored runtime pins its own pnpm version.
- Harnesses: local Claude Code and Codex executables detected; sign-in and real execution are not yet verified. Other providers require their own setup before live validation.
- Local runtime: uses a dedicated `.perpeto/runtime` directory. Provider discovery may find existing installs; no provider sign-in or account modification is required for the initial build.
- Multi-machine validation: select a second execution host and a user-owned CI runner for later end-to-end checks. No host enrollment has been performed.
- Hosted relay, production authentication, app signing and release distribution: not configured. No paid services are required for the initial local foundation.

No secrets belong in these files. Non-secret runtime settings live in `config/perpeto.json`.
