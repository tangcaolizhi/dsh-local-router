/**
 * dsh-local-router — Host half.
 *
 * Intercepts the harness `llm/stream` waterfall for ordinary conversation
 * turns. A short, self-contained user prompt is answered by a local Ollama
 * model through its OpenAI-compatible `/v1/chat/completions` endpoint; the
 * resulting text is yielded as a normal assistant stream, so the cloud
 * adapter is never dispatched.
 *
 * Everything else — long prompts, code, tool intent, context references,
 * compaction and session-title calls — goes straight to the cloud by calling
 * `next()`. Any local failure, timeout or unsafe configuration also calls
 * `next()`, which makes degradation silent and leaves the conversation
 * uninterrupted.
 *
 * Security posture:
 *  - Network access is restricted to loopback Ollama endpoints.
 *  - No filesystem, shell, clipboard or credential access.
 *  - Logs contain only the routing decision and elapsed time, never prompt
 *    text, model output or personal data.
 *  - Every internal failure is contained; the listener always returns an
 *    async iterable and never throws into the agent loop.
 */

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'http://localhost:11434',
  model: 'qwen2:1.5b',
  maxChars: 80,
  keywordFilter: true,
  timeoutMs: 5000,
  cooldownMs: 30000,
  prewarm: true,
  maxAnswerChars: 4000,
  temperature: 0.3,
  maxTokens: 512,
  timeZone: '',
  systemPrompt: '',
  showSourceBadge: true,
})

const COMPLEX_RE = new RegExp(
  [
    '分析', '设计', '重构', '证明', '比较', '对比', '解释', '原理', '机制', '架构',
    '算法', '方案', '评估', '优化', '调试', '实现', '推导', '论证', '论文', '详细',
    '深入', '全面', '优缺点', '优劣', '为什么', '如何', '怎么', '区别', '差异',
    '总结', '规划', '策略', '风险', '性能', '安全', '并发', '源码', '协议',
  ].join('|') +
    '|\\b(analy[sz]e|analysis|design|refactor|prove|proof|compare|comparison|' +
    'explain|implement|implementation|debug|optimi[sz]e|architecture|algorithm|' +
    'evaluate|assessment|trade-?offs?|why|how|differ\\w*|summar\\w*|plan|strategy|' +
    'risk|performance|security|concurren\\w*)\\b',
  'i',
)

const TOOL_RE = new RegExp(
  [
    '文件', '文件夹', '目录', '路径', '代码', '脚本', '仓库', '项目', '终端',
    '命令行', '命令', '浏览器', '网页', '截图', '剪贴板', '桌面', '安装', '卸载',
    '运行', '执行', '读取', '写入', '修改', '删除', '创建', '新建', '移动', '复制',
    '重命名', '下载', '上传', '搜索', '查找', '打开', '关闭', '部署', '启动', '停止',
    'git', 'npm', 'pnpm', 'python', 'node', 'docker', 'curl',
    'https?://',
  ].join('|'),
  'i',
)

const REFERENCE_RE = new RegExp(
  [
    '这个', '那个', '这些', '那些', '它们', '(?<!其)它', '上面', '上述', '刚才', '之前', '前面',
    '继续', '接着', '同样', '该文件', '此文件', '这条', '那条',
  ].join('|') +
    '|\\b(it|this|that|these|those|above|previous|continue|same)\\b',
  'i',
)

/** A request that is not an ordinary Agent-loop first step is never routed locally. */
export function analyzeRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { text: null, reason: 'no-messages' }
  }

  // Find the newest human message. Injected user-role context (runtime snapshot,
  // skill catalog, time snapshot) may follow it; an assistant or tool message
  // after it means this is a later step of the turn, not the first one.
  let humanIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (message.role === 'assistant' || message.role === 'tool') {
      return { text: null, reason: 'not-first-step' }
    }
    if (message.role === 'developer') {
      return { text: null, reason: 'tool-update' }
    }
    if (message.role === 'system') continue
    if (message.role !== 'user') return { text: null, reason: 'no-user' }
    if (message.source && message.source.kind !== 'user') continue
    humanIndex = index
    break
  }
  if (humanIndex < 0) return { text: null, reason: 'no-user' }

  // Several human messages in the same step form a batch, not a self-contained
  // simple prompt; leave the batch to the cloud. Messages before an assistant,
  // tool or developer message are history and do not disqualify the prompt.
  for (let index = humanIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || typeof message !== 'object') continue
    if (
      message.role === 'assistant' ||
      message.role === 'tool' ||
      message.role === 'developer'
    ) {
      break
    }
    if (message.role === 'user' && (!message.source || message.source.kind === 'user')) {
      return { text: null, reason: 'multiple-user-messages' }
    }
  }

  const human = messages[humanIndex]
  const blocks = Array.isArray(human.content)
    ? human.content
    : typeof human.content === 'string'
      ? [{ type: 'text', text: human.content }]
      : []
  if (blocks.some((block) => block && (block.type === 'image' || block.type === 'file'))) {
    return { text: null, reason: 'attachment' }
  }
  // A delegated subagent prompt is followed by a fixed parent-instruction
  // block. Classify the actual task, not the harness boilerplate.
  const parentInstruction = blocks.findIndex(
    (block, index) =>
      index > 0 &&
      block &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      /^Your parent agent id is "[^"]+"\./.test(block.text.trim()),
  )
  const taskBlocks = parentInstruction > 0 ? blocks.slice(0, parentInstruction) : blocks
  const text = taskBlocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return text ? { text, reason: 'ok' } : { text: null, reason: 'empty' }
}

