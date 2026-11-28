# 2 GB host migration runbook (issue #250)

Status: the code parts of #250 are implemented and verified in this release.
The host-specific parts (archiving the live box, cutting DNS/units over) are
operator steps and are listed below in the order they must run.

**Non-goals kept:** live SQLite stays live SQLite. R2 remains backup storage, not
the engine. Nothing here touches D1/KV/R2/Vectorize contents.

---

## 1. What is now in the release

| Concern | Where | What it does |
| --- | --- | --- |
| Online backup | `prism backup` → `engine/backup.ts` | `VACUUM INTO` per database, then a manifest with byte size, SHA-256, schema version, per-table row counts and `PRAGMA quick_check`. |
| Restore | `prism restore <archive>` → `engine/backup.ts` | Re-verifies hash/size/integrity/counts, stages, then atomically renames. The previous file is **moved aside**, never deleted. |
| Restore drill | `prism restore <archive> --verify-only` | The pre-cutover check. Writes nothing. Exit 1 on any problem. |
| Copy-signal feed | `prism copy-feed` → `engine/copy-signal-feed.ts` | The producer the deleted `prism-copy-signals` service used to be. Bearer auth (constant-time), `/health` that reports *feed* health (empty/stale), `/signals` GET+POST. Refuses to start without `COPY_SIGNALS_TOKEN`. |
| Small-host caps | `systemd/prism-profile@.service`, `systemd/prismd-shadow.service` | `MemoryMax`, `MemoryHigh`, `CPUQuota`, `LimitNOFILE`, `TasksMax`, crash-loop limits per profile. |
| E2E proof | `bench/backup-restore.test.ts`, `bench/copy-signal-feed.test.ts` | Three-profile restore onto a simulated fresh host, tamper rejection, WAL displacement, and the feed's auth/health contract driving the engine's own parser. |
| Repeatable artifact | `bench/tmp-backup-drill.json` | Written by the E2E run: version, per-database schema version, row counts, hashes, integrity. |

### Why `VACUUM INTO` and not `sqlite3_serialize`

The live box holds ~5.4 GB of databases across three profiles. `serialize()`
loads the entire database into memory; on a 1.9 GiB host that is an OOM, not a
backup. `VACUUM INTO` streams a consistent copy inside one read transaction and
never stops the writer.

### Why the manifest carries row counts

A SHA-256 proves the bytes did not change. It does not prove the copy is
*complete* — a truncated-but-valid SQLite file hashes fine. Restore therefore
compares every table's count against the backup baseline and refuses a copy that
is short.

---

## 2. Archive the current host

Run on the box (read-only against the live engines):

```sh
# Discover the profile databases from the profile env files, archive all of them.
prism backup --out /root/prism-archive-$(date +%Y%m%d)

# Or be explicit per profile:
prism backup --db /root/.local/share/prism/prism-review-20260905.db --out /root/prism-archive-...
```

Profile files lie about which database a process holds. Before trusting the
archive, confirm each source path against `/proc/<pid>/fd`:

```sh
for pid in $(pgrep -f 'prism dev'); do
  echo "$pid: $(readlink -f /proc/$pid/fd/* 2>/dev/null | grep '\.db$' | sort -u)"
done
```

Ship the archive off the host (it holds no keys — only orders, positions, audit
rows, memory vectors):

```sh
tar -czf prism-archive.tgz -C /root prism-archive-<date>
scp prism-archive.tgz <new-host>:/root/
```

R2 stays a cold mirror at best; it is not part of the restore path.

---

## 3. Prove the archive before touching the new host

On the new host, with only the archive present:

```sh
prism restore ./prism-archive-<date> --verify-only
```

This is the acceptance gate. It must print, for every database:

- `integrity ok`
- no `short tables`
- `sqlite-vec available`

