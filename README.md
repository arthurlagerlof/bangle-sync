# BangleSync

A reusable CLI foundation for backing up and synchronising Bangle.js watches. It includes hardware-free simulated device operations, binary logical-Storage backups, independent manifest verification, guarded explicit deployment planning, and hardware-independent transfer and REPL-framing simulators. These simulators validate host-side protocol behavior only; they do not provide device connectivity or qualify REPL/transport reliability. The unexecuted Espruino prototype in `fixtures/` is tested only against a mock and is not ready to upload or use for hardware testing. Installed firmware `2v27.62` has not been tied to an exact upstream commit, reproducible build, or firmware image.

## Requirements

Node.js 20 or newer. EspruinoTools is an optional peer and is not installed with the core CLI, so ordinary workspace, profile, backup-manifest, and simulated commands do not install Bluetooth/native build dependencies. Physical commands require a separately installed EspruinoTools JavaScript CLI and `transport.espruinoPath` configuration. EspruinoTools `0.1.67` has legacy transitive advisories in its optional BLE backends; those apply when that separate hardware tool is installed. Hardware support has only been exercised on the documented Windows/watch setup. See [Technical decisions](docs/TECHNICAL-DECISIONS.md) for test scope and dependency limitations.

## Installable CLI and workspaces

The package exposes the single `bangle-sync` command. To build and install locally without publishing:

```powershell
npm test
npm pack
npm install --global .\bangle-sync-0.2.0.tgz
bangle-sync --help
bangle-sync --version
```

Run `bangle-sync init` in a new project directory to create its independent `bangle-sync.json`. Commands invoked from a nested directory discover the nearest parent configuration; `workspace status`, `workspace diff`, and `app create` use that workspace. Use `--path <workspace>` to select another explicitly. App files are created under `BangleCustom/projects` and existing app directories are never overwritten. The starter configuration defaults `backup.directory` to `BangleSync-Device-Backups` under the current user's home directory. Existing workspace values remain authoritative; change one with `bangle-sync config set backup.directory 'D:\BangleBackups'`. Backups use unique timestamp folders and independent verification; destinations inside the workspace are refused.

Hardware-free workflow:

```powershell
node .\bin\bangle-sync.js backup --simulate
node .\bin\bangle-sync.js verify --path 'D:\BangleBackups\<timestamp>'
node .\bin\bangle-sync.js status --simulate
node .\bin\bangle-sync.js diff --simulate --backup 'D:\BangleBackups\<timestamp>'
node .\bin\bangle-sync.js sync --dry-run --simulate
```

Optional physical hardware setup (EspruinoTools is not installed by BangleSync):

```powershell
npm install --global espruino@0.1.67
$espruinoCli = Join-Path (npm root -g) 'espruino\bin\espruino-cli.js'
bangle-sync config set transport.espruinoPath $espruinoCli
```

EspruinoTools currently brings its own optional BLE/native dependency tree and reported advisories; installing it is a separate, explicit hardware choice. See [Technical decisions](docs/TECHNICAL-DECISIONS.md) before enabling physical operations.
The simulator is process-local and has no actual watch contents. Simulated backup output reports `COMPLETE_AND_VERIFIED` or `INCOMPLETE`; verification checks the manifest and saved hashes. StorageFiles containing `0xFF` are unsupported/incomplete due to the end-marker limitation and must not be called byte-perfect. Backups are logical Storage archives, not firmware/device images. The legacy `push` and `deploy` commands remain disabled. The simulator did not access a watch; separate selected-scope physical operations are documented below. See [Technical decisions](docs/TECHNICAL-DECISIONS.md) for firmware provenance and unresolved qualification requirements.

## Hardware readiness and limits

The EspruinoTools subprocess adapter implements physical discovery, connection, catalog-bounded inventory, selected-file reads/diff and backups, guarded app-file updates, and explicit app launch/clock restore. Physical update writes are enabled only through the reviewed `sync --apply` flow; they are **recoverable but not atomic**. On 2026-11-11 the actual CLI created a generated temporary clock app, performed two replacements, and used `device diff --pull` snapshots to verify read-back bytes and SHA-256 after each version; the pre-change backup was independently verified. The exact test file was erased and verified absent. Three subprocess-termination reconnect trials and three clean disconnect/reconnect cycles succeeded after adding bounded rediscovery. The actual CLI launch command failed once; a subsequent `device show-clock` succeeded. Physical app launch is not yet qualified through the external-CLI configuration. Interrupted staging was not tested on the watch. These tests do not qualify arbitrary devices, all BLE conditions, all payloads, settings writes, or power-loss recovery. Firmware `2v27.62` is not tied to an exact firmware image/build. No firmware or low-level system data is inspected. See [Technical decisions](docs/TECHNICAL-DECISIONS.md) for test evidence and boundaries.

