import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { normalizeOpenAIUsage, type AnthropicUsage } from '@ant/model-provider'
import { getValidChatGPTAuth } from './chatgptAuth.js'

type ResponsesInputItem = Record<string, unknown>
type ResponsesTool = Record<string, unknown>
export type ResponsesReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

type ResponsesRequest = {
  model: string
  stream: true
  store: false
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: unknown
  reasoning?: { effort: ResponsesReasoningEffort }
  parallel_tool_calls?: boolean
  /** Sticky cache routing key — stable for the CCB session. */
  prompt_cache_key: string
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function convertUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textFromContent(content)
  const result: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      result.push({ type: 'input_text', text: record.text })
    } else if (record.type === 'image_url') {
      const imageUrl = record.image_url as Record<string, unknown> | undefined
      if (typeof imageUrl?.url === 'string') {
        result.push({ type: 'input_image', image_url: imageUrl.url })
      }
    }
  }
  return result.length > 0 ? result : textFromContent(content)
}

function convertMessagesToResponsesInput(messages: unknown[]): {
  input: ResponsesInputItem[]
  instructions?: string
} {
  const input: ResponsesInputItem[] = []
  const instructions: string[] = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const role = record.role

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(record.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const callId = record.tool_call_id
      if (typeof callId === 'string') {
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: textFromContent(record.content),
        })
      }
      continue
    }

    if (role === 'assistant') {
      const text = textFromContent(record.content)
      if (text) {
        input.push({ role: 'assistant', content: text })
      }
      const toolCalls = record.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const tc = toolCall as Record<string, unknown>
          const fn = tc.function as Record<string, unknown> | undefined
          const id = typeof tc.id === 'string' ? tc.id : undefined
          const name = typeof fn?.name === 'string' ? fn.name : undefined
          if (!id || !name) continue
          input.push({
            type: 'function_call',
            call_id: id,
            name,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
          })
        }
      }
      continue
    }

    if (role === 'user') {
      input.push({
        role: 'user',
        content: convertUserContent(record.content),
      })
    }
  }

  return {
    input,
    instructions:
      instructions.length > 0 ? instructions.join('\n\n') : undefined,
  }
}

function convertToolsToResponses(tools: unknown[]): ResponsesTool[] {
  const result: ResponsesTool[] = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    result.push({
      type: 'function',
      name,
      description: typeof fn?.description === 'string' ? fn.description : '',
      parameters:
        fn?.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      strict: false,
    })
  }
  return result
}

function convertToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'required') return 'required'
  if (toolChoice === 'auto') return 'auto'
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  const record = toolChoice as Record<string, unknown>
  const fn = record.function as Record<string, unknown> | undefined
  if (record.type === 'function' && typeof fn?.name === 'string') {
    return { type: 'function', name: fn.name }
  }
  return toolChoice
}

export function buildResponsesRequest(params: {
  model: string
  messages: unknown[]
  tools: unknown[]
  toolChoice: unknown
  reasoningEffort?: ResponsesReasoningEffort
  /** Session-scoped key supplied only by the ChatGPT OAuth route. */
  promptCacheKey?: string
}): ResponsesRequest {
  const { input, instructions } = convertMessagesToResponsesInput(
    params.messages,
  )
  const tools = convertToolsToResponses(params.tools)
  return {
    model: params.model,
    stream: true,
    store: false,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(params.toolChoice
      ? { tool_choice: convertToolChoiceToResponses(params.toolChoice) }
      : {}),
    ...(params.reasoningEffort
      ? { reasoning: { effort: params.reasoningEffort } }
      : {}),
    parallel_tool_calls: true,
    // Same OAuth session → same key so OpenAI can sticky-route to a cache node.
    // Must not hash the full message list (would change every turn).
    ...(params.promptCacheKey
      ? { prompt_cache_key: params.promptCacheKey }
      : {}),
  }
}

async function* parseSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body) throw new Error('ChatGPT response did not include a body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // Some OpenAI-compatible servers terminate SSE frames with CRLF. Normalize
    // so frame splitting on "\n\n" works for both. A trailing lone "\r" is
    // resolved when the next chunk arrives.
    buffer = buffer.replace(/\r\n/g, '\n')
    let splitAt = buffer.indexOf('\n\n')
    while (splitAt >= 0) {
      const frame = buffer.slice(0, splitAt)
      buffer = buffer.slice(splitAt + 2)
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data && data !== '[DONE]') {
        const parsed = JSON.parse(data) as unknown
        if (parsed && typeof parsed === 'object') {
          yield parsed as Record<string, unknown>
        }
      }
      splitAt = buffer.indexOf('\n\n')
    }
  }
}

