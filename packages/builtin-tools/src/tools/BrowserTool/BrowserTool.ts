import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { z } from 'zod/v4'
import { buildTool, type ToolResultBlockParam } from 'src/Tool.js'
import { lazySchema } from 'src/utils/lazySchema.js'
import { BROWSER_TOOL_NAME } from './constants.js'

const CDP_TIMEOUT_MS = 30_000
const NAV_TIMEOUT_MS = 20_000

type CdpResult = Record<string, unknown>
type CdpMessage = {
  id?: number
  method?: string
  params?: CdpResult
  result?: CdpResult
  error?: { message?: string }
}
type Listener = (params: CdpResult) => void
type Pending = {
  resolve: (value: CdpResult) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type BrowserSession = {
  proc: ChildProcess
  ws: WebSocket
  seq: number
  pending: Map<number, Pending>
  listeners: Map<string, Set<Listener>>
  userDataDir: string
  headed: boolean
}

let session: BrowserSession | null = null

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter((path): path is string => typeof path === 'string' && path.length > 0)

function findChrome(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'Chrome/Chromium not found. Set the CHROME_PATH environment variable to its executable.',
  )
}

async function waitForDevToolsPort(
  userDataDir: string,
  timeoutMs = 15_000,
): Promise<number> {
  const portFile = join(userDataDir, 'DevToolsActivePort')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await readFile(portFile, 'utf8')
      const port = Number.parseInt(text.split('\n')[0]?.trim() ?? '', 10)
      if (Number.isFinite(port) && port > 0) return port
    } catch {
      // Not written yet.
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Chrome did not expose a DevTools port')
}

async function findPageTarget(port: number): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = (await response.json()) as Array<{
        type?: string
        webSocketDebuggerUrl?: string
      }>
      const page = targets.find(
        target => target.type === 'page' && target.webSocketDebuggerUrl,
      )
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      // Retry.
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Chrome did not expose a page target')
}

function send(method: string, params: CdpResult = {}): Promise<CdpResult> {
  const active = session
  if (!active) return Promise.reject(new Error('browser is not running'))
  const id = ++active.seq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      active.pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, CDP_TIMEOUT_MS)
    active.pending.set(id, { resolve, reject, timer })
    active.ws.send(JSON.stringify({ id, method, params }))
  })
}

function onEvent(method: string, listener: Listener): () => void {
  const active = session
  if (!active) return () => {}
  if (!active.listeners.has(method)) active.listeners.set(method, new Set())
  active.listeners.get(method)?.add(listener)
  return () => active.listeners.get(method)?.delete(listener)
}

function waitEvent(method: string, timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const off = onEvent(method, () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      off()
      resolve()
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      off()
      reject(new Error(`timeout waiting for ${method}`))
    }, timeoutMs)
  })
}

async function ensureBrowser(headed: boolean): Promise<BrowserSession> {
  if (session) {
    if (headed && !session.headed) {
      throw new Error(
        'browser is already running headless; use action "close" first to relaunch headed',
      )
    }
    return session
  }
  const chrome = findChrome()
  const userDataDir = await mkdtemp(join(tmpdir(), 'ccb-browser-'))
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--mute-audio',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ]
  const proc = spawn(chrome, args, { stdio: 'ignore' })
  const port = await waitForDevToolsPort(userDataDir)
  const wsUrl = await findPageTarget(port)
  const ws = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', error => reject(error))
  })
  const created: BrowserSession = {
    proc,
    ws,
    seq: 0,
    pending: new Map(),
    listeners: new Map(),
    userDataDir,
    headed,
  }
  ws.on('message', data => {
    let message: CdpMessage
    try {
      message = JSON.parse(String(data)) as CdpMessage
    } catch {
      return
    }
    if (typeof message.id === 'number' && created.pending.has(message.id)) {
      const pending = created.pending.get(message.id)!
      created.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'CDP error'))
      } else {
        pending.resolve(message.result ?? {})
      }
      return
    }
    if (message.method) {
      for (const listener of created.listeners.get(message.method) ?? []) {
        listener(message.params ?? {})
      }
    }
  })
  ws.on('close', () => {
    if (session === created) session = null
  })
  session = created
  await send('Page.enable')
  await send('Runtime.enable')
  return created
}

