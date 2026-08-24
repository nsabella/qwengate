// Test suite for Qwen-to-Anthropic tool call conversion
// Tests both streaming and non-streaming paths
//
// The parameter normalization suites below import the real implementation
// (src/routes/anthropicToolParams.ts) — the same code used by both response
// paths in anthropic.ts. Claude Code tool schemas are snake_case
// (file_path, old_string, new_string); Qwen tends to emit camelCase.

import { beforeAll, describe, expect, test } from 'bun:test';

// ── Test helpers ─────────────────────────────────────────────────────

// Real Claude Code tool schemas as they arrive in /v1/messages requests
const CLAUDE_CODE_TOOLS = [
  {
    name: 'Read',
    description: 'Reads a file from the local filesystem',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Edit',
    description: 'Performs exact string replacement in a file',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Write',
    description: 'Writes a file to the local filesystem',
    input_schema: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
];

// ── Local MCP extraction test ────────────────────────────────────────

describe('extractLocalMcpToolCalls', () => {
  test('extracts tool calls with params from local_mcp event', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            role: 'assistant',
            content: '',
            phase: 'local_tool',
            status: 'finished',
            extra: {
              local_mcp: {
                '★': [
                  {
                    tool_name: '★-Bash',
                    params: { command: 'ls -la /tmp' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe('Bash');
    expect(calls[0].arguments).toEqual({ command: 'ls -la /tmp' });
    expect(calls[0].id).toStartWith('call_');
  });

  test('extracts multiple tool calls', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [
                  { tool_name: '★-Bash', params: { command: 'echo hello' } },
                  { tool_name: '★-Read', params: { file_path: '/tmp/test.txt' } },
                  { tool_name: '★-Edit', params: { file_path: '/tmp/test.txt', old_string: 'foo', new_string: 'bar' } },
                ],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(3);
    expect(calls[0].name).toBe('Bash');
    expect(calls[1].name).toBe('Read');
    expect(calls[2].name).toBe('Edit');
    expect(calls[1].arguments).toEqual({ file_path: '/tmp/test.txt' });
  });

  test('returns empty array for missing local_mcp', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
    expect(extractLocalMcpToolCalls({})).toEqual([]);
    expect(extractLocalMcpToolCalls({ choices: [] })).toEqual([]);
    expect(extractLocalMcpToolCalls({ choices: [{}] })).toEqual([]);
  });

  test('strips ★- prefix from tool names', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Test with and without prefix
    const withPrefix = {
      choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Bash', params: { command: 'ls' } }] } } } }],
    };
    const withoutPrefix = {
      choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: 'Bash', params: { command: 'ls' } }] } } } }],
    };

    expect(extractLocalMcpToolCalls(withPrefix)[0].name).toBe('Bash');
    expect(extractLocalMcpToolCalls(withoutPrefix)[0].name).toBe('Bash');
  });
});

// ── XML tool call parsing test ───────────────────────────────────────

describe('xmlToolCallToParsed', () => {
  test('converts XML tool calls with parameters', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: 'Bash', parameters: { command: 'ls -la', description: 'List files' } }, 0);
    expect(result.name).toBe('Bash');
    expect(result.arguments).toEqual({ command: 'ls -la', description: 'List files' });
    expect(result.id).toStartWith('call_');
  });

  test('handles JSON parameter values', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: 'Read', parameters: { file_path: '"/tmp/test.txt"', timeout: '5000' } }, 0);
    expect(result.arguments).toEqual({ file_path: '/tmp/test.txt', timeout: 5000 });
  });

  test('strips ★- prefix from tool name', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: '★-Bash', parameters: { command: 'ls' } }, 0);
    expect(result.name).toBe('Bash');
  });

  test('handles empty parameters', async () => {
    const { xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    const result = xmlToolCallToParsed({ name: 'Bash', parameters: {} }, 0);
    expect(result.name).toBe('Bash');
    expect(result.arguments).toEqual({});
  });
});

