# TileLang DevKit

**English** | [简体中文](README.zh-CN.md)

TileLang development tools for VS Code. **Lower Trace** lets you explore compilation stages, lowering passes, IR differences, generated code, logs, and cache reuse. Import and export portable records for offline inspection.

This standalone extension is maintained by `easy-tilelang`, with extension ID `easy-tilelang.tilelang-devkit-vscode`. It loads TileLang from the Python environment you select and does not need to reside in the compiler repository. All UI resources are bundled with the extension.

## Quick start

1. Install the extension from a VSIX using **Extensions → … → Install from VSIX…**. Once published, it can also be found by searching for **TileLang DevKit** in the Marketplace.
2. Run **TileLang DevKit: Open Mock Demo** from the Command Palette. Browse stage outputs and switch to **Diff**; no Python, TileLang, or network is required for the demo or imported records.
3. For live collection, open the TileLang DevKit sidebar, select a saved Python script, and set the **absolute path** of a Python interpreter with the supported TileLang environment. Click **保存并运行** (Save and Run). With Remote SSH, install the extension and configure Python on the remote host.

**Current live collection support:** Linux / Remote SSH, TileLang 0.1.15 at commit `3e923e98`, CPU C target (`target="c"`) and Cython backend (`execution_backend="cython"`). Collection includes native compilation, linking, and dynamic library loading. Other live backends and arbitrary releases sharing the same version number are not yet supported. Offline viewing works in desktop VS Code without that compilation environment. The current interface is primarily in Chinese; VS Code 1.95 or newer is required.

## Preview

Actual browser previews of the bundled **MOCK** record, not measurements from a real compilation. These images show the result viewer; VS Code provides the separate compilation sidebar and source editor.

![Lower Trace code view — MOCK browser preview](media/screenshots/lower-trace-code.png)

![Lower Trace pass input/output diff — MOCK browser preview](media/screenshots/lower-trace-diff.png)

See [CHANGELOG](CHANGELOG.md) for release notes.

## Source development, packaging, and installation

Building requires Node.js 22 or newer. The minimum VS Code version is 1.95. From this directory, run:

```bash
npm ci
npm run build
code tilelang-devkit.code-workspace
```

In the provided workspace, press **F5** and select `Run TileLang DevKit`. In the new Extension Development Host, click the **TileLang DevKit** Activity Bar icon to configure a script or open the Mock demo. **TileLang DevKit: Open Mock Demo** loads an explicitly labeled `MOCK` record; **TileLang DevKit: Open Lower Trace** opens an empty workbench or the latest record.

Package and install:

```bash
npm run package
code --install-extension tilelang-devkit-vscode-0.1.0.vsix
```

You can also select **Install from VSIX…** in the Extensions view. For Remote SSH, install the extension on the remote host. The Python interpreter, entry paths, and compilation tasks are resolved on the workspace host.

For a browser-only preview, run `npm run preview` and open `http://127.0.0.1:4173`; the sidebar preview is at `/sidebar`. This development harness uses a Mock bridge. It cannot run real compilation and does not replace testing inside VS Code.

## Sidebar configuration, navigation, and result viewer

Open the **TileLang DevKit** Activity Bar view, choose an entry file, set the Python interpreter, script arguments, working directory, and cache options, then click **保存并运行** (Save and Run). **使用当前文件** (Use Current File) requires a saved `.py` file and clears script arguments and the working directory. Both browsing for an entry and selecting the current file retain the sidebar's draft interpreter and cache settings. **CPU 示例** (CPU Example) keeps the Python path, sets arguments to `["--repeat", "1", "--verify"]`, clears the working directory, enables cache disabling, and opens the example in VS Code's native editor. Click Save and Run to execute it. **编辑源码** (Edit Source) reopens the configured entry.

The sidebar lists stages in execution order. Search stages, select a kernel, or hide unchanged stages. Repeated pass names retain separate IDs and occurrence numbers; cache hits show only observed stages. Selecting a stage opens or reuses the viewer beside the source while keeping sidebar focus. Previous/next navigation and keyboard shortcuts in the viewer synchronize the sidebar selection. Filtering changes the navigation list, not the previous-stage Diff baseline.

The central viewer displays code, Diff, collapsible stage details, and logs. Configuration, run/cancel controls, stage navigation, and import/export are in the sidebar; source editing stays in VS Code's native editor. Script failures before any stage is collected still provide source snapshots and logs. Error navigation selects an available failed stage and opens diagnostics.