/**
 * Map OpenAI Responses usage → Anthropic-style mutually exclusive fields.
 *
 * OpenAI:  input_tokens is TOTAL input; cached_tokens ⊆ input_tokens;
 *          cache_write_tokens (GPT-5.6+) reports tokens written this turn.
 * Anthropic: input + cache_creation + cache_read are disjoint and sum to total.
 *
 * Without subtracting cached from input, cacheWarning hit-rate becomes
 * cached/(total+cached) with a hard ceiling of 50%.
 */
export function extractUsage(
  response: Record<string, unknown> | undefined,
): AnthropicUsage {
  const usage = response?.usage as Record<string, unknown> | undefined
  const inputDetails = usage?.input_tokens_details as
    | Record<string, unknown>
    | undefined

  const totalInput =
    typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens =
    typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0

  const cachedRaw =
    typeof inputDetails?.cached_tokens === 'number'
      ? inputDetails.cached_tokens
      : 0
  const writeRaw =
    typeof inputDetails?.cache_write_tokens === 'number'
      ? inputDetails.cache_write_tokens
      : 0

  return normalizeOpenAIUsage({
    totalInputTokens: totalInput,
    outputTokens,
    cacheReadTokens: cachedRaw,
    cacheWriteTokens: writeRaw,
  })
}

function mapStopReason(response: Record<string, unknown> | undefined): string {
  if (response?.status === 'incomplete') return 'max_tokens'
  return 'end_turn'
}

export async function* adaptResponsesStreamToAnthropic(
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const toolBlocks = new Map<
    number,
    { contentIndex: number; open: boolean; name: string; id: string }
  >()
  let started = false
  let currentContentIndex = -1
  let textBlockOpen = false
  let thinkingBlockOpen = false

  const ensureStarted = async function* () {
    if (started) return
    started = true
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as BetaRawMessageStreamEvent
  }

  for await (const event of stream) {
    for await (const startedEvent of ensureStarted()) yield startedEvent
    const type = event.type

    if (type === 'response.output_text.delta') {
      if (!textBlockOpen) {
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        textBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'text', text: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'text_delta', text: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.reasoning_text.delta') {
      if (!thinkingBlockOpen) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        currentContentIndex++
        thinkingBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'thinking_delta', thinking: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      if (item?.type === 'function_call' && outputIndex >= 0) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        const id = String(item.call_id ?? item.id ?? `call_${outputIndex}`)
        const name = String(item.name ?? '')
        toolBlocks.set(outputIndex, {
          contentIndex: currentContentIndex,
          open: true,
          name,
          id,
        })
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block) {
        yield {
          type: 'content_block_delta',
          index: block.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: String(event.delta ?? ''),
          },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block?.open) {
        yield {
          type: 'content_block_stop',
          index: block.contentIndex,
        } as BetaRawMessageStreamEvent
        block.open = false
      }
      continue
    }

    if (type === 'response.error') {
      const error = event.error as Record<string, unknown> | undefined
      throw new Error(String(error?.message ?? 'ChatGPT Responses API error'))
    }

    if (type === 'response.failed') {
      const response = event.response as Record<string, unknown> | undefined
      const error = response?.error as Record<string, unknown> | undefined
      throw new Error(String(error?.message ?? 'ChatGPT Responses API failed'))
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        textBlockOpen = false
      }
      if (thinkingBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        thinkingBlockOpen = false
      }
      const response = event.response as Record<string, unknown> | undefined
      yield {
        type: 'message_delta',
        delta: { stop_reason: mapStopReason(response), stop_sequence: null },
        usage: extractUsage(response),
      } as unknown as BetaRawMessageStreamEvent
      yield { type: 'message_stop' } as BetaRawMessageStreamEvent
    }
  }
}

export async function createChatGPTResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const auth = await getValidChatGPTAuth()
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    originator: 'claude-code-best',
  }
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId
  }
  const response = await fetchFn(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(params.request),
      signal: params.signal,
    },
  )
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `ChatGPT Responses API request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
    )
  }
  return parseSSE(response)
}

/**
 * Generic Responses API stream for OpenAI-compatible endpoints (Bearer API
 * key). Unlike the ChatGPT route above, this posts to the configured
 * `OPENAI_BASE_URL` and supports function tools alongside reasoning.
 */
export async function createOpenAIResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  baseUrl: string
  apiKey: string
  fetchOverride?: typeof fetch
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const base = params.baseUrl.replace(/\/+$/, '')
  const url = /\/v1$/.test(base) ? `${base}/responses` : `${base}/v1/responses`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${params.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params.request),
    signal: params.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `OpenAI Responses API request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
    )
  }
  return parseSSE(response)
}

