import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  listAvailableLevels,
  replayCodeInputError,
  resolveTerrainFromDirectories,
  type TerrainDirectory,
} from '../../gui/lib/runtime.js';

function writeTerrain(path: string, levelResId: number): void {
  const terrain = JSON.parse(readFileSync(resolve('test/fixtures/100075.json'), 'utf-8'));
  terrain.levelResId = levelResId;
  writeFileSync(path, JSON.stringify(terrain));
}

test('terrain library resolves prepared first, packaged second and uploads last', () => {
  const root = mkdtempSync(join(tmpdir(), 'reversegen-library-'));
  const prepared = join(root, 'prepared');
  const packaged = join(root, 'packaged');
  const uploaded = join(root, 'uploaded');
  mkdirSync(prepared); mkdirSync(packaged); mkdirSync(uploaded);
  const directories: TerrainDirectory[] = [
    { dir: prepared, source: 'prepared' },
    { dir: packaged, source: 'packaged' },
    { dir: uploaded, source: 'uploaded' },
  ];

  try {
    writeTerrain(join(prepared, '100075.json'), 100075);
    writeTerrain(join(packaged, '100075.json'), 100075);
    writeTerrain(join(packaged, '200002.json'), 200002);
    writeTerrain(join(uploaded, 'manual-300003-a1b2c3.json'), 300003);

    assert.deepEqual(resolveTerrainFromDirectories('100075', directories), {
      path: join(prepared, '100075.json'), source: 'prepared',
    });
    assert.deepEqual(resolveTerrainFromDirectories('200002', directories), {
      path: join(packaged, '200002.json'), source: 'packaged',
    });
    assert.equal(basename(resolveTerrainFromDirectories('300003', directories)?.path || ''), 'manual-300003-a1b2c3.json');

    assert.deepEqual(listAvailableLevels(undefined, directories).map(item => [item.id, item.source]), [
      [100075, 'prepared'],
      [200002, 'packaged'],
      [300003, 'uploaded'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uploaded index keeps the newest content-addressed revision for a level', () => {
  const root = mkdtempSync(join(tmpdir(), 'reversegen-upload-index-'));
  try {
    const older = join(root, 'manual-old.json');
    const newer = join(root, 'manual-new.json');
    writeTerrain(older, 400004);
    writeTerrain(newer, 400004);
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newer, new Date(2_000), new Date(2_000));

    const directories: TerrainDirectory[] = [{ dir: root, source: 'uploaded' }];
    const listed = listAvailableLevels(undefined, directories);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].fileName, 'manual-new.json');
    assert.equal(basename(resolveTerrainFromDirectories('400004', directories)?.path || ''), 'manual-new.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ReplayCode input errors distinguish LevelHash, Revision and malformed codes', () => {
  assert.match(replayCodeInputError('5f7873ec0e9adfc2') || '', /LevelHash/);
  assert.match(replayCodeInputError(`sha256:${'a'.repeat(64)}`) || '', /Revision/);
  assert.match(replayCodeInputError('b'.repeat(40)) || '', /Revision/);
  assert.equal(replayCodeInputError('not-a-replay-code'), null);
});
