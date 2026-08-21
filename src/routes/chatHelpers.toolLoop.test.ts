import assert from 'node:assert';
import test, { describe, beforeEach } from 'node:test';
import { checkCrossRequestToolLoop, resetToolCallHistory } from './chatHelpers.ts';

describe('checkCrossRequestToolLoop', () => {
  beforeEach(() => {
    resetToolCallHistory();
  });
  test('first call to a tool does not trigger loop', () => {
    const result = checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    assert.strictEqual(result, null, 'First call should not trigger loop');
  });

  test('second call to the same tool with same args does not trigger loop', () => {
    // First call
    checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    // Second call
    const result = checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    assert.strictEqual(result, null, 'Second call should not trigger loop');
  });

  test('third call to the same tool with same args triggers loop', () => {
    // First call
    checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    // Second call
    checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    // Third call should trigger loop
    const result = checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    assert.ok(result, 'Third call should trigger loop');
    assert.ok(
      result!.includes('CROSS-REQUEST LOOP DETECTED'),
      'Loop message should mention CROSS-REQUEST LOOP DETECTED',
    );
    assert.ok(
      result!.includes('Bash'),
      'Loop message should mention the tool name',
    );
    assert.ok(
      result!.includes('3 times'),
      'Loop message should mention the count',
    );
  });

  test('different args do not trigger loop', () => {
    // First call with args A
    checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    // Second call with different args B
    const result = checkCrossRequestToolLoop('Bash', { command: 'pwd' });
    assert.strictEqual(result, null, 'Different args should not trigger loop');
  });

  test('different tools do not trigger loop', () => {
    // First call to Bash
    checkCrossRequestToolLoop('Bash', { command: 'ls -la' });
    // Second call to Read
    const result = checkCrossRequestToolLoop('Read', { file_path: 'test.txt' });
    assert.strictEqual(result, null, 'Different tool should not trigger loop');
  });

  test('args are canonicalized (order-independent)', () => {
    // First call with args in one order
    checkCrossRequestToolLoop('Bash', { command: 'ls -la', flag: true });
    // Second call with args in different order
    const result = checkCrossRequestToolLoop('Bash', { flag: true, command: 'ls -la' });
    assert.strictEqual(result, null, 'Same args in different order should not trigger loop');
  });

  test('third call with canonicalized args triggers loop', () => {
    // First call
    checkCrossRequestToolLoop('Bash', { command: 'ls -la', flag: true });
    // Second call with different order
    checkCrossRequestToolLoop('Bash', { flag: true, command: 'ls -la' });
    // Third call should trigger loop
    const result = checkCrossRequestToolLoop('Bash', { command: 'ls -la', flag: true });
    assert.ok(result, 'Third call should trigger loop even with different arg order');
  });

  test('loop detection is cross-request (persists across function calls)', () => {
    // Simulate multiple requests
    checkCrossRequestToolLoop('Bash', { command: 'echo hello' });
    checkCrossRequestToolLoop('Bash', { command: 'echo hello' });
    // Third request should detect loop
    const result = checkCrossRequestToolLoop('Bash', { command: 'echo hello' });
    assert.ok(result, 'Should detect loop across requests');
  });
});
