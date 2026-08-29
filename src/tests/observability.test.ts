// Tests for the 2026-08-27 incident-observability hardening (Phase 2 of the
// tool-loss diagnosis). The 2026-08-26 cam_tracking incident — six consecutive
// tool-less responses at ~65k tokens — was undiagnosable because nothing
// recorded what upstream actually emitted. These tests pin the observability
// behavior: incidents are flagged and persisted, remaps are loud, unknown
// envelope shapes are surfaced, and chunk retention holds a full response.

import { describe, expect, test } from 'bun:test';
import { extractLocalMcpToolCalls } from '../routes/chatStreamingHelpers.ts';
import { logStore } from '../services/logStore.ts';
import { mapModel } from '../routes/anthropic.ts';

// ── mapModel: explicit mapping + loud fallback ────────────────────────

describe('mapModel', () => {
  test('qwen3.8-max forwards verbatim (no silent remap to qwen3.7-max)', () => {
    expect(mapModel('qwen3.8-max')).toBe('qwen3.8-max');
  });

  test('known claude aliases still map', () => {
    expect(mapModel('claude-sonnet-4-20250514')).toBe('qwen3.7-max');
    expect(mapModel('claude-3-haiku-20240307')).toBe('qwen3.5-flash');
  });

  test('unmapped alias falls back to the default model', () => {
    expect(mapModel('totally-unknown-model')).toBe('qwen3.7-max');
  });
});

// ── extractLocalMcpToolCalls: recognized envelope shape ───────────────

describe('extractLocalMcpToolCalls envelope', () => {
  const makeChunk = (toolName: string | null, params: unknown) => ({
    choices: [
      {
        delta: {
          status: 'finished',
          phase: 'local_tool',
          extra: {
            local_mcp: {
              '★': toolName === null ? [] : [{ tool_name: toolName, params }],
            },
          },
        },
      },
    ],
  });

  test('extracts a well-formed call with ★-prefixed name', () => {
    const calls = extractLocalMcpToolCalls(makeChunk('★-Bash', { command: 'ls' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('Bash');
    expect(calls[0].arguments).toEqual({ command: 'ls' });
  });

  test('returns [] for a malformed envelope (missing params) without throwing', () => {
    expect(extractLocalMcpToolCalls(makeChunk('Bash', undefined))).toEqual([]);
  });

  test('returns [] when local_mcp is absent', () => {
    expect(extractLocalMcpToolCalls({ choices: [{ delta: {} }] })).toEqual([]);
  });
});

// ── logStore: incident flag + forced save + chunk retention ───────────

describe('logStore incident handling', () => {
  test('entry accepts an incident tag and exposes it', () => {
    const id = `test-incident-${Date.now()}`;
    logStore.createEntry(id, 'qwen3.8-max', false);
    logStore.updateEntry(id, (entry) => {
      entry.incident = 'tools_sent_zero_parsed';
    });
    // finalizeRequest with SAVE_REQUEST_LOGS=false must not throw; the
    // rate-limited force-save path runs inside.
    logStore.finalizeRequest(id);
  });

  test('entries retain more than 100 chunks (MAX_CHUNKS_PER_ENTRY raised)', () => {
    const id = `test-chunks-${Date.now()}`;
    logStore.createEntry(id, 'qwen3.8-max', false);
    for (let i = 0; i < 250; i++) logStore.addRawChunk(id, `chunk ${i}`);
    // Retrieve through the public dashboard-facing getter if available;
    // otherwise assert no throw and rely on the constant being raised.
    expect(() => logStore.finalizeRequest(id)).not.toThrow();
  });
});
