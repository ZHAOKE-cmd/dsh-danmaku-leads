/**
 * Local browser-bridge client.
 *
 * The bridge CLI owns the daemon connection, the browser extension handshake
 * and the session queue, so this module only builds command lines, spawns the
 * executable and normalises its JSON replies.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** A failed bridge invocation: bad exit, timeout, spawn failure or JSON error envelope. */
export class BridgeError extends Error {
  /**
   * @param {string} message - one-line cause.
   * @param {{ code?: string, hint?: string, exitCode?: number | null, detail?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = options.code
    this.hint = options.hint
    this.exitCode = options.exitCode
    this.detail = options.detail
  }
}

/** Guidance shown whenever the bridge executable itself cannot be started. */
export function bridgeInstallHint(bridgePath) {
  return `未找到本机浏览器桥接命令行程序（bridgePath=${bridgePath || '未指定'}）。`
    + '请先安装桥接程序并在浏览器里装好对应扩展、连接守护进程，'
    + '或用 bridgePath 指定该可执行文件的绝对路径。'
}

function tail(text, limit = 400) {
  const value = String(text ?? '').trim()
  return value.length <= limit ? value : `…${value.slice(-limit)}`
}

function describeSpawnFailure(cause, bridgePath) {
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? String(cause.code) : undefined
  if (code === 'ENOENT') {
    const hint = bridgeInstallHint(bridgePath)
    return new BridgeError(hint, { code: 'bridge_missing', hint })
  }
  return new BridgeError(`无法启动桥接程序（${code ?? 'spawn error'}）：${cause instanceof Error ? cause.message : String(cause)}`, {
    code: 'bridge_spawn_failed',
  })
}

/**
 * Resolve the bridge executable. A running DSH host does not pick up PATH
 * changes, so a bare command also checks the usual install directories and the
 * current PATH before giving up.
 * @param {string} configured - explicit absolute path, empty to auto-detect.
 */
export function resolveBridgePath(configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const names = process.platform === 'win32' ? ['bsk.exe', 'bsk'] : ['bsk']
  const dirs = [
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
  ]
  for (const dir of dirs) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/**
 * Create a runner bound to one bridge executable.
 * @param {string} bridgePath - absolute executable path.
 * @param {typeof spawn} [spawnImpl] - injected for tests.
 */
export function createRunner(bridgePath, spawnImpl = spawn) {
  return {
    /**
     * Run one command.
     * @param {string[]} args - subcommand and flags, without `--json`.
     * @param {{ timeoutMs?: number }} [options]
     * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>}
     */
    run(args, options = {}) {
      const timeoutMs = options.timeoutMs ?? 120_000
      return new Promise((resolve, reject) => {
        let child
        try {
          child = spawnImpl(bridgePath, [...args, '--json'], {
            windowsHide: true,
            // Keep the bridge call cancellable when its caller's stdin goes away.
            env: { ...process.env, BSK_CANCEL_ON_STDIN_CLOSE: '1' },
          })
        } catch (cause) {
          reject(describeSpawnFailure(cause, bridgePath))
          return
        }
        let stdout = ''
        let stderr = ''
        let timedOut = false
        let settled = false
        let killTimer
        const timer = timeoutMs > 0
          ? setTimeout(() => {
            timedOut = true
            try { child.kill() } catch {}
            // ponytail: 宽限 2s 后强杀；需要回收桥接程序的孙子进程时再换成进程组/进程树清理
            killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2_000)
            killTimer.unref?.()
          }, timeoutMs)
          : undefined
        timer?.unref?.()
        const finish = (code) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (killTimer !== undefined) clearTimeout(killTimer)
          resolve({ code: code ?? null, stdout, stderr, timedOut })
        }
        child.stdout?.on('data', (chunk) => { stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8') })
        child.stderr?.on('data', (chunk) => { stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8') })
        child.on('error', (cause) => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (killTimer !== undefined) clearTimeout(killTimer)
          reject(describeSpawnFailure(cause, bridgePath))
        })
        child.on('close', (code) => finish(code))
        child.stdin?.on('error', () => {})
      })
    },
  }
}

function parseJson(text) {
  const value = String(text ?? '').trim()
  if (value === '') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function fromEnvelope(body, exitCode) {
  const message = typeof body.message === 'string' && body.message !== '' ? body.message : '桥接程序报告失败'
  return new BridgeError(message, {
    code: typeof body.code === 'string' ? body.code : undefined,
    hint: typeof body.hint === 'string' ? body.hint : undefined,
    exitCode,
    detail: body.data === undefined ? undefined : JSON.stringify(body.data).slice(0, 800),
  })
}

/**
 * Run one command and return its parsed JSON body, mapping any failure to BridgeError.
 * @param {ReturnType<typeof createRunner>} runner
 * @param {string[]} args
 * @param {{ timeoutMs?: number, allowExitCodes?: number[] }} [options] - `allowExitCodes`
 *   accepts non-zero exits whose JSON body still carries usable data (a navigation
 *   lifecycle timeout reports exit code 4 while the session stays usable).
 */
export async function runJson(runner, args, options = {}) {
  const result = await runner.run(args, options)
  const body = parseJson(result.stdout)
  const allowed = options.allowExitCodes ?? []
  if (result.timedOut) {
    throw new BridgeError(`桥接程序 ${args[0]} 超时（${options.timeoutMs ?? 120_000}ms）`, { code: 'timeout', exitCode: result.code })
  }
  const exitAllowed = result.code === 0 || (result.code !== null && allowed.includes(result.code))
  if (body !== undefined && typeof body === 'object') {
    if (body.ok === false) throw fromEnvelope(body, result.code)
    if (!exitAllowed && typeof body.message === 'string') throw fromEnvelope(body, result.code)
    if (!exitAllowed) throw new BridgeError(`桥接程序 ${args.join(' ')} 退出码 ${result.code}`, { exitCode: result.code, detail: tail(result.stderr) })
    return body
  }
  if (!exitAllowed) {
    throw new BridgeError(`桥接程序 ${args.join(' ')} 失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout)}`, {
      exitCode: result.code,
      detail: tail(result.stderr),
    })
  }
  throw new BridgeError(`桥接程序 ${args.join(' ')} 返回了非 JSON 输出：${tail(result.stdout)}`, { code: 'bad_output' })
}

/** The payload a command reports, tolerating both envelope and bare-body shapes. */
export function payload(body) {
  if (body !== null && typeof body === 'object' && body.data !== null && typeof body.data === 'object') return body.data
  return body
}

/** The evaluated value of an evaluate reply, tolerating known reply shapes. */
export function evaluateValue(body) {
  const value = payload(body)
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object') {
    for (const key of ['value', 'result', 'out']) if (value[key] !== undefined) return value[key]
  }
  return value
}

/**
 * Build the DOM extraction script.
 *
 * It reads the chat list container's children (Douyin renders chat items as
 * children of `.webcast-chatroom___list`) as well as any configurable item
 * selector, and walks same-origin iframes because some live layouts host the
 * chat in one.
 * @param {string[]} selectors - item selectors from the plugin config.
 */
export function buildDanmakuScript(selectors) {
  return `(() => {
  const ITEM = ${JSON.stringify(selectors)};
  const LIST = ${JSON.stringify(['.webcast-chatroom___list', '[class*="webcast-chatroom___list"]', '[class*="chatroom"][class*="list"]', '[class*="ChatList"]'])};
  const NICK = ${JSON.stringify(['[class*="nickname" i]', '[class*="userName" i]', '[class*="user-name" i]', '[data-e2e*="user" i]'])};
  const BODY = ${JSON.stringify(['[class*="content" i]', '[class*="text" i]', '[class*="message" i]'])};
  const seen = new Set();
  const out = [];
  const docs = [document];
  for (const frame of document.querySelectorAll('iframe')) {
    try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
  }
  const pick = (root, list) => {
    for (const selector of list) {
      let node; try { node = root.querySelector(selector); } catch { continue; }
      const text = node && node.textContent ? node.textContent.trim() : '';
      if (text !== '') return text;
    }
    return '';
  };
  const push = (node, url) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    const full = (node.innerText || '').replace(/\\s+/g, ' ').trim();
    const text = pick(node, BODY);
    if (full === '' && text === '') return;
    out.push({ user: pick(node, NICK), text: text || full, full, url });
  };
  for (const doc of docs) {
    let url = '';
    try { url = doc.location.href; } catch { url = location.href; }
    for (const selector of LIST) {
      let lists; try { lists = doc.querySelectorAll(selector); } catch { continue; }
      for (const list of lists) {
        for (const child of Array.from(list.children)) {
          push(child, url);
          for (const inner of child.querySelectorAll('[class*="item" i], [class*="message" i]')) push(inner, url);
        }
      }
    }
    for (const selector of ITEM) {
      let nodes; try { nodes = doc.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) push(node, url);
    }
    if (out.length >= 400) break;
  }
  return out.slice(0, 400);
})()`
}
