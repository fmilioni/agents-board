import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z, type ZodRawShape } from 'zod'

import type { Database } from '@agents-board/db'

import packageJson from '../package.json'
import { registerResources } from './resources/index'
import { assertToolAccess, type McpScope } from './scope'
import { withToolContract } from './tool-contracts'
import { registerTools } from './tools/index'

type ToolHandler = (input: Record<string, unknown>, extra: unknown) => unknown

export const serverInstructions = `Agents Board manages project work through cards, sprints, comments, docs, claims, tags, blockers, inbox demands, and attached commit context. Stay within the explicit project scope. Begin with focused, paginated reads and fetch full card or doc detail only when needed. Read relevant comments and docs before acting. Mutations change shared project state: inspect current data first, respect claims and blockers, prefer reversible archive/restore operations, and use permanent destroy operations only when explicitly required. Reading comments advances unread comments to read; mark them handled only after acting. Tool results keep compact legacy JSON in text and expose the same result under structuredContent.value.`

// The SDK wraps a raw `inputSchema` shape in a strip-mode `z.object()`, so a
// mistyped param is dropped silently; a prebuilt schema it keeps as-is, so a
// strict object makes unknown keys fail loud.
function strictInputSchema(config: unknown): unknown {
  if (!config || typeof config !== 'object') return config
  const c = config as { inputSchema?: unknown }
  const shape = c.inputSchema
  if (!shape || typeof shape !== 'object') return config
  if (
    '_def' in shape
    || '_zod' in shape
    || typeof (shape as { parse?: unknown }).parse === 'function'
  ) {
    return config
  }
  return { ...c, inputSchema: z.object(shape as ZodRawShape).strict() }
}

// Builds a fully-registered MCP server. The HTTP transport creates one per
// session, passing the session's resolved `scope`; `db` is shared.
//
// `scope` (null = unrestricted: sem-auth mode) is enforced at a single choke
// point: registerTool is wrapped so EVERY tool runs `assertToolAccess` before its
// handler — a new tool can't forget to scope, and an unmapped one fails closed.
export function createMcpServer(db: Database, scope: McpScope | null = null) {
  const server = new McpServer({
    name: 'agents-board',
    version: packageJson.version
  }, {
    instructions: serverInstructions
  })

  const registerTool = server.registerTool.bind(server)
  server.registerTool = function (
    ...args: Parameters<typeof server.registerTool>
  ) {
    const [name, config, handler] = args as [string, unknown, ToolHandler]
    return registerTool(
      name,
      strictInputSchema(
        withToolContract(name, config as Record<string, unknown>)
      ) as Parameters<typeof registerTool>[1],
      (async (input: Record<string, unknown>, extra: unknown) => {
        await assertToolAccess(db, scope, name, input ?? {})
        return handler(input, extra)
      }) as Parameters<typeof registerTool>[2]
    )
  } as typeof server.registerTool

  registerTools(server, db, scope)
  registerResources(server, db, scope)

  return server
}
