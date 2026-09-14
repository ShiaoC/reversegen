import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { handleExternalGenerateReplay } from '../../gui/lib/api-generate.js';

const parameterString = '50,71,80,85,90,95,98,100:8:7:50:0:0:50:100075';

describe('POST /api/v1/generate-replay contract', () => {
  it('returns generator, parameter, terrain hash, and validation metadata', async () => {
    const terrain = JSON.parse(
      readFileSync(join(process.cwd(), 'test', 'fixtures', '100075.json'), 'utf8'),
    ) as Record<string, unknown>;
    terrain.LevelHash = '0123456789abcdef';

    const server = createServer(async (request, response) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      if (!await handleExternalGenerateReplay(request, response, url)) {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/generate-replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parameterString, terrain }),
      });
      const body = await response.json() as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.generatorVersion, '1.0.0');
      assert.match(String(body.parameterHash), /^[a-f0-9]{64}$/);
      assert.equal(body.levelHash, '0123456789abcdef');
      assert.equal((body.validation as { ok: boolean }).ok, true);
      assert.ok(String(body.replayCode));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  });
});
