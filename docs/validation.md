# Validation and compatibility

The supported host for this first standalone distribution is DeepSeek Harness **0.2.1-rc.2**. The manifest pins that version; compatibility with other preview versions has not been established.

Run `npm ci --ignore-scripts` and `npm test` to execute the selected regression suites. They cover task and session projections, check input binding, observations and their limitations, scope/freshness, native check execution coordination, and retained failure states. Existing tests were copied with package namespace changes, without replacing their behavioral assertions with packaging-only checks.

An installed-host smoke fixture is provided at `scripts/runtime-smoke.cjs`. Run it through the installed desktop's Electron Node runtime:

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'C:\path\to\DeepSeek Harness.exe' --expose-internals scripts/runtime-smoke.cjs
```

The fixture creates an isolated temporary profile and sessions; it does not modify the user's active profile. It overrides requests with fixed responses and rejects any provider dispatch. It checks actual bundle mounting, the companion skill's discovery and loading, native file/check execution, the Flow Next tool catalog, native-to-PTC selection, and scoping away from a neighboring preset. It is a mechanism check, not a model quality experiment. On non-Windows platforms, unit tests are portable but this desktop smoke fixture has not been exercised.

The original research project contained older model trials. Those records remain private and are not evidence that this standalone build improves performance. This distribution does not claim universal task success, speed, token savings, or learning improvements.

Native Windows sandbox setup can reject workspaces whose ACLs it cannot update. The smoke fixture uses an owned temporary directory and reads again inside PTC before writing, because sandbox setup can change filesystem metadata. It retains native permission enforcement; passing here does not establish PTC availability on every drive or workspace.

After installing or updating in a real profile, use a new conversation and `/flow-next status` to verify which version is actually mounted. File writes alone do not establish hot reload in an existing session.
