---
name: debugging-rika-crashes
description: Diagnoses Rika client or resident crashes from its local Effect JSON logs. Use when Rika exits unexpectedly, hangs, fails to start, or loses its resident connection.
---

# Debugging Rika crashes

Use Rika's supported diagnostics commands before reading databases or internal implementation files.

## Workflow

1. Run `rika diagnostics status` and record the reported directory and file count.
2. Run `rika diagnostics path` when another tool needs the raw location.
3. Sort `client-*.jsonl` and `resident-*.jsonl` by modification time. Start with the newest file for each role.
4. Parse each line as JSON. Find `process.started`, `process.failed`, and `process.stopped` entries.
5. Correlate entries by `rika.process.instance`, then by safe request, thread, turn, or execution annotations when present.
6. Check the resident log before blaming the client when connection or execution work failed.
7. Export a reviewable copy with `rika diagnostics export <new-directory>`.
8. Reproduce once with the same command. Set `logging.level` to `debug` in Rika settings only when info-level records are insufficient.

## Safety

- Treat the diagnostics directory and every export as sensitive local data.
- Do not paste full logs into an issue or prompt without reviewing them.
- Do not infer that a missing `process.stopped` record proves one cause; SIGKILL, power loss, and runtime failure can prevent the final buffered write.
- Do not edit logs in place. Export them first when annotations or ordering need analysis.
- Do not delete the resident token, SQLite files, or logs during diagnosis.

## Evidence to report

Report the command, process role, log filename, timestamps, stable event names, safe IDs, and the smallest relevant JSON records. State whether failure was reproduced and whether the resident remained alive.
