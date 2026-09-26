/**
 * Regression tests for the "param'd MCP/custom tool calls arrive as {}" bug
 * (freebuff fork, shipped as @codebuff/sdk 0.10.7-paseo.1).
 *
 * The chain was: getMCPToolData converts an MCP tool's JSON Schema to zod v4
 * → getToolSet cloneDeep'd the zod schema (keeping safeParse, destroying the
 * internal `_zod` graph) → ensureJsonSchemaCompatible's z.toJSONSchema threw
 * → the schema was silently swapped for z.object({}).passthrough() → the
 * model was told the tool takes no params → the AI SDK v7 response path
 * validated args against the empty schema and stripped them to {}.
 *
 * Symptom: every param'd MCP tool (paseo__send_agent_prompt,
 * orchestration__track_status, ...) reached the host with input {}; no-param
 * tools (paseo__list_agents) passed. Native tools were unaffected because
 * their schemas are module-level constants, never cloned.
 */
import { cloneDeep } from 'lodash'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { convertJsonSchemaToZod } from 'zod-from-json-schema'

import {
  ensureZodSchema,
  getToolSet,
} from '../tools/prompts'

const PASEO_SEND_AGENT_PROMPT_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    agent_id: { type: 'string', description: 'Agent id' },
    prompt: { type: 'string', description: 'Task' },
    notifyOnFinish: { type: 'boolean', description: 'Notify on finish' },
  },
  required: ['agent_id', 'prompt'],
  additionalProperties: false,
}

function makeCustomToolDefs() {
  return {
    paseo__send_agent_prompt: {
      // The exact shape getMCPToolData produces: zod converted from the MCP
      // server's advertised JSON Schema.
      inputSchema: convertJsonSchemaToZod(PASEO_SEND_AGENT_PROMPT_JSON_SCHEMA),
      endsAgentStep: true,
      description: 'Send a task to a running agent.',
    },
  } as any
}

describe('MCP/custom tool schema survival ({}-input regression)', () => {
  test('ensureZodSchema passes a live zod v4 schema through unchanged', () => {
    const schema = convertJsonSchemaToZod(PASEO_SEND_AGENT_PROMPT_JSON_SCHEMA)
    expect(ensureZodSchema(schema)).toBe(schema)
  })

  test('getToolSet keeps full param validation for MCP tools', async () => {
    const toolSet = await getToolSet({
      toolNames: [],
      windowedFileReads: false,
      additionalToolDefinitions: async () => makeCustomToolDefs(),
      agentTools: {},
      skills: {},
    })
    const tool = toolSet['paseo__send_agent_prompt'] as any
    expect(tool).toBeDefined()

    // The advertised schema must still carry the real properties — this is
    // what the model sees. With the bug, it was `{}` (no properties).
    const jsonSchema = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as any
    expect(Object.keys(jsonSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['agent_id', 'prompt']),
    )
    expect(jsonSchema.required).toEqual(expect.arrayContaining(['agent_id', 'prompt']))

    // And the schema must still reject invalid input (it is the same object
    // the executor validates against).
    expect(tool.inputSchema.safeParse({ agent_id: 'a1' }).success).toBe(false)
    expect(
      tool.inputSchema.safeParse({ agent_id: 'a1', prompt: 'hi' }).success,
    ).toBe(true)
  })

  test('a cloneDeep-corrupted zod schema is detected, not silently trusted', () => {
    const schema = convertJsonSchemaToZod(PASEO_SEND_AGENT_PROMPT_JSON_SCHEMA)
    const corrupted = cloneDeep(schema)
    // The corruption: still duck-types as a schema, but cannot convert.
    expect(typeof corrupted.safeParse).toBe('function')
    expect(() => z.toJSONSchema(corrupted, { io: 'input' })).toThrow()
    // ensureJsonSchemaCompatible's stub path may swallow it, but ensureZodSchema
    // must never hand the corrupted object to a caller expecting conversion.
    expect(ensureZodSchema(corrupted)).toBe(corrupted)
  })
})