// ── parseXmlToolCalls test ───────────────────────────────────────────

describe('parseXmlToolCalls', () => {
  test('parses tool calls from XML text', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    const text = `<function=Bash>
<parameter=command>ls -la</parameter>
</function>`;
    const { toolCalls, cleanedText } = parseXmlToolCalls(text);
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[0].parameters).toEqual({ command: 'ls -la' });
    expect(cleanedText).not.toContain('<function=');
  });

  test('parses multiple tool calls from XML text', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    const text = `<function=Bash>
<parameter=command>echo hi</parameter>
</function>
<function=Read>
<parameter=file_path>/tmp/test.txt</parameter>
<parameter>ignore</parameter>
</function>`;
    const { toolCalls } = parseXmlToolCalls(text);
    expect(toolCalls.length).toBe(2);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[1].name).toBe('Read');
  });

  test('returns empty for text without tool calls', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    const { toolCalls } = parseXmlToolCalls('Hello, how can I help you?');
    expect(toolCalls.length).toBe(0);
  });

  test('handles malformed XML gracefully', async () => {
    const { parseXmlToolCalls } = await import('../tools/xmlToolParser.ts');

    // Missing closing tag
    const text1 = `<function=Bash>\n<parameter=command>ls</parameter>\n`;
    const result1 = parseXmlToolCalls(text1);
    // Should not crash, may or may not parse depending on implementation
    expect(result1.toolCalls).toBeDefined();

    // Just a function tag with no params
    const text2 = `<function=Bash></function>`;
    const result2 = parseXmlToolCalls(text2);
    if (result2.toolCalls.length > 0) {
      expect(result2.toolCalls[0].parameters).toEqual({});
    }
  });
});

// ── Anthropic tools → OpenAI conversion test ─────────────────────────

describe('anthropicToolsToOpenAI', () => {
  test('converts Anthropic tool format to OpenAI format', async () => {
    // Replicate the function
    const tools = CLAUDE_CODE_TOOLS;

    const converted = tools.map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
    }));

    expect(converted.length).toBe(3);
    expect(converted[0].type).toBe('function');
    expect(converted[0].function.name).toBe('Read');
    // Claude Code schemas keep their snake_case param names end-to-end
    expect(converted[0].function.parameters.required).toEqual(['file_path']);
    expect(converted[1].function.parameters.required).toEqual(['file_path', 'old_string', 'new_string']);
  });

  test('returns empty array for no tools', async () => {
    const converted: any[] = [];
    expect(converted).toEqual([]);
  });
});

// ── Tool parameter normalization (schema-driven) ─────────────────────