During collection, you can browse collected stages and export the current record. Replacing the entry, loading a Mock demo, and importing another record are temporarily unavailable. Switching Activity Bar views, hiding the sidebar, or closing the result viewer does not cancel a task. Use **取消** (Cancel) in the sidebar to stop it; collected stages are retained. Untrusted workspaces allow Mock and offline viewing, but cannot execute Python.

## Running scripts and collecting real JIT traces

Use a Linux Python environment that can import the supported TileLang build described above. A native C/C++ compiler and that checkout's JIT dependencies are required. Verify that these commands work:

```bash
# Enter this interpreter's absolute path in the sidebar's Python setting.
/path/to/venv/bin/python -c 'import tilelang; print(tilelang.__version__, tilelang.__file__)'
g++ --version
```

Choose an existing Python script in the sidebar, or set the Python path and click **CPU 示例** (CPU Example) to open `examples/cpu_vecadd.py`. The live target/backend is fixed to CPU C / Cython. Confirm the interpreter, source, and arguments, then click **保存并运行** (Save and Run). You can also set the default interpreter with `tilelangDevkit.pythonPath`. The sidebar's **Mock** action loads a labeled demonstration record without executing Python.

The entry contract is **Python file + script arguments + working directory**. Arguments are a JSON array of strings, such as `["--size", "128", "--repeat", "1", "--verify"]`. Each element becomes one `sys.argv` entry, without shell splitting or variable expansion. An empty working directory defaults to the workspace directory, or the script directory if no local workspace exists. Relative paths are resolved against the workspace. In the bundled example, `--verify` runs the CPU kernel and checks its output; `--repeat 2` can demonstrate a real cache hit within one process.

The collector executes the script through `runpy.run_path(..., run_name="__main__")`, including top-level code and the `if __name__ == "__main__":` block. Data reads, file writes, kernel calls, and other script operations execute normally; only run trusted scripts. Save the entry file before running so its source snapshot matches the file being executed. Python execution requires a trusted workspace.

The collector observes ordinary `tilelang.compile` / `@tilelang.jit` calls through the CPU C / Cython compilation path. Explicit requests for other targets or backends fail. Kernels must use semantics supported by the CPU C backend. Multiple compilations, different kernels, cache hits, and repeated passes retain separate identities. A successful script that does not trigger TileLang JIT explicitly reports that no compilation stages were collected, while retaining source and logs.

Observed compilation failures and unsupported calls retain a failed status even if the script catches the exception. Later successful compilations remain available for inspection.

## Viewer controls and record semantics

- The sidebar follows actual collection order. Every observed JIT request has a separate kernel ID, including repeated calls to the same symbol; the count is not the number of distinct functions. Repeated passes retain separate IDs, sequence numbers, and nesting depth. Unchanged stages are visible by default.
- Code is read-only, with syntax highlighting, line numbers, copying, wrapping, and Diff. By default, Diff compares with the **previous stage of the same kernel**, regardless of search or filtering. Switch to the pass input/output comparison to inspect changes made by that invocation.
- Use `Alt+↑` / `Alt+↓` in the viewer to navigate the full execution sequence, and `/` to return to the sidebar. Narrow layouts use a unified Diff. Stage details can be collapsed; themes can follow VS Code or be selected manually.
- Stage details show descriptions, timings, and change statistics. Missing descriptions and timings remain unknown. Timings include child stages and some collection overhead, so they cannot be summed into a total. Changed-line counts do not indicate performance gains.
- Expand the log panel for stdout/stderr and tracebacks. Failed stages retain their input; missing output is not treated as deletion of all input. Cancellation, abnormal exits, and reopening the viewer preserve stages already saved to disk.
- **禁用缓存** (Disable Cache) uses TileLang's official cache switch. Turn it off to observe memory or disk cache hits. In the supported version, the `@jit` decorator has a separate process-local cache that does not check this switch; repeated calls can still hit the `decorator` cache, as recorded in the trace and logs. Cache hits show only stages that actually occurred.
- `native_compile` / `module_load` show native compilation/linking and dynamic library loading status, timing, and available host wrapper text. Successful code generation does not imply successful JIT completion; compiler or loader failures retain earlier source and IR.

