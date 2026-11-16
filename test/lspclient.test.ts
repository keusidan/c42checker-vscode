import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { C42LspClient } from '../src/core/lspClient';

const LSP_BIN = process.env.C42CHECKER_LSP ?? '/home/ponzu/tmp/c42checker-base/target/release/c42checker-lsp';

test('C42LspClient: c42checker-lsp と通信して detectTools を取得できる', async (t) => {
  if (!fs.existsSync(LSP_BIN)) {
    t.skip('c42checker-lsp binary not found');
    return;
  }
  const client = new C42LspClient();
  await client.start(LSP_BIN, process.cwd());
  try {
    const res = await client.executeCommand<{ steps: { id: string }[] }>('c42checker.detectTools');
    assert.equal(res.steps.length, 14);
  } finally {
    await client.stop();
  }
});
