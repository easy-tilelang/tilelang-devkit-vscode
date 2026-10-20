import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { CompileConfig, HostMessage, Stage, TraceRecord, WebviewMessage } from '../src/shared/model';
import { RecordPublisher } from '../src/shared/record-update';
import { createSidebarState, type SidebarHostMessage, type SidebarMessage, type SidebarState } from '../src/shared/sidebar';

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page, context }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  const observe = (target: Page) => {
    target.on('pageerror', error => errors.push(error.message));
    target.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy|Refused to (apply|load|execute)/i.test(message.text())) errors.push(message.text());
    });
  };
  observe(page);
  context.on('page', observe);
});
test.afterEach(({ page }) => expect(browserErrors.get(page)).toEqual([]));

declare global {
  interface Window {
    __tracePreview: {
      ready: boolean;
      copied: string;
      record: TraceRecord;
      exported: TraceRecord | null;
      messages: WebviewMessage[];
      send(message: HostMessage): void;
      setRecord(record: TraceRecord): void;
      setTheme(name: string): void;
    };
    __sidebarPreview: {
      ready: boolean;
      state: SidebarState;
      record: TraceRecord | null;
      nextBrowsePath: string | null | undefined;
      nextSourceOpenError: string | null;
      openedSources: string[];
      setRecord(record: TraceRecord): void;
      messages: SidebarMessage[];
      setState(state: SidebarState): void;
      send(message: SidebarHostMessage): void;
      setTheme(name: string): void;
    };
  }
}

function stage(id: string, sequence: number, name: string, beforeText: string | null, afterText: string | null): Stage {
  return { id, sequence, kind: 'pass', name, phase: 'Lower', parentId: null, depth: 0,
    status: 'succeeded', beforeText, afterText, beforeLanguage: 'python', afterLanguage: 'python',
    durationMs: 0.125, changed: beforeText !== afterText, added: null, deleted: null };
}

function fixture(): TraceRecord {
  return {
    schemaVersion: 1, id: 'browser-test-fixture', provenance: 'mock', createdAt: '2000-01-01T00:00:00Z',
    status: 'succeeded', durationMs: 3,
    entry: { path: '/offline/example.py', function: '__main__', kwargs: {}, mode: 'script', args: ['--size', '128'], cwd: '/offline', source: 'def vector_add(N):\n    return kernel\n\nif __name__ == "__main__":\n    print("mock script")\n' },
    environment: { python: '3.11', tilelangVersion: '0.1.15', tilelangPath: '/offline/tilelang', target: { kind: 'c' }, executionBackend: 'cython', compilationMode: 'jit' },
    kernels: [
      { id: 'kernel-a', name: 'vector_add', symbol: 'main', status: 'succeeded', cache: 'disabled', cacheSource: 'disabled', stages: [
        { ...stage('source', 0, 'Python source', null, 'def vector_add(N):\n    return kernel\n'), kind: 'source' },
        { ...stage('frontend', 1, 'Initial IR', null, 'initial_ir = 0\n'), kind: 'frontend' },
        stage('pass-a', 2, 'Simplify', 'initial_ir = 0\n', 'previous_stage_output = 1\n'),
        stage('pass-b', 3, 'Simplify', 'own_pass_input = 2\n', 'selected_stage_output = 3\n'),
        stage('unchanged', 4, 'VerifyMemory', 'selected_stage_output = 3\n', 'selected_stage_output = 3\n'),
        { ...stage('codegen', 5, 'C source', null, 'int main_kernel(float* a) { return 0; }\n'), kind: 'codegen', afterLanguage: 'cpp' },
        { ...stage('jit-load', 6, 'module_load', null, 'mock native module loaded\n'), kind: 'jit', afterLanguage: 'text' },
      ] },
      { id: 'kernel-b', name: 'vector_add', symbol: 'main', status: 'succeeded', cache: 'hit', cacheSource: 'memory', stages: [
        { ...stage('cached', 7, 'Cached source', null, 'cached_kernel = 1\n'), kind: 'cache' },
      ] },
    ],
    logs: [{ timestamp: '2000-01-01T00:00:00Z', stream: 'system', text: 'This is a clearly marked mock record.' }],
  };
}

const config: CompileConfig = { entryPath: '/workspace/current.py', pythonPath: 'python', scriptArgs: [], workingDirectory: '', disableCache: true };

