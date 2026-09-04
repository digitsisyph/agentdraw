/**
 * Test hook: `?mock-webmcp=1` installs a minimal `document.modelContext`
 * before tools register, so the agent flow can be driven from DevTools or an
 * end-to-end script in an ordinary browser. Never active without the flag.
 *
 * Registered tools land on `window.__agentdrawMockTools` keyed by name;
 * call `window.__agentdrawMockTools.inspect_canvas.execute({})` etc.
 */

interface MockTool {
  name: string;
  execute: (input: unknown) => unknown;
  [key: string]: unknown;
}

type MockWindow = Window & {
  __agentdrawMockTools?: Record<string, MockTool>;
};

export function installWebMcpMockIfRequested() {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('mock-webmcp') !== '1') return false;
  const doc = document as Document & { modelContext?: unknown };
  if (doc.modelContext) return true;
  const registry: Record<string, MockTool> = {};
  (window as MockWindow).__agentdrawMockTools = registry;
  Object.defineProperty(doc, 'modelContext', {
    configurable: true,
    value: {
      registerTool(tool: MockTool) {
        registry[tool.name] = tool;
      },
    },
  });
  return true;
}
