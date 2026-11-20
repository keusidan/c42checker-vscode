import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveCtags } from '../src/core/ctags';
import { buildExecEnv } from '../src/core/exec';
import { C42LspClient } from '../src/core/lspClient';
import { parseLeaks, parseSanitizer } from '../src/core/parse';
import { runPipeline } from '../src/core/pipeline';
import { aslrHint, clangTidySdkFlags } from '../src/core/steps';
import {
  augmentDarwinPath,
  detectTools,
  effectiveEnvPath,
  findAllOnPath,
  findHighestVersioned,
  isAppleClangCompiler,
} from '../src/core/tools';
import { copyProject } from '../src/core/workdir';
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

test('augmentDarwinPath: ~/.cargo/bin と ~/Library/Python/<ver>/bin も探索先に含む', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-home-'));
  fs.mkdirSync(path.join(fakeHome, 'Library', 'Python', '3.11', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, 'Library', 'Python', '3.13', 'bin'), { recursive: true });
  const dirs = augmentDarwinPath('/usr/bin:/bin', fakeHome).split(path.delimiter);
  assert.ok(dirs.includes(path.join(fakeHome, '.cargo', 'bin')));
  const py13 = dirs.indexOf(path.join(fakeHome, 'Library', 'Python', '3.13', 'bin'));
  const py11 = dirs.indexOf(path.join(fakeHome, 'Library', 'Python', '3.11', 'bin'));
  assert.ok(py13 >= 0 && py11 >= 0 && py13 < py11, '新しい Python バージョンの bin を優先する');
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test('resolveCtags (macOS): /usr/bin/ctags (BSD 版) より後ろにある Homebrew の universal-ctags を検出する', async () => {
  const sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-bsdctags-'));
  const brewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-brewctags-'));
  makeExe(sysDir, 'ctags', 'echo "ctags: illegal option -- -" >&2; exit 1');
  const brewCtags = makeExe(brewDir, 'ctags', 'echo "Universal Ctags 6.1.0"');
  const combined = `${sysDir}${path.delimiter}${brewDir}`;
  assert.equal(findAllOnPath('ctags', combined).length, 2);
  const resolved = await resolveCtags(combined);
  assert.equal(resolved.bin, brewCtags);
  fs.rmSync(sysDir, { recursive: true, force: true });
  fs.rmSync(brewDir, { recursive: true, force: true });
});

test('detectTools (macOS): /usr/bin/gcc (Apple clang) の後ろに実体の GNU gcc があれば拾う', () => {
  const sysDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-sysgcc-'));
  const gnuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-gnugcc-'));
  makeExe(sysDir, 'gcc', 'echo "Apple clang version 16.0.0"');
  const realGcc = makeExe(gnuDir, 'gcc', 'echo "gcc (Homebrew GCC 14.2.0) 14.2.0"');
  const detected = detectTools(`${sysDir}${path.delimiter}${gnuDir}`, 'darwin');
  assert.equal(detected.gcc, realGcc);
  fs.rmSync(sysDir, { recursive: true, force: true });
  fs.rmSync(gnuDir, { recursive: true, force: true });
});

test('buildExecEnv: macOS で { ...process.env, LC_ALL: "C" } を渡しても PATH と SDKROOT を補完する', () => {
  const procEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };
  const merged = buildExecEnv({ ...procEnv, LC_ALL: 'C' }, 'darwin', procEnv, '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
  assert.ok((merged.PATH ?? '').includes('/opt/homebrew/bin'));
  assert.equal(merged.SDKROOT, '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk');
  assert.equal(merged.LC_ALL, 'C');
  // 明示的に別 PATH を渡した場合は上書きしない
  const custom = buildExecEnv({ PATH: '/only/here' }, 'darwin', procEnv, '/sdk');
  assert.equal(custom.PATH, '/only/here');
});

test('clangTidySdkFlags: macOS のみ -isysroot を補完し、既指定や Linux では追加しない', () => {
  assert.deepEqual(clangTidySdkFlags([], 'darwin', '/sdk/MacOSX.sdk'), ['-isysroot', '/sdk/MacOSX.sdk']);
  assert.deepEqual(clangTidySdkFlags(['-isysroot', '/custom/sdk'], 'darwin', '/sdk/MacOSX.sdk'), []);
  assert.deepEqual(clangTidySdkFlags([], 'linux', '/sdk/MacOSX.sdk'), []);
});

test('copyProject: macOS の .DS_Store / .dylib / .dSYM をコピーしない', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-copysrc-'));
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-copydst-'));
  fs.writeFileSync(path.join(src, 'main.c'), 'int main(void) { return 0; }\n');
  fs.writeFileSync(path.join(src, '.DS_Store'), 'junk');
  fs.writeFileSync(path.join(src, 'libfoo.dylib'), 'junk');
  fs.mkdirSync(path.join(src, 'prog.dSYM', 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(src, 'prog.dSYM', 'Contents', 'Info.plist'), 'junk');
  copyProject(src, dst, 10 * 1024 * 1024);
  assert.equal(fs.existsSync(path.join(dst, 'main.c')), true);
  assert.equal(fs.existsSync(path.join(dst, '.DS_Store')), false);
  assert.equal(fs.existsSync(path.join(dst, 'libfoo.dylib')), false);
  assert.equal(fs.existsSync(path.join(dst, 'prog.dSYM')), false);
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(dst, { recursive: true, force: true });
});

test('parseLeaks & leaks step: macOS leaks の出力 (通常形式・--list 形式) からリークとソース位置を検出する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-leaks-'));
  fs.writeFileSync(path.join(dir, 'main.c'), 'int main(void) { return 0; }\n');
  const treeOut = [
    'Process 999: 192 nodes malloced for 18 KB',
    'Process 999: 1 leak for 16 total leaked bytes.',
    '',
    "STACK OF 1 INSTANCE OF 'ROOT LEAK: <malloc in main>':",
    '3   dyld                         0x180001000 start + 2360',
    `2   prog                         0x100003f50 main + 48  ${path.join(dir, 'main.c')}:12`,
    '1   libsystem_malloc.dylib       0x180123456 malloc + 28',
    '====',
  ].join('\n');
  const p1 = parseLeaks(treeOut, dir);
  assert.equal(p1.leakCount, 1);
  assert.equal(p1.leakedBytes, 16);
  assert.equal(p1.diags.length, 1);
  assert.equal(p1.diags[0].file, path.join(dir, 'main.c'));
  assert.equal(p1.diags[0].line, 12);

  const listOut = [
    'Process 999: 1 leak for 32 total leaked bytes.',
    'Leak: 0x600000004010  size=32  zone: DefaultMallocZone_0x104000000',
    '    Call stack: [thread 0x1e0000000]: | start | main (in prog) + 48  main.c:20 | malloc',
  ].join('\n');
  const p2 = parseLeaks(listOut, dir);
  assert.equal(p2.leakCount, 1);
  assert.equal(p2.leakedBytes, 32);
  assert.equal(p2.diags.length, 1);
  assert.equal(p2.diags[0].line, 20);

  // leaks ステップの E2E (偽の leaks と偽の clang)
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-fakeleaks-'));
  const fakeCc = makeExe(
    fakeBinDir,
    'clang',
    `out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
if [ -n "$out" ]; then
  printf '#!/bin/sh\\nexit 0\\n' > "$out"
  chmod +x "$out"
fi`,
  );
  const { ctx, dir: projDir, cleanup } = sampleContext('ok');
  const leakMain = path.join(projDir, 'main.c');
  const fakeLeaksFail = makeExe(
    fakeBinDir,
    'leaks',
    `echo "Process 42: 1 leak for 24 total leaked bytes."
echo "STACK OF 1 INSTANCE OF 'ROOT LEAK: <malloc in main>':"
echo "2   prog  0x100003f50 main + 48  ${leakMain}:7"
exit 1`,
  );
  ctx.tools = { ...ctx.tools, cc: fakeCc, leaks: fakeLeaksFail };
  const rFail = await runPipeline(ctx, { selected: ['leaks'] });
  const sFail = rFail.results.find((x) => x.id === 'leaks')!;
  assert.equal(sFail.status, 'fail', sFail.log);
  assert.equal(sFail.diags.length, 1);
  assert.equal(sFail.diags[0].line, 7);

  const fakeLeaksPerm = makeExe(
    fakeBinDir,
    'leaks',
    'echo "leaks: cannot examine process 42 for security reasons" >&2; exit 2',
  );
  ctx.tools = { ...ctx.tools, cc: fakeCc, leaks: fakeLeaksPerm };
  const rSkip = await runPipeline(ctx, { selected: ['leaks'] });
  const sSkip = rSkip.results.find((x) => x.id === 'leaks')!;
  assert.equal(sSkip.status, 'skip', sSkip.log);
  assert.match(sSkip.hint ?? '', /DevToolsSecurity/);

  const fakeLeaksOk = makeExe(
    fakeBinDir,
    'leaks',
    'echo "Process 42: 0 leaks for 0 total leaked bytes."\nexit 0',
  );
  ctx.tools = { ...ctx.tools, cc: fakeCc, leaks: fakeLeaksOk };
  const rOk = await runPipeline(ctx, { selected: ['leaks'] });
  assert.equal(rOk.results.find((x) => x.id === 'leaks')!.status, 'pass');

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fakeBinDir, { recursive: true, force: true });
  cleanup();
});

