import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordEventStream, applyEvent, emptyRecord, endIncomplete, EventDecoder, parseRecord, previousStage, validateConfig } from '../src/shared/record';
import type { CompileConfig, Kernel, Stage } from '../src/shared/model';
import { createSidebarState, validateSidebarPreferences } from '../src/shared/sidebar';

const config: CompileConfig = { entryPath: '/example.py', scriptArgs: ['--size', '128'], pythonPath: 'python', workingDirectory: '', disableCache: true };
function stage(id: string, sequence: number, overrides: Partial<Stage> = {}): Stage {
  return { id, sequence, kind: 'pass', name: 'Simplify', phase: 'pipeline_cpu', parentId: null, depth: 0, status: 'succeeded', beforeText: 'a', afterText: 'b', beforeLanguage: 'python', afterLanguage: 'python', durationMs: 1, changed: true, added: 1, deleted: 1, ...overrides };
}
function record() {
  const r = emptyRecord('run', config, '<script>源码</script>');
  r.status = 'succeeded';
  r.kernels = [{ id: 'k', name: 'main', symbol: 'main', status: 'succeeded', cache: 'disabled', cacheSource: 'disabled', stages: [stage('a', 0), stage('b', 1), stage('c', 2)] }];
  return r;
}

test('portable JSON roundtrip preserves exact source, IR, errors and provenance', () => {
  const r = record();
  r.kernels[0].stages[1].afterText = '中文\n\t"text"\r\n<script>alert(1)</script>';
  r.kernels[0].stages[2].kind = 'jit';
  r.error = { phase: 'codegen', message: 'error', traceback: 'trace\nlast frame', stageId: 'b' };
  assert.deepEqual(parseRecord(JSON.stringify(r)), r);
});

test('legacy v1 source-only Ascend records remain readable without script metadata', () => {
  const r = record();
  r.entry = { path: '/old/ascend_example.py', function: 'vector_add', kwargs: { N: 128 }, source: '# original Ascend source\n' };
  r.environment = { python: '3.12', tilelangVersion: '0.1.15', tilelangPath: '/old/tilelang', target: { kind: 'ascend', arch: 'dav-3510' } };
  r.kernels[0].cache = 'not-applicable';
  delete r.kernels[0].cacheSource;
  assert.deepEqual(parseRecord(JSON.stringify(r)), r);
});

test('reject unsupported version, invalid parent, duplicate identity and malformed status', () => {
  for (const mutate of [
    (r: any) => { r.schemaVersion = 2; },
    (r: any) => { r.kernels[0].stages[1].parentId = 'missing'; },
    (r: any) => { r.kernels[0].stages[1].id = 'a'; },
    (r: any) => { r.kernels[0].stages[1].sequence = 0; },
    (r: any) => { r.status = 'maybe'; },
    (r: any) => { r.kernels[0].stages[1].durationMs = -1; },
  ]) { const r = record(); mutate(r); assert.throws(() => parseRecord(JSON.stringify(r))); }
});

test('repeated pass names retain identity and parent ordering while finishing out of order', () => {
  let r = emptyRecord('run', config, '');
  const kernel: Kernel = { id: 'k', name: 'main', symbol: 'main', status: 'running', cache: 'not-applicable', stages: [] };
  r = applyEvent(r, { type: 'kernel', kernel });
  for (const s of [stage('outer', 0, { status: 'running', afterText: null }), stage('inner', 1, { parentId: 'outer', depth: 1 }), stage('outer', 0)]) {
    r = applyEvent(r, { type: 'stage', kernelId: 'k', stage: s });
  }
  assert.deepEqual(r.kernels[0].stages.map(s => s.id), ['outer', 'inner']);
  assert.equal(r.kernels[0].stages[0].status, 'succeeded');
  assert.equal(parseRecord(JSON.stringify(r)).kernels[0].stages.length, 2);
});

test('previous stage uses full kernel order, never filtered search results or another kernel', () => {
  const r = record();
  assert.equal(previousStage(r.kernels[0], r.kernels[0].stages[2])?.id, 'b');
  assert.equal(previousStage(r.kernels[0], r.kernels[0].stages[0]), undefined);
});

test('incremental decoder handles split UTF-8, partial tail and keeps events before malformed line', () => {
  const decoder = new EventDecoder();
  const first = Buffer.from('{"message":"中文"}\n');
  assert.deepEqual([...decoder.push(first.subarray(0, 14))], []);
  assert.deepEqual([...decoder.push(first.subarray(14))], [{ message: '中文' }]);
  const captured: unknown[] = [];
  assert.throws(() => { for (const event of decoder.push(Buffer.from('{"ok":true}\nINVALID\n'))) captured.push(event); });
  assert.deepEqual(captured, [{ ok: true }]);
  assert.deepEqual([...decoder.push(Buffer.from('{"unfinished":'))], []);
  assert.equal(decoder.hasPartialLine, true);
});

