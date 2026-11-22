/**
 * Host half: drives the local browser bridge, turns live-room danmaku into
 * target customers, and serves the panel that the client half renders in the
 * left sidebar.
 *
 * One capture session at a time. Everything the agent tool returns is the same
 * snapshot the panel reads from `/danmaku-leads/state`.
 */
import {
  BridgeError, buildDanmakuScript, createRunner, evaluateValue, payload, resolveBridgePath, runJson,
} from './lib/bridge.js'
import { classify, parseDanmaku, targetTerms, upsertLead } from './lib/leads.js'

export const name = 'dsh-danmaku-leads'

/** The agent tool needs the tool registry; the panel degrades without a web server. */
export const inject = ['tools']

const ROUTE = '/danmaku-leads'
const MAX_LEADS = 200
const MAX_RECENT = 20
const MAX_SEEN = 20_000
const DEFAULT_SELECTORS = [
  '[data-e2e="chat-message"]',
  '[data-e2e*="chat" i]',
  '.webcast-chatroom___item',
  '[class*="webcast-chatroom" i] [class*="item" i]',
  '[class*="ChatMessage" i]',
  '[class*="chat-item" i]',
]

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const cfg = {
    bridgePath: typeof config.bridgePath === 'string' ? config.bridgePath : '',
    browserName: typeof config.browserName === 'string' ? config.browserName : '测试抖音链接',
    daemonUrl: typeof config.daemonUrl === 'string' ? config.daemonUrl : 'ws://127.0.0.1:52800',
    roomUrl: typeof config.roomUrl === 'string' ? config.roomUrl : '',
    target: typeof config.target === 'string' ? config.target : '想学习嵌入式的人',
    minScore: Number.isFinite(config.minScore) ? Number(config.minScore) : 4,
    pollMs: Number.isFinite(config.pollMs) ? Math.max(1000, Number(config.pollMs)) : 4000,
    timeoutMs: Number.isFinite(config.timeoutMs) ? Number(config.timeoutMs) : 120000,
    noFocus: config.noFocus !== false,
    selectors: Array.isArray(config.selectors) && config.selectors.length > 0
      ? config.selectors.filter((item) => typeof item === 'string')
      : DEFAULT_SELECTORS,
  }
  const bridgePath = resolveBridgePath(cfg.bridgePath)
  const runner = createRunner(bridgePath)
  /** The target audience is editable at run time; its words join the built-in topic list. */
  const target = { text: cfg.target, terms: targetTerms(cfg.target) }
  function setTarget(text) {
    const trimmed = String(text ?? '').trim()
    if (trimmed === '') return
    target.text = trimmed
    target.terms = targetTerms(trimmed)
  }

  /** @type {{ status: string, error: null | string, sessionId: null | string, roomUrl: string, startedAt: null | number, lastScanAt: null | number, messages: number, scans: number }} */
  const status = {
    status: 'idle',
    error: null,
    sessionId: null,
    roomUrl: cfg.roomUrl,
    startedAt: null,
    lastScanAt: null,
    messages: 0,
    scans: 0,
  }
  /** @type {Map<string, { nickname: string, content: string, score: number, topics: string[], intents: string[], at: number, hits: number, url: string }>} */
  const leads = new Map()
  /** @type {Array<{ nickname: string, content: string, at: number }>} */
  const recent = []
  const seen = new Set()
  let timer
  let polling = false

  function snapshot() {
    return {
      status: status.status,
      error: status.error,
      sessionId: status.sessionId,
      roomUrl: status.roomUrl,
      startedAt: status.startedAt,
      lastScanAt: status.lastScanAt,
      messages: status.messages,
      scans: status.scans,
      target: target.text,
      targetTerms: target.terms,
      minScore: cfg.minScore,
      bridgePath,
      browserName: cfg.browserName,
      daemonUrl: cfg.daemonUrl,
      selectors: cfg.selectors.length,
      leads: [...leads.values()].sort((a, b) => b.score - a.score || b.at - a.at),
      recent,
    }
  }

  function schedule(delay) {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { void pollOnce(true) }, delay)
    timer.unref?.()
  }

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  function ingest(rows, at) {
    for (const message of parseDanmaku(rows)) {
      const key = `${message.nickname}|${message.content}`
      if (seen.has(key)) continue
      if (seen.size >= MAX_SEEN) seen.clear()
      seen.add(key)
      status.messages += 1
      recent.unshift({ nickname: message.nickname, content: message.content, at })
      if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
      const verdict = classify(message.content, { minScore: cfg.minScore, extraTopics: target.terms })
      if (!verdict.isLead) continue
      upsertLead(leads, message, verdict, at)
      if (leads.size > MAX_LEADS) {
        const weakest = [...leads.values()].sort((a, b) => a.score - b.score)[0]
        if (weakest !== undefined) leads.delete(weakest.nickname)
      }
    }
  }

  const EVAL_TIMEOUT = '20000ms'
  const EVAL_TOTAL_TIMEOUT = () => Math.max(cfg.timeoutMs, 30000)

  async function readDanmaku() {
    const sessionId = status.sessionId
    const script = buildDanmakuScript(cfg.selectors)
    // A script needs page evidence: sync first, then pass the strict observation.
    const sync = payload(await runJson(
      runner,
      ['cooperate', 'sync', '--session', sessionId, '--policy', 'auto'],
      { timeoutMs: 30000 },
    ))
    const contextId = sync?.context_id
    const observationId = sync?.observation_id
    if (typeof contextId !== 'string' || typeof observationId !== 'string') {
      throw new BridgeError('桥接程序 cooperate sync 未返回 context_id/observation_id', {
        code: 'bad_output',
        detail: JSON.stringify(sync).slice(0, 400),
      })
    }
    let reply
    try {
      reply = await runJson(runner, [
        'evaluate', script, '--session', sessionId, '--context', contextId, '--observation', observationId, '--timeout', EVAL_TIMEOUT,
      ], { timeoutMs: EVAL_TOTAL_TIMEOUT() })
    } catch (error) {
      // A live chat changes between sync and evaluate; 1.9+ peers accept an unverified read as the retry.
      if (!(error instanceof BridgeError) || !/observ|unused strict|changed|match/i.test(error.message)) throw error
      try {
        reply = await runJson(runner, [
          'evaluate', script, '--session', sessionId, '--context', contextId, '--unverified', '--timeout', EVAL_TIMEOUT,
        ], { timeoutMs: EVAL_TOTAL_TIMEOUT() })
      } catch (fallbackError) {
        if (fallbackError instanceof BridgeError && /unverified|protocol 1\.9/i.test(fallbackError.message)) {
          throw new BridgeError(
            '浏览器桥接扩展协议版本过低：脚本读取需要扩展协议 1.9（当前 1.8）。请在浏览器扩展商店更新该扩展，重连后再试。',
            { code: 'extension_outdated', detail: fallbackError.message },
          )
        }
        throw fallbackError
      }
    }
    const value = evaluateValue(reply)
    if (!Array.isArray(value)) {
      throw new BridgeError('桥接程序 evaluate 未返回弹幕数组（页面里可能还没有弹幕列表）', { code: 'bad_output', detail: JSON.stringify(value).slice(0, 400) })
    }
    ingest(value, Date.now())
    status.scans += 1
    status.lastScanAt = Date.now()
  }

  /** @param {boolean} reschedule */
  async function pollOnce(reschedule) {
    if (status.status !== 'running' || status.sessionId === null) return
    if (polling) return
    polling = true
    try {
      await readDanmaku()
      status.error = null
    } catch (error) {
      status.error = messageOf(error)
    } finally {
      polling = false
      if (reschedule && status.status === 'running') schedule(cfg.pollMs)
    }
  }

  function messageOf(error) {
    if (error instanceof BridgeError) return error.hint === undefined ? error.message : `${error.message} ${error.hint}`
    return error instanceof Error ? error.message : String(error)
  }

  async function stopSession() {
    const sessionId = status.sessionId
    status.sessionId = null
    if (sessionId === null) return
    try { await runJson(runner, ['session', 'stop', sessionId], { timeoutMs: 30000 }) } catch {}
  }

  function isLiveRoom(url) {
    const value = typeof url === 'string' ? url.toLowerCase() : ''
    return value.includes('live.douyin.com') || (value.includes('douyin.com') && value.includes('live'))
  }

  async function borrowLiveRoomTab(sessionId) {
    const reply = await runJson(runner, ['tab', 'list', '--session', sessionId, '--scope', 'user'], { timeoutMs: 30000 })
    const tabs = Array.isArray(payload(reply)?.tabs) ? payload(reply).tabs : []
    const room = tabs.find((tab) => isLiveRoom(tab?.url))
    if (room === undefined) {
      throw new BridgeError(
        `「${cfg.browserName}」里没有找到抖音直播间标签页。请先在该浏览器打开直播间，或在插件配置/面板里填写 roomUrl。`,
        { code: 'no_live_room' },
      )
    }
    try {
      await runJson(runner, ['tab', 'borrow', String(room.tab_id), '--session', sessionId], { timeoutMs: 30000 })
    } catch (error) {
      if (error instanceof BridgeError && /borrow confirmation/i.test(error.message)) {
        throw new BridgeError(
          '借用直播间标签页需要人工确认，但当前没有可显示的确认界面。二选一：在扩展的 Automation settings 关闭「Confirm before borrowing tabs」，'
          + '或在面板/配置里填写 roomUrl（插件会新开标签页，无需借用）。',
          { code: 'borrow_confirmation_unavailable', detail: error.message },
        )
      }
      throw error
    }
    status.roomUrl = room.url
    return room
  }

  async function startCapture() {
    if (status.status === 'running' || status.status === 'starting') return
    status.status = 'starting'
    status.error = null
    try {
      // Fail with install guidance before blaming the daemon when the bridge itself is missing.
      await runner.run(['--version'], { timeoutMs: 15000 })
      const startArgs = ['session', 'start', '--browser', cfg.browserName]
      if (cfg.noFocus) startArgs.push('--no-focus')
      let reply
      try {
        // The bridge starts its own daemon on first use; only its failure needs the manual start hint.
        reply = await runJson(runner, startArgs, { timeoutMs: cfg.timeoutMs })
      } catch (error) {
        if (error instanceof BridgeError && /daemon|os error 5|breakaway/i.test(error.message)) {
          throw new BridgeError(
            `${error.message} 守护进程可能未能启动：请在独立终端执行 \`${bridgePath || 'bridge'} daemon start --foreground\` 后重试。`,
            { code: 'daemon_down', hint: error.hint },
          )
        }
        throw error
      }
      const sessionId = payload(reply)?.session_id ?? payload(reply)?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new BridgeError('桥接程序 session start 未返回 session_id', { code: 'bad_output', detail: JSON.stringify(reply).slice(0, 400) })
      }
      status.sessionId = sessionId
      if (status.roomUrl !== '') {
        // Exit code 4 means the page lifecycle did not settle in time; the session stays usable.
        await runJson(runner, ['navigate', status.roomUrl, '--session', sessionId], {
          timeoutMs: cfg.timeoutMs,
          allowExitCodes: [4],
        })
      } else {
        await borrowLiveRoomTab(sessionId)
      }
      status.status = 'running'
      status.startedAt = Date.now()
      schedule(500)
    } catch (error) {
      status.status = 'error'
      status.error = messageOf(error)
      await stopSession()
    }
  }

  async function stopCapture() {
    clearTimer()
    status.status = 'idle'
    await stopSession()
  }

  async function scanOnce() {
    const owned = status.status !== 'running' && status.status !== 'starting'
    if (owned) await startCapture()
    if (status.status !== 'running') return
    await pollOnce(false)
    if (owned) await stopCapture()
  }

  function reset() {
    leads.clear()
    recent.length = 0
    seen.clear()
    status.messages = 0
    status.scans = 0
    status.lastScanAt = null
    status.error = null
    if (status.status === 'error') status.status = 'idle'
  }

  async function action(request) {
    const verb = typeof request?.action === 'string' ? request.action : 'status'
    if (typeof request?.roomUrl === 'string') status.roomUrl = request.roomUrl.trim()
    if (typeof request?.target === 'string') setTarget(request.target)
    switch (verb) {
      case 'status':
        break
      case 'start':
        await startCapture()
        break
      case 'stop':
        await stopCapture()
        break
      case 'scan':
        await scanOnce()
        break
      case 'reset':
        reset()
        break
      default:
        throw new BridgeError(`未知操作：${verb}`, { code: 'bad_request' })
    }
    return snapshot()
  }

  function sendJson(res, codeValue, body) {
    res.writeHead(codeValue, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** Loopback + same-origin + JSON-body fence, mirroring DSH's own /api checks. */
  function fenceRejects(req, res) {
    const host = req.headers.host ?? ''
    const hostname = /^\[.*\](?::\d+)?$/.test(host) ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
    if (!(hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname))) {
      sendJson(res, 403, { error: 'host is not a loopback authority' })
      return true
    }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== 'null') {
      let originHost = ''
      try { originHost = new URL(origin).host } catch {}
      if (originHost !== host) { sendJson(res, 403, { error: 'Origin does not match Host' }); return true }
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') { sendJson(res, 403, { error: 'cross-site request' }); return true }
    return false
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 64 * 1024) reject(new BridgeError('请求体过大', { code: 'bad_request' }))
      })
      req.on('end', () => {
        if (body.trim() === '') { resolve({}); return }
        try { resolve(JSON.parse(body)) } catch { reject(new BridgeError('请求体不是合法 JSON', { code: 'bad_request' })) }
      })
      req.on('error', reject)
    })
  }

  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.get('webServer')
    if (webServer === undefined) return () => {}
    const stateRoute = webServer.register({
      kind: 'exact',
      path: `${ROUTE}/state`,
      handler: (req, res) => {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return }
        if (fenceRejects(req, res)) return
        sendJson(res, 200, snapshot())
      },
    })
    const actionRoute = webServer.register({
      kind: 'exact',
      path: `${ROUTE}/action`,
      handler: async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return }
        if (fenceRejects(req, res)) return
        if (!/^\s*application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
          sendJson(res, 415, { error: 'POST requires an application/json body' })
          return
        }
        try {
          sendJson(res, 200, await action(await readBody(req)))
        } catch (error) {
          sendJson(res, 400, { error: messageOf(error), state: snapshot() })
        }
      },
    })
    return () => { stateRoute(); actionRoute() }
  })

  ctx.effect(() => () => {
    clearTimer()
    void stopSession()
  }, 'danmaku-leads: capture lifetime')

  ctx.tools?.register({
    name: 'danmaku_leads',
    description: 'Capture Douyin live-room danmaku through the local browser bridge and list viewers who look like target customers. '
      + 'The target audience and the bridge browser are plugin configuration. '
      + 'start opens a browser session and polls the live room; status shows the collected leads; scan captures once and stops; '
      + 'stop ends the session; reset clears collected data.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'start', 'stop', 'scan', 'reset'],
          description: 'status reads state; start begins polling; stop ends the browser session; scan captures once and stops; reset clears leads.',
        },
        roomUrl: {
          type: 'string',
          description: 'Optional live-room URL for this and later captures; when omitted, an already-open Douyin live tab is borrowed.',
        },
        target: {
          type: 'string',
          description: 'Optional target audience in your own words, e.g. "想学剪辑的人"; its words join the built-in topic list for this and later captures.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return await action({ action: args?.action, roomUrl: args?.roomUrl, target: args?.target })
    },
  })
}
