import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { SidebarAction, SidebarHostMessage, SidebarMessage, SidebarState } from '../shared/sidebar';

const actions = new Set<SidebarAction>(['open', 'use-current', 'example', 'demo', 'import', 'export', 'reveal-error', 'browse', 'cancel', 'edit-source']);

/** Compilation controls and navigation; the extension host owns task lifetime. */
export class TraceSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'tilelangDevkit.launcher';

  private view?: vscode.WebviewView;
  private viewSubscriptions: vscode.Disposable[] = [];
  private ready = false;
  private disposed = false;
  private pendingFeedback?: Extract<SidebarHostMessage, { type: 'sidebar-error' | 'sidebar-notice' }>;
  private resolveReady?: () => void;
  private readyPromise: Promise<void>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getState: () => SidebarState,
    private readonly onMessage: (message: Exclude<SidebarMessage, { type: 'ready' }>) => Promise<void>,
  ) {
    this.readyPromise = new Promise(resolve => { this.resolveReady = resolve; });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.disposed) return;
    this.releaseView();
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    this.viewSubscriptions.push(
      view.webview.onDidReceiveMessage(raw => {
        if (this.view !== view || this.disposed) return;
        void this.handle(raw).catch(error => this.showError(error instanceof Error ? error.message : String(error)));
      }),
      view.onDidChangeVisibility(() => {
        if (this.view === view && view.visible) this.refresh();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.releaseView();
      }),
    );
    view.webview.html = this.html(view.webview);
  }

  refresh(): void {
    if (this.disposed || !this.view || !this.ready) return;
    try {
      this.post({ type: 'sidebar-state', state: this.getState() });
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    }
  }

  showError(message: string): void {
    if (this.disposed) return;
    this.pendingFeedback = { type: 'sidebar-error', message };
    this.post(this.pendingFeedback);
  }

  showNotice(message: string): void {
    if (this.disposed) return;
    this.pendingFeedback = { type: 'sidebar-notice', message };
    this.post(this.pendingFeedback);
  }

  whenReady(): Promise<void> { return this.readyPromise; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseView();
    // Release teardown waiters; disposing this provider never touches a task.
    this.resolveReady?.();
    this.resolveReady = undefined;
  }

  private releaseView(): void {
    this.view = undefined;
    this.ready = false;
    this.viewSubscriptions.splice(0).forEach(subscription => subscription.dispose());
    // Keep an unresolved waiter across reconstruction. Once an earlier view
    // completed its handshake, a replacement needs its own ready handshake.
    if (!this.resolveReady) this.readyPromise = new Promise(resolve => { this.resolveReady = resolve; });
  }

  private async handle(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('无效的侧栏消息');
    const message = raw as { type?: unknown; action?: unknown; recordId?: unknown; stageId?: unknown; entryPath?: unknown };
    if (message.type === 'ready') {
      this.ready = true;
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.refresh();
      if (this.pendingFeedback) this.post(this.pendingFeedback);
      return;
    }
    const validAction = message.type === 'action' && typeof message.action === 'string' && actions.has(message.action as SidebarAction);
    const validSelection = message.type === 'select-stage' && typeof message.recordId === 'string' && typeof message.stageId === 'string';
    const validSource = message.type === 'edit-source' && typeof message.entryPath === 'string';
    if (!validAction && !validSelection && !validSource && message.type !== 'compile') {
      throw new Error('未知的侧栏操作');
    }
    this.pendingFeedback = undefined;
    // CompileConfig is validated by the same host entry used by commands/tests.
    await this.onMessage(raw as Exclude<SidebarMessage, { type: 'ready' }>);
    this.refresh();
  }

  private post(message: SidebarHostMessage): void {
    if (!this.view || !this.ready || this.disposed) return;
    try {
      // VS Code may tear down a hidden webview between the check and delivery.
      // Its next ready event requests a fresh summary from getState().
      void Promise.resolve(this.view.webview.postMessage(message)).catch(() => {});
    } catch { /* View disposed during delivery. */ }
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(24).toString('base64');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'sidebar.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'sidebar.css'));
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:;"><link rel="stylesheet" href="${css}"><title>TileLang DevKit · Lower Trace</title></head><body data-nonce="${nonce}"><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
  }
}