/** Heuristic, millisecond-scale routing decision. Never sees the model output. */
export function classifyPrompt(text, settings = DEFAULT_CONFIG) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!settings.enabled) return { local: false, reason: 'disabled' }
  if (!value) return { local: false, reason: 'empty' }
  if (!/[\p{L}\p{N}]/u.test(value)) return { local: false, reason: 'no-content' }
  if (Array.from(value).length > settings.maxChars) {
    return { local: false, reason: 'too-long' }
  }
  if (value.includes('`') || value.includes('~~~')) {
    return { local: false, reason: 'code' }
  }
  if (/[\r\n\t]/.test(value)) return { local: false, reason: 'multiline' }
  if (settings.keywordFilter && COMPLEX_RE.test(value)) {
    return { local: false, reason: 'complex-keyword' }
  }
  if (TOOL_RE.test(value)) return { local: false, reason: 'tool-intent' }
  if (REFERENCE_RE.test(value)) return { local: false, reason: 'context-reference' }
  return { local: true, reason: 'ok' }
}

/** Accept only loopback HTTP(S) endpoints; anything else disables routing. */
export function normalizeLoopbackBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  if (!loopback) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

function numberOr(value, fallback, min, max) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function floatOr(value, fallback, min, max) {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function booleanOr(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Validate and clamp the row config; malformed values degrade to safe defaults. */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const settings = {
    ...DEFAULT_CONFIG,
    enabled: booleanOr(input.enabled, DEFAULT_CONFIG.enabled),
    keywordFilter: booleanOr(input.keywordFilter, DEFAULT_CONFIG.keywordFilter),
    prewarm: booleanOr(input.prewarm, DEFAULT_CONFIG.prewarm),
    showSourceBadge: booleanOr(input.showSourceBadge, DEFAULT_CONFIG.showSourceBadge),
    maxChars: numberOr(input.maxChars, DEFAULT_CONFIG.maxChars, 1, 4000),
    timeoutMs: numberOr(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 500, 30000),
    cooldownMs: numberOr(input.cooldownMs, DEFAULT_CONFIG.cooldownMs, 0, 300000),
    maxAnswerChars: numberOr(input.maxAnswerChars, DEFAULT_CONFIG.maxAnswerChars, 80, 20000),
    temperature: floatOr(input.temperature, DEFAULT_CONFIG.temperature, 0, 2),
    maxTokens: numberOr(input.maxTokens, DEFAULT_CONFIG.maxTokens, 16, 4096),
  }
  settings.baseUrl = normalizeLoopbackBaseUrl(input.baseUrl ?? DEFAULT_CONFIG.baseUrl) ?? ''
  if (typeof input.model === 'string' && input.model.trim() !== '') {
    settings.model = input.model.trim().slice(0, 200)
  }
  if (typeof input.timeZone === 'string') {
    const zone = input.timeZone.trim()
    if (zone) {
      try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: zone }).format(new Date())
        settings.timeZone = zone
      } catch {
        settings.timeZone = ''
      }
    }
  }
  if (typeof input.systemPrompt === 'string' && input.systemPrompt.trim() !== '') {
    settings.systemPrompt = input.systemPrompt.trim().slice(0, 2000)
  }
  return settings
}

function buildSystemPrompt(settings) {
  if (settings.systemPrompt) return settings.systemPrompt
  let now
  try {
    now = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full',
      timeStyle: 'short',
      ...(settings.timeZone ? { timeZone: settings.timeZone } : {}),
    }).format(new Date())
  } catch {
    now = new Date().toString()
  }
  return (
    '你是运行在用户本机的轻量助手。请直接、准确、简洁地回答，' +
    '使用与用户相同的语言。不要声称调用了工具、读取了文件或访问了网络；' +
    `不确定时如实说明。当前时间：${now}。`
  )
}

