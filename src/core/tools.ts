import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StepId, Tools } from './types';

function darwinPythonUserBins(home: string): string[] {
  const pyRoot = path.join(home, 'Library', 'Python');
  try {
    return readdirSync(pyRoot)
      .filter((name) => /^\d+(\.\d+)*$/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => path.join(pyRoot, name, 'bin'));
  } catch {
    return [];
  }
}

const DARWIN_EXTRA_DIRS = (home: string) => [
  path.join(home, '.local', 'bin'),
  path.join(home, '.cargo', 'bin'),
  ...darwinPythonUserBins(home),
  '/opt/homebrew/bin',
  '/opt/homebrew/opt/llvm/bin',
  '/usr/local/bin',
  '/usr/local/opt/llvm/bin',
];

export function augmentDarwinPath(basePath: string, home = os.homedir()): string {
  const dirs = basePath.split(path.delimiter).filter(Boolean);
  for (const d of DARWIN_EXTRA_DIRS(home)) {
    if (!dirs.includes(d)) dirs.push(d);
  }
  return dirs.join(path.delimiter);
}

/** macOS の GUI 版 VS Code は Homebrew / pipx のパスを継承しないことがあるため、既定の探索先を補う。 */
export function effectiveEnvPath(
  envPath?: string,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (envPath !== undefined) return envPath;
  const base = process.env.PATH ?? '';
  return platform === 'darwin' ? augmentDarwinPath(base, home) : base;
}

let macOsSdkCache: string | null | undefined;

/**
 * macOS の SDK パス (SDKROOT または `xcrun --show-sdk-path`) を返す。
 * Homebrew の LLVM (`clang-tidy` / `scan-build`) は SDK パスが無いと `<stdio.h>` を見つけられないため使用する。
 */
export function detectMacOsSdkRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (platform !== 'darwin') return undefined;
  if (env.SDKROOT) return env.SDKROOT;
  if (macOsSdkCache !== undefined) return macOsSdkCache ?? undefined;
  try {
    const out = execFileSync('xcrun', ['--show-sdk-path'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    macOsSdkCache = out || null;
  } catch {
    macOsSdkCache = null;
  }
  return macOsSdkCache ?? undefined;
}

const appleClangCache = new Map<string, boolean>();

/** macOS の /usr/bin/gcc のように、gcc の名前でも実体が Apple Clang かどうかを判定する。 */
export function isAppleClangCompiler(binPath: string): boolean {
  const cached = appleClangCache.get(binPath);
  if (cached !== undefined) return cached;
  const r = spawnSync(binPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) {
    // 初回 xcrun 起動のタイムアウト等では false をキャッシュしない
    return false;
  }
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const result = /Apple (?:clang|LLVM) version|\bclang version\b/i.test(out);
  appleClangCache.set(binPath, result);
  return result;
}

/** 先に書いたものを優先する。校舎は -12 系、メイン機 (Arch) は素の名前。 */
export const CANDIDATES: Record<keyof Tools, string[]> = {
  cc: ['clang-12', 'clang'],
  tidy: ['clang-tidy-12', 'clang-tidy'],
  scanBuild: ['scan-build-12', 'scan-build'],
  gcc: ['gcc-12', 'gcc'],
  valgrind: ['valgrind'],
  leaks: ['leaks'],
  norminette: ['norminette'],
  make: ['make'],
  cbmc: ['cbmc'],
  framaC: ['frama-c'],
  // Ubuntu は ctags-universal (ctags は alternatives)。素の ctags は Exuberant / GNU 版のことがあるので最後
  ctags: ['universal-ctags', 'ctags-universal', 'ctags'],
  // PyPI の c-formatter-42 が入れるコマンド名は c_formatter_42
  cFormatter: ['c_formatter_42', 'c-formatter-42'],
  setarch: ['setarch'],
};

/** PATH 上で見つかる全ての実行ファイルのフルパスを順に返す (重複は除く)。 */
export function findAllOnPath(name: string, envPath = effectiveEnvPath()): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (seen.has(full)) continue;
    try {
      accessSync(full, constants.X_OK);
      seen.add(full);
      results.push(full);
    } catch {
      /* 次の候補へ */
    }
  }
  return results;
}

export function findOnPath(name: string, envPath = effectiveEnvPath()): string | undefined {
  return findAllOnPath(name, envPath)[0];
}

/** `base-<N>` 形式の実行ファイルのうち、最も新しい版のフルパスを返す (例: scan-build-18 / gcc-14 のみ入っている環境向け)。 */
export function findHighestVersioned(
  base: string,
  envPath = effectiveEnvPath(),
  accept?: (fullPath: string) => boolean,
): string | undefined {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  let best: { full: string; n: number } | undefined;
  for (const dir of envPath.split(path.delimiter)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = re.exec(name);
      if (!m) continue;
      const full = findOnPath(name, dir);
      if (full && (!best || Number(m[1]) > best.n) && (!accept || accept(full))) {
        best = { full, n: Number(m[1]) };
      }
    }
  }
  return best?.full;
}

