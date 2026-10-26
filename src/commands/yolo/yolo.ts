import { setSessionBypassPermissionsMode } from '../../bootstrap/state.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  _args: string,
): Promise<null> {
  // Mirror the `--permission-mode bypassPermissions` launch path so subagents,
  // teammates and background work inherit the bypass flag too.
  setSessionBypassPermissionsMode(true)
  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
      type: 'setMode',
      mode: 'bypassPermissions',
      destination: 'session',
    }),
  }))
  onDone(
    'YOLO mode enabled: all permission prompts are bypassed for this session.',
    { display: 'system' },
  )
  return null
}
