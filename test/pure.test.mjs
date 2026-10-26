import assert from 'node:assert/strict'
import {
  analyzeRequest,
  classifyPrompt,
  normalizeConfig,
  normalizeLoopbackBaseUrl,
} from '../index.js'

const base = normalizeConfig({
  enabled: true,
  baseUrl: 'http://localhost:11434',
  model: 'qwen2:1.5b',
  maxChars: 80,
  keywordFilter: true,
  timeoutMs: 8000,
  cooldownMs: 0,
  prewarm: false,
})

const cases = [
  ['今天星期几', true, 'ok'],
  ['用一句话说你好', true, 'ok'],
  ['请分析一下 Rust 所有权机制的设计优劣', false, 'complex-keyword'],
  ['帮我读取 D:\\secret.txt', false, 'tool-intent'],
  ['继续', false, 'context-reference'],
  ['它是什么', false, 'context-reference'],
  ['a'.repeat(81), false, 'too-long'],
  ['你好\n再见', false, 'multiline'],
  ['```js\nconsole.log(1)\n```', false, 'code'],
  ['https://example.com 讲了什么', false, 'tool-intent'],
  ['2 + 2 等于几', true, 'ok'],
]

for (const [text, expectedLocal, expectedReason] of cases) {
  const verdict = classifyPrompt(text, base)
  assert.equal(verdict.local, expectedLocal, `${text}: local`)
  assert.equal(verdict.reason, expectedReason, `${text}: reason`)
}

assert.equal(normalizeLoopbackBaseUrl('http://localhost:11434'), 'http://localhost:11434')
assert.equal(normalizeLoopbackBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434')
assert.equal(normalizeLoopbackBaseUrl('https://example.com'), null)
assert.equal(normalizeLoopbackBaseUrl('file:///etc/passwd'), null)
assert.equal(normalizeConfig({ baseUrl: 'https://example.com' }).baseUrl, '')
assert.equal(normalizeConfig({ maxChars: '120' }).maxChars, 120)
assert.equal(normalizeConfig({ temperature: 0.7 }).temperature, 0.7)
assert.equal(normalizeConfig({ prewarm: false }).prewarm, false)
assert.equal(normalizeConfig({ enabled: 'false' }).enabled, false)

const system = {
  role: 'system',
  source: { kind: 'system-prompt' },
  content: [{ type: 'text', text: 'system' }],
}
const user = (text) => ({
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

assert.equal(analyzeRequest([system, user('你好')]).text, '你好')
assert.equal(
  analyzeRequest([
    system,
    user('你好'),
    { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'context' }] },
    { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'time' }] },
  ]).text,
  '你好',
)
assert.equal(
  analyzeRequest([system, user('first'), user('second')]).reason,
  'multiple-user-messages',
)

const previousAssistant = {
  role: 'assistant',
  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
  content: [{ type: 'text', text: 'previous answer' }],
}
assert.equal(
  analyzeRequest([system, user('第一轮'), previousAssistant, user('你好')]).text,
  '你好',
)
assert.equal(
  analyzeRequest([system, user('第一轮'), previousAssistant, user('a'), user('b')]).reason,
  'multiple-user-messages',
)
assert.equal(
  analyzeRequest([
    system,
    {
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: '用一句话说你好' },
        { type: 'text', text: 'Your parent agent id is "session-1". Before you finish, send your result.' },
      ],
    },
  ]).text,
  '用一句话说你好',
)
assert.equal(
  analyzeRequest([system, user('你好'), { role: 'assistant', content: [] }]).text,
  null,
)
assert.equal(
  analyzeRequest([system, user('你好'), { role: 'developer', content: [] }]).reason,
  'tool-update',
)
assert.equal(
  analyzeRequest([system, { role: 'user', source: { kind: 'notice' }, content: [{ type: 'text', text: 'x' }] }]).text,
  null,
)
assert.equal(
  analyzeRequest([system, { ...user('看这个'), content: [{ type: 'image', attachment: {} }] }]).reason,
  'attachment',
)

console.log('ok: pure routing heuristics, config normalization, and request analysis')