async function load(page: Page, record = fixture(), stageId = 'pass-a') {
  await page.goto('/');
  await page.waitForFunction(() => window.__tracePreview?.ready);
  await page.evaluate(record => window.__tracePreview.setRecord(record), record);
  if (record.kernels.length) await selectStage(page, record.id, stageId);
}

async function selectStage(page: Page, recordId: string, stageId: string) {
  await page.evaluate(({ recordId, stageId }) => window.__tracePreview.send({ type: 'reveal-stage', recordId, stageId }), { recordId, stageId });
}

function sidebarFixture(record = fixture()): SidebarState {
  return createSidebarState(record, false, true, { path: '/workspace/current.py', name: 'current.py' }, config, 'pass-a', 1);
}

async function loadSidebar(page: Page, state = sidebarFixture()) {
  await page.setViewportSize({ width: 340, height: 950 });
  await page.goto('/sidebar');
  await page.waitForFunction(() => window.__sidebarPreview?.ready);
  await page.evaluate(state => window.__sidebarPreview.setState(state), state);
  await expect(page.getByTestId('sidebar-entry-path')).toBeVisible();
}

function item(page: Page, id: string) {
  return page.locator(`[data-testid="sidebar-stage-item"][data-stage-id="${id}"]`);
}

test('central viewer follows record and stage identity without exposing compilation controls', async ({ page }) => {
  await load(page);
  await expect(page.getByText(/mock/i).first()).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('previous_stage_output');
  await selectStage(page, fixture().id, 'cached');
  await expect(page.locator('.cm-content')).toContainText('cached_kernel');
  await selectStage(page, 'stale-record', 'pass-b');
  await expect(page.locator('.cm-content')).toContainText('cached_kernel');
  for (const id of ['compile-button', 'stage-search', 'import-button', 'export-button']) await expect(page.getByTestId(id)).toHaveCount(0);
  await page.getByTestId('focus-sidebar').click();
  await expect.poll(() => page.evaluate(() => window.__tracePreview.messages.some(message => message.type === 'focus-sidebar'))).toBe(true);
});

test('previous-stage diff remains distinct from this pass input after sidebar filtering', async ({ page, context }) => {
  await load(page, fixture(), 'pass-b');
  await page.getByTestId('diff-tab').click();
  await page.getByTestId('diff-mode').selectOption('previous');
  await expect(page.locator('.cm-content').first()).toContainText('previous_stage_output');
  await expect(page.locator('.cm-content').last()).toContainText('selected_stage_output');
  await expect(page.locator('.cm-changedLine, .cm-insertedLine, .cm-deletedLine').first()).toBeVisible();
  const sidebar = await context.newPage();
  await loadSidebar(sidebar, { ...sidebarFixture(), selectedStageId: 'pass-b' });
  await sidebar.getByTestId('sidebar-stage-search').fill('Simplify');
  await expect(sidebar.getByTestId('sidebar-stage-item')).toHaveCount(2);
  expect(await sidebar.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'select-stage'))).toEqual([]);
  await expect(page.locator('.cm-content').first()).toContainText('previous_stage_output');
  await page.getByTestId('diff-mode').selectOption('pass');
  await expect(page.locator('.cm-content').first()).toContainText('own_pass_input');
  await expect(page.locator('.cm-content').last()).toContainText('selected_stage_output');
});

test('keyboard navigation updates host selection and copy and wrap use the selected code', async ({ page }) => {
  await load(page);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.cm-content')).toContainText('selected_stage_output');
  await expect.poll(() => page.evaluate(() => window.__tracePreview.messages.filter(message => message.type === 'stage-selected').at(-1))).toEqual({ type: 'stage-selected', recordId: fixture().id, stageId: 'pass-b' });
  await page.getByTestId('copy-button').click();
  await expect.poll(() => page.evaluate(() => window.__tracePreview.copied)).toBe('selected_stage_output = 3\n');
  const editor = page.locator('.cm-content');
  const originalWrap = await editor.evaluate(node => getComputedStyle(node).whiteSpace);
  await page.getByTestId('wrap-toggle').click();
  await expect.poll(() => editor.evaluate(node => getComputedStyle(node).whiteSpace)).not.toBe(originalWrap);
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('.cm-content')).toContainText('previous_stage_output');
});