The fixture in `fixtures/` is separate from this adapter: it is exercised only with a mock and is not ready to upload to a watch.

## Workspace development

Use a workspace created by `bangle-sync init`; keep upstream BangleApps and personal `BangleCustom` projects separate. Workspace comparison is app-ID/project-metadata level and does not compare inaccessible emulator/device filesystems. `workspace import-device` is unavailable; device snapshots are created by the selected-scope `device diff --pull` workflow described below.

New commands:

```powershell
node .\bin\bangle-sync.js workspace status
node .\bin\bangle-sync.js workspace diff
node .\bin\bangle-sync.js workspace update-upstream
node .\bin\bangle-sync.js app create my-clock --type clock
node .\bin\bangle-sync.js app create my-widget --type widget
node .\bin\bangle-sync.js app create my-app --type standard
```

`app create` emits an official-schema project in the separate custom repository and never uploads it. `workspace update-upstream` is fast-forward-only and refuses dirty upstream working trees. Workspace comparison is currently app-ID/project metadata level and deliberately excludes emulator/device file comparisons when their filesystems are not accessible. `workspace import-device` remains unavailable. The documented hardware tests used catalog-bounded `device diff --pull` and verified selected-scope backups through the subprocess adapter; those imports never modify the BangleApps clone.

## Managed user layer and protection boundaries

`bangle-sync init` also creates `apps/`, `themes/`, `behaviours/`, `profiles/`, `config/`, and `manifests/` as workspace-owned configuration areas. The upstream `BangleApps` checkout remains separate from `BangleCustom/projects`. Available local metadata commands include `app list` (local or `--source upstream`), `theme create|list`, `behaviour create|list`, `profile create|list|plan|apply`, `phone protocol create|list`, and `config list`. Themes declare compatibility and affect only apps that explicitly implement the format. Behaviour manifests enumerate dependencies, capabilities, permissions, files, and optional phone-protocol metadata; they are descriptions, not an automatic injector or installer. Profiles describe intended apps, clock, launcher, widgets, theme, behaviours, and settings. `profile apply` saves the generated desired-state file and previews a simulator sync plan; it never writes to a device.

### Device diff and update status

`bangle-sync device diff --app <id> --device-index N` compares only catalogued filenames for the selected app against the pinned upstream baseline; it downloads each present file to calculate a trustworthy current hash. `--pull` additionally saves a timestamped local snapshot/import. Such imported snapshots are cached historical state, not live device verification. Device inventory currently probes presence only; it does not provide reliable device hashes, so a fresh content comparison necessarily reads selected files. Diff does not yet provide a reusable fresh-hash cache or a complete workspace-to-device status matrix.

`device update --dry-run` is an alias for previewing all active desired-state mappings; `device update --apply --confirm --plan-hash <hash>` delegates to the guarded sync apply (reviewed plan hash and verified backup required for updates). Physical writes stage to a unique temporary name, verify exact length and SHA-256, retain a verified pre-change recovery copy, then commit through the documented `Storage.write(name, data, 0, size)` rewrite behavior. The destination is read back and verified before recovery files are removed. This is recoverable, not atomic: a disconnect can leave the destination incomplete; automatic rollback is attempted after reconnect, otherwise the verified recovery copy remains. Update results expose per-file states (`pending`, `staging`, `staged`, `verified`, `committing`, `committed`, `partially-written`, `recovery-required`, or `failed`). No command automatically deletes device-only files. A device backup contains only catalogued, selected user files and explicitly registered settings; it is not device-wide and excludes firmware, bootloader, OS/runtime internals, drivers, and other low-level system data.

The centralized filename classification distinguishes BangleSync-owned, recognized application, explicitly allowlisted configuration, protected-system, and unknown files. Unknown files are not eligible for modification. The configuration allowlist is deliberately narrow (`setting.json`, `setting.js`, `wid_settings.json`) and does not imply every key within these files is safe. No file operation targets firmware, bootloaders, low-level drivers, raw flash, recovery, or core runtime. There is no `Storage.eraseAll`, raw Flash, firmware flashing, automatic compaction, or user-file deletion command. Existing app replacements use `Storage.write` at offset zero only after staging and verifying the new file and saving a verified recovery copy. This replacement is not atomic; on failure BangleSync attempts to restore the old contents and retains the recovery file until the new destination verifies. Unknown files are never erased.

