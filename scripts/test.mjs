import { spawnSync } from 'node:child_process';
import { resolvePython } from './python.mjs';

try {
  const suites = {
    node: ['--import', 'tsx', '--test', 'test/record.test.ts', 'test/task.test.ts', 'test/record-update.test.ts', 'test/python.test.ts'],
    python: ['-m', 'pytest', 'test/test_collector.py', '-q'],
    'python-unit': ['-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_runner_unit.py'],
  };
  const suite = process.argv[2];
  if (!Object.hasOwn(suites, suite)) throw new Error('Usage: node scripts/test.mjs node|python|python-unit');
  const python = resolvePython();
  console.log(`Using Python: ${python}`);
  const result = spawnSync(suite === 'node' ? process.execPath : python, [...suites[suite], ...process.argv.slice(3)], {
    stdio: 'inherit', shell: false, env: { ...process.env, TRACE_TEST_PYTHON: python },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