test('failure retains input and error reveal opens diagnostics without inventing deleted output', async ({ page }) => {
  const record = fixture();
  record.status = 'failed'; record.kernels = [record.kernels[0]]; record.kernels[0].status = 'failed';
  const failure = stage('failure', 7, 'FailingPass', 'retained_failure_input = 9\n', null);
  failure.status = 'failed'; failure.changed = null; failure.durationMs = null;
  failure.error = { phase: 'Lower', message: 'intentional invalid buffer scope', traceback: 'Traceback (most recent call last):\nValueError: intentional invalid buffer scope', stageId: 'failure' };
  record.kernels[0].stages.push(failure); record.error = failure.error;
  await load(page, record, 'failure');
  await expect(page.locator('.cm-content')).toContainText('retained_failure_input');
  await page.getByTestId('diff-tab').click();
  await expect(page.locator('.cm-deletedLine')).toHaveCount(0);
  await selectStage(page, record.id, 'pass-a');
  await page.evaluate(() => window.__tracePreview.send({ type: 'reveal-error' }));
  await expect(page.locator('.cm-content')).toContainText('retained_failure_input');
  await expect(page.getByRole('log')).toBeVisible();
  await expect(page.getByRole('log')).toContainText('ValueError: intentional invalid buffer scope');
});

test('script without kernels retains source and distinguishes success from failure', async ({ page }) => {
  const record = fixture(); record.kernels = [];
  await load(page, record);
  await expect(page.getByTestId('no-jit-banner')).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('__main__');
  record.status = 'failed';
  record.error = { phase: 'script', message: 'Script failed before compiling', traceback: 'Traceback:\nValueError: Script failed before compiling' };
  await page.evaluate(record => window.__tracePreview.setRecord(record), record);
  await expect(page.getByText('Script failed before compiling', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('def vector_add(N):');
  await page.getByTestId('copy-button').click();
  await expect.poll(() => page.evaluate(() => window.__tracePreview.copied)).toBe(record.entry.source);
});

test('central light and dark themes and narrow details remain usable', async ({ page }, testInfo) => {
  await load(page, fixture(), 'pass-b');
  await page.getByTestId('diff-tab').click();
  await page.screenshot({ path: testInfo.outputPath('viewer-dark.png'), fullPage: true });
  await page.evaluate(() => window.__tracePreview.setTheme('light'));
  await expect(page.locator('body')).toHaveClass('vscode-light');
  await page.screenshot({ path: testInfo.outputPath('viewer-light.png'), fullPage: true });
  await page.setViewportSize({ width: 680, height: 850 });
  await page.getByTestId('details-toggle').click();
  await expect(page.getByTestId('code-tab')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('viewer-narrow.png'), fullPage: true });
});

test('sidebar offline actions remain available in an untrusted workspace', async ({ page }) => {
  await loadSidebar(page, { ...sidebarFixture(), trusted: false, currentFile: null, record: null });
  await expect(page.getByTestId('sidebar-empty')).toBeVisible();
  await expect(page.getByTestId('sidebar-use-current')).toBeDisabled();
  await expect(page.getByTestId('sidebar-compile')).toBeDisabled();
  await expect(page.getByTestId('sidebar-export')).toBeDisabled();
  for (const action of ['open', 'demo']) {
    await expect(page.getByTestId(`sidebar-${action}`)).toBeEnabled();
    await page.getByTestId(`sidebar-${action}`).click();
  }
  await expect(page.getByTestId('sidebar-import')).toBeEnabled();
  const actions = await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'action').map(message => message.action));
  expect(actions).toEqual(['open', 'demo']);
  await page.getByTestId('sidebar-example').click();
  await expect(page.getByTestId('sidebar-notice')).toBeVisible();
  await expect(page.getByTestId('sidebar-compile')).toBeDisabled();
  expect(await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'compile'))).toEqual([]);
});