If `sqlite-vec` reports unavailable, fix the extension first
(`prism doctor` prints the platform remediation; on Debian/Ubuntu it is
`libsqlite3-0`, and release bundles ship `lib/vec0.so`).

---

## 4. Restore

```sh
# Into the recorded source paths, moving any existing file aside:
prism restore ./prism-archive-<date> --force

# Or into a fresh layout (recommended for a new host):
prism restore ./prism-archive-<date> --target-dir /root/.local/share/prism
```

The old file becomes `<path>.pre-restore-<epoch>` together with its `-wal`/`-shm`
pair, so a rollback is a rename back, not a re-restore.

---

## 5. Start the profiles under the caps

```sh
sudo cp systemd/prism-profile@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now prism-profile@prism-paper-bin20.service
journalctl -u prism-profile@prism-paper-bin20.service --since '5 min ago' | tail -40
```

Only after that profile shows one clean cycle:

```sh
sudo systemctl enable --now prism-profile@prism-paper-growth.service
```

Then measure (`docs/plan/box-prismd-deploy.md` §4):

```sh
systemd-cgtop --cpu=memory -n 1 -b | grep -i prism
```

Acceptance: each unit `active`, no panics, one cycle per `SCAN_INTERVAL_MS`,
RSS at or below the pre-migration value (107-125 MB per Bun profile).

### Copy signals

```sh
export COPY_SIGNALS_TOKEN=<long random>
prism copy-feed --port 8787 --host 127.0.0.1
```

Then on the engine profile: `COPY_SIGNALS_ENABLED=true`,
`COPY_SIGNALS_ENDPOINT=http://127.0.0.1:8787/signals`, `COPY_SIGNAL_WALLETS=...`.

Check it end-to-end — a 200 from `/health` is **not** proof the feed works:

```sh
curl -s -H "Authorization: Bearer $COPY_SIGNALS_TOKEN" http://127.0.0.1:8787/health
# {"ok":false,"signals":0,"ageMs":null,"reason":"feed is empty — no signals being produced"}
```

That is the honest answer for a feed nobody is writing to, and it is what the old
service could never tell you.

---

## 6. Rollback rehearsal (do this before you need it)

```sh
# 1. stop one profile
sudo systemctl stop prism-profile@prism-paper-bin20.service
# 2. put the previous database back
mv /root/.local/share/prism/prism-review-20260905.db.pre-restore-<epoch> \
   /root/.local/share/prism/prism-review-20260905.db
# 3. previous binary (TS tarball rollback, docs/plan/box-prismd-deploy.md §5)
# 4. start and confirm one cycle
sudo systemctl start prism-profile@prism-paper-bin20.service
```

Rehearse on one profile, never both (§6 soak guard in
`docs/plan/box-prismd-deploy.md`).

---

## 7. Acceptance checklist (from #250)

- [x] A supported backup command using SQLite's online copy API, with a manifest
      carrying paths, versions, table counts, integrity results and SHA-256 —
      `prism backup`.
- [x] A restore command that verifies the manifest, restores all profiles, loads
      `sqlite-vec`, and runs read-only integrity and row-count checks —
      `prism restore`, `--verify-only`.
- [x] Copy-signal source shipped in the release with a startup health check that
      fails when authentication is invalid — `prism copy-feed`, refuses to start
      without `COPY_SIGNALS_TOKEN`, `/health` distinguishes empty/stale/ok.
- [x] Small-host systemd preset with explicit memory, CPU, fd and restart limits
      — `systemd/`.
- [x] Documented archive and restore drill; R2 remains backup storage —
      this file, §2-§6.
- [x] A CI smoke test that restores a fixture and starts each profile without
      network writes — `bench/backup-restore.test.ts` (backup → verify-only →
      restore onto a fresh root → integrity/count/vector assertions →
      `bench/tmp-backup-drill.json`), `bench/copy-signal-feed.test.ts`.

Remaining operator-only items: the cable-level work in §2-§6 of this runbook.
