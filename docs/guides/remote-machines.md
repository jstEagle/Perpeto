# Join machines over a LAN or tailnet

A node on another machine joins with one command. There are two ways to reach the hub, and neither needs you to provision TLS by hand.

| Path | When | Who terminates TLS | What the node trusts |
| --- | --- | --- | --- |
| Tailscale (recommended) | The machines share a tailnet | `tailscale serve`, with a certificate browsers and nodes already trust | The system CAs |
| Built-in HTTPS | A LAN without Tailscale | The hub, with a self-signed certificate made on first start | Exactly that certificate's SHA-256 fingerprint |

The hub stays on loopback unless you choose one of these. Plain HTTP beyond loopback would send tokens in the clear, so the hub refuses to bind elsewhere without TLS (`INSECURE_BIND`) unless `allowInsecureRemote` is set in `hub.json`.

## Tailscale (recommended)

The hub keeps listening on loopback; Tailscale publishes it on your tailnet with a real certificate and only tailnet members can reach it. Tailscale must be logged in, with MagicDNS and HTTPS certificates enabled for the tailnet.

```sh
# Hub machine
perpeto hub init
perpeto hub start
perpeto hub expose --tailscale      # prints https://<machine>.<tailnet>.ts.net
perpeto hub enroll-code             # prints the join command

# Other machine (paste the printed command)
perpeto node join pj1_…
perpeto node start
```

`hub expose --tailscale` reads the machine's MagicDNS name from `tailscale status --json`, runs `tailscale serve --bg --https=443 http://127.0.0.1:<hub port>` and records the tailnet URL as the hub's `publicUrl`, which join codes then carry. Use `--https-port` for another port and `--off` to remove the mapping. On Linux, run `tailscale set --operator=$USER` once if Tailscale refuses the change. Tailscale's own error output is never printed, because it can contain auth keys.

## Built-in HTTPS on a LAN

```sh
# Hub machine
perpeto hub init --tls --host 0.0.0.0     # prints the certificate fingerprint
perpeto hub start
perpeto hub enroll-code --url https://192.168.1.20:4320

# Other machine (paste the printed command)
perpeto node join pj1_…
perpeto node start
```

The first start creates `hub/tls/cert.pem` and an owner-only `hub/tls/key.pem` (ECDSA P-256, valid 825 days). The join command carries the hub URL, the certificate's SHA-256 fingerprint and the one-time code. `node join` checks the certificate against the fingerprint during the TLS handshake, before anything is sent, so a machine impersonating the hub never sees the code. The node keeps the fingerprint as `hubFingerprint` and trusts nothing else; no CA is involved. Compare the fingerprint `hub init` printed with the one in the join command if the command crossed an untrusted channel.

Back up `hub/tls/` with the rest of `hub/`. Browsers will warn about the self-signed certificate; use the Tailscale path for the web app.

## The join command is a secret

It contains a one-time enrollment code that expires after ten minutes. Paste it only on the machine that should join, preferably over a channel you trust. A command that fails before reaching the hub (for example a fingerprint mismatch) leaves the code unused. `perpeto hub enroll-code` also writes the code to a private file for `node join <url> --code-file`.

## Rotating the hub certificate

Rotation takes two steps, so running nodes never lose the hub:

```sh
perpeto hub tls rotate      # creates the next certificate; heartbeats announce it to pinned nodes
perpeto hub tls status      # shows the served fingerprint and the next one
perpeto hub tls activate    # serves the next certificate, without a restart
```

Running nodes pin the next fingerprint from their heartbeats before it is served, and drop the old one after activation; they keep the list in `<node data>/hub-pins.json`. Wait at least one heartbeat interval (10 seconds by default) between rotate and activate. A node that was offline throughout still pins the old certificate. It stops with an error naming the presented fingerprint. Confirm that fingerprint with the hub owner (`perpeto hub tls status`), then:

```sh
perpeto node repin <fingerprint>    # or a fresh join command
perpeto node start
```

## Limits

- Pinning trusts one certificate per hub, not host names, so the same join command works through any address that reaches the hub.
- Remote project repositories (for example GitHub) are still cloned by the node with its own credentials; merge-queue candidates and local-project CI come from the hub.
- Rotation and re-pinning were tested on one machine over loopback, not across a real LAN or tailnet.