test('sidebar draft survives streaming updates and sends literal argv and cwd', async ({ page }) => {
  const state = sidebarFixture();
  await loadSidebar(page, state);
  await page.getByTestId('sidebar-config-toggle').click();
  await page.getByTestId('sidebar-entry-path').fill('/workspace/custom script.py');
  await page.getByTestId('sidebar-python-path').fill('/venv/bin/python');
  await page.getByTestId('sidebar-script-args').fill('["--size", "128", "arg with spaces", "$(not-a-command)"]');
  await page.getByTestId('sidebar-working-directory').fill('/workspace/example with spaces');
  await page.getByTestId('sidebar-disable-cache').uncheck();
  await page.evaluate(state => window.__sidebarPreview.setState({ ...state, busy: true, record: { ...state.record!, status: 'running', durationMs: 99 } }), state);
  await expect(page.getByTestId('sidebar-entry-path')).toHaveValue('/workspace/custom script.py');
  await expect(page.getByTestId('sidebar-working-directory')).toHaveValue('/workspace/example with spaces');
  await page.evaluate(state => window.__sidebarPreview.setState(state), state);
  await page.getByTestId('sidebar-compile').click();
  const message = await page.evaluate(() => window.__sidebarPreview.messages.find(message => message.type === 'compile'));
  expect(message).toEqual({ type: 'compile', config: { entryPath: '/workspace/custom script.py', pythonPath: '/venv/bin/python', scriptArgs: ['--size', '128', 'arg with spaces', '$(not-a-command)'], workingDirectory: '/workspace/example with spaces', disableCache: false } });
  await page.evaluate(state => window.__sidebarPreview.setState({ ...state, configRevision: state.configRevision + 1, config: { ...state.config, entryPath: '/workspace/new.py', scriptArgs: ['--new'] } }), state);
  await expect(page.getByTestId('sidebar-entry-path')).toHaveValue('/workspace/new.py');
  await expect.poll(async () => JSON.parse(await page.getByTestId('sidebar-script-args').inputValue())).toEqual(['--new']);
});

test('CPU example preserves draft Python despite malformed old args and confirms every load', async ({ page }) => {
  await loadSidebar(page);
  await page.getByTestId('sidebar-config-toggle').click();
  await page.getByTestId('sidebar-python-path').fill('/custom venv/bin/python');
  await page.getByTestId('sidebar-script-args').fill('[broken old arguments');
  await page.getByTestId('sidebar-working-directory').fill('/old/workdir');
  await page.getByTestId('sidebar-disable-cache').uncheck();
  const beforeRecord = await page.evaluate(() => window.__sidebarPreview.record?.id);
  await page.getByTestId('sidebar-example').click();
  await expect(page.getByTestId('sidebar-notice')).toContainText('CPU');
  expect(await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'action').at(-1))).toEqual({
    type: 'action', action: 'example', preferences: { pythonPath: '/custom venv/bin/python', disableCache: false },
  });
  await expect(page.getByTestId('sidebar-python-path')).toHaveValue('/custom venv/bin/python');
  await expect.poll(async () => JSON.parse(await page.getByTestId('sidebar-script-args').inputValue())).toEqual(['--repeat', '1', '--verify']);
  await expect(page.getByTestId('sidebar-working-directory')).toHaveValue('');
  await expect(page.getByTestId('sidebar-disable-cache')).toBeChecked();
  expect(await page.evaluate(() => window.__sidebarPreview.openedSources.length)).toBe(1);
  expect(await page.evaluate(() => window.__sidebarPreview.record?.id)).toBe(beforeRecord);
  expect(await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'compile'))).toEqual([]);
  await page.getByTestId('sidebar-notice').getByRole('button').click();
  await expect(page.getByTestId('sidebar-notice')).toHaveCount(0);
  await page.getByTestId('sidebar-example').click();
  await expect(page.getByTestId('sidebar-notice')).toBeVisible();
  const opened = await page.evaluate(() => window.__sidebarPreview.openedSources);
  expect(opened).toHaveLength(2);
  expect(opened[0]).toBe(opened[1]);
  await page.getByTestId('sidebar-compile').click();
  const compile = await page.evaluate(() => window.__sidebarPreview.messages.find(message => message.type === 'compile'));
  expect(compile).toMatchObject({ type: 'compile', config: { pythonPath: '/custom venv/bin/python', scriptArgs: ['--repeat', '1', '--verify'], disableCache: true, workingDirectory: '' } });
});

