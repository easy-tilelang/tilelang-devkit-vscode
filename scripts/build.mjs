import { build, context } from 'esbuild';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
mkdirSync('dist', { recursive: true });
const common = { bundle: true, sourcemap: true, metafile: true, logLevel: 'info' };
const targets = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['src/webview/app.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' }, minify: true },
  { ...common, entryPoints: ['src/sidebar/app.tsx'], outfile: 'dist/sidebar.js', platform: 'browser', format: 'iife', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' }, minify: true },
];
if (existsSync('test/extension.test.ts')) targets.push({ ...common, entryPoints: ['test/extension.test.ts'], outfile: 'dist/test/extension.test.cjs', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] });
if (process.argv.includes('--watch')) {
  for (const target of targets) await (await context(target)).watch();
} else {
  const results = await Promise.all(targets.map(target => build(target)));
  const packages = new Set();
  for (const result of results) for (const input of Object.keys(result.metafile.inputs)) {
    const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
    if (match) packages.add(match[1]);
  }
  const notices = ['Third-party software bundled with TileLang DevKit.\n'];
  for (const name of [...packages].sort()) {
    const dir = join('node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const licenseFile = readdirSync(dir).find(file => /^(licen[cs]e|copying)(\.|$)/i.test(file));
    if (!licenseFile) throw new Error(`No license file found for bundled dependency ${name}`);
    notices.push(`${name} ${pkg.version} (${pkg.license ?? 'see below'})\n${'='.repeat(72)}\n${readFileSync(join(dir, licenseFile), 'utf8')}`);
  }
  writeFileSync('THIRD_PARTY_NOTICES.txt', notices.join('\n\n') + '\n');
}