Use **导出记录** (Export Record) in the sidebar to save a `.tltrace.json` file. Reopen it on another machine with **TileLang DevKit: Import Compilation Record**. Import reads JSON without executing embedded Python or commands; the original entry file need not exist. The default import limit is 64 MiB, configurable through `tilelangDevkit.maxRecordSizeMiB`.

The format is defined by [record.schema.json](record.schema.json) and the [shared TypeScript types](src/shared/model.ts). The current `schemaVersion` is `1`:

| Data | Contents |
| --- | --- |
| Record | Real/Mock provenance, entry source, script arguments and working directory, environment versions, target/backend, status, total duration, logs, and error |
| Kernel | Unique ID, name, compilation symbol, cache status/source, and stages |
| Stage | Unique ID, observed name, sequence, kind, phase, parent/depth, original input/output text, language, status, optional duration, and change statistics |

`null` means not yet collected or unavailable, and differs from empty text. `changed` and stored added/deleted counts describe the pass's own input/output; the viewer recalculates Diff statistics for the selected comparison. `sequence` is shared across the entire compilation and may have gaps. Stages are ordered by it; passes inside code generation appear before the final generated source.

Script records identify the entry through `entry.mode="script"`, `entry.function="__main__"`, `entry.args`, and `entry.cwd`, with empty `entry.kwargs`. `executionBackend`, `compilationMode`, and `cacheSource` are optional, so v1 records without these fields remain importable. Cache status `disabled` means explicitly disabled; `not-applicable` means caching does not apply to that record.

The extension host owns processes, logs, persistence, and import/export. React webviews handle browsing and interaction. The Python worker uses `PassInstrumentationTool`, `PassEventObserver`, and `StackedPassInstrument` to observe real passes and code generation, and observes JIT compilation, loading, and caching in a separate process. Events are emitted incrementally to a dedicated JSONL file; stdout/stderr are not the protocol. After a JIT kernel is returned, the collector compares code-generation text with `get_kernel_source()` and native-compilation text with `get_kernel_source(kernel_only=False)` exactly. A mismatch fails the task. Automatic activation of TileLang's built-in `lower_trace` is disabled in the collection process to prevent its existing feedback mechanism from modifying inputs.

## Examples and development checks

The repository includes a labeled offline [Mock record](examples/mock.tltrace.json) and an executable [CPU example](examples/cpu_vecadd.py). Mock data is only for exploring stage navigation, code display, and Diff.

From the project root, capture the CPU example using a supported TileLang environment:

```bash
TRACE_TEST_PYTHON=/path/to/venv/bin/python npx tsx scripts/capture-example.ts
# Optionally specify the output file.
TRACE_TEST_PYTHON=/path/to/venv/bin/python npx tsx scripts/capture-example.ts /path/to/cpu-vecadd.tltrace.json
```

The default output is `artifacts/examples/cpu-vecadd.tltrace.json`, which can be imported from the sidebar. Capture completes JIT and checks the CPU result numerically. `TILELANG_WORKSPACE` explicitly sets the script's working directory; the default is this extension project. The capture script does not automatically configure Python import paths. Generated records contain environment details, paths, logs, and compilation output, and are excluded from source control and the extension package.

Development checks:

```bash
npm run check
npm test
npm run test:python:unit
npm run benchmark
# With a supported TileLang Python environment activated:
npm run test:python
npm run build
npx playwright install chromium
npm run test:webview
xvfb-run -a npm run test:extension
TRACE_TEST_SIDEBAR_RUN=1 xvfb-run -a npm run test:extension
TRACE_TEST_REAL=1 xvfb-run -a npm run test:extension
```

Browser tests exercise webview interaction and save screenshots and failure traces to `test-results/`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to use an existing Chromium installation. VS Code tests use the actual Extension Host and require a graphical session; use `xvfb-run` on headless Linux. `TRACE_TEST_SIDEBAR_RUN=1` enables task lifecycle and cancellation checks and requires an environment that can initialize TileLang. `TRACE_TEST_REAL=1` checks full CPU C JIT, numerical output, caching, and error records, requiring the supported TileLang environment and native compiler. `TRACE_TEST_PYTHON` selects an interpreter explicitly; `VSCODE_TEST_VERSION` or `VSCODE_EXECUTABLE_PATH` selects the test host. UI tests without real compilation do not validate JIT output.

### Test interpreters and common errors