test('browse cancel preserves the draft and successful entry changes retain draft preferences', async ({ page }) => {
  await loadSidebar(page);
  await page.getByTestId('sidebar-config-toggle').click();
  await page.getByTestId('sidebar-entry-path').fill('/old/draft.py');
  await page.getByTestId('sidebar-python-path').fill('/selected/python');
  await page.getByTestId('sidebar-script-args').fill('invalid old args');
  await page.getByTestId('sidebar-working-directory').fill('/old/cwd');
  await page.getByTestId('sidebar-disable-cache').uncheck();
  const revision = await page.evaluate(() => window.__sidebarPreview.state.configRevision);
  await page.evaluate(() => { window.__sidebarPreview.nextBrowsePath = null; });
  await page.getByTestId('sidebar-browse').click();
  await expect(page.getByTestId('sidebar-entry-path')).toHaveValue('/old/draft.py');
  await expect(page.getByTestId('sidebar-script-args')).toHaveValue('invalid old args');
  await expect(page.getByTestId('sidebar-working-directory')).toHaveValue('/old/cwd');
  expect(await page.evaluate(() => window.__sidebarPreview.state.configRevision)).toBe(revision);
  await page.evaluate(() => { window.__sidebarPreview.nextBrowsePath = '/selected/new.py'; });
  await page.getByTestId('sidebar-browse').click();
  await expect(page.getByTestId('sidebar-entry-path')).toHaveValue('/selected/new.py');
  await expect(page.getByTestId('sidebar-python-path')).toHaveValue('/selected/python');
  await expect(page.getByTestId('sidebar-disable-cache')).not.toBeChecked();
  await expect.poll(async () => JSON.parse(await page.getByTestId('sidebar-script-args').inputValue())).toEqual([]);
  await page.getByTestId('sidebar-python-path').fill('/another/python');
  await page.getByTestId('sidebar-script-args').fill('[still broken');
  await page.getByTestId('sidebar-use-current').click();
  await expect(page.getByTestId('sidebar-entry-path')).toHaveValue('/workspace/current.py');
  await expect(page.getByTestId('sidebar-python-path')).toHaveValue('/another/python');
  await expect(page.getByTestId('sidebar-disable-cache')).not.toBeChecked();
  expect(await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'action' && message.action === 'use-current').at(-1))).toEqual({
    type: 'action', action: 'use-current', preferences: { pythonPath: '/another/python', disableCache: false },
  });
});

test('example open failure preserves configuration and an empty Python draft can still load it', async ({ page }) => {
  await loadSidebar(page);
  const original = await page.evaluate(() => window.__sidebarPreview.state.config);
  await page.evaluate(() => { window.__sidebarPreview.nextSourceOpenError = 'Example source unavailable'; });
  await page.getByTestId('sidebar-example').click();
  await expect(page.getByTestId('sidebar-error')).toContainText('Example source unavailable');
  await expect(page.getByTestId('sidebar-notice')).toHaveCount(0);
  expect(await page.evaluate(() => window.__sidebarPreview.state.config)).toEqual(original);
  await page.getByTestId('sidebar-config-toggle').click();
  await page.getByTestId('sidebar-python-path').fill('');
  await page.getByTestId('sidebar-example').click();
  await expect(page.getByTestId('sidebar-notice')).toBeVisible();
  await expect(page.getByTestId('sidebar-python-path')).toHaveValue('');
  await expect(page.getByTestId('sidebar-compile')).toBeDisabled();
  expect(await page.evaluate(() => window.__sidebarPreview.openedSources)).toHaveLength(1);
});

test('sidebar search and kernel filters preserve repeated pass order and selected identity', async ({ page }) => {
  await loadSidebar(page);
  await expect(page.getByTestId('sidebar-stage-item')).toHaveCount(8);
  await page.getByTestId('sidebar-stage-search').fill('Simplify');
  await expect(page.getByTestId('sidebar-stage-item')).toHaveCount(2);
  expect(await page.getByTestId('sidebar-stage-item').evaluateAll(items => items.map(item => item.getAttribute('data-stage-id')))).toEqual(['pass-a', 'pass-b']);
  await item(page, 'pass-b').click();
  await expect(item(page, 'pass-b')).toHaveAttribute('aria-current', 'step');
  const message = await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'select-stage').at(-1));
  expect(message).toEqual({ type: 'select-stage', recordId: fixture().id, stageId: 'pass-b' });
  await page.getByTestId('sidebar-stage-search').fill('');
  await page.getByTestId('sidebar-hide-unchanged').click();
  await expect(item(page, 'unchanged')).toHaveCount(0);
  await page.getByTestId('sidebar-kernel-select').selectOption('kernel-b');
  await expect(page.getByTestId('sidebar-stage-item')).toHaveCount(1);
  await expect(item(page, 'cached')).toBeVisible();
  await item(page, 'cached').click();
  expect(await page.evaluate(() => window.__sidebarPreview.messages.filter(message => message.type === 'select-stage').at(-1))).toEqual({ type: 'select-stage', recordId: fixture().id, stageId: 'cached' });
});