describe('normalizeToolArgNames', () => {
  let P: typeof import('../routes/anthropicToolParams.ts');
  beforeAll(async () => {
    P = await import('../routes/anthropicToolParams.ts');
  });

  test('regression: Qwen camelCase filePath is renamed toward schema file_path', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    const args = P.normalizeToolArgNames('Read', { filePath: '/tmp/x.md' }, index);
    expect(args).toEqual({ file_path: '/tmp/x.md' });
  });

  test('regression: Edit camelCase trio renamed toward schema snake_case', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    const args = P.normalizeToolArgNames('Edit', { filePath: '/tmp/x', oldString: 'a', newString: 'b' }, index);
    expect(args).toEqual({ file_path: '/tmp/x', old_string: 'a', new_string: 'b' });
  });

  test('already-correct snake_case passes through untouched', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    const args = P.normalizeToolArgNames('Read', { file_path: '/tmp/x.md', offset: 5 }, index);
    expect(args).toEqual({ file_path: '/tmp/x.md', offset: 5 });
  });

  test('client with camelCase schema gets camelCase preserved (Qwen snake_case renamed)', () => {
    const camelTools = [
      {
        name: 'Read',
        input_schema: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
        },
      },
    ];
    const index = P.buildToolSchemaIndex(camelTools);
    const args = P.normalizeToolArgNames('Read', { file_path: '/tmp/x' }, index);
    expect(args).toEqual({ filePath: '/tmp/x' });
  });

  test('params unknown to the schema pass through unchanged', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    const args = P.normalizeToolArgNames('Read', { file_path: '/x', weird_param: 1 }, index);
    expect(args).toEqual({ file_path: '/x', weird_param: 1 });
  });

  test('JSON string arguments are parsed before normalization', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    const args = P.normalizeToolArgNames('Edit', '{"filePath":"/x","oldString":"a","newString":"b"}', index);
    expect(args).toEqual({ file_path: '/x', old_string: 'a', new_string: 'b' });
  });

  test('unparseable or non-object arguments yield {}', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    expect(P.normalizeToolArgNames('Read', 'not-json', index)).toEqual({});
    expect(P.normalizeToolArgNames('Read', ['/x'], index)).toEqual({});
    expect(P.normalizeToolArgNames('Read', null, index)).toEqual({});
  });

  test('lookup tolerates lowercase tool names from Qwen', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    const args = P.normalizeToolArgNames('read', { filePath: '/x' }, index);
    expect(args).toEqual({ file_path: '/x' });
  });

  test('no schema at all: known Claude Code camelCase params still renamed via fallback', () => {
    const index = P.buildToolSchemaIndex([]);
    const args = P.normalizeToolArgNames('Read', { filePath: '/x' }, index);
    expect(args).toEqual({ file_path: '/x' });
  });

  test('no schema at all: unrelated keys pass through untouched', () => {
    const index = P.buildToolSchemaIndex([]);
    const args = P.normalizeToolArgNames('Grep', { pattern: 'foo', path: '/x' }, index);
    expect(args).toEqual({ pattern: 'foo', path: '/x' });
  });
});

// ── Tool call required-param validation tests ─────────────────────

describe('requiredParamsFor and isValidToolCall', () => {
  let P: typeof import('../routes/anthropicToolParams.ts');
  beforeAll(async () => {
    P = await import('../routes/anthropicToolParams.ts');
  });

  test('schema-required wins over fallback table', () => {
    const index = P.buildToolSchemaIndex(CLAUDE_CODE_TOOLS);
    expect(P.requiredParamsFor('Read', index)).toEqual(['file_path']);
    expect(P.requiredParamsFor('Edit', index)).toEqual(['file_path', 'old_string', 'new_string']);
  });

  test('fallback table matches real Claude Code schemas (snake_case)', () => {
    const index = P.buildToolSchemaIndex([]);
    expect(P.requiredParamsFor('Bash', index)).toEqual(['command']);
    expect(P.requiredParamsFor('Read', index)).toEqual(['file_path']);
    expect(P.requiredParamsFor('Write', index)).toEqual(['file_path', 'content']);
  });

  test('unknown tool has no required params', () => {
    const index = P.buildToolSchemaIndex([]);
    expect(P.requiredParamsFor('TotallyCustom', index)).toBeNull();
  });

  test('Bash requires command (fallback)', () => {
    expect(P.isValidToolCall('Bash', { command: 'ls' })).toBe(true);
    expect(P.isValidToolCall('Bash', {})).toBe(false);
    expect(P.isValidToolCall('Bash', { description: 'List files' })).toBe(false);
    expect(P.isValidToolCall('Bash', { command: '' })).toBe(false);
    expect(P.isValidToolCall('Bash', { command: null })).toBe(false);
  });

  test('regression: Read with snake_case file_path is valid', () => {
    // This is exactly what Claude Code sends and expects back
    expect(P.isValidToolCall('Read', { file_path: '/tmp/x' })).toBe(true);
    expect(P.isValidToolCall('Read', {})).toBe(false);
  });

  test('regression: Edit with snake_case trio is valid', () => {
    expect(P.isValidToolCall('Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' })).toBe(true);
    expect(P.isValidToolCall('Edit', { file_path: '/tmp/x' })).toBe(false);
    expect(P.isValidToolCall('Edit', { file_path: '/tmp/x', old_string: 'a' })).toBe(false);
  });

  test('unknown tool passes with any params but not with none', () => {
    expect(P.isValidToolCall('Unknown', { param1: 'val' })).toBe(true);
    expect(P.isValidToolCall('Unknown', {})).toBe(false);
  });

  test('non-object args are invalid', () => {
    expect(P.isValidToolCall('Read', null)).toBe(false);
    expect(P.isValidToolCall('Read', ['/x'])).toBe(false);
  });

  test('missingRequiredParams reports which params are absent', () => {
    expect(P.missingRequiredParams(['file_path', 'content'], { file_path: '/x' })).toEqual(['content']);
    expect(P.missingRequiredParams(['file_path'], { file_path: '' })).toEqual(['file_path']);
    expect(P.missingRequiredParams(['command'], { command: 'ls' })).toEqual([]);
  });
});