`npm test`, both Python test commands, the example capture script, and Extension Host tests with real execution enabled share an interpreter preflight. An explicit `TRACE_TEST_PYTHON` is used strictly, with no fallback on failure. Otherwise, discovery tries `python`, then `python3`, requiring Python 3 and allowing up to 5 seconds per probe. Subsequent processes use the interpreter's reported absolute path. If no usable interpreter is found, the entrypoint reports the failures and a configuration example before starting tests.

```bash
TRACE_TEST_PYTHON=/path/to/venv/bin/python npm test
TRACE_TEST_PYTHON=/path/to/venv/bin/python npm run test:python
```

`spawn python ENOENT` means the current process cannot find an executable named `python`; it does not mean TileLang compilation failed. Activate the virtual environment or specify an absolute path as above. The Python subprocesses in `npm test` use only the standard library and do not need TileLang. `test:python` requires pytest and the supported TileLang installation; real JIT validation also requires that TileLang environment. Offline Extension Host and browser tests do not require Python.

These discovery rules apply only to tests and development scripts. The extension itself strictly uses the interpreter configured in the sidebar or `tilelangDevkit.pythonPath`, without automatically switching environments.

For source development, provide TileLang through an existing editable installation or an explicit `PYTHONPATH`. Tests and capture scripts do not infer compiler locations from parent directories. Copying this extension repository does not copy TileLang sources, native libraries, or Python environments.

## Support and limitations

Live collection supports only the CPU C / Cython path at the TileLang commit specified above; compatibility with other releases or backends is not guaranteed. Offline browsing is available in desktop VS Code; real execution supports Linux / Remote SSH. Only synchronous JIT on the main thread is collected. Compilation on another thread fails explicitly, and the collector is not injected into subprocesses started by the script. Precise source-to-IR mapping, hardware layout inspection, and performance analysis are not yet supported. Records store complete text, so very large IR or many passes increase memory and disk usage. Recorded logs are capped at 8 MiB with an explicit truncation notice; code snapshots continue to be collected.

## Run data and performance checks

During collection, complete snapshots are saved at most about once per second, with an immediate final save when the task ends. Normal completion and cancellation wait for that save. If the host terminates abnormally, recovery uses the latest snapshot; the most recent unsaved events may be missing.

After the final record is saved successfully, the extension deletes that run's `runs/<uuid>` directory, including its event protocol and temporary files within that directory, while retaining `latest.tltrace.json`. Run files are retained if saving fails. Enable `tilelangDevkit.retainRunFiles` to retain diagnostic files for subsequent runs. External `TMPDIR` contents, older leftover directories, and explicitly retained directories are not automatically cleaned up.

For large text, added/deleted counts can be unknown. If input and output exceed 512 Ki characters combined, or their line-count product exceeds 250,000, the collector keeps `changed` and the complete text but records `added` / `deleted` as `null`. Identical text still produces exact zero counts. On-demand Diff in the viewer retains its existing computation budget.

`npm run benchmark` runs synthetic ingestion and snapshot serialization for 500, 2,000, and 5,000 stages, reporting elapsed time and record size. `npm run benchmark -- --baseline` uses full validation as a comparison. These results compare changes in the same environment; they are not fixed timing thresholds and do not measure real JIT compilation time.

The GitHub `Checks` workflow runs type checks, TypeScript/Python unit tests, builds, browser interaction tests, offline Extension Host integration, and VSIX packaging. The real JIT workflow is manually triggered and needs a dedicated runner labeled `self-hosted`, `linux`, and `tilelang-cpu-jit`. Its discovered interpreter or explicit `TRACE_TEST_PYTHON` must load the supported TileLang environment. The runner also needs pytest, a native compiler, Node.js 22+, Xvfb, and VS Code test runtime dependencies.

## Release package checks

```bash
npm ci
npm run check
npm test
npm run package
```

`npm run package` builds the extension and creates `tilelang-devkit-vscode-0.1.0.vsix`. Install it with **Install from VSIX…** in VS Code and check Mock, imported records, and real collection before a maintainer with `easy-tilelang` Publisher permissions uploads it to Marketplace. Repository CI checks and packages the extension but does not publish it automatically. Packaging tools are development dependencies, so do not omit devDependencies when building or packaging.

The release package includes runtime code, the Python collector, examples, documentation, and screenshots. Source tests, development scripts, CI configuration, local tool directories, and node_modules are excluded. Update the version and CHANGELOG together for future releases.
