/** Capture a local CPU example record with the same task manager as VS Code. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CompilationTask } from '../src/host/task';
import { assertRecord } from '../src/shared/record';

async function main() {
  const extension = path.resolve(import.meta.dirname, '..');
  if (process.argv.length > 3) throw new Error('Usage: tsx scripts/capture-example.ts [output.tltrace.json]');
  const output = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(extension, 'artifacts', 'examples', 'cpu-vecadd.tltrace.json');
  const task = new CompilationTask({
    storagePath: path.join(extension, 'artifacts', 'real-capture'),
    runnerPath: path.join(extension, 'python', 'runner.py'),
    onChange: () => {},
    onLog: text => process.stdout.write(text),
  });
  await task.start({
    entryPath: path.join(extension, 'examples', 'cpu_vecadd.py'),
    scriptArgs: ['--size', '128', '--repeat', '1', '--verify'], workingDirectory: '', disableCache: true,
    pythonPath: process.env.TRACE_TEST_PYTHON ?? 'python',
  }, process.env.TILELANG_WORKSPACE ?? extension);
  const record = task.record;
  assertRecord(record);
  if (record.status !== 'succeeded') throw new Error(record.error?.traceback ?? record.error?.message ?? record.status);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(record, null, 2) + '\n');
  console.log(`Record saved to ${output}`);
  console.log(`Captured ${record.kernels.length} kernel invocation(s), ${record.kernels.reduce((sum, kernel) => sum + kernel.stages.length, 0)} stages; CPU C JIT completed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
