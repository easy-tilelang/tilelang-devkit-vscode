import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CompilationTask } from '../src/host/task';
import { parseRecord } from '../src/shared/record';
import type { CompileConfig, TraceRecord } from '../src/shared/model';

const python = process.env.TRACE_TEST_PYTHON ?? 'python';
async function fixture(body: string, onChange?: (record: TraceRecord, task: CompilationTask) => void) {
  const base = path.resolve('artifacts', 'unit-tests');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'task-'));
  const entry = path.join(dir, 'entry with spaces.py');
  await fs.writeFile(entry, '# original source\n');
  const runner = path.join(dir, 'runner.py');
  await fs.writeFile(runner, `import argparse,json,time,os,signal\np=argparse.ArgumentParser()\np.add_argument('--request')\np.add_argument('--events')\na=p.parse_args()\nr=json.load(open(a.request))\nf=open(a.events,'a')\ndef emit(x):\n f.write(json.dumps(x)+'\\n');f.flush()\n${body}\n`);
  const task = new CompilationTask({ storagePath: dir, runnerPath: runner, cancelGraceMs: 80, onChange: record => onChange?.(record, task) });
  const config: CompileConfig = { entryPath: entry, scriptArgs: [], pythonPath: python, workingDirectory: dir, disableCache: true };
  return { task, dir, config, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const emitKernel = `emit({'type':'kernel','kernel':{'id':'k','name':'same','symbol':'main','status':'running','cache':'not-applicable','stages':[]}})`;

test('child process crash preserves received events, logs and a portable failure record', async () => {
  const f = await fixture(`${emitKernel}\nprint('compiler log 中文',flush=True)\nf.write('{"partial":');f.flush()\nos._exit(23)`);
  try {
    await f.task.start(f.config, f.dir);
    assert.equal(f.task.busy, false);
    assert.equal(f.task.record?.status, 'failed');
    assert.equal(f.task.record?.kernels[0].id, 'k');
    assert.match(f.task.record?.error?.message ?? '', /23/);
    assert.ok(f.task.record?.logs.some(log => log.text.includes('compiler log 中文')));
    const saved = parseRecord(await fs.readFile(path.join(f.dir, 'latest.tltrace.json'), 'utf8'));
    assert.equal(saved.entry.source, '# original source\n');
    assert.equal(saved.kernels[0].status, 'failed');
  } finally { await f.cleanup(); }
});

test('cancel escalates for an unresponsive child and retains collected kernels', { timeout: 10_000 }, async () => {
  const f = await fixture(`signal.signal(signal.SIGINT,signal.SIG_IGN)\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n${emitKernel}\ntime.sleep(60)`, (record, task) => {
    if (record.kernels.length && task.busy) task.cancel();
  });
  try {
    await f.task.start(f.config, f.dir);
    assert.equal(f.task.record?.status, 'cancelled');
    assert.equal(f.task.record?.kernels[0].status, 'cancelled');
    assert.equal(f.task.busy, false);
  } finally { await f.task.dispose(); await f.cleanup(); }
});

test('missing interpreter produces an environment error and preserves source', async () => {
  const f = await fixture('');
  try {
    await f.task.start({ ...f.config, pythonPath: path.join(f.dir, 'missing-python') }, f.dir);
    assert.equal(f.task.record?.status, 'failed');
    assert.equal(f.task.record?.error?.phase, 'environment');
    assert.equal(f.task.record?.entry.source, '# original source\n');
  } finally { await f.cleanup(); }
});

test('bad complete protocol line fails without discarding preceding complete events', async () => {
  const f = await fixture(`signal.signal(signal.SIGTERM,signal.SIG_IGN)\n${emitKernel}\nf.write('NOT JSON\\n');f.flush()\ntime.sleep(10)`);
  try {
    await f.task.start(f.config, f.dir);
    assert.equal(f.task.record?.status, 'failed');
    assert.equal(f.task.record?.error?.phase, 'protocol');
    assert.equal(f.task.record?.kernels[0].id, 'k');
  } finally { await f.task.dispose(); await f.cleanup(); }
});

test('successful completion survives persisted recovery without requiring Python', async () => {
  const f = await fixture(`${emitKernel}\nemit({'type':'kernel-update','kernelId':'k','patch':{'status':'succeeded'}})\nemit({'type':'finish','status':'succeeded','durationMs':5})`);
  try {
    await f.task.start(f.config, f.dir);
    assert.equal(f.task.record?.status, 'succeeded');
    const recovered = await f.task.restore();
    assert.equal(recovered?.status, 'succeeded');
    assert.equal(recovered?.kernels[0].id, 'k');
  } finally { await f.cleanup(); }
});

test('script request preserves argv, selected cwd and full CPU JIT configuration', async () => {
  const f = await fixture(`assert r['target']=={'kind':'c'}\nassert r['executionBackend']=='cython'\nassert r['disableCache'] is False\nassert r['workingDirectory']==os.getcwd()\nassert r['scriptArgs']==['arg with spaces','$(not-a-command)','--size=128']\nprint('literal argv received',flush=True)\nemit({'type':'finish','status':'succeeded','durationMs':5})`);
  try {
    await f.task.start({ ...f.config, scriptArgs: ['arg with spaces', '$(not-a-command)', '--size=128'], disableCache: false }, f.dir);
    assert.equal(f.task.record?.status, 'succeeded', f.task.record?.error?.message);
    assert.ok(f.task.record?.logs.some(log => log.text.includes('literal argv received')));
    assert.deepEqual(f.task.record?.entry.args, ['arg with spaces', '$(not-a-command)', '--size=128']);
    assert.equal(f.task.record?.entry.cwd, f.dir);
    assert.equal(f.task.record?.entry.function, '__main__');
  } finally { await f.cleanup(); }
});

test('dispose during initialization waits for a durable cancelled record and cleanup', async () => {
  const f = await fixture("raise AssertionError('cancelled task must not spawn')");
  try {
    const running = f.task.start(f.config, f.dir);
    await f.task.dispose();
    assert.equal(f.task.busy, false);
    const saved = await f.task.restore();
    assert.equal(saved?.status, 'cancelled');
    assert.equal(saved?.error, undefined);
    assert.deepEqual(await fs.readdir(path.join(f.dir, 'runs')), []);
    await running;
    await assert.rejects(f.task.start(f.config, f.dir), /已销毁/);
  } finally { await f.cleanup(); }
});

test('dispose waits while final persistence is blocked', async () => {
  const f = await fixture("emit({'type':'finish','status':'succeeded','durationMs':5})");
  const persist = f.task.persist.bind(f.task);
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const finalSave = new Promise<void>(resolve => { reached = resolve; });
  f.task.persist = async () => {
    if (f.task.record?.status !== 'running') { reached(); await blocked; }
    await persist();
  };
  try {
    const running = f.task.start(f.config, f.dir);
    await finalSave;
    let disposed = false;
    const disposing = f.task.dispose().then(() => { disposed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    assert.equal(f.task.busy, true);
    release();
    await Promise.all([running, disposing]);
    assert.equal((await f.task.restore())?.status, 'succeeded');
  } finally { release(); await f.task.dispose(); await f.cleanup(); }
});

test('completed and failed runs remove protocol files but preserve the final record', async () => {
  for (const body of ["emit({'type':'finish','status':'succeeded','durationMs':5})", 'os._exit(23)']) {
    const f = await fixture(body);
    try {
      await f.task.start(f.config, f.dir);
      assert.deepEqual(await fs.readdir(path.join(f.dir, 'runs')), []);
      assert.ok(await f.task.restore());
    } finally { await f.cleanup(); }
  }
});

test('diagnostic retention keeps run files', async () => {
  const f = await fixture("emit({'type':'finish','status':'succeeded','durationMs':5})");
  const task = new CompilationTask({ storagePath: f.dir, runnerPath: path.join(f.dir, 'runner.py'), retainRunFiles: true, onChange: () => {} });
  try {
    await task.start(f.config, f.dir);
    const runs = await fs.readdir(path.join(f.dir, 'runs'));
    assert.equal(runs.length, 1);
    assert.ok((await fs.readdir(path.join(f.dir, 'runs', runs[0]))).includes('events.jsonl'));
  } finally { await task.dispose(); await f.cleanup(); }
});

test('failed final persistence retains protocol files for recovery', async () => {
  const f = await fixture("emit({'type':'finish','status':'succeeded','durationMs':5})");
  const persist = f.task.persist.bind(f.task);
  f.task.persist = async () => {
    if (f.task.record?.status !== 'running') throw new Error('simulated disk failure');
    return persist();
  };
  try {
    await assert.rejects(f.task.start(f.config, f.dir), /simulated disk failure/);
    assert.equal(f.task.busy, false);
    const runs = await fs.readdir(path.join(f.dir, 'runs'));
    assert.equal(runs.length, 1);
    assert.ok((await fs.readdir(path.join(f.dir, 'runs', runs[0]))).includes('events.jsonl'));
  } finally { await f.cleanup(); }
});

test('cleanup preserves external TMPDIR contents', async () => {
  const f = await fixture("emit({'type':'finish','status':'succeeded','durationMs':5})");
  const external = path.join(f.dir, 'external-temp');
  const previous = process.env.TMPDIR;
  try {
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, 'keep.txt'), 'keep');
    process.env.TMPDIR = external;
    await f.task.start(f.config, f.dir);
    assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep');
    assert.deepEqual(await fs.readdir(path.join(f.dir, 'runs')), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await f.cleanup();
  }
});

test('event polling coalesces snapshots while final save retains all events', async () => {
  const f = await fixture(`for i in range(6):\n emit({'type':'log','log':{'timestamp':'2000-01-01T00:00:00Z','stream':'system','text':str(i)}})\n time.sleep(0.12)\nemit({'type':'finish','status':'succeeded','durationMs':720})`);
  const task = new CompilationTask({ storagePath: f.dir, runnerPath: path.join(f.dir, 'runner.py'), snapshotIntervalMs: 60_000, onChange: () => {} });
  let saves = 0;
  const persist = task.persist.bind(task);
  task.persist = async () => { saves++; await persist(); };
  try {
    await task.start(f.config, f.dir);
    assert.equal(saves, 2, 'initial and final snapshots only');
    assert.equal((await task.restore())?.logs.length, 6);
  } finally { await task.dispose(); await f.cleanup(); }
});

test('a quiet worker still checkpoints its last events before it exits', async () => {
  const f = await fixture(`${emitKernel}\ntime.sleep(30)`);
  const task = new CompilationTask({ storagePath: f.dir, runnerPath: path.join(f.dir, 'runner.py'), snapshotIntervalMs: 150, cancelGraceMs: 80, onChange: () => {} });
  const running = task.start(f.config, f.dir);
  try {
    const deadline = Date.now() + 5000;
    let saved: TraceRecord | null = null;
    while (Date.now() < deadline) {
      saved = await task.restore();
      if (saved?.kernels.length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(saved?.kernels[0]?.id, 'k');
    assert.equal(task.busy, true);
  } finally { await task.dispose(); await running; await f.cleanup(); }
});