async function evaluate(expression: string): Promise<unknown> {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    const details = result.exceptionDetails as CdpResult
    throw new Error(String(details.text ?? 'evaluation failed'))
  }
  const remote = result.result as CdpResult | undefined
  return remote?.value
}

async function pageInfo(): Promise<{
  url: string
  title: string
  text: string
}> {
  const info = (await evaluate(
    '({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, 6000) })',
  )) as { url?: string; title?: string; text?: string } | undefined
  return {
    url: info?.url ?? '',
    title: info?.title ?? '',
    text: info?.text ?? '',
  }
}

async function navigate(url: string, headed: boolean) {
  await ensureBrowser(headed)
  const loaded = waitEvent('Page.loadEventFired').catch(() => undefined)
  const result = await send('Page.navigate', { url })
  if (result.errorText) throw new Error(String(result.errorText))
  await loaded
  // Give client-side apps a moment to render.
  await new Promise(resolve => setTimeout(resolve, 400))
  return pageInfo()
}

async function click(selector: string) {
  const clicked = await evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`,
  )
  if (clicked !== true) throw new Error(`element not found: ${selector}`)
  await new Promise(resolve => setTimeout(resolve, 200))
}

async function typeText(selector: string, text: string) {
  const focused = await evaluate(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`,
  )
  if (focused !== true) throw new Error(`element not found: ${selector}`)
  await send('Input.insertText', { text })
}

const KEY_MAP: Record<
  string,
  { key: string; code: string; windowsVirtualKeyCode: number; text?: string }
> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: {
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

async function pressKey(key: string) {
  const mapped =
    KEY_MAP[key] ??
    (key.length === 1
      ? {
          key,
          code: /[a-zA-Z]/.test(key) ? `Key${key.toUpperCase()}` : key,
          windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
          text: key,
        }
      : undefined)
  if (!mapped) throw new Error(`unsupported key: ${key}`)
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
    text: mapped.text,
    unmodifiedText: mapped.text,
  })
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: mapped.key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
  })
}

async function screenshot(fullPage: boolean): Promise<string> {
  await ensureBrowser(false)
  const result = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage,
  })
  const data = result.data
  if (typeof data !== 'string') throw new Error('screenshot returned no data')
  const dir = join(tmpdir(), 'ccb-browser')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `shot-${Date.now()}.png`)
  await writeFile(file, Buffer.from(data, 'base64'))
  return file
}

async function goBack() {
  await evaluate('history.back()')
  await waitEvent('Page.loadEventFired', 10_000).catch(() => undefined)
  await new Promise(resolve => setTimeout(resolve, 300))
  return pageInfo()
}

