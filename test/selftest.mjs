/**
 * Self-check for the danmaku → target-customer pipeline.
 * Runs without a browser, a daemon or the bsk CLI: `node test/selftest.mjs`.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { buildDanmakuScript, createRunner, evaluateValue, payload, resolveBskPath, runJson } from '../lib/bsk.js'
import { classify, parseDanmaku, targetTerms, upsertLead } from '../lib/leads.js'

// --- target-customer judgement -------------------------------------------------
const cases = [
  ['想学嵌入式，零基础能学吗？', true],
  ['STM32 单片机怎么入门', true],
  ['嵌入式好学吗', true],
  ['这个开发板多少钱', true],
  ['想学习 C 语言转行嵌入式', true],
  ['嵌入式', false],
  ['主播好帅，来了', false],
  ['666666', false],
  ['今天天气不错', false],
]
for (const [text, expected] of cases) {
  const verdict = classify(text, { minScore: 4 })
  assert.equal(verdict.isLead, expected, `classify("${text}") should be ${expected}, got ${JSON.stringify(verdict)}`)
}

// Repeated mention of the same viewer keeps the stronger message.
const leads = new Map()
upsertLead(leads, { nickname: '小明', content: '嵌入式', url: '' }, classify('嵌入式'), 1)
upsertLead(leads, { nickname: '小明', content: '想学嵌入式怎么入门', url: '' }, classify('想学嵌入式怎么入门'), 2)
assert.equal(leads.size, 1)
assert.equal(leads.get('小明').content, '想学嵌入式怎么入门')
assert.equal(leads.get('小明').hits, 2)

// A typed target audience contributes its own topic words.
assert.deepEqual(targetTerms('想学嵌入式的人'), ['嵌入式'])
assert.deepEqual(targetTerms('想学剪辑 / 特效的人'), ['剪辑', '特效'])
assert.deepEqual(targetTerms('   '), [])
assert.equal(classify('剪辑怎么入门', { extraTopics: ['剪辑'] }).isLead, true)
assert.equal(classify('剪辑怎么入门').isLead, false)

// --- DOM rows → messages ------------------------------------------------------
const parsed = parseDanmaku([
  { user: '阿伟', text: '单片机零基础怎么学？', full: '' },
  { user: '', text: '', full: '小红：想报嵌入式培训班' },
  { user: '', text: '', full: '系统提示：为主播点赞了' },
  { user: '', text: '   ', full: '' },
])
assert.deepEqual(parsed.map((item) => [item.nickname, item.content]), [
  ['阿伟', '单片机零基础怎么学？'],
  ['小红', '想报嵌入式培训班'],
])
// A DOM nickname node that still carries its separator is normalised.
assert.deepEqual(
  parseDanmaku([{ user: '小刚：', text: '嵌入式怎么学', full: '' }]).map((item) => item.nickname),
  ['小刚'],
)

// --- bsk CLI plumbing ---------------------------------------------------------
function fakeSpawn(text, exitCode = 0) {
  const seen = []
  return {
    seen,
    spawn: (command, args, options) => {
      seen.push({ command, args, options })
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.stdin.end = () => {}
      child.kill = () => {}
      setTimeout(() => {
        child.stdout.emit('data', Buffer.from(text))
        child.emit('close', exitCode)
      }, 0)
      return child
    },
  }
}

// A success envelope exposes its payload and always asks for JSON.
const okFake = fakeSpawn(JSON.stringify({ ok: true, data: { session_id: 's-1', tabs: [{ tab_id: 7, url: 'https://live.douyin.com/1' }] } }))
const okBody = await runJson(createRunner('bsk', okFake.spawn), ['session', 'start', '--browser', '测试抖音链接'])
assert.equal(payload(okBody).session_id, 's-1')
assert.equal(payload(okBody).tabs[0].tab_id, 7)
assert.equal(okFake.seen[0].args.at(-1), '--json')
assert.equal(okFake.seen[0].options.env.BSK_CANCEL_ON_STDIN_CLOSE, '1')

// An error envelope becomes a thrown BskError instead of a silent success.
await assert.rejects(
  runJson(createRunner('bsk', fakeSpawn(JSON.stringify({ ok: false, code: 'no_browser', message: 'browser not connected' })).spawn), ['session', 'start']),
  /browser not connected/,
)

// Plain non-JSON output with a bad exit code keeps the exit code visible.
await assert.rejects(
  runJson(createRunner('bsk', fakeSpawn('boom', 3).spawn), ['--version']),
  /退出码 3/,
)

// Evaluate replies unwrap the evaluated value.
assert.deepEqual(evaluateValue({ ok: true, data: { value: [{ user: 'a', text: 'b' }] } }), [{ user: 'a', text: 'b' }])
assert.deepEqual(evaluateValue({ ok: true, data: [{ user: 'a' }] }), [{ user: 'a' }])

// The injected page script must at least parse as JavaScript.
const script = buildDanmakuScript(['[data-e2e="chat-message"]'])
assert.doesNotThrow(() => new Function(`return ${script}`))
assert.match(script, /querySelectorAll/)

// An explicit CLI path is used as given; a bare `bsk` may resolve to an install dir.
assert.equal(resolveBskPath('C:\\tools\\bsk.exe'), 'C:\\tools\\bsk.exe')

console.log('danmaku-leads selftest: ok')
