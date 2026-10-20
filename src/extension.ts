import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { RecordPublisher } from './shared/record-update';
import { CompilationTask } from './host/task';
import { TraceSidebarProvider } from './host/sidebar';
import { assertRecord, parseRecord, validateConfig } from './shared/record';
import type { CompileConfig, HostMessage, TraceRecord, WebviewMessage } from './shared/model';
import { createSidebarState, validateSidebarPreferences, type SidebarAction, type SidebarMessage, type SidebarPreferences } from './shared/sidebar';

let activeTask: CompilationTask | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('TileLang DevKit · Lower Trace');
  context.subscriptions.push(output);
  let panel: vscode.WebviewPanel | undefined;
  let ready = false;
  let resolveReady: (() => void) | undefined;
  let readyPromise = Promise.resolve();
  let pendingRevealError = false;
  let pendingStage: { recordId: string; stageId: string } | undefined;
  let selectedRecordId: string | null = null;
  let selectedStageId: string | null = null;
  let stageRevealCount = 0;
  let errorRevealCount = 0;
  let workbenchOpenCount = 0;
  let cancellationVersion = 0;
  let preparing = false;
  let configRevision = 0;
  let record: TraceRecord | null = null;
  let publishTimer: NodeJS.Timeout | undefined;
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  const savedConfig = context.workspaceState.get<Partial<CompileConfig>>('config');
  let config: CompileConfig = {
    entryPath: vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri.fsPath : '',
    scriptArgs: [], workingDirectory: '', disableCache: false,
    pythonPath: vscode.workspace.getConfiguration('tilelangDevkit').get('pythonPath', 'python'),
    ...(savedConfig?.entryPath ? { entryPath: savedConfig.entryPath } : {}),
    ...(savedConfig?.pythonPath ? { pythonPath: savedConfig.pythonPath } : {}),
    ...(Array.isArray(savedConfig?.scriptArgs) ? { scriptArgs: savedConfig.scriptArgs } : {}),
    ...(typeof savedConfig?.workingDirectory === 'string' ? { workingDirectory: savedConfig.workingDirectory } : {}),
    ...(typeof savedConfig?.disableCache === 'boolean' ? { disableCache: savedConfig.disableCache } : {}),
  };

  const publisher = new RecordPublisher();
  function send(message: HostMessage): void {
    if (!panel || !ready) return;
    if (message.type === 'state') publisher.reset(message.record);
    if (message.type === 'record') {
      message = { ...publisher.next(message.record), busy: message.busy, selectedStageId: message.selectedStageId };
    }
    void panel.webview.postMessage(message);
  }
  function isBusy(): boolean { return preparing || task.busy; }
  function syncSelection(): void {
    const nextRecordId = record?.id ?? null;
    if (nextRecordId !== selectedRecordId) {
      selectedRecordId = nextRecordId;
      selectedStageId = null;
      pendingStage = undefined;
      pendingRevealError = false;
    }
    const stages = record?.kernels.flatMap(kernel => kernel.stages).sort((a, b) => a.sequence - b.sequence) ?? [];
    if (!stages.some(stage => stage.id === selectedStageId)) {
      selectedStageId = (stages.find(stage => stage.kind !== 'source') ?? stages[0])?.id ?? null;
    }
  }
  function state(): void {
    syncSelection();
    send({ type: 'state', record, config, busy: isBusy(), trusted: vscode.workspace.isTrusted, selectedStageId });
    sidebar.refresh();
  }
  const task = new CompilationTask({
    storagePath: (context.storageUri ?? context.globalStorageUri).fsPath,
    runnerPath: path.join(context.extensionPath, 'python', 'runner.py'),
    onChange: (current, busy) => {
      record = current;
      if (publishTimer) return;
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        syncSelection();
        if (record) send({ type: 'record', record, busy: isBusy(), selectedStageId });
        sidebar.refresh();
      }, busy ? 80 : 0);
    },
    onLog: text => output.append(text),
    get retainRunFiles() { return vscode.workspace.getConfiguration('tilelangDevkit').get('retainRunFiles', false); },
  });
  activeTask = task;

  function currentPythonFile(): { path: string; name: string } | null {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.isUntitled || document.uri.scheme !== 'file' || path.extname(document.uri.fsPath).toLowerCase() !== '.py') return null;
    return { path: document.uri.fsPath, name: path.basename(document.uri.fsPath) };
  }

  function sidebarState() {
    syncSelection();
    return createSidebarState(record, isBusy(), vscode.workspace.isTrusted, currentPythonFile(), config, selectedStageId, configRevision);
  }
  const sidebar = new TraceSidebarProvider(context.extensionUri, sidebarState, async message => {
    try { await handleSidebarMessage(message); }
    catch (error) {
      output.appendLine(`[sidebar] ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  });

  async function replaceRecord(next: TraceRecord): Promise<void> {
    available();
    assertRecord(next);
    record = next;
    task.record = next;
    await task.persist();
    state();
  }

  function available(): void {
    if (isBusy()) throw new Error('请等待当前编译结束，或先取消任务');
  }

  function cancelRun(): void {
    cancellationVersion += 1;
    task.cancel();
  }

  async function importRecord(): Promise<boolean> {
    available();
    const result = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'TileLang record': ['tltrace.json', 'json'] } });
    if (!result?.[0]) return false;
    const max = vscode.workspace.getConfiguration('tilelangDevkit').get('maxRecordSizeMiB', 64) * 1024 * 1024;
    if ((await vscode.workspace.fs.stat(result[0])).size > max) throw new Error(`记录超过 ${max / 1024 / 1024} MiB 上限；可在设置中调整`);
    const bytes = await vscode.workspace.fs.readFile(result[0]);
    if (bytes.length > max) throw new Error('记录在读取过程中超过大小上限');
    await replaceRecord(parseRecord(Buffer.from(bytes).toString('utf8')));
    return true;
  }

  async function exportRecord(): Promise<void> {
    if (!record) throw new Error('尚无可导出的记录');
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(workspace?.fsPath ?? context.globalStorageUri.fsPath, `${record.provenance}-${record.id.slice(0, 12)}.tltrace.json`)), filters: { 'TileLang record': ['tltrace.json'] } });
    if (!uri) return;
    const snapshot = JSON.stringify(record, null, 2);
    // Saving a record never resolves or reads its embedded source paths.
    await vscode.workspace.fs.writeFile(uri, Buffer.from(snapshot, 'utf8'));
    send({ type: 'notice', message: '记录已导出；可在没有 TileLang 的机器上离线打开。' });
  }

  async function demo(): Promise<void> {
    available();
    await replaceRecord(parseRecord(await fs.readFile(path.join(context.extensionPath, 'examples', 'mock.tltrace.json'), 'utf8')));
  }

  async function compile(next: unknown): Promise<void> {
    available();
    const version = cancellationVersion;
    if (!vscode.workspace.isTrusted) throw new Error('当前工作区未受信任，仅可使用 Mock 和离线记录查看');
    if (process.platform !== 'linux') throw new Error('真实 CPU C JIT 支持 Linux / Remote SSH；当前平台可离线查看记录');
    const selected = validateConfig(next);
    selected.entryPath = path.resolve(workspace?.scheme === 'file' ? workspace.fsPath : process.cwd(), selected.entryPath);
    const baseDirectory = workspace?.scheme === 'file' ? workspace.fsPath : path.dirname(selected.entryPath);
    selected.workingDirectory = path.resolve(baseDirectory, selected.workingDirectory || '.');
    preparing = true;
    sidebar.refresh();
    try {
      const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && doc.uri.fsPath === selected.entryPath);
      if (openDocument?.isDirty && !(await openDocument.save())) throw new Error('入口文件未保存，编译已停止');
      if (version !== cancellationVersion) return;
      config = selected;
      configRevision += 1;
      await context.workspaceState.update('config', config);
      // Cancel also covers the save/configuration interval before worker start.
      if (version !== cancellationVersion) return;
      const completion = task.start(config, baseDirectory);
      preparing = false;
      state();
      await completion;
    } finally {
      preparing = false;
      state();
    }
  }

  function configurationUnchanged(revision: number): void {
    available();
    if (revision !== configRevision) throw new Error('编译配置已更新，请重新选择入口');
  }

  async function configureExample(preferences?: SidebarPreferences): Promise<void> {
    available();
    const revision = configRevision;
    const entryPath = path.join(context.extensionPath, 'examples', 'cpu_vecadd.py');
    // Loading a preset must not validate the previous entry or its argv. Keep
    // the user's interpreter draft even if it has not been used for a run yet.
    const next = { ...config, ...preferences, entryPath, scriptArgs: ['--repeat', '1', '--verify'], workingDirectory: '', disableCache: true };
    try {
      await editSource(entryPath);
    } catch (error) {
      throw new Error(`无法打开 CPU 示例（${entryPath}）：${error instanceof Error ? error.message : String(error)}`);
    }
    // A run or another entry selection may have completed while the editor
    // opened. Never overwrite a newer configuration with this older request.
    configurationUnchanged(revision);
    config = next;
    configRevision += 1;
    send({ type: 'configuration', config, trusted: vscode.workspace.isTrusted });
    sidebar.refresh();
    sidebar.showNotice('已载入 CPU 示例，可编辑源码后点击“保存并运行”。');
  }

  async function useCurrentFile(preferences?: SidebarPreferences): Promise<void> {
    available();
    const current = currentPythonFile();
    if (!current) throw new Error('请先打开一个已保存的 Python（.py）文件');
    config = { ...config, ...preferences, entryPath: current.path, scriptArgs: [], workingDirectory: '' };
    configRevision += 1;
    send({ type: 'configuration', config, trusted: vscode.workspace.isTrusted });
    sidebar.refresh();
  }

  function flushRevealError(): void {
    if (!ready || !pendingRevealError) return;
    pendingRevealError = false;
    const stageId = sidebarState().record?.error?.stageId;
    if (stageId && record?.kernels.some(kernel => kernel.stages.some(stage => stage.id === stageId))) selectedStageId = stageId;
    send({ type: 'reveal-error', ...(stageId ? { stageId } : {}) });
    errorRevealCount += 1;
    sidebar.refresh();
  }

  function validateSelection(recordId: string, stageId: string): void {
    if (record?.id !== recordId || !record.kernels.some(kernel => kernel.stages.some(stage => stage.id === stageId))) {
      throw new Error('此阶段已不属于当前记录，请从最新的阶段列表中选择');
    }
  }

  function flushStage(): void {
    if (!ready || !pendingStage) return;
    const next = pendingStage;
    pendingStage = undefined;
    if (record?.id !== next.recordId || selectedStageId !== next.stageId) return;
    send({ type: 'reveal-stage', ...next });
    stageRevealCount += 1;
  }

  async function revealStage(recordId: string, stageId: string): Promise<void> {
    validateSelection(recordId, stageId);
    syncSelection();
    selectedStageId = stageId;
    pendingRevealError = false;
    pendingStage = { recordId, stageId };
    sidebar.refresh();
    await openWorkbench(true);
    flushStage();
  }

  function mainStageSelected(recordId: string, stageId: string): void {
    // In-flight messages from a replaced record must not select a new record.
    if (record?.id !== recordId) return;
    validateSelection(recordId, stageId);
    selectedStageId = stageId;
    pendingStage = undefined;
    // A streamed record may have been queued just before the local keypress.
    // Acknowledge selection after it so the two views converge on the same ID.
    send({ type: 'reveal-stage', recordId, stageId });
    sidebar.refresh();
  }

  async function browseEntry(preferences?: SidebarPreferences): Promise<void> {
    available();
    const revision = configRevision;
    const selection = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Python: ['py'] } });
    if (!selection?.[0]) return;
    configurationUnchanged(revision);
    config = { ...config, ...preferences, entryPath: selection[0].fsPath, scriptArgs: [], workingDirectory: '' };
    configRevision += 1;
    send({ type: 'configuration', config, trusted: vscode.workspace.isTrusted });
    sidebar.refresh();
  }

  async function editSource(entryPath: unknown): Promise<void> {
    if (typeof entryPath !== 'string' || !entryPath.trim() || entryPath.includes('\0')) throw new Error('请先选择要编辑的入口脚本');
    // Only an explicit entry selection is opened. Imported record paths are
    // never resolved implicitly; their original source is a read-only snapshot.
    const base = workspace?.scheme === 'file' ? workspace.fsPath : process.cwd();
    const uri = vscode.Uri.file(path.resolve(base, entryPath));
    const document = await vscode.workspace.openTextDocument(uri);
    const existing = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
    await vscode.window.showTextDocument(document, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One, preview: false });
  }

  async function handleSidebarMessage(message: Exclude<SidebarMessage, { type: 'ready' }>): Promise<void> {
    switch (message.type) {
      case 'action': await handleSidebarAction(message.action, message.preferences); break;
      case 'compile': await compile(message.config); break;
      case 'select-stage': await revealStage(message.recordId, message.stageId); break;
      case 'edit-source': await editSource(message.entryPath); break;
      default: throw new Error('未知侧栏消息');
    }
  }

  async function handleSidebarAction(action: SidebarAction, rawPreferences?: unknown): Promise<void> {
    const preferences = validateSidebarPreferences(rawPreferences);
    switch (action) {
      case 'open': await openWorkbench(); break;
      case 'use-current': await useCurrentFile(preferences); break;
      case 'example': await configureExample(preferences); break;
      case 'demo': await demo(); await openWorkbench(); break;
      case 'import': if (await importRecord()) await openWorkbench(); break;
      case 'export': await exportRecord(); break;
      case 'browse': await browseEntry(preferences); break;
      case 'cancel': cancelRun(); break;
      case 'edit-source': await editSource(config.entryPath); break;
      case 'reveal-error':
        syncSelection();
        pendingRevealError = true;
        pendingStage = undefined;
        await openWorkbench();
        if (record) send({ type: 'record', record, busy: isBusy(), selectedStageId });
        flushRevealError();
        break;
      default: throw new Error('未知侧栏操作');
    }
  }

  async function handle(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== 'object' || !('type' in raw)) throw new Error('无效工作台消息');
    const message = raw as WebviewMessage;
    switch (message.type) {
      case 'ready': ready = true; resolveReady?.(); state(); flushStage(); flushRevealError(); break;
      case 'stage-selected': mainStageSelected(message.recordId, message.stageId); break;
      case 'focus-sidebar': await vscode.commands.executeCommand('tilelangDevkit.launcher.focus'); break;
      case 'edit-source': await editSource(config.entryPath); break;
      case 'compile': await compile(message.config); break;
      case 'cancel': cancelRun(); break;
      case 'import': await importRecord(); break;
      case 'export': await exportRecord(); break;
      case 'demo': await demo(); break;
      case 'restore': {
        available();
        const previous = await task.restore();
        if (previous) await replaceRecord(previous);
        else send({ type: 'notice', message: '没有已保存的编译记录。' });
        break;
      }
      case 'browse': {
        await browseEntry();
        break;
      }
      case 'example':
        await configureExample();
        break;
      case 'copy':
        if (typeof message.text !== 'string' || Buffer.byteLength(message.text) > 64 * 1024 * 1024) throw new Error('复制内容无效或超过 64 MiB');
        await vscode.env.clipboard.writeText(message.text);
        send({ type: 'notice', message: '已复制代码。' });
        break;
      default: throw new Error('未知工作台消息');
    }
  }

  function showError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[workbench] ${message}`);
    send({ type: 'error', message });
    sidebar.showError(message);
    if (!panel || !ready) void vscode.window.showErrorMessage(message);
  }

  function attach(current: vscode.WebviewPanel): void {
    panel = current;
    workbenchOpenCount += 1;
    ready = false;
    readyPromise = new Promise(resolve => { resolveReady = resolve; });
    current.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
    current.webview.onDidReceiveMessage(message => { void handle(message).catch(showError); }, undefined, context.subscriptions);
    let wasVisible = current.visible;
    current.onDidChangeViewState(() => {
      if (panel !== current || current.visible === wasVisible) return;
      wasVisible = current.visible;
      if (current.visible) {
        // A quick reveal can reuse the document before VS Code deallocates it;
        // request a handshake in both the retained and recreated cases.
        void current.webview.postMessage({ type: 'request-ready' } satisfies HostMessage);
        return;
      }
      // Hidden workbenches release their webview document. Queue navigation
      // until the recreated document acknowledges readiness on reveal.
      ready = false;
      readyPromise = new Promise(resolve => { resolveReady = resolve; });
    }, undefined, context.subscriptions);
    current.onDidDispose(() => {
      if (panel !== current) return;
      panel = undefined;
      ready = false;
      pendingRevealError = false;
      pendingStage = undefined;
      // The viewer is optional; compilation is controlled from the sidebar.
      sidebar.refresh();
    }, undefined, context.subscriptions);
    const nonce = randomBytes(24).toString('base64');
    const js = current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'));
    const css = current.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.css'));
    current.webview.html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${current.webview.cspSource} 'nonce-${nonce}'; font-src ${current.webview.cspSource}; img-src ${current.webview.cspSource} data:;"><link rel="stylesheet" href="${css}"><title>TileLang DevKit · Lower Trace</title></head><body data-nonce="${nonce}"><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }

  async function openWorkbench(preserveFocus = false): Promise<void> {
    if (panel) { panel.reveal(panel.viewColumn, preserveFocus); return; }
    const viewColumn = vscode.window.activeTextEditor || vscode.window.visibleTextEditors.length
      ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    attach(vscode.window.createWebviewPanel('tilelangDevkit.workbench', 'Lower Trace · TileLang DevKit', { viewColumn, preserveFocus }, { enableScripts: true }));
  }

  context.subscriptions.push(
    sidebar,
    vscode.window.registerWebviewViewProvider('tilelangDevkit.launcher', sidebar),
    vscode.commands.registerCommand('tilelangDevkit.open', () => openWorkbench().catch(showError)),
    vscode.commands.registerCommand('tilelangDevkit.focus', () => vscode.commands.executeCommand('tilelangDevkit.launcher.focus')),
    ...(['use-current', 'example', 'demo', 'import', 'export', 'reveal-error'] as const).map(action =>
      vscode.commands.registerCommand(`tilelangDevkit.${action}`, () => handleSidebarAction(action).catch(showError))),
    vscode.window.registerWebviewPanelSerializer('tilelangDevkit.workbench', { async deserializeWebviewPanel(restored) {
      try { record = await task.restore(); } catch (error) { output.appendLine(String(error)); }
      syncSelection();
      attach(restored);
      sidebar.refresh();
    } }),
    vscode.workspace.onDidGrantWorkspaceTrust(state),
    vscode.window.onDidChangeActiveTextEditor(() => sidebar.refresh()),
    vscode.workspace.onDidSaveTextDocument(() => sidebar.refresh()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('tilelangDevkit.pythonPath')) { config = { ...config, pythonPath: vscode.workspace.getConfiguration('tilelangDevkit').get('pythonPath', 'python') }; configRevision += 1; state(); }
    }),
    { dispose: () => { cancelRun(); panel?.dispose(); if (publishTimer) clearTimeout(publishTimer); } },
  );
  try { record = await task.restore(); } catch (error) { output.appendLine(`无法恢复旧记录：${String(error)}`); }
  syncSelection();
  sidebar.refresh();
  const api = { openWorkbench, waitForWebviewReady: () => readyPromise };
  if (context.extensionMode === vscode.ExtensionMode.Test) return {
    ...api,
    importRecordForTest: replaceRecord,
    getRecordForTest: () => record,
    compileForTest: compile,
    cancelForTest: cancelRun,
    waitForSidebarReady: () => sidebar.whenReady(),
    getSidebarStateForTest: sidebarState,
    invokeSidebarActionForTest: handleSidebarAction,
    invokeSidebarMessageForTest: handleSidebarMessage,
    getSelectedStageIdForTest: () => selectedStageId,
    getStageRevealCountForTest: () => stageRevealCount,
    mainStageSelectedForTest: mainStageSelected,
    getConfigForTest: () => structuredClone(config),
    getWorkbenchOpenCountForTest: () => workbenchOpenCount,
    getErrorRevealCountForTest: () => errorRevealCount,
    closeWorkbenchForTest: () => panel?.dispose(),
  };
  return api;
}

export async function deactivate(): Promise<void> { await activeTask?.dispose(); activeTask = undefined; }
