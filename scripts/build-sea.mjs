import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.join(ROOT, '.sea-build');
const OUTPUT = path.join(ROOT, 'dist');
const executable = path.join(OUTPUT, 'ASIC ToolBox.exe');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} завершился с кодом ${result.status}`);
}

if (process.platform !== 'win32') {
  throw new Error('Сборка Windows SEA должна выполняться в Windows (или на Windows runner CI).');
}
if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error(`Требуется Node.js 22 или новее; обнаружен ${process.versions.node}.`);
}

await rm(WORK, { recursive: true, force: true });
await rm(OUTPUT, { recursive: true, force: true });
await mkdir(WORK, { recursive: true });
await mkdir(OUTPUT, { recursive: true });

const bundle = path.join(WORK, 'server.cjs');
await build({
  entryPoints: [path.join(ROOT, 'server.js')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'bundle',
  external: ['cpu-features', '*.node'],
  sourcemap: false,
  legalComments: 'none',
  minify: true,
});

const publicDir = path.join(ROOT, 'public');
const publicFiles = (await readdir(publicDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(publicDir, entry.name));
const assets = {
  'package.json': path.join(ROOT, 'package.json'),
  'tools/grpcurl.exe': path.join(ROOT, 'tools', 'grpcurl.exe'),
};
for (const file of publicFiles) assets[`public/${path.basename(file)}`] = file;
for (const [name, file] of Object.entries(assets)) {
  try {
    await readFile(file);
  } catch {
    throw new Error(`Не найден обязательный ресурс для встраивания: ${file}`);
  }
}

const configPath = path.join(WORK, 'sea-config.json');
const blobPath = path.join(WORK, 'sea-prep.blob');
await writeFile(
  configPath,
  JSON.stringify({
    main: bundle,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  }),
);
run(process.execPath, ['--experimental-sea-config', configPath]);
await copyFile(process.execPath, executable);
const rceditPath = path.join(WORK, 'rcedit-x64.exe');
const rceditUrl =
  'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';
const rceditSha256 = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a';
console.log('Downloading pinned rcedit v2.0.0 to set the Windows app icon...');
const rceditResponse = await fetch(rceditUrl, { signal: AbortSignal.timeout(30_000) });
if (!rceditResponse.ok) throw new Error(`Не удалось скачать rcedit: HTTP ${rceditResponse.status}`);
const rceditBytes = Buffer.from(await rceditResponse.arrayBuffer());
const actualSha256 = createHash('sha256').update(rceditBytes).digest('hex');
if (actualSha256 !== rceditSha256) throw new Error('SHA-256 rcedit не совпадает с ожидаемым');
await writeFile(rceditPath, rceditBytes);
console.log('Applying public/app-icon.ico to the Windows executable...');
run(rceditPath, [executable, '--set-icon', path.join(ROOT, 'public', 'app-icon.ico')]);
console.log('Windows icon installed. Injecting the SEA payload...');
run(process.execPath, [
  path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'),
  executable,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  fuse,
]);

console.log(`Готов единый исполняемый файл: ${executable}`);
console.log('Windows icon установлен из public/app-icon.ico.');
console.log('Для запуска пользователю достаточно скопировать только этот EXE.');
