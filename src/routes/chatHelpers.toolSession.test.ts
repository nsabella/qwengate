import assert from 'node:assert';
import test, { describe } from 'node:test';
import { buildQwenMessages, readFileTracker } from './chatHelpers.ts';

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

// ── Repeated file reads regression tests ──────────────────────────

describe('buildQwenMessages repeated file reads fix', () => {
  test('already-read note is placed inside <metadata>, not <stdout>', () => {
    // Simulate two consecutive Read calls on the same file.
    // The second call should include an "already read" note.
    readFileTracker.clear();

    const messages = [
      { role: 'user', content: 'Read this file' },
      {
        role: 'assistant',
        content: 'Reading the file now',
        tool_calls: [
          {
            id: 'call_read_1',
            function: { name: 'Read', arguments: '{"path":"test.txt"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_1',
        name: 'Read',
        content: 'First line of test.txt\nSecond line',
      },
      {
        role: 'assistant',
        content: 'Reading it again',
        tool_calls: [
          {
            id: 'call_read_2',
            function: { name: 'Read', arguments: '{"path":"test.txt"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_read_2',
        name: 'Read',
        content: 'First line of test.txt\nSecond line',
      },
    ];
    const body = { model: 'qwen3.7-max' };

    const result = buildQwenMessages(messages, body, 100000, true);
    const toolResultsContent = result.toolResultsContent!;

    // The second tool result should contain the "already read" note
    assert.ok(
      toolResultsContent.includes('You already read this file 1 time(s) in this conversation'),
      'Should contain "already read" note',
    );

    // The note must be inside <metadata>, NOT inside <stdout>
    // Extract the second <tool_result> block
    const toolResultBlocks = toolResultsContent.match(/<tool_result[^>]*>[\s\S]*?<\/tool_result>/g)!;
    assert.strictEqual(toolResultBlocks.length, 2, 'Should have exactly 2 tool result blocks');

    const secondToolResult = toolResultBlocks[1];

    // The note should appear inside <metadata>
    const metadataMatch = secondToolResult.match(/<metadata>([\s\S]*?)<\/metadata>/);
    assert.ok(metadataMatch, 'Second tool result should have <metadata> element');
    assert.ok(
      metadataMatch![1].includes('You already read this file 1 time(s) in this conversation'),
      '"already read" note should be inside <metadata>',
    );

    // The note should NOT appear inside <stdout>
    const stdoutMatch = secondToolResult.match(/<stdout>([\s\S]*?)<\/stdout>/);
    assert.ok(stdoutMatch, 'Second tool result should have <stdout> element');
    assert.ok(
      !stdoutMatch![1].includes('You already read this file'),
      '"already read" note should NOT be inside <stdout>',
    );

    // The <stdout> should contain the actual file content
    assert.ok(
      stdoutMatch![1].includes('First line of test.txt'),
      '<stdout> should contain the actual file content',
    );
  });

  test('compressed content triggers "(compressed — middle lines omitted)" in metadata header', () => {
    // Create a tool result with >50 lines that includes the compression
    // marker pattern.  The regex /\\[\\d+\\s+lines?\\s+omitted\\]/i in
    // buildQwenMessages detects this and adds the compression indicator
    // to the metadata header.
    readFileTracker.clear();

    // Build content with 55 lines including a "[5 lines omitted]" marker
    const lines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      lines.push(`Line ${i}: some content for regression test purposes`);
    }
    lines.push('[5 lines omitted]');
    for (let i = 26; i <= 50; i++) {
      lines.push(`Line ${i}: more content for regression test purposes`);
    }
    const compressedContent = lines.join('\n');

    const messages = [
      { role: 'user', content: 'Show me the output' },
      {
        role: 'assistant',
        content: 'Running the command',
        tool_calls: [
          {
            id: 'call_compress_1',
            function: { name: 'Bash', arguments: '{"command":"cat large_file.txt"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_compress_1',
        name: 'Bash',
        content: compressedContent,
      },
    ];
    const body = { model: 'qwen3.7-max' };

    const result = buildQwenMessages(messages, body, 100000, true);
    const toolResultsContent = result.toolResultsContent!;

    // The metadata should contain the compression indicator
    const metadataMatch = toolResultsContent.match(/<metadata>([\s\S]*?)<\/metadata>/);
    assert.ok(metadataMatch, 'Tool result should have <metadata> element');

    const metadataContent = metadataMatch![1];
    assert.ok(
      metadataContent.includes('(compressed — middle lines omitted)'),
      `Metadata should include compression indicator. Got: ${metadataContent}`,
    );

    // The header should also be present (Tool: Bash | Lines: ...)
    assert.ok(
      metadataContent.includes('Tool: Bash'),
      'Metadata header should include tool name',
    );
  });
});