# Perpeto CLI

Dependency-free Node 24 command line for local hub/node lifecycle, machine enrollment, hub overview, diagnostics and user services. See [the install guide](../../docs/install.md) for the single-machine and second-machine paths.

```sh
source ~/.nvm/nvm.sh && nvm use 24
node packages/perpeto-cli/bin/perpeto.js --help
node --test packages/perpeto-cli/test/*.test.js
```

The package imports factory-hub/node directly from the checkout. It does not require workspace linking or change their adapters. The installer links this bin into a user bin directory. Runtime setup/build remain owned by `scripts/runtime.mjs`.

`hub/node start` detach one process with private Unix-socket control and a process lock under `--dir` (default `~/.perpeto`). User services run the same implementation in the foreground with `hub/node run`. `service install --dry-run` renders templates without creating or loading service files; service tests use stubbed managers only. No inference, account copying, public network setup or service-manager deployment is claimed by package tests.
