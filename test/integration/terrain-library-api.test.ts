import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'reversegen-library-api-'));
const prepared = join(root, 'prepared');
const packaged = join(root, 'packaged');
const uploaded = join(root, 'uploaded');
mkdirSync(prepared); mkdirSync(packaged); mkdirSync(uploaded);

function writeTerrain(path: string, levelResId: number): void {
  const terrain = JSON.parse(readFileSync(resolve('test/fixtures/100075.json'), 'utf-8'));
  terrain.levelResId = levelResId;
  writeFileSync(path, JSON.stringify(terrain));
}

writeTerrain(join(prepared, '100075.json'), 100075);
writeTerrain(join(packaged, '100075.json'), 100075);
writeTerrain(join(packaged, '200002.json'), 200002);
writeTerrain(join(uploaded, 'manual-300003-contenthash.json'), 300003);

let port = 0;
let child: ReturnType<typeof spawn>;

async function reservePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('无法取得测试端口'));
      const selectedPort = address.port;
      probe.close(error => error ? reject(error) : resolvePort(selectedPort));
    });
  });
}

before(async () => {
  port = await reservePort();
  child = spawn(resolve('node_modules/.bin/tsx'), ['gui/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      APP_BASE_PATH: '/apps/reversegen/',
      PREPARED_LEVELS_DIR: prepared,
      PACKAGED_LEVELS_DIR: packaged,
      UPLOADED_TERRAINS_DIR: uploaded,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch { /* 等待启动 */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error('ReverseGen 测试服务未就绪');
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
});

test('library API returns one precedence-aware index and reports actual source', async () => {
  const levelsResponse = await fetch(`http://127.0.0.1:${port}/apps/reversegen/api/levels`);
  assert.equal(levelsResponse.status, 200);
  const levelsBody = await levelsResponse.json() as {
    levels: Array<{ id: number; source: string }>;
    precedence: string[];
  };
  assert.deepEqual(levelsBody.precedence, ['prepared', 'packaged', 'uploaded']);
  assert.deepEqual(levelsBody.levels.map(level => [level.id, level.source]), [
    [100075, 'prepared'],
    [200002, 'packaged'],
    [300003, 'uploaded'],
  ]);

  const preparedResponse = await fetch(`http://127.0.0.1:${port}/apps/reversegen/api/terrain-info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ levelId: '100075' }),
  });
  const preparedBody = await preparedResponse.json() as { source: string; sourceLabel: string; resolvedPath: string };
  assert.equal(preparedBody.source, 'prepared');
  assert.equal(preparedBody.sourceLabel, '预备地形');
  assert.equal(preparedBody.resolvedPath, join(prepared, '100075.json'));

  const packagedResponse = await fetch(`http://127.0.0.1:${port}/apps/reversegen/api/terrain-info`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ levelId: '200002' }),
  });
  const packagedBody = await packagedResponse.json() as { source: string; sourceLabel: string };
  assert.equal(packagedBody.source, 'packaged');
  assert.equal(packagedBody.sourceLabel, '入包地形');
});

test('ReplayCode API explains Hash and Revision copy mistakes', async () => {
  for (const [input, expected] of [
    ['5f7873ec0e9adfc2', 'LevelHash'],
    [`sha256:${'a'.repeat(64)}`, 'Revision'],
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}/apps/reversegen/api/decode`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replayCode: input }),
    });
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, new RegExp(expected));
  }
});

test('legacy navigation asset and persistent upload flow remain available', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/apps/reversegen/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /reversegen-nav\.js/);
  const navigation = await fetch(`http://127.0.0.1:${port}/apps/reversegen/reversegen-nav.js`);
  assert.equal(navigation.status, 200);
  assert.match(navigation.headers.get('content-type') || '', /javascript/);

  const terrain = JSON.parse(readFileSync(resolve('test/fixtures/100075.json'), 'utf-8'));
  terrain.levelResId = 400004;
  const uploadResponse = await fetch(`http://127.0.0.1:${port}/apps/reversegen/api/terrain-upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: '400004.json', terrainJson: JSON.stringify(terrain) }),
  });
  assert.equal(uploadResponse.status, 200);
  const uploadBody = await uploadResponse.json() as { source: string; resolvedPath: string };
  assert.equal(uploadBody.source, 'uploaded');
  assert.equal(existsSync(uploadBody.resolvedPath), true);
  assert.equal(uploadBody.resolvedPath.startsWith(uploaded), true);

  const levelsResponse = await fetch(`http://127.0.0.1:${port}/apps/reversegen/api/levels`);
  const levelsBody = await levelsResponse.json() as { levels: Array<{ id: number; source: string }> };
  const uploadedLevel = levelsBody.levels.find(level => level.id === 400004);
  assert.equal(uploadedLevel?.source, 'uploaded');
});
