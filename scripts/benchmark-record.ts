import { performance } from 'node:perf_hooks';
import { applyEvent, emptyRecord, RecordEventStream } from '../src/shared/record';
import type { Stage } from '../src/shared/model';

// Repeatable synthetic protocol workload; timings are reported, not CI thresholds.
for (const count of [500, 2000, 5000]) {
  let record = emptyRecord('benchmark', { entryPath: '/benchmark.py', pythonPath: 'python', scriptArgs: [], workingDirectory: '/', disableCache: true }, '');
  record = applyEvent(record, { type: 'kernel', kernel: { id: 'kernel', name: 'main', symbol: 'main', status: 'running', cache: 'disabled', stages: [] } });
  const stream = process.argv.includes('--baseline') ? null : new RecordEventStream(record);
  const text = '    buffer[i] = buffer[i] + 1\n'.repeat(80);
  const started = performance.now();
  for (let i = 0; i < count; i++) {
    const stage: Stage = { id: `stage-${i}`, sequence: i, kind: 'pass', name: 'Simplify', phase: null, parentId: null, depth: 0, status: 'succeeded', beforeText: text, afterText: text + `# ${i}`, beforeLanguage: 'python', afterLanguage: 'python', durationMs: 1, changed: true, added: 1, deleted: 0 };
    const event = { type: 'stage', kernelId: 'kernel', stage };
    record = stream ? stream.apply(event) : applyEvent(record, event);
  }
  const ingestMs = performance.now() - started;
  const saving = performance.now();
  const bytes = Buffer.byteLength(JSON.stringify(record));
  console.log(JSON.stringify({ mode: stream ? 'indexed' : 'baseline', stages: count, sizeMiB: +(bytes / 1024 ** 2).toFixed(2), ingestMs: +ingestMs.toFixed(1), snapshotMs: +(performance.now() - saving).toFixed(1) }));
}
