import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearOpenAIClientCache } from '../services/api/openai/client.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from './settings/settings.js'

export type WireApi = 'chat' | 'responses'

export type KeyProfile = {
  apiKey: string
  baseUrl: string
  /** Native Anthropic /v1/messages base; derived from baseUrl when omitted. */
  anthropicBaseUrl?: string
  wireApi?: WireApi
  models?: string[]
}

export type KeyProfilesFile = {
  active?: string
  profiles: Record<string, KeyProfile>
}

export function keyProfilesPath(): string {
  return join(getClaudeConfigHomeDir(), 'key-profiles.json')
}

export function loadKeyProfiles(): KeyProfilesFile {
  try {
    const parsed = JSON.parse(readFileSync(keyProfilesPath(), 'utf-8')) as
      | KeyProfilesFile
      | undefined
    if (parsed && typeof parsed === 'object' && parsed.profiles) {
      return parsed
    }
  } catch {
    // Missing or malformed file: start empty.
  }
  return { profiles: {} }
}

export function saveKeyProfiles(file: KeyProfilesFile): void {
  writeFileSync(keyProfilesPath(), JSON.stringify(file, null, 2), {
    mode: 0o600,
  })
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/**
 * List the models a key can use. Tries the configured base URL first, then the
 * same host with/without a `/v1` suffix (OpenAI-compatible providers differ).
 */
export async function discoverModels(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const base = normalizeBaseUrl(baseUrl)
  const candidates = new Set<string>([
    base,
    base.endsWith('/v1') ? base.slice(0, -3) : `${base}/v1`,
  ])
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) continue
      const payload = (await response.json()) as {
        data?: Array<{ id?: unknown }>
      }
      const ids = (payload.data ?? [])
        .map(entry => entry?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) return ids
    } catch {
      // Try the next candidate.
    }
  }
  return []
}

/**
 * Derive the native Anthropic base URL for a provider. DeepSeek exposes
 * `/anthropic`; other OpenAI-compatible gateways generally serve `/v1/messages`
 * at the host root, so strip a trailing `/v1`.
 */
export function deriveAnthropicBase(baseUrl: string): string {
  try {
    const url = new URL(normalizeBaseUrl(baseUrl))
    if (url.hostname === 'api.deepseek.com') {
      return `${url.protocol}//${url.host}/anthropic`
    }
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/v1$/, '')}`
  } catch {
    return normalizeBaseUrl(baseUrl)
  }
}

export function inferWireApi(baseUrl: string): WireApi {
  return /stepfun-inc\.com|models-proxy/i.test(baseUrl) ? 'responses' : 'chat'
}

/**
 * Build the environment variables for a profile without mutating process state.
 */
function buildProfileEnv(profile: KeyProfile): Record<string, string> {
  const wireApi = profile.wireApi ?? inferWireApi(profile.baseUrl)
  const anthropicBaseUrl =
    profile.anthropicBaseUrl ?? deriveAnthropicBase(profile.baseUrl)
  const models = profile.models ?? []

  const env: Record<string, string> = {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: profile.apiKey,
    OPENAI_BASE_URL: profile.baseUrl,
    OPENAI_WIRE_API: wireApi,
    ANTHROPIC_AUTH_TOKEN: profile.apiKey,
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
  }
  if (models.length > 0) {
    env.OPENAI_MODEL_MAP = JSON.stringify(
      Object.fromEntries(models.map(model => [model, model])),
    )
    env.CLAUDE_CODE_SUBAGENT_MODEL = models[0]!
    // Keep the retry/fallback pool inside this key's entitled models.
    env.OPENAI_FALLBACK_MODELS = models.join(',')
  }
  return env
}

/** Apply a profile's env to the current process (no persistence). */
export function applyProfileEnvOnly(profile: KeyProfile): void {
  for (const [key, value] of Object.entries(buildProfileEnv(profile))) {
    process.env[key] = value
  }
  clearOpenAIClientCache()
}

/**
 * Apply the `active` profile at startup so editing key-profiles.json directly
 * (without running /keys) takes effect on the next launch.
 */
export function applyActiveKeyProfileOnStartup(): void {
  const file = loadKeyProfiles()
  const profile = file.active ? file.profiles[file.active] : undefined
  if (profile) {
    applyProfileEnvOnly(profile)
  }
}

/**
 * Make a profile active: update the process environment, drop the cached
 * OpenAI client, persist the active profile and mirror the env into
 * settings.json so the next launch starts with it.
 */
export function applyKeyProfile(
  name: string,
  profile: KeyProfile,
  file: KeyProfilesFile,
): void {
  const env = buildProfileEnv(profile)
  // An explicit switch also moves the main model to one the key can serve;
  // startup application keeps whatever model the user already chose.
  if (profile.models?.length) {
    env.ANTHROPIC_MODEL = profile.models[0]!
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  clearOpenAIClientCache()

  file.active = name
  saveKeyProfiles(file)

  const currentEnv = getSettings_DEPRECATED()?.env ?? {}
  updateSettingsForSource('userSettings', {
    env: { ...currentEnv, ...env },
  })
}
