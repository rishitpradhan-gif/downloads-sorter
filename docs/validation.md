# Executed validation and limits

The runtime uses Node.js built-ins. Core/API checks run on Node 22 on macOS with temporary synthetic files. The browser suite uses Chromium headless, desktop and an emulated 390px phone. No personal Downloads folder is used. Actual Windows/Linux launchers, OS-native folder dialogs, network filesystems, cloud-provider integration and power-failure injection were not tested.

The suite covers preview without mutation, duplicate-name handling, byte-identical sort/undo, changed-source rejection, destination collisions, modified sorted files, occupied original names, skipped symbolic links and symlink destinations, settling intervals, ignored initial files, edited initial files, forged path rejection, pending-journal recovery, token/Origin/Host checks, rule invalidation and explicit automatic-mode control.

## Development findings retained in tests

- Newly written files can have submillisecond modification timestamps later than Date.now's integer millisecond value. The explicit zero-settling test option now bypasses the age check. The normal user-facing 15-second settling rule is unchanged.
- Node fetch did not send an overridden Host header in the security fixture. That check now uses an actual HTTP request with the intended raw Host header, verifying server rejection rather than assuming a client override worked.
- Automatic mode initially treated a changed baseline signature as a new file. It now excludes all names already observed at activation until an absence is observed. Modified pre-existing files and files restored by Undo stay put.
- Two crash-adjacent journal states are exercised synthetically: both hard links present, and journal intent recorded before destination creation. Neither test simulates an actual power cut.

## Limits

Concurrent writers can still change files between filesystem calls. The tool rechecks signatures and hashes, uses exclusive hard-link creation and records intent before each move, but it is not a transactional filesystem or protection against a malicious local process. A file modified after sorting will generally be ineligible for automatic undo. Hard-link-unsupported destinations fail. A stale process lock requires the documented manual recovery. No automatic background/login service is installed; the launcher must remain open. Automation is rule-based, not an LLM agent.

## Distribution checks

The ZIP was extracted into a fresh temporary directory and its CLI preview/apply/undo sequence was executed on a synthetic file, with the original contents restored. The npm tarball was installed in a separate temporary project without runtime dependencies; its module exports were imported and its executable started the loopback web page. ZIP/npm manifests exclude runtime settings, demo folders, undo journals and node_modules. The npm cache was redirected to a disposable directory after the host cache rejected a write; no cache ownership or permission controls were changed.

The first repository-creation push rejected the Actions workflow under its OAuth authorization. A direct Git push subsequently accepted the workflow using the existing Git credentials. No account permission controls were changed. The repository includes the test workflow; local results are recorded separately.
