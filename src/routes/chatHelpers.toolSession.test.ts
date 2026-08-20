import assert from 'node:assert';
import test, { describe } from 'node:test';
import { buildQwenMessages } from './chatHelpers.ts';

describe('buildQwenMessages tool session state', () => {
  test('when body.tools is provided, local_mcp is populated from tool definitions', () => {
    const messages = [
      {
        role: 'user',
        content: 'Run a command',
      },
    ];
    const body = {
      model: 'qwen3.7-max',
      tools: [
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
      ],
    };

    const result = buildQwenMessages(messages, body, 100000, true);

    // Should have local_mcp populated from tool definitions
    assert.ok(result.qwenMessages[0].feature_config.local_mcp, 'local_mcp should be populated');
    assert.ok(result.qwenMessages[0].feature_config.local_mcp['★'], 'local_mcp should have ★ key');
    assert.ok(result.qwenMessages[0].feature_config.local_mcp['★']['Bash'], 'Bash tool should be registered');
    assert.strictEqual(
      result.qwenMessages[0].feature_config.local_mcp['★']['Bash'].description,
      'Execute a bash command',
      'Tool description should be preserved',
    );
    assert.ok(
      result.qwenMessages[0].feature_config.local_mcp['★']['Bash'].input_schema.properties,
      'Tool schema should be preserved',
    );
  });

  test('when body.tools is absent but tool results exist, local_mcp is reconstructed from tool results (FIX)', () => {
    const messages = [
      {
        role: 'user',
        content: 'Run a command',
      },
      {
        role: 'assistant',
        content: 'I will run the command',
        tool_calls: [
          {
            id: 'call_123',
            function: {
              name: 'Bash',
              arguments: '{"command":"ls -la"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_123',
        name: 'Bash',
        content: 'total 100\ndrwxr-xr-x  5 user  staff   160 Aug 20 10:00 .\n-rw-r--r--  1 user  staff  2048 Aug 20 09:30 file.txt',
      },
    ];
    const body = {
      model: 'qwen3.7-max',
      // NOTE: body.tools is ABSENT — this is the bug scenario
    };

    const result = buildQwenMessages(messages, body, 100000, true);

    // The fix: local_mcp should be reconstructed from tool results
    assert.ok(
      result.qwenMessages[0].feature_config.local_mcp,
      'local_mcp should be populated (reconstructed from tool results)',
    );
    assert.ok(
      result.qwenMessages[0].feature_config.local_mcp['★'],
      'local_mcp should have ★ key',
    );
    assert.ok(
      result.qwenMessages[0].feature_config.local_mcp['★']['Bash'],
      'Bash tool should be registered from tool result',
    );

    // Schema will be empty object since we don't have the original definition
    assert.deepStrictEqual(
      result.qwenMessages[0].feature_config.local_mcp['★']['Bash'].input_schema,
      { type: 'object', properties: {} },
      'Tool schema should be empty object (reconstructed)',
    );
  });

  test('when body.tools is absent and no tool results, local_mcp remains empty', () => {
    const messages = [
      {
        role: 'user',
        content: 'Hello',
      },
    ];
    const body = {
      model: 'qwen3.7-max',
    };

    const result = buildQwenMessages(messages, body, 100000, true);

    // Should not have local_mcp when there are no tools
    assert.strictEqual(
      result.qwenMessages[0].feature_config.local_mcp,
      undefined,
      'local_mcp should not be populated when no tools exist',
    );
  });

  test('multiple tool calls are all registered in local_mcp', () => {
    const messages = [
      {
        role: 'user',
        content: 'Help me',
      },
      {
        role: 'assistant',
        content: 'I will use multiple tools',
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'Bash', arguments: '{"command":"ls"}' },
          },
          {
            id: 'call_2',
            function: { name: 'Read', arguments: '{"file_path":"test.txt"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'Bash',
        content: 'file1.txt file2.txt',
      },
      {
        role: 'tool',
        tool_call_id: 'call_2',
        name: 'Read',
        content: 'File contents here',
      },
    ];
    const body = {
      model: 'qwen3.7-max',
    };

    const result = buildQwenMessages(messages, body, 100000, true);

    assert.ok(result.qwenMessages[0].feature_config.local_mcp, 'local_mcp should be populated');
    assert.ok(result.qwenMessages[0].feature_config.local_mcp['★']['Bash'], 'Bash should be registered');
    assert.ok(result.qwenMessages[0].feature_config.local_mcp['★']['Read'], 'Read should be registered');
  });

  test('existing local_mcp from body.tools takes precedence over reconstructed one', () => {
    const messages = [
      {
        role: 'user',
        content: 'Run a command',
      },
      {
        role: 'assistant',
        content: 'I will run the command',
        tool_calls: [
          {
            id: 'call_1',
            function: { name: 'Bash', arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        name: 'Bash',
        content: 'file1.txt',
      },
    ];
    const body = {
      model: 'qwen3.7-max',
      tools: [
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
      ],
    };

    const result = buildQwenMessages(messages, body, 100000, true);

    // Should use the full schema from body.tools, not the empty reconstructed one
    assert.ok(result.qwenMessages[0].feature_config.local_mcp, 'local_mcp should be populated');
    assert.ok(
      result.qwenMessages[0].feature_config.local_mcp['★']['Bash'].input_schema.properties,
      'Should have full schema from body.tools',
    );
    assert.strictEqual(
      result.qwenMessages[0].feature_config.local_mcp['★']['Bash'].description,
      'Execute a bash command',
      'Should have description from body.tools',
    );
  });
});