test('cancellation preserves finished data and pending kernel state', () => {
  const r = record();
  r.kernels[0].status = 'running';
  r.kernels[0].stages[2].status = 'running';
  r.kernels[0].stages[2].afterText = null;
  r.kernels.push({ id: 'later', name: 'later', symbol: 'later', status: 'pending', cache: 'not-applicable', stages: [] });
  endIncomplete(r, 'cancelled');
  assert.equal(r.kernels[0].stages[0].afterText, 'b');
  assert.equal(r.kernels[0].stages[2].status, 'cancelled');
  assert.equal(r.kernels[1].status, 'pending');
  assert.equal(parseRecord(JSON.stringify(r)).status, 'cancelled');
});

test('configuration preserves literal script argv and rejects malformed command settings', () => {
  assert.deepEqual(validateConfig(config), config);
  const literal = { ...config, scriptArgs: ['arg with spaces', '$(not-a-command)', '--size=128'] };
  assert.deepEqual(validateConfig(literal), literal);
  assert.throws(() => validateConfig({ ...config, scriptArgs: '--size 128' }));
  assert.throws(() => validateConfig({ ...config, scriptArgs: [128] }));
  assert.throws(() => validateConfig({ ...config, scriptArgs: ['a\0b'] }));
  assert.throws(() => validateConfig({ ...config, workingDirectory: 42 }));
  assert.throws(() => validateConfig({ ...config, disableCache: 'yes' }));
  assert.throws(() => validateConfig({ ...config, entryPath: 'x\0.py' }));
});

test('entry selection validates only retained preferences and permits unfinished Python drafts', () => {
  const preferences = { pythonPath: '/a venv/bin/python', disableCache: false };
  assert.deepEqual(validateSidebarPreferences({ ...preferences, entryPath: null, scriptArgs: 'broken JSON' }), preferences);
  assert.deepEqual(validateSidebarPreferences({ pythonPath: '', disableCache: true }), { pythonPath: '', disableCache: true });
  assert.equal(validateSidebarPreferences(undefined), undefined, 'Commands can retain the host configuration');
  for (const invalid of [null, [], 42, { ...preferences, pythonPath: 42 }, { ...preferences, pythonPath: 'bad\0python' }, { ...preferences, disableCache: 'false' }]) {
    assert.throws(() => validateSidebarPreferences(invalid));
  }
  const detached = validateSidebarPreferences(preferences)!;
  detached.pythonPath = 'view edit';
  assert.equal(preferences.pythonPath, '/a venv/bin/python');
});

test('incremental cache outcome preserves whether a hit came from disk or memory', () => {
  const r = record();
  applyEvent(r, { type: 'kernel-update', kernelId: 'k', patch: { cache: 'hit', cacheSource: 'disk' } });
  assert.equal(parseRecord(JSON.stringify(r)).kernels[0].cacheSource, 'disk');
  applyEvent(r, { type: 'kernel-update', kernelId: 'k', patch: { cache: 'hit', cacheSource: 'memory' } });
  assert.equal(parseRecord(JSON.stringify(r)).kernels[0].cacheSource, 'memory');
});

test('invalid incremental references cannot corrupt the last recoverable record', () => {
  const r = record();
  const original = JSON.stringify(r);
  for (const s of [stage('bad', 0), stage('bad', 3, { parentId: 'missing', depth: 1 })]) {
    assert.throws(() => applyEvent(r, { type: 'stage', kernelId: 'k', stage: s }));
    assert.equal(JSON.stringify(r), original);
  }
  assert.throws(() => applyEvent(r, { type: 'kernel', kernel: { ...r.kernels[0], id: 'other' } }));
  assert.equal(JSON.stringify(r), original);
  assert.doesNotThrow(() => parseRecord(JSON.stringify(r)));
});

test('sidebar summary contains portable metadata without copying IR, source, logs or traceback', () => {
  const r = record();
  r.entry.path = 'C:\\project\\example.py';
  r.error = { message: 'native compile failed', phase: 'native_compile', stageId: 'b', traceback: 'private traceback payload' };
  const currentFile = { path: '/workspace/current.py', name: 'current.py' };
  const summary = createSidebarState(r, false, true, currentFile, config, 'b', 3);
  assert.equal(summary.record?.fileName, 'example.py');
  assert.equal(summary.record?.stageCount, 3);
  assert.equal(summary.record?.kernelCount, 1);
  assert.deepEqual(summary.record?.error, { message: 'native compile failed', phase: 'native_compile', stageId: 'b' });
  assert.doesNotMatch(JSON.stringify(summary), /private traceback payload|<script>|beforeText|afterText|"logs"|"source"/);
  assert.equal(summary.selectedStageId, 'b');
  assert.equal(summary.configRevision, 3);
  summary.record!.error!.message = 'changed in view';
  summary.currentFile!.name = 'changed.py';
  summary.config.scriptArgs.push('local edit');
  assert.equal(r.error.message, 'native compile failed');
  assert.equal(currentFile.name, 'current.py');
  assert.deepEqual(config.scriptArgs, ['--size', '128']);
  r.error.message = 'compiler output '.repeat(1000);
  const concise = createSidebarState(r, false, true, null).record!.error!.message;
  assert.equal(concise, `${r.error.message.slice(0, 512)}…`);
  assert.ok(r.error.message.length > concise.length, 'The full diagnostic remains in the record');
});