test('parseSanitizer (macOS): arm64 (prog:arm64+0x...) 形式の ASan フレームから位置を取得する', () => {
  const out = [
    '==1==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000014',
    '    #0 0x102873e24 in main /Users/alice/proj/main.c:24 (prog:arm64+0x100003e24)',
  ].join('\n');
  const d = parseSanitizer(out, '/Users/alice/proj');
  assert.equal(d.length, 1);
  assert.equal(d[0].file, '/Users/alice/proj/main.c');
  assert.equal(d[0].line, 24);
});

test('C42LspClient.findBinary: 絶対パス指定と PATH 探索の両方に対応する', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c42-lspbin-'));
  const bin = makeExe(dir, 'c42checker-lsp', 'exit 0');
  assert.equal(C42LspClient.findBinary(bin, ''), bin);
  assert.equal(C42LspClient.findBinary(undefined, dir), bin);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('aslrHint (macOS): darwin では util-linux ではなく macOS 向けの案内を返す', () => {
  const h = aslrHint({ noAslr: true, viaSetarch: false, setarchMissing: true, personalityFailed: false }, 'darwin');
  assert.match(h, /macOS では setarch/);
  assert.doesNotMatch(h, /util-linux/);
});

/* ───────── 実機 macOS 上での結合テスト (Linux では skip) ───────── */

test('実機 macOS: 最小限の GUI PATH でもツールを検出し、samples/ok・bug-asan・bug-leak・msan が期待どおり動く', async (t) => {
  if (process.platform !== 'darwin') return t.skip('macOS 実機専用の結合テスト');

  // GUI 版 VS Code 相当の最小 PATH でも Homebrew / pipx のツールを検出できること
  const origPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    const tools = detectTools();
    assert.ok(tools.cc, 'Apple clang が見つかる');
    assert.ok(tools.leaks, 'macOS 標準の leaks が見つかる');
    if (tools.gcc) {
      assert.equal(isAppleClangCompiler(tools.gcc), false, `gcc は Apple clang ではないこと: ${tools.gcc}`);
    }
    const ct = await resolveCtags();
    if (ct.bin) {
      assert.notEqual(ct.bin, '/usr/bin/ctags', 'BSD /usr/bin/ctags ではなく Universal Ctags を選ぶ');
    }
  } finally {
    process.env.PATH = origPath;
  }

  // samples/ok: 段階 1〜2 の実ツール検証 (fail が 0 件)
  {
    const { ctx, cleanup } = sampleContext('ok');
    const r = await runPipeline(ctx, {
      selected: ['norminette', 'normExtra', 'makefile', 'warnings', 'clangTidy', 'scanBuild', 'gccAnalyzer', 'asanUbsan', 'leaks'],
    });
    const fails = r.results.filter((x) => x.status === 'fail').map((x) => `${x.id}: ${x.reason}\n${x.log.slice(0, 600)}`);
    assert.deepEqual(fails, [], `samples/ok で失敗があってはならない:\n${fails.join('\n---\n')}`);
    cleanup();
  }

  // samples/bug-asan: ASan+UBSan がバグを検出 (Apple Silicon で detect_leaks=0 フォールバックしても検出)
  {
    const { ctx, cleanup } = sampleContext('bug-asan');
    const r = await runPipeline(ctx, { selected: ['asanUbsan'] });
    const asan = r.results.find((x) => x.id === 'asanUbsan')!;
    assert.equal(asan.status, 'fail', asan.log);
    assert.ok(asan.diags.length > 0, `ASan の診断が付く:\n${asan.log}`);
    cleanup();
  }

  // samples/bug-leak: macOS leaks (-atExit) でリークを検出 (SIP 制限時は skip を許容)
  {
    const { ctx, cleanup } = sampleContext('bug-leak');
    const r = await runPipeline(ctx, { selected: ['leaks'] });
    const lk = r.results.find((x) => x.id === 'leaks')!;
    assert.ok(lk.status === 'fail' || lk.status === 'skip', `leaks の結果が想定外: ${lk.status}\n${lk.log}`);
    if (lk.status === 'fail') {
      assert.match(lk.reason ?? '', /リーク/);
    }
    cleanup();
  }

  // samples/ok + MSan: macOS では未対応のため fail ではなく skip になること
  {
    const { ctx, cleanup } = sampleContext('ok');
    const r = await runPipeline(ctx, { selected: ['msan'] });
    const ms = r.results.find((x) => x.id === 'msan')!;
    assert.equal(ms.status, 'skip', ms.log);
    cleanup();
  }
});
