# Single-file Windows executable (Node.js SEA)

The SEA distribution is one file: `dist/ASIC ToolBox.exe`. The Node runtime, bundled server, `ssh2` dependencies, browser UI, package metadata, and `grpcurl.exe` are embedded in that executable. Users do not need Node.js and do not need to keep a runtime, `public/`, `tools/`, or application source folder beside it.

## Build

Build on Windows with Node.js 22 or newer and npm:

```powershell
npm ci
npm run build:windows
```

The build bundles `server.js` and its JavaScript dependencies with esbuild, creates a Node SEA blob with the current Node executable, and injects it into that same executable using `postject`. It then downloads the official `electron/rcedit` v2.0.0 x64 tool, verifies its pinned SHA-256, and installs `public/app-icon.ico` as the Windows executable icon.

After a local build, find the file at `dist\ASIC ToolBox.exe` in the project directory. To get the CI build, open the successful run in the repository's **Actions** tab, then download the `ASIC-ToolBox-Windows-SEA` artifact; the downloaded ZIP contains `ASIC ToolBox.exe`. Building on Linux/macOS is intentionally rejected: the SEA executable must be assembled with a Windows Node binary and PE injection tooling.

## Run and data location

Copy `dist/ASIC ToolBox.exe` anywhere writable and launch it. The browser UI is served from resources embedded in the EXE. The application binds only to `127.0.0.1` and opens the local interface in the default browser.

Mutable data is stored outside the installation directory, under `%LOCALAPPDATA%\ASIC ToolBox` (for example, `state.json`, `maps.json`, `scan-settings.json`, `saves/`, and `runtime\grpcurl.exe`). This is deliberate: a single-file portable executable cannot safely write its database beside itself when launched from a read-only location, and Windows requires a real file to launch the embedded `grpcurl` helper. The helper is extracted from the executable on its first gRPC request. No application/runtime/UI files need to be distributed next to the EXE.

On first launch, if the EXE is placed in an existing portable app folder, the app copies any missing `state.json`, `state.js`, `maps.json`, `scan-settings.json`, and `saves/` into the user-data directory. Existing data in `%LOCALAPPDATA%` takes precedence and is never overwritten.

To back up or move user data, use the application's **Export backup** function or copy `%LOCALAPPDATA%\ASIC ToolBox` while the application is stopped. The single EXE contains program assets, not private/user data.

## Legacy portable package

`run-windows.cmd`, `launcher.cjs`, and the existing `runtime/` and `tools/` binaries remain available for the old folder-based portable distribution. They are not used by `npm run build:windows` and are not required by the new single-file build.
