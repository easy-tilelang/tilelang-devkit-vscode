import { resolvePython } from './python.mjs';
import { runTests } from '@vscode/test-electron';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform === 'linux' && !process.env.DISPLAY) {
  throw new Error('VS Code integration tests need a display. Run xvfb-run -a npm run test:extension, or set DISPLAY to an existing X server.');
}

if (process.env.TRACE_TEST_REAL === '1' || process.env.TRACE_TEST_SIDEBAR_RUN === '1') {
  process.env.TRACE_TEST_PYTHON = resolvePython();
  console.log(`Using Python: ${process.env.TRACE_TEST_PYTHON}`);
}

const testProfile = await mkdtemp(resolve(tmpdir(), 'tilelang-devkit-test-'));
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, 'dist/test/extension.test.cjs'),
    ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : { version: process.env.VSCODE_TEST_VERSION || '1.95.3' }),
    launchArgs: [
      resolve(root, 'examples'),
      '--disable-extensions',
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--user-data-dir=' + resolve(testProfile, 'user'),
      '--extensions-dir=' + resolve(testProfile, 'extensions'),
    ],
  });
} finally {
  await rm(testProfile, { recursive: true, force: true });
}