**Implementation and verification boundaries:** The subprocess EspruinoTools adapter has been exercised for catalog-bounded physical inventory, selected-app diff/import, verified backups, and a temporary/user-app update with read-back SHA-256 verification. A test app was launched and the watch returned to its clock through `Bangle.showClock()`. The specific hardware test scope and limitations are recorded in [Technical decisions](docs/TECHNICAL-DECISIONS.md); this does not establish general BLE reliability or qualify arbitrary files/devices. Discovery and downloads have been intermittent, and writes are non-atomic. The legacy root-level `backup --simulate` format remains simulator-only. Device inventory candidates are limited to selected `--app` IDs, the active desired-state profile, explicitly registered settings, BangleSync-owned files, and prior import scopes. It never calls global `Storage.list()` or queries unselected/unknown/system filenames. `device backup --pull --app <id>` (also available as `device diff --pull --app <id>`) compares the selected scope against the pinned BangleApps commit and stores the comparison package under the configured `backup.directory` (or `--destination`). The package contains the changed-file diff and a hash-verified snapshot. `device diff --from-import <snapshot>` rechecks cached hashes against the pinned baseline without BLE. `device backup --from-import <snapshot>` materializes that cache as an independent full backup of the selected scope without another BLE read. Live `device backup --device-index N` creates a full snapshot initially and subsequent content-addressed differentials by default; `--full` forces a new full snapshot. Differentials reference the preceding complete managed backup, record deletions as metadata, and reconstruct through the verified chain with `verify --reconstruct <directory>`. `backup list` lists saved backup manifests; `verify --path <backup>` checks their integrity, and `verify --path <backup> --reconstruct <directory>` restores the selected complete snapshot without overwriting existing files. Unsealed interrupted attempts are ignored as baselines. These backups never claim device-wide or firmware coverage.

`profile plan` compiles app, launcher, clock, widget, theme, and behaviour manifests into desired file mappings; `profile apply` saves desired state and emits a simulator preview, not a device write. `sync --dry-run --simulate` previews local mappings. With a selected physical device, sync reads only relevant managed file contents and reports a hash-bound preview. `sync --apply` requires explicit confirmation, the reviewed plan hash, a verified pre-change backup for updates, central ownership checks, and read-back hash verification. Application is non-atomic if a connection is interrupted; partial completion is reported and the backup is the recovery path. Unknown files are never deleted or overwritten.

Per-key watch settings writes and device-side restore are not implemented. `config register-device` lets the user explicitly register a top-level key and type in the two allowlisted JSON settings files; `config set-device` stages typed desired values locally. These staged values are never uploaded by sync yet, and arbitrary JSON keys are not inferred as safe. BangleApps association depends on local metadata and exact file mapping. Android support consists of protocol metadata only; no Android app exists. Bangle.js applications can share a JavaScript environment; behaviour manifests do not create OS-level isolation. The manifest SHA-256 detects accidental modification but is not a cryptographic signature.

```powershell
bangle-sync workspace update-upstream --path '<workspace>'
bangle-sync device discover --path '<workspace>'
bangle-sync device backup --path '<workspace>' --device-index 1 --pull --app my-app
# device diff --pull remains an alias for the Git-baseline comparison and pull
bangle-sync device backup --from-import '<backup-directory>\<snapshot>'
bangle-sync backup list
bangle-sync verify --path '<backup-directory>\<backup-timestamp>'
bangle-sync device launch --app <owned-app-id> --confirm --device-index 1
bangle-sync device show-clock --device-index 1
bangle-sync profile plan daily
bangle-sync profile apply daily
bangle-sync config register-device setting.json brightness --type number
bangle-sync config set-device setting.json brightness 0.5
bangle-sync sync --dry-run --device-index 1
bangle-sync sync --apply --device-index 1 --confirm --plan-hash <hash-from-preview>
```

Read-only discovery, app-scoped diff/import, and selected-scope backups were exercised on the watch. One new clock app was installed and updated after a verified pre-change backup; read-back SHA-256 passed, the app was launched, and `Bangle.showClock()` returned the watch to its prior clock. An interrupted early update was recovered from a separate verified snapshot. These tests do not qualify arbitrary apps, settings writes, or all BLE failure cases. Do not apply other changes without a fresh backup covering the exact selected scope. The bundled CLI is used by default. To override it, set `transport.espruinoPath` to an EspruinoTools JavaScript CLI file (not a Windows `.cmd` shim).