describe('normalizeToolName', () => {
  let P: typeof import('../routes/anthropicToolParams.ts');
  beforeAll(async () => {
    P = await import('../routes/anthropicToolParams.ts');
  });

  test('normalizes Qwen casing to Claude Code conventions', () => {
    expect(P.normalizeToolName('bash')).toBe('Bash');
    expect(P.normalizeToolName('read')).toBe('Read');
    expect(P.normalizeToolName('edit')).toBe('Edit');
    expect(P.normalizeToolName('write')).toBe('Write');
    expect(P.normalizeToolName('websearch')).toBe('WebSearch');
    expect(P.normalizeToolName('web_search')).toBe('WebSearch');
  });

  test('leaves already-correct and unknown names alone', () => {
    expect(P.normalizeToolName('Read')).toBe('Read');
    expect(P.normalizeToolName('Grep')).toBe('Grep');
    expect(P.normalizeToolName('mcp__server__tool')).toBe('mcp__server__tool');
  });
});

// ── Full local_mcp pipeline test ──────────────────────────────────────
// End-to-end: mock Qwen SSE → extractLocalMcpToolCalls → normalize/validate
// → emit as Anthropic tool_use content blocks for Claude Code

describe('local_mcp pipeline to Claude Code', () => {
  let P: typeof import('../routes/anthropicToolParams.ts');
  beforeAll(async () => {
    P = await import('../routes/anthropicToolParams.ts');
  });

  // Mirrors validateToolCall in handleAnthropicStream (anthropic.ts)
  function makeValidator(tools?: any[]) {
    const index = P.buildToolSchemaIndex(tools);
    return (tc: { id?: string; name: string; arguments: any }) => {
      const toolName = P.normalizeToolName(tc.name);
      const args = P.normalizeToolArgNames(toolName, tc.arguments, index);
      const required = P.requiredParamsFor(toolName, index);
      return { toolName, args, valid: P.isValidToolCall(toolName, args, required) };
    };
  }

  function emitToolUseBlock(id: string, name: string, args: any): any {
    return {
      type: 'content_block_start',
      content_block: { type: 'tool_use', id, name, input: args },
    };
  }

  test('local_mcp Bash reaches Claude Code correctly', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            role: 'assistant',
            content: '',
            phase: 'local_tool',
            status: 'finished',
            extra: {
              local_mcp: {
                '★': [{ tool_name: '★-Bash', params: { command: 'ls -la /tmp' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    expect(calls.length).toBe(1);

    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const result = validate(calls[0]);
    expect(result.valid).toBe(true);
    expect(result.toolName).toBe('Bash');
    expect(result.args).toEqual({ command: 'ls -la /tmp' });

    const block = emitToolUseBlock(calls[0].id, result.toolName, result.args);
    expect(block.content_block.type).toBe('tool_use');
    expect(block.content_block.name).toBe('Bash');
    expect(block.content_block.input).toEqual({ command: 'ls -la /tmp' });
    expect(block.content_block.id).toStartWith('call_');
  });

  test('regression: Read with snake_case file_path stays snake_case and is valid', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [{ tool_name: '★-Read', params: { file_path: '/tmp/test.txt' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const result = validate(calls[0]);

    expect(result.valid).toBe(true);
    const block = emitToolUseBlock(calls[0].id, result.toolName, result.args);
    expect(block.content_block.name).toBe('Read');
    // Claude Code requires file_path — renaming it would break every call
    expect(block.content_block.input).toEqual({ file_path: '/tmp/test.txt' });
  });

  test('regression: Read with Qwen-style camelCase filePath is normalized to file_path', async () => {
    // Reproduces the reported failure: Qwen emitted {"filePath": "..."} and
    // Claude Code rejected it ("required parameter file_path is missing")
    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const result = validate({
      name: 'read',
      arguments: { filePath: 'C:\\Users\\Nick\\.claude\\projects\\proj\\memory\\MEMORY.md' },
    });

    expect(result.valid).toBe(true);
    expect(result.toolName).toBe('Read');
    expect(result.args).toEqual({ file_path: 'C:\\Users\\Nick\\.claude\\projects\\proj\\memory\\MEMORY.md' });
  });

  test('Write passes validation and keeps snake_case file_path', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [
                  {
                    tool_name: '★-Write',
                    params: { file_path: '/tmp/output.txt', content: 'hello world' },
                  },
                ],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const result = validate(calls[0]);

    expect(result.valid).toBe(true);
    const block = emitToolUseBlock(calls[0].id, result.toolName, result.args);
    expect(block.content_block.name).toBe('Write');
    expect(block.content_block.input).toEqual({ file_path: '/tmp/output.txt', content: 'hello world' });
  });

  test('lowercase tool name is normalized to PascalCase', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [{ tool_name: 'bash', params: { command: 'echo hi' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    // extractLocalMcpToolCalls strips ★- prefix but doesn't normalize case
    expect(calls[0].name).toBe('bash');

    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const result = validate(calls[0]);

    expect(result.valid).toBe(true);
    const block = emitToolUseBlock(calls[0].id, result.toolName, result.args);
    expect(block.content_block.name).toBe('Bash'); // normalized
    expect(block.content_block.input).toEqual({ command: 'echo hi' });
  });

  test('missing required param is filtered out (not sent to Claude Code)', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Bash without command
    const sseChunk = {
      choices: [
        {
          delta: {
            extra: {
              local_mcp: {
                '★': [{ tool_name: '★-Bash', params: { description: 'list files' } }],
              },
            },
          },
        },
      ],
    };

    const calls = extractLocalMcpToolCalls(sseChunk);
    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const results = calls.map(validate).filter((r) => r.valid);

    expect(results.length).toBe(0); // filtered out
  });

  test('full multi-tool local_mcp round trip with dedup by ID', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');

    // Simulate multiple SSE chunks arriving during stream
    const chunks = [
      {
        choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Bash', params: { command: 'ls' } }] } } } }],
      },
      {
        choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Read', params: { file_path: '/tmp/x' } }] } } } }],
      },
      {
        choices: [
          {
            delta: {
              extra: { local_mcp: { '★': [{ tool_name: '★-Edit', params: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } }] } },
            },
          },
        ],
      },
    ];

    // Accumulate tool calls during stream
    const localToolCallsAccum: any[] = [];
    for (const chunk of chunks) {
      const calls = extractLocalMcpToolCalls(chunk);
      for (const c of calls) {
        if (!localToolCallsAccum.some((e) => e.id === c.id)) localToolCallsAccum.push(c);
      }
    }

    expect(localToolCallsAccum.length).toBe(3);

    // Validate all against the schemas Claude Code sent
    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const validated = localToolCallsAccum.map((tc) => ({ tc, ...validate(tc) }));
    const validOnes = validated.filter((v) => v.valid);

    expect(validOnes.length).toBe(3);

    // Emit and verify each tool_use block — param names match client schemas
    const blocks = validOnes.map((v) => emitToolUseBlock(v.tc.id!, v.toolName, v.args));
    expect(blocks[0].content_block).toEqual({
      type: 'tool_use',
      id: expect.stringMatching(/^call_/),
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(blocks[1].content_block).toEqual({
      type: 'tool_use',
      id: expect.stringMatching(/^call_/),
      name: 'Read',
      input: { file_path: '/tmp/x' },
    });
    expect(blocks[2].content_block).toEqual({
      type: 'tool_use',
      id: expect.stringMatching(/^call_/),
      name: 'Edit',
      input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
    });
  });

  test('XML fallback + local_mcp both active — merge produces correct tool_use blocks', async () => {
    const { extractLocalMcpToolCalls } = await import('../routes/chatStreamingHelpers.ts');
    const { parseXmlToolCalls, xmlToolCallToParsed } = await import('../tools/xmlToolParser.ts');

    // Simulate lastFullContent with XML tool call (model hallucinated XML)
    const lastFullContent = `I'll run that command for you.
<function=Bash>
<parameter=command>ls -la</parameter>
</function>`;

    // Step 1: Extract XML from text
    const { toolCalls: xmlToolCalls } = parseXmlToolCalls(lastFullContent);
    const xmlParsedCalls = xmlToolCalls.map((tc, i) => xmlToolCallToParsed(tc, i));
    expect(xmlParsedCalls.length).toBe(1);
    expect(xmlParsedCalls[0].name).toBe('Bash');
    expect(xmlParsedCalls[0].arguments).toEqual({ command: 'ls -la' });

    // Step 2: Also got a local_mcp for the same tool
    const sseChunk = {
      choices: [{ delta: { extra: { local_mcp: { '★': [{ tool_name: '★-Bash', params: { command: 'ls -la' } }] } } } }],
    };
    const localMcpCalls = extractLocalMcpToolCalls(sseChunk);

    // Step 3: Merge (dedup by ID only)
    const allToolCalls: any[] = [...xmlParsedCalls];
    for (const ltc of localMcpCalls) {
      if (!allToolCalls.some((e: any) => e.id === ltc.id)) allToolCalls.push(ltc);
    }
    expect(allToolCalls.length).toBe(2);

    // Step 4: Validate both
    const validate = makeValidator(CLAUDE_CODE_TOOLS);
    const validOnes = allToolCalls.map((tc) => ({ tc, ...validate(tc) })).filter((v) => v.valid);
    expect(validOnes.length).toBe(2);

    // Step 5: Emit — both go to Claude Code
    const blocks = validOnes.map((v) => emitToolUseBlock(v.tc.id, v.toolName, v.args));
    expect(blocks.every((b) => b.content_block.name === 'Bash')).toBe(true);
    expect(blocks.every((b) => b.content_block.input.command === 'ls -la')).toBe(true);
  });

  test('XML hallucination in text — text content still emitted as text_delta during stream', async () => {
    const { cleanTextOfXmlArtifacts } = await import('../tools/xmlToolParser.ts');

    // Model produces text with XML tool call markup
    const rawText = `I'll list the directory for you.
<function=Bash>
<parameter=command>ls -la /tmp</parameter>
</function>`;

    // What gets streamed as text_delta to Claude Code:
    // cleanTextOfXmlArtifacts strips XML from text
    const { toolCalls, cleanedText } = cleanTextOfXmlArtifacts(rawText);

    // XML markup removed from text
    expect(cleanedText).toBe("I'll list the directory for you.\n");
    expect(cleanedText).not.toContain('<function=');

    // Tool call extracted correctly
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].name).toBe('Bash');
    expect(toolCalls[0].parameters).toEqual({ command: 'ls -la /tmp' });
  });
});
