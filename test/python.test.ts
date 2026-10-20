import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { probePython, resolvePython } from '../scripts/python.mjs';

test('explicit interpreter is used literally and never falls back', () => {
  const calls: string[] = [];
  const explicit = '/a venv/bin/python';
  assert.equal(resolvePython({ env: { TRACE_TEST_PYTHON: explicit }, probe: executable => { calls.push(executable); return executable; } }), explicit);
  assert.deepEqual(calls, [explicit]);
  calls.length = 0;
  assert.throws(() => resolvePython({ env: { TRACE_TEST_PYTHON: '/missing' }, probe: executable => { calls.push(executable); throw new Error('ENOENT'); } }), /An explicit TRACE_TEST_PYTHON is never replaced/);
  assert.deepEqual(calls, ['/missing']);
  assert.throws(() => resolvePython({ env: { TRACE_TEST_PYTHON: '' }, probe: () => { throw new Error('must not probe'); } }), /TRACE_TEST_PYTHON is empty/);
});

test('automatic discovery prefers python and falls back to python3', () => {
  for (const reason of ['ENOENT', 'Python 3 is required', 'ETIMEDOUT']) {
    const calls: string[] = [];
    assert.equal(resolvePython({ env: {}, probe: executable => {
      calls.push(executable);
      if (executable === 'python') throw new Error(reason);
      return '/selected/python3';
    } }), '/selected/python3');
    assert.deepEqual(calls, ['python', 'python3']);
  }
  const calls: string[] = [];
  assert.equal(resolvePython({ env: {}, probe: executable => { calls.push(executable); return '/selected/python'; } }), '/selected/python');
  assert.deepEqual(calls, ['python']);
});

test('missing interpreters produce a single actionable error listing both attempts', () => {
  assert.throws(() => resolvePython({ env: {}, probe: () => { throw new Error('ENOENT'); } }), error => {
    assert.match(String(error), /"python": ENOENT/);
    assert.match(String(error), /"python3": ENOENT/);
    assert.match(String(error), /TRACE_TEST_PYTHON=\/path\/to\/venv\/bin\/python npm test/);
    return true;
  });
});

test('real probing handles executable paths with spaces, rejects Python 2 and times out', { skip: process.platform === 'win32' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'python probe '));
  const executable = path.join(dir, 'fake python');
  try {
    const write = (body: string) => fs.writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    await write(`console.log(JSON.stringify({major: 3, executable: ${JSON.stringify(executable)}}))`);
    assert.equal(probePython(executable), executable);
    await write(`console.log(JSON.stringify({major: 2, executable: ${JSON.stringify(executable)}}))`);
    assert.throws(() => probePython(executable), /Python 3 is required/);
    await write('console.log("bad output")');
    assert.throws(() => probePython(executable), /valid Python version/);
    await write('setTimeout(() => {}, 30000)');
    assert.throws(() => probePython(executable, { timeoutMs: 100 }), /ETIMEDOUT/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('test entry fails before starting suites for an invalid explicit interpreter', () => {
  const result = spawnSync(process.execPath, ['scripts/test.mjs', 'node'], {
    env: { ...process.env, TRACE_TEST_PYTHON: path.resolve('artifacts', 'nonexistent-python-for-test') }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No usable Python 3 interpreter/);
  assert.doesNotMatch(result.stdout, /TAP version|tests \d|child process crash/);
});

test('test entry passes the chosen interpreter to the Python suite', () => {
  const python = resolvePython();
  const result = spawnSync(process.execPath, ['scripts/test.mjs', 'python-unit'], {
    env: { ...process.env, TRACE_TEST_PYTHON: python }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Using Python: ${python}`));
  assert.match(result.stderr, /Ran 4 tests/);
});
