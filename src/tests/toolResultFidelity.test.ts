// Regression tests for the 2026-08-24 cam_tracking session failures:
//
// 1. compressToolResult gutted any tool result over 50 lines down to
//    first-20 + last-10, so Qwen never saw the middle of files it had just
//    Read/catted. The agent re-read the same files, then concluded its file
//    tools were broken ("returning 'does not exist' errors") and dumped file
//    contents into chat text instead of using Write.
// 2. Tool results were hoisted into a separate uploaded context.txt,
//    decoupling them from the <assist> turns that produced them.
// 3. Text accompanying tool_result blocks was silently dropped during
//    Anthropic → OpenAI conversion.

import { describe, expect, test } from 'bun:test';
import { buildQwenMessages } from '../routes/chatHelpers.ts';
import { compressToolResult } from '../routes/compressToolResult.ts';

// ── Fix 1: source-file tool results survive intact ─────────────────────

describe('compressToolResult fidelity', () => {
  const pythonFile = Array.from({ length: 300 }, (_, i) => `def section_${i}():\n    return requests.post(URL_${i}, timeout=10)\n`).join(
    '\n',
  );

  test('a multi-hundred-line source file passes through intact (under cap)', () => {
    // ~17K chars — same ballpark as the session's test_ptz.py Read result
    expect(pythonFile.length).toBeGreaterThan(10000);
    expect(pythonFile.length).toBeLessThan(24000);
    const out = compressToolResult(pythonFile);
    expect(out).toBe(pythonFile);
  });

  test('the middle of a long file is not replaced by "[N lines omitted]"', () => {
    const out = compressToolResult(pythonFile);
    expect(out).not.toContain('lines omitted');
    expect(out).toContain('def section_150()'); // previously destroyed territory
  });

  test('extremely large unstructured output is bounded by TOOL_RESULT_MAX_CHARS with head+tail kept', () => {
    // 120K chars, no recognizable structure → capped at ~24K default
    const huge = Array.from({ length: 4000 }, (_, i) => `log line ${i}: ${'x'.repeat(28)}`).join('\n');
    const out = compressToolResult(huge);
    expect(out.length).toBeLessThan(26000);
    expect(out).toContain('log line 0:'); // head preserved
    expect(out).toContain(`log line ${3999}`); // tail preserved
    expect(out).toContain('[truncated');
  });

  test('TOOL_RESULT_MAX_CHARS=0 disables the cap entirely', () => {
    process.env.TOOL_RESULT_MAX_CHARS = '0';
    try {
      const huge = 'y'.repeat(60000);
      expect(compressToolResult(huge)).toBe(huge);
    } finally {
      delete process.env.TOOL_RESULT_MAX_CHARS;
    }
  });

  test('short content is untouched', () => {
    const small = 'ok';
    expect(compressToolResult(small)).toBe(small);
  });

  test('pytest-style output still gets summarized to pass/fail counts', () => {
    const pytest =
      Array.from({ length: 80 }, (_, i) => `tests/test_${i}.py::test_case_${i} PASSED`).join('\n') + '\n== 80 passed in 2.00s ==';
    const out = compressToolResult(pytest);
    expect(out).toContain('compressed pytest>');
    expect(out).toContain('80 passed');
  });
});

// ── Fix 2: tool results are inline, adjacent to their calls ────────────

describe('buildQwenMessages inline tool results', () => {
  const body = { model: 'qwen3.7-max' };

  function history() {
    return [
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path": "test.py"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'LINE_A\nLINE_B\nLINE_C' },
      { role: 'user', content: 'now fix it' },
    ];
  }

  test('tool result appears inline between its assistant turn and the next user turn', () => {
    const { qwenMessages } = buildQwenMessages(history(), body, 100000, true);
    const prompt = qwenMessages[0].content as string;

    const assistIdx = prompt.indexOf('<function=Read>');
    const resultIdx = prompt.indexOf('<tool_result tool="Read"');
    const nextUserIdx = prompt.indexOf('<user>\nnow fix it');

    expect(assistIdx).toBeGreaterThan(-1);
    expect(resultIdx).toBeGreaterThan(assistIdx); // after the call it answers
    expect(nextUserIdx).toBeGreaterThan(resultIdx); // before the next user turn
  });

  test('results are no longer hoisted into a separate toolResultsContent blob', () => {
    const result = buildQwenMessages(history(), body, 100000, true);
    expect('toolResultsContent' in result).toBe(false);
  });

  test('multiple parallel call results stay ordered and attributed by tool name', () => {
    const msgs = [
      { role: 'user', content: 'cat both' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"cat a.py"}' } },
          { id: 'c2', type: 'function', function: { name: 'Bash', arguments: '{"command":"cat b.py"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'AAA' },
      { role: 'tool', tool_call_id: 'c2', content: 'BBB' },
    ];
    const { qwenMessages } = buildQwenMessages(msgs, body, 100000, true);
    const prompt = qwenMessages[0].content as string;
    expect(prompt.indexOf('AAA')).toBeGreaterThan(-1);
    expect(prompt.indexOf('BBB')).toBeGreaterThan(prompt.indexOf('AAA'));
  });

  test('result content is XML-escaped so it cannot forge markup in the prompt', () => {
    const msgs = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '<script>alert("evil")</script>' },
    ];
    const { qwenMessages } = buildQwenMessages(msgs, body, 100000, true);
    const prompt = qwenMessages[0].content as string;
    expect(prompt).toContain('&lt;script&gt;');
    expect(prompt).not.toContain('<script>');
  });
});

// ── Fix 4: text accompanying tool_results survives conversion ──────────

describe('anthropicMessagesToOpenAI text preservation', () => {
  test('text blocks in a tool_result user message are forwarded after the tool messages', async () => {
    const { anthropicMessagesToOpenAI } = await import('../routes/anthropic.ts');

    const out = anthropicMessagesToOpenAI([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'a.py\nb.py' },
          { type: 'text', text: '[Request interrupted by user for tool use]' },
        ],
      },
    ]);

    const toolMsg = out.find((m: any) => m.role === 'tool');
    expect(toolMsg?.content).toBe('a.py\nb.py');

    const trailingUser = out[out.length - 1];
    expect(trailingUser.role).toBe('user');
    expect(trailingUser.content).toContain('interrupted by user');
  });

  test('plain user messages still convert to a single user message', async () => {
    const { anthropicMessagesToOpenAI } = await import('../routes/anthropic.ts');
    const out = anthropicMessagesToOpenAI([{ role: 'user', content: 'hello' }]);
    expect(out).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
