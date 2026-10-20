import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CompileConfig, TraceRecord } from '../src/shared/model';
import type { SidebarAction, SidebarMessage, SidebarState } from '../src/shared/sidebar';

interface TestApi {
  openWorkbench(): Promise<void>;
  waitForWebviewReady(): Promise<void>;
  importRecordForTest(record: TraceRecord): Promise<void>;
  getRecordForTest(): TraceRecord | null;
  compileForTest(config: CompileConfig): Promise<void>;
  waitForSidebarReady(): Promise<void>;
  getSidebarStateForTest(): SidebarState;
  invokeSidebarActionForTest(action: SidebarAction): Promise<void>;
  invokeSidebarMessageForTest(message: Exclude<SidebarMessage, { type: 'ready' }>): Promise<void>;
  getSelectedStageIdForTest(): string | null;
  getStageRevealCountForTest(): number;
  mainStageSelectedForTest(recordId: string, stageId: string): void;
  getConfigForTest(): CompileConfig;
  getWorkbenchOpenCountForTest(): number;
  getErrorRevealCountForTest(): number;
  closeWorkbenchForTest(): void;
}

async function waitFor(predicate: () => boolean, description: string, milliseconds = 10_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > milliseconds) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

async function sidebarActions(api: TestApi, extensionUri: vscode.Uri, fixture: TraceRecord): Promise<void> {
  const artifacts = vscode.Uri.joinPath(extensionUri, 'artifacts').fsPath;
  await mkdir(artifacts, { recursive: true });
  const dir = await mkdtemp(path.join(artifacts, 'extension-sidebar-'));
  const source = path.join(dir, 'current script.py');
  const text = path.join(dir, 'notes.txt');
  await writeFile(source, '# configuration must not execute Python\nraise RuntimeError("selection must not execute this file")\n');
  await writeFile(text, 'This is not a Python file.\n');
  try {
    api.closeWorkbenchForTest();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const initialCount = api.getWorkbenchOpenCountForTest();
    const beforeExample = api.getRecordForTest()?.id;
    const preferences = { pythonPath: '/configured/draft/python', disableCache: false };
    await api.invokeSidebarMessageForTest({ type: 'action', action: 'example', preferences });
    const example = api.getConfigForTest();
    assert.equal(example.entryPath, vscode.Uri.joinPath(extensionUri, 'examples', 'cpu_vecadd.py').fsPath, 'The example belongs to this independent extension installation');
    assert.deepEqual(example.scriptArgs, ['--repeat', '1', '--verify']);
    assert.equal(example.pythonPath, preferences.pythonPath);
    assert.equal(example.disableCache, true);
    assert.equal(example.workingDirectory, '');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, example.entryPath, 'The CPU example opens in the native editor');
    assert.equal(api.getWorkbenchOpenCountForTest(), initialCount, 'Configuring an example does not create a viewer');
    assert.equal(api.getRecordForTest()?.id, beforeExample, 'Loading a CPU example does not run Python');
    const beforeReload = api.getSidebarStateForTest().configRevision;
    await api.invokeSidebarMessageForTest({ type: 'action', action: 'example', preferences });
    assert.ok(api.getSidebarStateForTest().configRevision > beforeReload, 'Loading the same example explicitly refreshes its configuration');
    assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === example.entryPath).length, 1, 'Repeated example loads reuse the source tab');
    await assert.rejects(api.invokeSidebarMessageForTest({ type: 'action', action: 'example', preferences: { ...preferences, disableCache: 'bad' } } as unknown as Exclude<SidebarMessage, { type: 'ready' }>), /缓存|布尔/);
    assert.deepEqual(api.getConfigForTest(), example, 'Invalid preferences leave the active configuration intact');
    const beforeSelection = api.getRecordForTest()?.id;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(source), { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('tilelangDevkit.launcher.focus');
    await waitFor(() => api.getSidebarStateForTest().currentFile?.path === source, 'current Python file after sidebar focus');
    await api.invokeSidebarMessageForTest({ type: 'action', action: 'use-current', preferences });
    assert.deepEqual(api.getConfigForTest(), { ...example, ...preferences, entryPath: source, scriptArgs: [], workingDirectory: '' });
    assert.equal(api.getRecordForTest()?.id, beforeSelection, 'Using a file only configures the entry');
    assert.equal(api.getWorkbenchOpenCountForTest(), initialCount, 'Current-file selection leaves the source editor open');
    await api.invokeSidebarMessageForTest({ type: 'edit-source', entryPath: source });
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, source);
    console.log('PASS: CPU example keeps draft Python, opens and reuses its source tab without running or opening a viewer');

    await api.importRecordForTest(fixture);
    const stages = fixture.kernels.flatMap(kernel => kernel.stages).filter(stage => stage.kind === 'pass');
    assert.ok(stages.length >= 2);
    await vscode.commands.executeCommand('tilelangDevkit.launcher.focus');
    const beforeReveal = api.getStageRevealCountForTest();
    await api.invokeSidebarMessageForTest({ type: 'select-stage', recordId: fixture.id, stageId: stages[0].id });
    await withTimeout(api.waitForWebviewReady(), 30_000);
    await waitFor(() => api.getStageRevealCountForTest() === beforeReveal + 1, 'stage intent after new viewer ready');
    assert.equal(api.getSelectedStageIdForTest(), stages[0].id);
    assert.equal(api.getSidebarStateForTest().selectedStageId, stages[0].id);
    const sourceEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.fsPath === source);
    const viewerGroup = vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview));
    assert.ok(sourceEditor, 'The Python source remains visible beside the result');
    assert.ok(viewerGroup);
    assert.notEqual(viewerGroup.viewColumn, sourceEditor.viewColumn);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, source, 'Selecting a stage preserves the editor/sidebar focus');
    const viewerCount = api.getWorkbenchOpenCountForTest();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(text), { preview: false, viewColumn: viewerGroup.viewColumn });
    await api.invokeSidebarMessageForTest({ type: 'select-stage', recordId: fixture.id, stageId: stages[1].id });
    await withTimeout(api.waitForWebviewReady(), 30_000);
    await waitFor(() => api.getStageRevealCountForTest() === beforeReveal + 2, 'stage intent after hidden viewer ready');
    assert.equal(api.getWorkbenchOpenCountForTest(), viewerCount);
    assert.equal(api.getSelectedStageIdForTest(), stages[1].id);
    await assert.rejects(api.invokeSidebarMessageForTest({ type: 'select-stage', recordId: 'old-record', stageId: stages[0].id }), /记录|阶段/);
    api.mainStageSelectedForTest(fixture.id, stages[0].id);
    assert.equal(api.getSidebarStateForTest().selectedStageId, stages[0].id);
    api.mainStageSelectedForTest('old-record', stages[1].id);
    assert.equal(api.getSidebarStateForTest().selectedStageId, stages[0].id);
    await api.invokeSidebarActionForTest('open');
    assert.equal(api.getWorkbenchOpenCountForTest(), viewerCount);
    console.log('PASS: sidebar stage selection opens beside source, survives hidden/new handshakes and syncs central navigation');

    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(text), { preview: false });
    await vscode.commands.executeCommand('tilelangDevkit.launcher.focus');
    assert.equal(api.getSidebarStateForTest().currentFile, null);
    await assert.rejects(api.invokeSidebarActionForTest('use-current'), /Python|\.py/);
    await api.invokeSidebarActionForTest('demo');
    assert.equal(api.getRecordForTest()?.provenance, 'mock');
    const failure = structuredClone(fixture);
    failure.id = 'sidebar-error-routing'; failure.status = 'failed';
    const failedStage = failure.kernels[0].stages.find(stage => stage.kind === 'pass')!;
    failedStage.status = 'failed'; failedStage.afterText = null;
    failure.error = { phase: failedStage.name, message: 'sidebar error routing', stageId: failedStage.id, traceback: 'Traceback: sidebar error routing' };
    failure.kernels[0].status = 'failed';
    await api.importRecordForTest(failure);
    assert.equal(api.getSidebarStateForTest().record?.error?.stageId, failedStage.id);
    api.closeWorkbenchForTest();
    const beforeError = api.getErrorRevealCountForTest();
    await api.invokeSidebarActionForTest('reveal-error');
    await withTimeout(api.waitForWebviewReady(), 30_000);
    await waitFor(() => api.getErrorRevealCountForTest() === beforeError + 1, 'error intent after viewer loads');
    assert.equal(api.getSidebarStateForTest().selectedStageId, failedStage.id);
    console.log('PASS: offline records and failure navigation update sidebar selection and central diagnostics');

    if (process.env.TRACE_TEST_SIDEBAR_RUN === '1') {
      const runningSource = path.join(dir, 'sidebar lifecycle.py');
      await writeFile(runningSource, 'import time\nprint("SIDEBAR_RUN_STARTED", flush=True)\ntime.sleep(3)\nprint("SIDEBAR_RUN_FINISHED", flush=True)\n');
      const config: CompileConfig = {
        entryPath: runningSource, scriptArgs: ['literal argument with spaces'], workingDirectory: dir,
        pythonPath: process.env.TRACE_TEST_PYTHON || 'python', disableCache: true,
      };
      api.closeWorkbenchForTest();
      const closedCount = api.getWorkbenchOpenCountForTest();
      const completion = api.invokeSidebarMessageForTest({ type: 'compile', config });
      await waitFor(() => api.getRecordForTest()?.logs.some(log => log.text.includes('SIDEBAR_RUN_STARTED')) ?? false, 'script start', 60_000);
      assert.equal(api.getSidebarStateForTest().busy, true);
      assert.equal(api.getWorkbenchOpenCountForTest(), closedCount, 'Sidebar compilation does not open a viewer');
      for (const action of ['use-current', 'example', 'demo', 'import', 'browse'] as SidebarAction[]) {
        await assert.rejects(api.invokeSidebarActionForTest(action), /当前编译|编译任务/);
      }
      await api.invokeSidebarActionForTest('open');
      await withTimeout(api.waitForWebviewReady(), 30_000);
      api.closeWorkbenchForTest();
      assert.equal(api.getSidebarStateForTest().busy, true, 'Closing a read-only viewer does not cancel the run');
      await vscode.commands.executeCommand('workbench.view.explorer');
      await withTimeout(completion, 30_000);
      assert.equal(api.getRecordForTest()?.status, 'succeeded', api.getRecordForTest()?.error?.traceback);
      assert.ok(api.getRecordForTest()?.logs.some(log => log.text.includes('SIDEBAR_RUN_FINISHED')));
      await vscode.commands.executeCommand('workbench.view.extension.tilelangDevkit');
      await withTimeout(api.waitForSidebarReady(), 30_000);
      assert.equal(api.getSidebarStateForTest().busy, false);
      assert.equal(api.getSidebarStateForTest().record?.status, 'succeeded');
      console.log('PASS: closing the viewer and hiding the sidebar both preserve a running script');

      const previousRun = api.getRecordForTest()?.id;
      const cancelled = api.invokeSidebarMessageForTest({ type: 'compile', config });
      await waitFor(() => {
        const record = api.getRecordForTest();
        return record?.id !== previousRun && (record?.logs.some(log => log.text.includes('SIDEBAR_RUN_STARTED')) ?? false);
      }, 'second script start', 60_000);
      await api.invokeSidebarActionForTest('cancel');
      await withTimeout(cancelled, 30_000);
      assert.equal(api.getRecordForTest()?.status, 'cancelled');
      assert.equal(api.getSidebarStateForTest().record?.status, 'cancelled');
      console.log('PASS: explicit sidebar cancellation stops the worker and retains its partial record');
    } else {
      console.log('SKIP: running-script sidebar lifecycle (set TRACE_TEST_SIDEBAR_RUN=1 with the supported TileLang environment)');
    }
  } finally {
    await api.invokeSidebarActionForTest('cancel');
    api.closeWorkbenchForTest();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await rm(dir, { recursive: true, force: true });
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms waiting for the VS Code webview`)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

// @vscode/test-electron loads this entry inside a real Extension Development Host.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<TestApi>('easy-tilelang.tilelang-devkit-vscode');
  assert.ok(extension, 'The extension is installed in the development host');
  assert.equal(extension.packageJSON.name, 'tilelang-devkit-vscode');
  assert.equal(extension.packageJSON.publisher, 'easy-tilelang');
  assert.equal(extension.packageJSON.displayName, 'TileLang DevKit');
  await vscode.commands.executeCommand('workbench.view.extension.tilelangDevkit');
  const api = await extension.activate();
  assert.ok(extension.isActive, 'The extension activated');
  await vscode.commands.executeCommand('tilelangDevkit.launcher.focus');
  await withTimeout(api.waitForSidebarReady(), 30_000);
  console.log('PASS: actual VS Code Activity Bar view loads the sidebar and completes its ready handshake');
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['open', 'demo', 'import', 'use-current', 'example', 'export', 'reveal-error', 'focus'].map(action => `tilelangDevkit.${action}`)) {
    assert.ok(commands.includes(id), `Command ${id} is registered`);
  }

  await api.openWorkbench();
  await withTimeout(api.waitForWebviewReady(), 30_000);
  console.log('PASS: actual VS Code webview loaded bundled JavaScript and sent its ready message');

  await vscode.commands.executeCommand('tilelangDevkit.demo');
  assert.equal(api.getRecordForTest()?.provenance, 'mock');
  assert.ok((api.getRecordForTest()?.kernels.length ?? 0) > 0);
  console.log('PASS: mock command loads a clearly identified compilation record');

  const fixture = JSON.parse(await readFile(vscode.Uri.joinPath(extension.extensionUri, 'examples/mock.tltrace.json').fsPath, 'utf8')) as TraceRecord;
  const imported = structuredClone(fixture);
  imported.id = 'extension-offline-roundtrip';
  await api.importRecordForTest(imported);
  assert.deepEqual(api.getRecordForTest(), imported, 'Offline import preserves every stage text and status');
  console.log('PASS: offline import keeps the complete record in the extension host');

  await sidebarActions(api, extension.extensionUri, fixture);

  if (process.env.TRACE_TEST_REAL === '1') {
    const selectedPython = process.env.TRACE_TEST_PYTHON || 'python';
    const beforeLoad = api.getRecordForTest()?.id;
    const beforeViewer = api.getWorkbenchOpenCountForTest();
    await api.invokeSidebarMessageForTest({ type: 'action', action: 'example', preferences: { pythonPath: selectedPython, disableCache: false } });
    const config = api.getConfigForTest();
    assert.equal(config.entryPath, vscode.Uri.joinPath(extension.extensionUri, 'examples', 'cpu_vecadd.py').fsPath);
    assert.equal(config.pythonPath, selectedPython);
    assert.deepEqual(config.scriptArgs, ['--repeat', '1', '--verify']);
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, config.entryPath);
    assert.equal(api.getRecordForTest()?.id, beforeLoad);
    assert.equal(api.getWorkbenchOpenCountForTest(), beforeViewer);
    await withTimeout(api.invokeSidebarMessageForTest({ type: 'compile', config }), 90_000);
    const real = api.getRecordForTest();
    assert.equal(real?.status, 'succeeded', real?.error?.traceback ?? real?.error?.message);
    assert.equal(real?.provenance, 'real');
    assert.equal(real.entry.mode, 'script');
    assert.equal(real.entry.function, '__main__');
    assert.deepEqual(real.entry.args, config.scriptArgs);
    assert.equal(real.environment.target.kind, 'c');
    assert.equal(real.environment.executionBackend, 'cython');
    assert.equal(real.environment.compilationMode, 'jit');
    assert.ok(real.kernels[0].stages.some(stage => stage.kind === 'pass'));
    assert.ok(real.kernels[0].stages.find(stage => stage.kind === 'codegen')?.afterText);
    assert.ok(real.kernels[0].stages.some(stage => stage.kind === 'jit' && stage.status === 'succeeded'));
    assert.equal(real.kernels[0].cache, 'disabled');
    await api.importRecordForTest(JSON.parse(JSON.stringify(real)) as TraceRecord);
    assert.deepEqual(api.getRecordForTest(), real);
    const finalStage = real.kernels[0].stages.find(stage => stage.name === 'module_load')!;
    assert.ok(finalStage);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(config.entryPath), { preview: false, viewColumn: vscode.ViewColumn.One });
    await vscode.commands.executeCommand('tilelangDevkit.launcher.focus');
    await api.invokeSidebarMessageForTest({ type: 'select-stage', recordId: real.id, stageId: finalStage.id });
    await withTimeout(api.waitForWebviewReady(), 30_000);
    assert.equal(api.getSidebarStateForTest().selectedStageId, finalStage.id);
    console.log(`PASS: real CPU C full JIT via sidebar, numerical script verification, stage selection and offline roundtrip (${real.kernels[0].stages.length} stages)`);

    await withTimeout(api.compileForTest({ ...config, scriptArgs: ['--size', '128', '--repeat', '2'], disableCache: false }), 90_000);
    const cached = api.getRecordForTest();
    assert.equal(cached?.status, 'succeeded', cached?.error?.traceback ?? cached?.error?.message);
    const hit = cached.kernels.find(kernel => kernel.cache === 'hit');
    assert.ok(hit, 'A repeated compile uses a real cache hit');
    assert.ok(['memory', 'disk', 'decorator'].includes(hit.cacheSource ?? ''), 'The record identifies the observed cache');
    assert.ok(hit.stages.every(stage => stage.kind !== 'pass'), 'Cache hits do not invent lowering passes');
    console.log(`PASS: real JIT cache hit (${hit.cacheSource}) preserves only observed stages`);

    const failureDirectory = await mkdtemp(path.join(tmpdir(), 'tilelang-script-failure-'));
    try {
      const failureEntry = path.join(failureDirectory, 'jit_failure.py');
      await writeFile(failureEntry, `${await readFile(config.entryPath, 'utf8')}\nraise RuntimeError('Script failure after successful CPU JIT')\n`);
      await withTimeout(api.compileForTest({ ...config, entryPath: failureEntry, scriptArgs: ['--size', '128', '--repeat', '1'] }), 90_000);
      const failed = api.getRecordForTest();
      assert.equal(failed?.status, 'failed');
      assert.match(failed?.error?.traceback ?? '', /RuntimeError/);
      assert.ok(failed?.entry.source.includes('__main__'));
      assert.ok(failed?.kernels.some(kernel => kernel.status === 'succeeded' && kernel.stages.some(stage => stage.kind === 'jit')));
      console.log('PASS: script exception after JIT retains completed kernels, Python source and diagnostic');
    } finally {
      await rm(failureDirectory, { recursive: true, force: true });
    }
  } else {
    console.log('SKIP: real CPU C JIT (set TRACE_TEST_REAL=1 with the supported TileLang environment and native compiler)');
  }
}
