// Tool parameter normalization for the Anthropic-compatible endpoint.
//
// Qwen habitually emits camelCase parameter names (`filePath`, `oldString`) — a
// Cline/Kilo-style training artifact — while most client schemas (Claude Code,
// OpenCode, …) declare snake_case (`file_path`, `old_string`). Instead of forcing
// one casing convention, normalize each tool call's argument names toward the
// schema the client actually sent in the request, falling back to camelCase→
// snake_case for known Claude Code params when no matching schema exists.

// Known Claude Code params that may arrive in camelCase despite snake_case schemas.
const KNOWN_CAMEL_TO_SNAKE: Record<string, string> = {
  filePath: 'file_path',
  oldString: 'old_string',
  newString: 'new_string',
  toolCallId: 'tool_call_id',
};

// Static required-param fallback for clients that don't send tool schemas.
// Matches Claude Code's real tool schemas (snake_case).
const FALLBACK_REQUIRED_PARAMS: Record<string, string[]> = {
  Bash: ['command'],
  Read: ['file_path'],
  Edit: ['file_path', 'old_string', 'new_string'],
  Write: ['file_path', 'content'],
};

export interface ToolSchemaInfo {
  properties: ReadonlySet<string>;
  required: readonly string[];
}

// Index Anthropic-format request tools (name → input_schema info), keyed by
// lowercase name so lookups tolerate case drift from Qwen.
export function buildToolSchemaIndex(tools?: Array<{ name?: string; input_schema?: any }> | null): Map<string, ToolSchemaInfo> {
  const index = new Map<string, ToolSchemaInfo>();
  for (const t of tools ?? []) {
    if (!t?.name) continue;
    const schema = t.input_schema ?? {};
    const props = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
    const required = Array.isArray(schema.required) ? schema.required.filter((k: unknown): k is string => typeof k === 'string') : [];
    index.set(t.name.toLowerCase(), { properties: new Set(props), required });
  }
  return index;
}

function toSnakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function toCamelCase(key: string): string {
  const parts = key.split('_').filter(Boolean);
  if (parts.length < 2) return key;
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join('')
  );
}

// Rename a parsed tool call's argument names toward the client's schema.
// Accepts an object or a JSON string; unparseable input yields {}.
export function normalizeToolArgNames(
  toolName: string,
  rawArgs: unknown,
  schemaIndex: Map<string, ToolSchemaInfo>,
): Record<string, unknown> {
  let args: any = rawArgs;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      /* ignore */
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};

  const schema = schemaIndex.get((toolName || '').toLowerCase());
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (schema?.properties.has(key)) {
      mapped[key] = value;
      continue;
    }
    if (schema) {
      // Key isn't in the client's schema — try the opposite casing convention.
      const asSnake = toSnakeCase(key);
      if (asSnake !== key && schema.properties.has(asSnake)) {
        mapped[asSnake] = value;
        continue;
      }
      const asCamel = toCamelCase(key);
      if (asCamel !== key && schema.properties.has(asCamel)) {
        mapped[asCamel] = value;
        continue;
      }
    }
    // No schema match — apply the known Claude Code renames so file tools
    // still work against schemas we couldn't consult.
    mapped[KNOWN_CAMEL_TO_SNAKE[key] ?? key] = value;
  }
  return mapped;
}

// Required params for a tool: from the client's schema when available, else the
// static fallback. Null means "unknown tool" (any non-empty args accepted).
export function requiredParamsFor(toolName: string, schemaIndex: Map<string, ToolSchemaInfo>): readonly string[] | null {
  return schemaIndex.get((toolName || '').toLowerCase())?.required ?? FALLBACK_REQUIRED_PARAMS[toolName] ?? null;
}

export function missingRequiredParams(required: readonly string[], args: Record<string, unknown>): string[] {
  return required.filter((p) => args[p] === undefined || args[p] === null || args[p] === '');
}

// Spam guard: known tools must supply their required params; unknown tools must
// have at least one param.
export function isValidToolCall(toolName: string, args: unknown, required?: readonly string[] | null): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  const req = required ?? FALLBACK_REQUIRED_PARAMS[toolName] ?? null;
  if (req) return missingRequiredParams(req, record).length === 0;
  return Object.keys(record).length > 0;
}

// ponytail: normalize Qwen tool name case to match Claude Code conventions
export function normalizeToolName(name: string): string {
  const CASE_MAP: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    websearch: 'WebSearch',
    web_search: 'WebSearch',
  };
  return CASE_MAP[name] || name;
}
