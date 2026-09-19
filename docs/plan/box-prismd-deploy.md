# Box prismd deploy (217.216.35.77) — artifacts only, no box mutation from here

Status: prepare-only. SSH from this workstation to `217.216.35.77` as `root`
now works (confirmed 2026-09-18). Nothing here restarts units, touches live
DBs, or mutates the box unless a step explicitly says "ON the box".

**BLOCKER (2026-09-18, confirmed): `scripts/build-bundle.ts` /
`scripts/compile-binary.ts` binaries currently CRASH ON STARTUP.**
`bun build --compile` on this repo's CLI/engine bundle hits an open upstream
Bun bug (circular module-initializer ordering, `oven-sh/bun#42664`) via
`@coral-xyz/anchor`'s bundled ESM output: the compiled binary throws
`ReferenceError: exports_esm is not defined` before doing anything, on both
linux-x64 (verified by running the artifact on this box, in `/tmp`, not
`/opt/prism`) and darwin-arm64 (reproduced locally). The equivalent
`dist/cli/index.mjs` bundle run un-compiled (`bun dist/cli/index.mjs`) does
**not** crash — this is specific to the `--compile` step, not the tsdown
bundle. `scripts/compile-binary.ts` now smoke-tests every build it produces
(fails loud instead of shipping a broken artifact) when run on a matching
host, but as of this wave there is no known fix — only detection. **Do not
run the binary-drop sequence below (§3) until this is resolved**; the
existing box units keep running the plain Bun `dist/index.mjs` path
(`prism-agent`, `prism-paper-bin20`, `prism-paper-growth` — all healthy,
un-compiled Bun, unaffected by this bug) and that is correctly what they
should keep doing for now.

Process model (from `docs/plan/2026-09-18-rust-bend-hybrid.md`): **one binary,
many profiles**. Same `prismd` artifact serves both paper profiles; only the
env dir + systemd unit differ. Never merge the two profiles into one process
(A/B control for Jev/evolution is valuable).

## 1. Shared-binary layout

```text
/opt/prism/
  prismd                      # current binary (single artifact, both profiles)
/opt/prism/releases/
  prismd-<version>            # versioned drops, e.g. prismd-0.2.39
  prismd-previous             # symlink or copy of last-good binary (rollback)
~/.config/prism-paper-bin20/
  .env                        # profile env (runner lane; see profiles/paper-runner.env)
~/.config/prism-paper-growth/
  .env                        # profile env (baseline; see profiles/paper-aggressive.env)
~/.local/share/prism/         # live SQLite profiles — NEVER delete
```

Profile sources of truth (local repo):

- `profiles/paper-runner.env` — runner lane only (`MARKET_SCAN_RUNNER_ENABLED=true`,
  rotation OFF, `REALIZED_PNL_HALT` + pool-PnL kill switch + fee-density on).
- `profiles/paper-aggressive.env` — low-risk baseline, all scan lanes OFF.

Sync a profile env to the box (run ON the box, after copying the file over):

```sh
cp paper-runner.env ~/.config/prism-paper-bin20/.env
cp paper-aggressive.env ~/.config/prism-paper-growth/.env
```

Release source note (`cli/update.ts`, `scripts/build-bundle.ts`): today
`prism update` is R2-first (`--r2-url` defaults to `R2_PUBLIC_URL`,
`source: "r2" | "github"` in `downloadAndVerify`). Direction per hybrid plan
Phase 4 is **GitHub Releases + SHA-256 only** (R2 stays cold backup until the
explicit data-delete follow-up). `scripts/build-bundle.ts` names the tarball
`prism-v<version>-<platform>-<arch>.tar.gz` + `.sha256`. For box drops below,
prefer the GitHub tarball hash, not R2.

## 2. systemd unit template (2 profiles, one binary)

One unit per profile, same `ExecStart`, different `EnvironmentFile`.
`Restart=always` so the scan loop survives crashes; profile isolation comes
from the env file, not the binary.

```ini
# ~/.config/systemd/user/prism-paper-bin20.service
[Unit]
Description=prismd paper-bin20 (runner lane)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/prism/prismd
EnvironmentFile=%h/.config/prism-paper-bin20/.env
Restart=always
RestartSec=10
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

```ini
# ~/.config/systemd/user/prism-paper-growth.service
[Unit]
Description=prismd paper-growth (baseline)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/prism/prismd
EnvironmentFile=%h/.config/prism-paper-growth/.env
Restart=always
RestartSec=10
NoNewPrivileges=true