test('sidebar running state blocks replacement and compile while preserving navigation and cancellation', async ({ page }) => {
  const state = sidebarFixture();
  await loadSidebar(page, { ...state, busy: true, record: { ...state.record!, status: 'running' } });
  for (const action of ['use-current', 'example', 'demo', 'import', 'browse']) await expect(page.getByTestId(`sidebar-${action}`)).toBeDisabled();
  await expect(page.getByTestId('sidebar-compile')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-export')).toBeEnabled();
  await item(page, 'pass-b').click();
  await page.getByTestId('sidebar-cancel').click();
  await expect.poll(() => page.evaluate(() => window.__sidebarPreview.messages.some(message => message.type === 'action' && message.action === 'cancel'))).toBe(true);
});

test('sidebar exported record imports offline with unchanged source and stages', async ({ page }, testInfo) => {
  await loadSidebar(page);
  await page.evaluate(record => window.__sidebarPreview.setRecord(record), fixture());
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('sidebar-export').click();
  const exportedPath = testInfo.outputPath('offline.tltrace.json');
  await (await downloadPromise).saveAs(exportedPath);
  expect(JSON.parse(await readFile(exportedPath, 'utf8'))).toEqual(fixture());
  await page.evaluate(() => window.__sidebarPreview.setRecord({ ...window.__sidebarPreview.record!, id: 'empty', kernels: [] }));
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('sidebar-import').click();
  await (await chooser).setFiles(exportedPath);
  await expect.poll(() => page.evaluate(() => window.__sidebarPreview.record?.id)).toBe(fixture().id);
  await expect(page.getByTestId('sidebar-stage-item')).toHaveCount(8);
});

test('sidebar error routing and dark and light layouts fit a narrow panel', async ({ page }, testInfo) => {
  const state = sidebarFixture();
  state.record!.status = 'failed';
  state.record!.error = { message: 'native compiler rejected input', phase: 'native_compile', stageId: 'jit-load' };
  await loadSidebar(page, state);
  await expect(page.getByText('native compiler rejected input')).toBeVisible();
  await page.getByTestId('sidebar-reveal-error').click();
  await expect.poll(() => page.evaluate(() => window.__sidebarPreview.messages.some(message => message.type === 'action' && message.action === 'reveal-error'))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sidebar-dark.png'), fullPage: true });
  await page.evaluate(() => window.__sidebarPreview.setTheme('light'));
  await expect(page.locator('body')).toHaveClass('vscode-light');
  await page.screenshot({ path: testInfo.outputPath('sidebar-light.png'), fullPage: true });
});


test('incremental records refresh selected code and logs, and missing baselines resync', async ({ page }) => {
  const record = fixture();
  await load(page, record);
  const publisher = new RecordPublisher();
  publisher.reset(record);
  const kernel = record.kernels[0];
  kernel.stages[2] = { ...kernel.stages[2], afterText: 'incremental_result = 42\n' };
  record.logs.push({ timestamp: '2000-01-01T00:00:01Z', stream: 'stdout', text: 'incremental log' });
  const message = { ...publisher.next(record), busy: false, selectedStageId: 'pass-a' };
  await page.evaluate(message => window.__tracePreview.send(message), message);
  await expect(page.getByTestId('code-editor')).toContainText('incremental_result = 42');
  await page.getByTestId('logs-toggle').click();
  await expect(page.getByRole('log')).toContainText('incremental log');
  const readyCount = await page.evaluate(() => window.__tracePreview.messages.filter(message => message.type === 'ready').length);
  // The duplicate log batch has the wrong offset and must request a full snapshot.
  await page.evaluate(message => window.__tracePreview.send(message), message);
  await expect.poll(() => page.evaluate(() => window.__tracePreview.messages.filter(message => message.type === 'ready').length)).toBe(readyCount + 1);
  await expect(page.getByTestId('code-editor')).toContainText('previous_stage_output = 1');
});
