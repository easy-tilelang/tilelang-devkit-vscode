import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

/** @param {string} executable
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options] */
export function probePython(executable, { env = process.env, timeoutMs = 5000 } = {}) {
  const result = spawnSync(executable, ['-c', 'import json, sys; print(json.dumps({"major": sys.version_info[0], "executable": sys.executable}))'], {
    env, shell: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024,
  });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(`exit ${result.status ?? result.signal}: ${result.stderr.trim()}`);
  let info;
  try { info = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('interpreter did not return valid Python version information'); }
  if (info?.major !== 3) throw new Error('Python 3 is required');
  if (typeof info.executable !== 'string' || !isAbsolute(info.executable)) throw new Error('interpreter did not return an absolute sys.executable path');
  return info.executable;
}

/** @param {{ env?: NodeJS.ProcessEnv, probe?: (executable: string) => string }} [options] */
export function resolvePython({ env = process.env, probe = executable => probePython(executable, { env }) } = {}) {
  const explicit = env.TRACE_TEST_PYTHON;
  const candidates = explicit === undefined ? ['python', 'python3'] : [explicit];
  const failures = [];
  for (const candidate of candidates) {
    try {
      if (!candidate.trim()) throw new Error('TRACE_TEST_PYTHON is empty');
      return probe(candidate);
    } catch (error) {
      failures.push(`${JSON.stringify(candidate)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No usable Python 3 interpreter found.\n${failures.join('\n')}\nSet TRACE_TEST_PYTHON to a Python 3 executable, for example:\nTRACE_TEST_PYTHON=/path/to/venv/bin/python npm test${explicit !== undefined ? '\nAn explicit TRACE_TEST_PYTHON is never replaced by another interpreter.' : ''}`);
}
