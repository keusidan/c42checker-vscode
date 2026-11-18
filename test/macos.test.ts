import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runPipeline } from '../src/core/pipeline';
import { augmentDarwinPath, detectTools, effectiveEnvPath, findHighestVersioned, isAppleClangCompiler } from '../src/core/tools';
import { sampleContext } from './helpers';

function makeExe(dir: string, name: string, body: string): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return full;
}

test('augmentDarwinPath / effectiveEnvPath: macOS では Homebrew / pipx のパスを補い、Linux では補わない', () => {
  const darwin = augmentDarwinPath('/usr/bin:/bin', '/Users/alice');
  const dirs = darwin.split(path.delimiter);
  assert.ok(dirs.includes('/Users/alice/.local/bin'));
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/opt/homebrew/opt/llvm/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes('/usr/local/opt/llvm/bin'));
  // 重複追加しない
  assert.equal(
    augmentDarwinPath('/opt/homebrew/bin:/usr/bin', '/Users/alice')
      .split(path.delimiter)
      .filter((d) => d === '/opt/homebrew/bin').length,
    1,
  );
  assert.equal(effectiveEnvPath('/custom/bin', 'darwin', '/Users/alice'), '/custom/bin');
  assert.equal(effectiveEnvPath(undefined, 'linux', '/home/alice'), process.env.PATH ?? '');
});

test('findHighestVersioned: フルパスを返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-ver-'));
  makeExe(dir, 'gcc-12', 'exit 0');
  makeExe(dir, 'gcc-14', 'exit 0');
  assert.equal(findHighestVersioned('gcc', dir), path.join(dir, 'gcc-14'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detectTools (macOS): /usr/bin/gcc が Apple clang のみのときは gcc 未検出にし、Homebrew の gcc-14 があればそちらを拾う', () => {
  const sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-sys-'));
  const brewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-brew-'));
  const appleGcc = makeExe(
    sysDir,
    'gcc',
    'echo "Apple clang version 15.0.0 (clang-1500.3.9.4)"',
  );
  assert.equal(isAppleClangCompiler(appleGcc), true);

  // Apple clang のみ → macOS では gcc 未検出
  const onlyApple = detectTools(sysDir, 'darwin');
  assert.equal(onlyApple.gcc, undefined);

  // Linux 扱いなら通常の gcc として拾う
  const asLinux = detectTools(sysDir, 'linux');
  assert.equal(asLinux.gcc, appleGcc);

  // Homebrew の gcc-14 があれば Apple clang を飛ばして gcc-14 を拾う
  const gnuGcc14 = makeExe(brewDir, 'gcc-14', 'echo "gcc-14 (Homebrew GCC 14.2.0) 14.2.0"');
  assert.equal(isAppleClangCompiler(gnuGcc14), false);
  const withBrew = detectTools(`${sysDir}${path.delimiter}${brewDir}`, 'darwin');
  assert.equal(withBrew.gcc, gnuGcc14);

  fs.rmSync(sysDir, { recursive: true, force: true });
  fs.rmSync(brewDir, { recursive: true, force: true });
});

test('gccAnalyzer: -fanalyzer 未対応 (Apple clang 等) のときは fail ではなく skip にする', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakegcc-'));
  const fakeGcc = makeExe(dir, 'gcc', 'echo "clang: error: unknown argument: \'-fanalyzer\'" >&2\nexit 1');
  const { ctx, cleanup } = sampleContext('ok');
  ctx.tools = { ...ctx.tools, gcc: fakeGcc };
  const r = await runPipeline(ctx, { selected: ['gccAnalyzer'] });
  const step = r.results.find((x) => x.id === 'gccAnalyzer')!;
  assert.equal(r.ok, true);
  assert.equal(step.status, 'skip');
  assert.match(step.reason ?? '', /-fanalyzer に対応していません/);
  fs.rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('asanUbsan: macOS の detect_leaks 非対応エラーが出たら detect_leaks=0 で再実行して pass する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakelsan-'));
  // cc のフリをして、実行時に ASAN_OPTIONS を検査するバイナリを生成するシェルスクリプト
  const fakeCc = makeExe(
    dir,
    'clang',
    `out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
if [ -n "$out" ]; then
  cat > "$out" <<'EOF'
#!/bin/sh
case "$ASAN_OPTIONS" in
  *detect_leaks=1*)
    echo "==123==AddressSanitizer: detect_leaks is not supported on this platform." >&2
    exit 1
    ;;
esac
exit 0
EOF
  chmod +x "$out"
fi
exit 0`,
  );
  const { ctx, cleanup } = sampleContext('ok');
  ctx.tools = { ...ctx.tools, cc: fakeCc };
  const r = await runPipeline(ctx, { selected: ['asanUbsan'] });
  const step = r.results.find((x) => x.id === 'asanUbsan')!;
  assert.equal(r.ok, true, step.log);
  assert.equal(step.status, 'pass', step.log);
  assert.match(step.log, /LeakSanitizer が使えないため、リーク検査なしで再実行します/);
  fs.rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('msan: macOS 向けの非対応メッセージ (unsupported option / .dylib 欠如) は fail ではなく skip にする', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakemsan-'));
  const fakeCc = makeExe(
    dir,
    'clang',
    `echo "clang: error: unsupported option '-fsanitize=memory' for target 'arm64-apple-darwin23.0.0'" >&2
exit 1`,
  );
  const { ctx, cleanup } = sampleContext('ok');
  ctx.tools = { ...ctx.tools, cc: fakeCc };
  const r = await runPipeline(ctx, { selected: ['msan'] });
  const step = r.results.find((x) => x.id === 'msan')!;
  assert.equal(r.ok, true);
  assert.equal(step.status, 'skip');
  assert.match(step.reason ?? '', /ランタイムが使えません/);
  fs.rmSync(dir, { recursive: true, force: true });
  cleanup();
});