const RATE_LIMIT_MAX_RETRIES = 3

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Transient upstream failures (capacity, overload, 5xx, timeouts) worth retrying. */
export function isRetryableUpstreamError(error: unknown): boolean {
  const message = errorMessageOf(error)
  return (
    /\((429|500|502|503|504|529)\)/.test(message) ||
    /rate_limit_exceeded|capacity limit|maximum usage size|high demand|token limit .*reached|token rate limit|exceeded .*rate limit|overloaded|service unavailable|temporarily unavailable|internal error|unable to complete inference|upstream (error|timeout)|try again|timed out|econnreset|etimedout|socket hang up|bad gateway|gateway timeout/i.test(
      message,
    )
  )
}

/** Model-level rejections where trying the next model makes sense. */
export function isModelUnavailableError(error: unknown): boolean {
  const message = errorMessageOf(error)
  return (
    message.includes('(404)') ||
    /is not available for user|does not support the claude_native|model_not_found|unknown model|no such model/i.test(
      message,
    )
  )
}

function retryAfterSeconds(error: unknown): number | undefined {
  const match = /retry after (\d+)\s*second/i.exec(errorMessageOf(error))
  return match ? Number(match[1]) : undefined
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('Aborted'))
      },
      { once: true },
    )
  })
}

/**
 * Call the generic Responses API with rate-limit retries and model fallback,
 * returning the Anthropic-shaped stream.
 *
 * Unlike a pre-stream-only wrapper, this also catches rate-limit failures
 * delivered as SSE `response.error` / `response.failed` events after HTTP 200.
 * Events are buffered until real content starts, so a failed attempt can be
 * discarded and retried without duplicating output.
 *
 * - Rate limited: wait (honoring "retry after N seconds") and retry the same
 *   model up to RATE_LIMIT_MAX_RETRIES times.
 * - Still rate limited, or the model is unavailable: switch to the next model.
 * - Every model exhausted: throw the last error.
 */
export async function* createOpenAIResponsesStreamWithFallback(params: {
  models: string[]
  makeRequest: (model: string) => ResponsesRequest
  signal: AbortSignal
  baseUrl: string
  apiKey: string
  fetchOverride?: typeof fetch
}): AsyncGenerator<BetaRawMessageStreamEvent, void, void> {
  let lastError: unknown
  for (const model of params.models) {
    for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      let committed = false
      const buffered: BetaRawMessageStreamEvent[] = []
      try {
        const stream = await createOpenAIResponsesStream({
          request: params.makeRequest(model),
          signal: params.signal,
          baseUrl: params.baseUrl,
          apiKey: params.apiKey,
          fetchOverride: params.fetchOverride,
        })
        for await (const event of adaptResponsesStreamToAnthropic(
          stream,
          model,
        )) {
          if (committed) {
            yield event
          } else if (
            event.type === 'content_block_start' ||
            event.type === 'content_block_delta' ||
            event.type === 'message_stop'
          ) {
            // Content has started: from here on a retry could duplicate output.
            committed = true
            for (const pending of buffered) yield pending
            buffered.length = 0
            yield event
          } else {
            buffered.push(event)
          }
        }
        if (!committed) {
          for (const pending of buffered) yield pending
        }
        if (attempt > 0) {
          process.stderr.write(
            `[ccb] ${model} recovered after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}\n`,
          )
        }
        return
      } catch (error) {
        // Past this point partial output was already emitted — retrying would
        // duplicate it, so surface the error instead.
        if (committed) throw error
        lastError = error
        if (isRetryableUpstreamError(error)) {
          if (attempt === RATE_LIMIT_MAX_RETRIES) break
          const waitSeconds =
            retryAfterSeconds(error) ?? Math.min(2 ** (attempt + 1), 10)
          process.stderr.write(
            `[ccb] ${model} upstream error; retry ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES} in ${waitSeconds}s\n`,
          )
          await sleepWithSignal(waitSeconds * 1000, params.signal)
          continue
        }
        if (isModelUnavailableError(error)) break
        throw error
      }
    }
    process.stderr.write(
      `[ccb] model ${model} unavailable; trying next model\n`,
    )
  }
  throw lastError ?? new Error('All models are unavailable')
}
