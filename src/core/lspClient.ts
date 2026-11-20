import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import * as path from 'node:path';
import { augmentDarwinPath, effectiveEnvPath, findOnPath } from './tools';
import type { StepResult } from './types';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * c42checker-base (c42checker-lsp) と stdio JSON-RPC 2.0 (LSP) で通信する軽量クライアント。
 */
export class C42LspClient {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = Buffer.alloc(0);
  public onNotification?: (method: string, params: unknown) => void;

  static findBinary(configured?: string, envPath = effectiveEnvPath()): string | undefined {
    if (configured) {
      if (configured.includes('/') || configured.includes(path.sep)) {
        return isExecutableFile(configured) ? configured : undefined;
      }
      const resolved = findOnPath(configured, envPath);
      if (resolved) return resolved;
    }
    return findOnPath('c42checker-lsp', envPath);
  }

  async start(bin: string, rootPath: string, initSettings?: unknown): Promise<void> {
    if (this.proc) return;
    const env =
      process.platform === 'darwin'
        ? { ...process.env, PATH: augmentDarwinPath(process.env.PATH ?? '') }
        : process.env;
    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.proc.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('c42checker-lsp exited'));
      this.pending.clear();
      this.proc = undefined;
    });

    await this.request('initialize', {
      processId: process.pid,
      rootUri: `file://${rootPath}`,
      initializationOptions: initSettings ? { c42checker: initSettings } : {},
      capabilities: {},
    });
    this.notify('initialized', {});
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc) return Promise.reject(new Error('c42checker-lsp is not running'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.proc!.stdin.write(frame);
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc) return;
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params });
    const frame = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`;
    this.proc.stdin.write(frame);
  }

  executeCommand<T = unknown>(command: string, args: unknown[] = []): Promise<T> {
    return this.request<T>('workspace/executeCommand', { command, arguments: args });
  }

  runStep(stepId: string): Promise<StepResult> {
    return this.executeCommand<StepResult>('c42checker.runStep', [{ stepId }]);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request('shutdown', null);
      this.notify('exit', null);
    } catch {
      this.proc.kill();
    }
    this.proc = undefined;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buf.subarray(0, headerEnd).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const total = headerEnd + 4 + len;
      if (this.buf.length < total) break;
      const body = this.buf.subarray(headerEnd + 4, total).toString('utf8');
      this.buf = this.buf.subarray(total);
      try {
        const msg = JSON.parse(body) as { id?: number; method?: string; result?: unknown; error?: { message: string }; params?: unknown };
        if (typeof msg.id === 'number') {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } else if (msg.method) {
          this.onNotification?.(msg.method, msg.params);
        }
      } catch {
        /* ignore malformed frame */
      }
    }
  }
}