async function closeBrowser(): Promise<void> {
  const active = session
  if (!active) return
  session = null
  try {
    active.ws.close()
  } catch {
    // Ignore.
  }
  try {
    active.proc.kill('SIGTERM')
  } catch {
    // Ignore.
  }
  setTimeout(() => {
    try {
      active.proc.kill('SIGKILL')
    } catch {
      // Ignore.
    }
  }, 1_500)
  await rm(active.userDataDir, { recursive: true, force: true }).catch(() => {})
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'navigate',
        'click',
        'type',
        'press',
        'screenshot',
        'eval',
        'back',
        'info',
        'close',
      ])
      .describe('Browser action to perform.'),
    url: z.string().optional().describe('URL for action "navigate".'),
    selector: z
      .string()
      .optional()
      .describe('CSS selector for "click" and "type".'),
    text: z.string().optional().describe('Text to enter for "type".'),
    key: z
      .string()
      .optional()
      .describe('Key for "press" (e.g. Enter, Tab, Escape, ArrowDown).'),
    script: z
      .string()
      .optional()
      .describe('JavaScript expression for "eval"; its value is returned.'),
    fullPage: z
      .boolean()
      .optional()
      .describe(
        'For "screenshot": capture the full page, not just the viewport.',
      ),
    headed: z
      .boolean()
      .optional()
      .describe(
        'For "navigate": launch a visible Chrome window instead of headless.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type BrowserInput = z.infer<InputSchema>

type BrowserOutput = {
  ok: boolean
  action: string
  url?: string
  title?: string
  text?: string
  screenshotPath?: string
  value?: unknown
  error?: string
}

export const BrowserTool = buildTool({
  name: BROWSER_TOOL_NAME,
  searchHint: 'browser navigate click type screenshot eval web page interact',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return 'Control a real Chrome browser: navigate, click, type, press keys, run JavaScript, and take screenshots.'
  },

  async prompt() {
    return `Control a real Chrome/Chromium browser (via the DevTools protocol). The browser session persists across calls until you run action "close".

Actions:
- navigate: open a URL (set "url"; set "headed": true to show a window for manual logins)
- click: click the element matching "selector"
- type: focus the element matching "selector" and enter "text"
- press: send a key ("Enter", "Tab", "Escape", "ArrowDown", ...)
- eval: evaluate the JavaScript expression "script" and return its value
- screenshot: save a PNG (set "fullPage": true for the whole page) and return its path; read the file to view it
- back: go back in history
- info: return the current URL, title and page text
- close: shut the browser down

Use this for pages that need JavaScript, login, form filling, or multi-step interaction.`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },

  userFacingName() {
    return 'Browser'
  },

  checkPermissions(input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },

  renderToolUseMessage(input: Partial<BrowserInput>) {
    const target =
      input.url ?? input.selector ?? input.key ?? input.script ?? ''
    return `Browser ${input.action ?? '...'} ${target}`.trim()
  },

  mapToolResultToToolResultBlockParam(
    content: BrowserOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    if (!content.ok) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Browser ${content.action} failed: ${content.error ?? 'unknown error'}`,
      }
    }
    if (content.action === 'screenshot' && content.screenshotPath) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Screenshot saved to ${content.screenshotPath}\nPage: ${content.title ?? ''} (${content.url ?? ''})`,
      }
    }
    const parts = [`Browser ${content.action}: ${content.url ?? ''}`]
    if (content.title) parts.push(`Title: ${content.title}`)
    if (content.text) parts.push('', content.text)
    if (content.value !== undefined) {
      parts.push('', JSON.stringify(content.value, null, 2))
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: parts.join('\n'),
    }
  },

  async call(input: BrowserInput) {
    try {
      switch (input.action) {
        case 'navigate': {
          if (!input.url) throw new Error('url is required for navigate')
          const info = await navigate(input.url, input.headed ?? false)
          return { data: { ok: true, action: input.action, ...info } }
        }
        case 'click': {
          if (!input.selector) throw new Error('selector is required for click')
          await ensureBrowser(false)
          await click(input.selector)
          const info = await pageInfo()
          return { data: { ok: true, action: input.action, ...info } }
        }
        case 'type': {
          if (!input.selector) throw new Error('selector is required for type')
          if (input.text === undefined)
            throw new Error('text is required for type')
          await ensureBrowser(false)
          await typeText(input.selector, input.text)
          return { data: { ok: true, action: input.action } }
        }
        case 'press': {
          if (!input.key) throw new Error('key is required for press')
          await ensureBrowser(false)
          await pressKey(input.key)
          return { data: { ok: true, action: input.action } }
        }
        case 'screenshot': {
          const path = await screenshot(input.fullPage ?? false)
          const info = await pageInfo()
          return {
            data: {
              ok: true,
              action: input.action,
              screenshotPath: path,
              url: info.url,
              title: info.title,
            },
          }
        }
        case 'eval': {
          if (!input.script) throw new Error('script is required for eval')
          await ensureBrowser(false)
          const value = await evaluate(input.script)
          return { data: { ok: true, action: input.action, value } }
        }
        case 'back': {
          await ensureBrowser(false)
          const info = await goBack()
          return { data: { ok: true, action: input.action, ...info } }
        }
        case 'info': {
          await ensureBrowser(false)
          const info = await pageInfo()
          return { data: { ok: true, action: input.action, ...info } }
        }
        case 'close': {
          await closeBrowser()
          return { data: { ok: true, action: input.action } }
        }
      }
    } catch (error) {
      return {
        data: {
          ok: false,
          action: input.action,
          error: error instanceof Error ? error.message : String(error),
        },
      }
    }
  },
})