test('sidebar summary retains stage-only diagnostics and represents an empty untrusted workspace', () => {
  const r = record();
  r.kernels[0].stages[1].error = { message: 'failed pass', phase: 'Simplify' };
  const summary = createSidebarState(r, true, false, null);
  assert.deepEqual(summary.record?.error, { message: 'failed pass', phase: 'Simplify', stageId: 'b' });
  assert.equal(summary.busy, true);
  assert.equal(summary.trusted, false);
  assert.deepEqual(createSidebarState(null, false, false, null, config), {
    busy: false, trusted: false, currentFile: null, record: null, config, configRevision: 0, selectedStageId: null,
  });
});

test('sidebar navigation orders repeated passes per kernel and preserves unchanged and cache stages', () => {
  const r = record();
  r.kernels[0].stages = [stage('c', 2, { changed: false }), stage('a', 0), stage('b', 1)];
  r.kernels.push({ id: 'next', name: 'main', symbol: 'main', status: 'succeeded', cache: 'hit', cacheSource: 'memory', stages: [stage('cached', 3, { kind: 'cache' })] });
  const stages = createSidebarState(r, false, true, null).record!.stages;
  assert.deepEqual(stages.map(s => [s.id, s.kernelId, s.occurrence, s.repetitions]), [
    ['a', 'k', 1, 3], ['b', 'k', 2, 3], ['c', 'k', 3, 3], ['cached', 'next', 1, 1],
  ]);
  assert.equal(stages[2].changed, false);
  assert.equal(stages[3].cache, 'hit');
  assert.equal(stages[3].kind, 'cache');
  assert.equal(stages[3].kernelIndex, 2);
  stages[0].name = 'view edit';
  assert.equal(r.kernels[0].stages[1].name, 'Simplify');
});


test('indexed stream matches full validation for nested and out-of-order updates', () => {
  const initial = emptyRecord('run', config, '');
  const stream = new RecordEventStream(structuredClone(initial));
  let baseline = initial;
  const events = [
    { type: 'kernel', kernel: { id: 'k', name: 'main', symbol: 'main', status: 'running', cache: 'disabled', stages: [] } },
    { type: 'stage', kernelId: 'k', stage: stage('outer', 0, { status: 'running' }) },
    { type: 'stage', kernelId: 'k', stage: stage('inner', 2, { parentId: 'outer', depth: 1 }) },
    { type: 'stage', kernelId: 'k', stage: stage('middle', 1) },
    { type: 'stage', kernelId: 'k', stage: stage('outer', 0) },
    { type: 'stage', kernelId: 'k', stage: stage('middle', 3) },
    { type: 'kernel-update', kernelId: 'k', patch: { status: 'succeeded' } },
  ];
  for (const event of events) {
    baseline = applyEvent(baseline, structuredClone(event));
    assert.deepEqual(stream.apply(structuredClone(event)), baseline);
  }
});

test('indexed validation rejects collisions and broken children without mutating the record', () => {
  const initial = record();
  initial.kernels[0].stages[1] = stage('b', 1, { parentId: 'a', depth: 1 });
  initial.kernels.push({ id: 'other', name: 'other', symbol: 'other', status: 'running', cache: 'unknown', stages: [] });
  const stream = new RecordEventStream(initial);
  const snapshot = JSON.stringify(initial);
  for (const event of [
    { type: 'stage', kernelId: 'other', stage: stage('a', 4) },
    { type: 'stage', kernelId: 'k', stage: stage('other', 4) },
    { type: 'stage', kernelId: 'k', stage: stage('new', 1) },
    { type: 'stage', kernelId: 'other', stage: stage('new', 4, { parentId: 'a', depth: 1 }) },
    { type: 'stage', kernelId: 'k', stage: stage('a', 0, { depth: 2 }) },
    { type: 'stage', kernelId: 'k', stage: stage('a', 5) },
    { type: 'stage', kernelId: 'k', stage: stage('new', 4, { parentId: 'missing', depth: 1 }) },
  ]) {
    assert.throws(() => stream.apply(event));
    assert.equal(JSON.stringify(stream.record), snapshot);
  }
  const replacement = record();
  replacement.kernels[0].stages = [];
  stream.apply({ type: 'record', record: replacement });
  stream.apply({ type: 'stage', kernelId: 'k', stage: stage('a', 0) });
  assert.equal(stream.record.kernels[0].stages.length, 1);
});
