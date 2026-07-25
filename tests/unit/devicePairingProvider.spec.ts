/**
 * Covers `DevicePairingProvider.getBootstrapCode()` by testing the
 * `vscode`-free core it delegates to: {@link fetchBootstrapCode} in
 * `src/auth/bootstrapCode.ts`.
 *
 * `DevicePairingProvider` itself imports `vscode`, which only resolves
 * inside the VS Code extension host — it cannot be constructed in a plain
 * node/tsx test (the same reason `deviceFlow.ts` was pulled out as pure,
 * `vscode`-free logic; see its file header). `getBootstrapCode()`'s own body
 * is a one-line guard ("no stored token → throw") plus a direct delegation
 * to `fetchBootstrapCode`, reviewed by inspection + `tsc`.
 *
 * These tests exercise the real request/response handling in
 * `fetchBootstrapCode` (built on `requestJson`, itself `vscode`-free) against
 * a throwaway local HTTP server standing in for the orchestrator — no
 * network-mocking dependency needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchBootstrapCode } from '../../src/auth/bootstrapCode.ts';

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe('fetchBootstrapCode', () => {
  it('POSTs /api/auth/embed-bootstrap with the Authorization: Bearer header and returns the code', async () => {
    let method = '';
    let url = '';
    let auth = '';
    const { url: baseUrl, close } = await startServer((req, res) => {
      method = req.method ?? '';
      url = req.url ?? '';
      auth = req.headers['authorization'] ?? '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'bc_test_123' }));
    });
    try {
      const code = await fetchBootstrapCode(baseUrl, 'est_abcdef');
      assert.equal(code, 'bc_test_123');
      assert.equal(method, 'POST');
      assert.equal(url, '/api/auth/embed-bootstrap');
      assert.equal(auth, 'Bearer est_abcdef');
    } finally {
      await close();
    }
  });

  it('throws when the server rejects the token (non-200, e.g. revoked)', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_token' }));
    });
    try {
      await assert.rejects(() => fetchBootstrapCode(url, 'est_revoked'), /Failed to mint bootstrap code/);
    } finally {
      await close();
    }
  });

  it('throws when the response is 200 but carries no code', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
    });
    try {
      await assert.rejects(() => fetchBootstrapCode(url, 'est_x'), /Failed to mint bootstrap code/);
    } finally {
      await close();
    }
  });
});

describe('DevicePairingProvider.getBootstrapCode', () => {
  it.todo(
    'throws "Not signed in" when no token is stored, and otherwise delegates to fetchBootstrapCode — ' +
      'not directly constructible here (requires vscode.SecretStorage from the extension host); see file header.'
  );
});
