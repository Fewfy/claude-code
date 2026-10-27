import type { UUID } from 'crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolResultBlockParam } from 'src/Tool.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { generateSessionName } from 'src/commands/rename/generateSessionName.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import {
  getTranscriptPath,
  saveAgentName,
  saveCustomTitle,
} from 'src/utils/sessionStorage.js'
import { isTeammate } from 'src/utils/teammate.js'
import { RENAME_TOOL_NAME } from './constants.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .optional()
      .describe(
        'New session name in short kebab-case (2-4 words), e.g. "fix-login-bug". Omit to auto-generate one from the conversation.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type RenameInput = z.infer<InputSchema>

type RenameOutput = {
  success: boolean
  name?: string
  error?: string
}

export const RenameTool = buildTool({
  name: RENAME_TOOL_NAME,
  searchHint: 'rename session title when the topic has significantly changed',
  maxResultSizeChars: 1_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return 'Rename the current session/conversation so its title reflects what it is now about.'
  },

  async prompt() {
    return `Rename the current session/conversation.

Use this when the work has **significantly diverged** from the current session title
(for example, the conversation started on one task and has moved on to a different
feature or area). Do not call it for small follow-ups or minor refactors.

- Provide a short kebab-case name (2-4 words), e.g. "fix-login-bug", "add-auth-feature".
- Omit "name" to auto-generate a name from the recent conversation.
- Teammate sessions cannot be renamed (the team leader assigns their names).`
  },

  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  userFacingName() {
    return 'Rename'
  },

  checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },

  renderToolUseMessage(input: Partial<RenameInput>) {
    return `Rename session to: ${input.name ?? '(auto-generated)'}`
  },

  mapToolResultToToolResultBlockParam(
    content: RenameOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.success
        ? `Renamed session to "${content.name}".`
        : `Rename failed: ${content.error ?? 'unknown error'}`,
    }
  },

  async call(input: RenameInput, context) {
    if (isTeammate()) {
      return {
        data: {
          success: false,
          error:
            'this session is a swarm teammate; names are assigned by the team leader',
        },
      }
    }

    let name = input.name?.trim()
    if (!name) {
      const generated = await generateSessionName(
        context.messages,
        context.abortController.signal,
      )
      if (!generated) {
        return {
          data: {
            success: false,
            error: 'could not generate a name: no conversation context yet',
          },
        }
      }
      name = generated
    }

    const sessionId = getSessionId() as UUID
    const fullPath = getTranscriptPath()
    await saveCustomTitle(sessionId, name, fullPath)
    await saveAgentName(sessionId, name, fullPath)
    context.setAppState(prev => {
      if (prev.standaloneAgentContext?.name === name) return prev
      return {
        ...prev,
        standaloneAgentContext: { ...prev.standaloneAgentContext, name },
      }
    })

    return { data: { success: true, name } }
  },
})