function extractAnswer(payload) {
  const content = payload?.choices?.[0]?.message?.content
  let text = ''
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    text = content
      .map((part) =>
        typeof part === 'string' ? part : part && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
      )
      .join('')
  } else if (typeof payload?.response === 'string') {
    text = payload.response
  }
  const trimmed = text.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Call the local Ollama OpenAI-compatible endpoint.
 * @returns the answer text, or null for any failure/timeout.
 */
export async function callLocalModel(settings, text, signal, state) {
  if (!settings.baseUrl) return null
  if (signal?.aborted) return null

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, settings.timeoutMs)

  const onAbort = () => controller.abort()
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true })
  }

  const markUnavailable = () => {
    if (state && settings.cooldownMs > 0) state.downUntil = Date.now() + settings.cooldownMs
  }

  try {
    const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: buildSystemPrompt(settings) },
          { role: 'user', content: text },
        ],
        stream: false,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      markUnavailable()
      return null
    }
    const payload = await response.json()
    const answer = extractAnswer(payload)
    if (!answer) {
      markUnavailable()
      return null
    }
    if (state) state.downUntil = 0
    return answer.length > settings.maxAnswerChars
      ? `${answer.slice(0, settings.maxAnswerChars)}…`
      : answer
  } catch {
    // User cancellation is not a local-model outage.
    if (!signal?.aborted) markUnavailable()
    return null
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * Load the local model ahead of the first user turn. Fire-and-forget: a warmup
 * failure never changes routing or throws.
 * @returns true when the endpoint accepted the warmup request.
 */
export async function warmLocalModel(settings, signal) {
  if (!settings.prewarm || !settings.baseUrl) return false
  if (signal?.aborted) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  const onAbort = () => controller.abort()
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        temperature: 0,
        max_tokens: 1,
      }),
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function makeLogger(ctx) {
  return (line) => {
    try {
      const logger = ctx?.logger
      if (logger && typeof logger.info === 'function') {
        logger.info(`[local-router] ${line}`)
      }
    } catch {
      // Diagnostics must never disturb a conversation.
    }
  }
}

function assistantChunks(answer) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: answer },
    { type: 'block-end', index: 0, block: { type: 'text', text: answer } },
    { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function* localAnswerStream({ settings, state, text, options, next, logger }) {
  const startedAt = Date.now()
  let answer = null
  try {
    answer = await callLocalModel(settings, text, options?.signal, state)
  } catch {
    answer = null
  }
  const elapsed = Date.now() - startedAt

  if (!answer) {
    // Silent degradation: the original cloud route runs untouched.
    logger(`decision=cloud reason=local-failed elapsedMs=${elapsed}`)
    yield* next()
    return
  }

  logger(`decision=local elapsedMs=${elapsed}`)
  const badge = settings.showSourceBadge ? `\n\n> 本地模型 · ${settings.model}` : ''
  for (const chunk of assistantChunks(`${answer}${badge}`)) yield chunk
}

/**
 * Host plugin entry point.
 * @param ctx Cordis plugin context.
 * @param config Loader row config.
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const state = { downUntil: 0 }
  const logger = makeLogger(ctx)

  ctx.on('llm/stream', (options, next) => {
    const startedAt = Date.now()
    try {
      if (!settings.enabled) {
        logger('decision=cloud reason=disabled')
        return next()
      }
      if (!settings.baseUrl) {
        logger('decision=cloud reason=unsafe-base-url')
        return next()
      }
      if (options?.purpose !== undefined) {
        logger(`decision=cloud reason=purpose-${String(options.purpose)}`)
        return next()
      }
      const first = Array.isArray(options?.messages) ? options.messages[0] : undefined
      if (!first || first.role !== 'system' || first.source?.kind !== 'system-prompt') {
        logger('decision=cloud reason=not-agent-loop')
        return next()
      }
      const request = analyzeRequest(options.messages)
      if (!request.text) {
        logger(`decision=cloud reason=${request.reason}`)
        return next()
      }
      const verdict = classifyPrompt(request.text, settings)
      if (!verdict.local) {
        logger(`decision=cloud reason=${verdict.reason} elapsedMs=${Date.now() - startedAt}`)
        return next()
      }
      if (Date.now() < state.downUntil) {
        logger('decision=cloud reason=local-cooldown')
        return next()
      }
      return localAnswerStream({ settings, state, text: request.text, options, next, logger })
    } catch {
      logger('decision=cloud reason=router-error')
      return next()
    }
  })

  if (settings.enabled && settings.prewarm && settings.baseUrl) {
    const lifetime = new AbortController()
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => lifetime.abort(), 'local-router.prewarm')
    }
    const startedAt = Date.now()
    void warmLocalModel(settings, lifetime.signal)
      .then((ok) => logger(`prewarm=${ok ? 'ok' : 'failed'} elapsedMs=${Date.now() - startedAt}`))
      .catch(() => {})
  }
}
