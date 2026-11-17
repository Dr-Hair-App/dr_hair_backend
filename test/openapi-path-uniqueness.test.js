import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('OpenAPI path registry', () => {
  it('contains each route path exactly once', async () => {
    const spec = await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
    const paths = [...spec.matchAll(/^  (\/[^:\n]+):\s*$/gm)].map((match) => match[1]);
    const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index);
    assert.deepEqual(duplicates, [], `Duplicate OpenAPI path keys: ${duplicates.join(', ')}`);
  });

  it('documents app release build, scheduling, maintenance, and user-facing fields', async () => {
    const spec = await readFile(new URL('../docs/openapi.yaml', import.meta.url), 'utf8');
    const releaseBlock = spec.split('  /api/v1/admin/releases/{platform}:')[1]?.split('\n  /')[0] || '';
    const configBlock = spec.split('  /api/v1/app/config:')[1]?.split('\n  /')[0] || '';
    for (const property of ['minBuild', 'latestBuild', 'enabled', 'scheduledAt', 'maintenanceMessage', 'updateMessage']) {
      assert.ok(releaseBlock.includes(`${property}:`), `Release API is missing ${property}`);
    }
    assert.ok(configBlock.includes('name: build'), 'App config must document the client build query parameter');
  });
});
