import assert from 'node:assert';
import test from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';

import { sessionPool } from './sessionPool.ts';

const TEST_EMAIL = 'test@qwen-gate.dev';

test('release() persists cachedTools to session entry', async () => {
  // Acquire a session
  const entry = await sessionPool.acquire(TEST_EMAIL);
  assert.ok(entry.chatId, 'Should have chatId');

  // Verify cachedTools is initially undefined
  assert.strictEqual(entry.cachedTools, undefined, 'cachedTools should be undefined initially');

  // Release with cachedTools
  const tools = [
    {
      function: {
        name: 'Bash',
        description: 'Execute a bash command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
        },
      },
    },
  ];

  await sessionPool.release(entry.chatId, null, undefined, TEST_EMAIL, true, tools);

  // Re-acquire the same session (should be the same entry from the pool)
  const reAcquired = await sessionPool.acquire(TEST_EMAIL);
  assert.strictEqual(reAcquired.chatId, entry.chatId, 'Should re-acquire the same session');

  // Verify cachedTools is now populated
  assert.ok(reAcquired.cachedTools, 'cachedTools should be populated after release');
  assert.strictEqual(reAcquired.cachedTools!.length, 1, 'Should have 1 tool');
  assert.strictEqual(reAcquired.cachedTools![0].function.name, 'Bash', 'Tool name should be Bash');
});

test('cachedTools is not persisted when release() has no tools', async () => {
  const entry = await sessionPool.acquire(TEST_EMAIL);

  // Release without cachedTools
  await sessionPool.release(entry.chatId, null, undefined, TEST_EMAIL, true, undefined);

  const reAcquired = await sessionPool.acquire(TEST_EMAIL);
  assert.strictEqual(reAcquired.cachedTools, undefined, 'cachedTools should remain undefined');
});

test('cachedTools is consumed after first inherit', async () => {
  const entry = await sessionPool.acquire(TEST_EMAIL);
  const tools = [
    {
      function: {
        name: 'Write',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
    },
  ];

  // First cycle: release with tools, acquire should inherit
  await sessionPool.release(entry.chatId, null, undefined, TEST_EMAIL, true, tools);
  const entry2 = await sessionPool.acquire(TEST_EMAIL);
  assert.strictEqual(entry2.cachedTools!.length, 1, 'Should have 1 tool after first cycle');
  assert.strictEqual(entry2.cachedTools![0].function.name, 'Write', 'Tool name should be Write');

  // Second cycle: acquire without prior release should have no cachedTools (consumed)
  const entry3 = await sessionPool.acquire(TEST_EMAIL);
  assert.strictEqual(entry3.cachedTools, undefined, 'cachedTools should be undefined after consumption');
});