/** 校舎の指定版 (-12) → 素の名前 → 入っている最新の版、の順で探す。 */
/** setarch に渡すアーキテクチャ名 (x86_64 / aarch64)。分からなければ省略する (新しい util-linux は省略できる)。 */
export function machineArch(): string[] {
  const m = typeof os.machine === 'function' ? os.machine() : '';
  return m ? [m] : [];
}

function detectGcc(
  envPath: string,
  platform: NodeJS.Platform,
  isAppleClang: (binPath: string) => boolean,
): string | undefined {
  const rejectApple = (p: string) => platform !== 'darwin' || !isAppleClang(p);
  for (const name of CANDIDATES.gcc) {
    for (const found of findAllOnPath(name, envPath)) {
      if (rejectApple(found)) return found;
    }
  }
  return findHighestVersioned('gcc', envPath, rejectApple);
}

export function detectTools(
  envPath?: string,
  platform: NodeJS.Platform = process.platform,
  isAppleClang: (binPath: string) => boolean = isAppleClangCompiler,
): Tools {
  const searchPath = effectiveEnvPath(envPath, platform);
  const tools: Tools = {};
  for (const key of Object.keys(CANDIDATES) as (keyof Tools)[]) {
    if (key === 'gcc') {
      const found = detectGcc(searchPath, platform, isAppleClang);
      if (found) tools.gcc = found;
      continue;
    }
    const found =
      CANDIDATES[key].find((name) => findOnPath(name, searchPath)) ??
      (key === 'cc' || key === 'tidy' || key === 'scanBuild'
        ? findHighestVersioned(CANDIDATES[key][CANDIDATES[key].length - 1], searchPath)
        : undefined);
    if (found) tools[key] = found;
  }
  return tools;
}

/** 各ステップが必要とするツール (View で未検出を表示するため) */
/** 外部ツールを使わない項目は undefined */
export const STEP_TOOL: Record<StepId, keyof Tools | undefined> = {
  cFormatter: 'cFormatter',
  norminette: 'norminette',
  normExtra: undefined,
  makefile: 'make',
  warnings: 'cc',
  clangTidy: 'tidy',
  scanBuild: 'scanBuild',
  gccAnalyzer: 'gcc',
  asanUbsan: 'cc',
  tsan: 'cc',
  msan: 'cc',
  valgrind: 'valgrind',
  leaks: 'leaks',
  cbmc: 'cbmc',
  framaC: 'framaC',
};

/** skip 理由に添える、未検出ツールごとの対処案 */
export const INSTALL_HINTS: Record<keyof Tools, string> = {
  cc: 'clang (校舎: clang-12 系) が PATH にありません。Arch: `sudo pacman -S clang` / macOS: `xcode-select --install`',
  tidy: 'clang-tidy (校舎: clang-tidy-12) が PATH にありません。Arch: `sudo pacman -S clang` / macOS: `brew install llvm`',
  scanBuild: 'scan-build (校舎: scan-build-12) が PATH にありません。Arch: `sudo pacman -S clang-analyzer` / macOS: `brew install llvm`',
  gcc: 'GNU gcc (校舎: gcc-12) が PATH にありません (macOS の /usr/bin/gcc は Apple clang のため非対応)。-fanalyzer は GCC 10 以降が必要です。macOS: `brew install gcc`',
  valgrind: 'valgrind が PATH にありません。Arch: `sudo pacman -S valgrind` (macOS では valgrind 非対応の環境が多いため、代わりに「leaks (macOS)」を有効にし、valgrind のチェックを外してください)',
  leaks: 'leaks は macOS 標準のメモリリーク検査ツールです (`xcode-select --install` が必要)。Linux では valgrind を使用してください',
  norminette: 'norminette が PATH にありません。校舎では標準で入っています。自分の機 (Linux / macOS) では `pipx install norminette` (または `pip3 install --user norminette`) 等',
  make: 'make が PATH にありません',
  cbmc: 'cbmc が PATH にありません。ネイティブ版のみ対応です (校舎では Docker image を pull しない方針)',
  framaC: 'frama-c が PATH にありません。ネイティブ版のみ対応です (校舎では Docker image を pull しない方針)',
  ctags: 'universal-ctags (ctags-universal) が PATH にありません。Arch: `sudo pacman -S ctags` / Ubuntu: `sudo apt install universal-ctags` / macOS: `brew install universal-ctags`。プロトタイプ同期のみで使います',
  setarch: 'setarch (util-linux) が PATH にありません。TSan / MSan は ASLR 無効 (setarch -R) で起動しないと、環境によって起動できないことがあります',
  cFormatter: 'c_formatter_42 が PATH にありません。`pipx install c-formatter-42` (または `pip install --user c-formatter-42`) で入ります。自分の機の norminette と同じように、校舎の home に入れる場合は容量に注意してください',
};
