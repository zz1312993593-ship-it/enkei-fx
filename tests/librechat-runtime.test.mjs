import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { dockerCliCandidates, libreChatHomeCandidates, resolveLibreChatDeployment } from '../launcher/librechat-runtime.mjs';

test('explicit LibreChat home is the first candidate and duplicates are removed', () => {
  const root = path.resolve('C:/Enkei/project');
  const explicit = path.resolve('C:/Enkei/gateway');
  const candidates = libreChatHomeCandidates(root, { ENKEI_LIBRECHAT_HOME: explicit });
  assert.equal(candidates[0], explicit);
  assert.equal(new Set(candidates).size, candidates.length);
});

test('deployment resolver accepts a packaged librechat directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enkei-runtime-'));
  const home = path.join(root, 'librechat');
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'docker-compose.yml'), 'services: {}\n');
  assert.deepEqual(await resolveLibreChatDeployment(root, {}), {
    home: path.resolve(home),
    composeFile: path.resolve(home, 'docker-compose.yml'),
  });
});

test('docker candidate list keeps the PATH command as a safe fallback', () => {
  assert.ok(dockerCliCandidates({}).includes('docker.exe'));
});