[Install]
WantedBy=default.target
```

Enable once (ON the box):

```sh
systemctl --user daemon-reload
systemctl --user enable --now prism-paper-bin20.service
systemctl --user enable --now prism-paper-growth.service
systemctl --user status prism-paper-bin20.service prism-paper-growth.service
```

Adjust `systemctl --user` to system units (`/etc/systemd/system/`,
`sudo systemctl ...`) only if the box already runs them as system units —
match what exists, do not migrate unit scope as part of a binary drop.

## 3. Binary-drop sequence (one profile at a time, keep A/B)

Preferred source: the `prismd-<version>-linux-x64` GitHub Release asset (built by
`release.yml` `build-bundles` on linux-x64 alongside the TS tarballs, SHA-256
checksummed, `gh release upload` — R2 `releases/v<version>/` is a cold mirror).
This matches the `prism update` client, which is GitHub-first with R2 fallback. Fallback, pre-release: the `prismd-linux-x64`
CI artifact from the latest green `prismd-binary` run (Actions → CI), or build
from source ON the box (`cargo build --release --manifest-path
native/rust/Cargo.toml`). All three are the same fail-open shadow binary with
no Bun involved, so the `bun#42664` blocker below does NOT apply to this path.

Copy to the box (run where your key works; from this host SSH currently
fails — run ON the box or provide key):

```sh
scp prismd-<version>-linux-x64 prismd-<version>-linux-x64.sha256 <user>@217.216.35.77:/tmp/
```

```sh
cd /tmp
# Release asset path:
sha256sum -c prismd-<version>-linux-x64.sha256
mkdir -p /opt/prism/releases
cp /opt/prism/prismd /opt/prism/releases/prismd-previous
cp prismd-<version>-linux-x64 /opt/prism/releases/prismd-<version>
cp /opt/prism/releases/prismd-<version> /opt/prism/prismd
chmod +x /opt/prism/prismd
/opt/prism/prismd --help
# legacy TS tarball path (blocked by bun#42664 — do NOT use until resolved):
# sha256sum -c prism-v<version>-linux-x64.tar.gz.sha256
# tar -xzf prism-v<version>-linux-x64.tar.gz -C /opt/prism/releases/
```

Restart **bin20 only**, confirm healthy, then growth:

```sh
systemctl --user restart prism-paper-bin20.service
sleep 90
systemctl --user is-active prism-paper-bin20.service
journalctl --user -u prism-paper-bin20.service --since "5 min ago" --no-pager | tail -30
# only when bin20 shows a full cold cycle clean:
systemctl --user restart prism-paper-growth.service
sleep 90
systemctl --user is-active prism-paper-growth.service
journalctl --user -u prism-paper-growth.service --since "5 min ago" --no-pager | tail -30
```

## 4. CPU / RSS measure

Baseline today: ~3 Bun processes, ~32% CPU, ~310 MB combined. After each drop,
compare like-for-like (same two profiles, settled scan loop, not mid-cycle):

```sh
systemd-cgtop --cpu=memory -n 1 -b | grep -i prism
ps -o pid,rss,pcpu,etime,args -C prismd
ps -o pid,rss,pcpu,etime,args -C bun | grep -i prism
```

Cold-cycle log check (one full `SCAN_INTERVAL_MS=60000` cycle per profile):

```sh
journalctl --user -u prism-paper-bin20.service --since "10 min ago" --no-pager | grep -Ei "cycle|scan|error|halt|panic" | tail -20
journalctl --user -u prism-paper-growth.service --since "10 min ago" --no-pager | grep -Ei "cycle|scan|error|halt|panic" | tail -20
```

Healthy = unit `active`, no panics/errors, one scan cycle completes per
profile, RSS/CPU at or below pre-drop values.

## 5. Rollback (previous binary path + restart)

Same one-at-a-time rule in reverse:

```sh
cp /opt/prism/releases/prismd-previous /opt/prism/prismd
chmod +x /opt/prism/prismd
systemctl --user restart prism-paper-bin20.service
sleep 90
systemctl --user is-active prism-paper-bin20.service
# only when bin20 is green:
systemctl --user restart prism-paper-growth.service
systemctl --user is-active prism-paper-growth.service
```

If the previous binary is missing, reinstall from the last GitHub Release
tarball + `.sha256` (`sha256sum -c` first), never from an unverified copy.

## 6. Soak guard (binding)

- NEVER restart both profiles at once — always bin20 → verify → growth.
- NEVER restart either profile during the 7d expectancy soak without an
  explicit go. A binary drop resets soak evidence; unapproved restarts during
  soak invalidate the expectancy comparison (verify vs growth control).
- NEVER delete live DBs/configs (`~/.local/share/prism/`, profile `.env`
  dirs) or Cloudflare data resources (D1/KV/R2/Vectorize) as part of a deploy.
