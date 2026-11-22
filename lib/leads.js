/**
 * Rule-based target-customer detection for live-room danmaku.
 *
 * Pure functions only: no I/O, no browser, no timers, so `test/selftest.mjs`
 * can exercise the whole judgement path without a live room.
 */

/** Product/field words that make a message relevant at all. */
const TOPICS = [
  '嵌入式', '单片机', 'stm32', 'stm32f1', 'stm32f4', 'esp32', 'esp8266', 'arduino', '树莓派',
  'arm', 'cortex', 'c语言', 'c++', 'linux', '驱动', 'rtos', 'freertos', '裸机', 'bootloader',
  '电路', 'pcb', '原理图', '硬件', '开发板', '模电', '数电', 'dsp', 'fpga', 'can总线',
  '串口', 'i2c', 'spi', '物联网', 'iot', '电子工程', '自动化', 'plc', '机器人', '机械臂', '电机驱动',
]

/** Learning / buying intent words: the "wants to learn" half of the target. */
const INTENTS = [
  '想学', '想学习', '想入门', '咋学', '怎么学', '如何学', '从哪学', '在哪学', '学什么',
  '能学吗', '好学吗', '难学吗', '零基础', '入门', '自学', '转行', '报班', '培训班', '培训',
  '课程', '学费', '多少钱', '价格', '求推荐', '推荐', '求带', '求资料', '资料', '教程',
  '视频教程', '新手', '小白', '值得学吗', '就业', '前景', '薪资', '求指路', '求指导', '请教',
]

/** Question markers: weak evidence of wanting an answer rather than chatting. */
const QUESTIONS = ['?', '？', '吗', '呢', '怎么', '如何', '哪', '求', '教']

/** System / join / gift lines that never describe a customer. */
const NOISE = /来了|进来了|关注了主播|送出了|送出了\S*|为主播点赞|加入了直播间|分享了直播间|说得好|主播好/

/** Filler in a typed target audience; removing it leaves the topic words. */
const TARGET_FILLER = [
  '想学习', '想学', '想要', '感兴趣', '的人', '人群', '用户', '客户', '观众', '粉丝', '爱好者',
  '目标', '潜在', '可能', '关注', '喜欢', '需要', '想', '学习',
]

/** Lower-case and drop every kind of space so partial matches survive formatting. */
export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\u3000\u00a0]+/g, '')
}

/**
 * Turn a typed target audience into extra topic words.
 *
 * "想学嵌入式的人" → ["嵌入式"]; "想学剪辑 / 特效的人" → ["剪辑", "特效"].
 * Words still need a learning or buying intent in the message to become a lead.
 * @param {string} target
 * @returns {string[]}
 */
export function targetTerms(target) {
  let text = String(target ?? '').toLowerCase().replace(/[（(][^)）]*[)）]/g, ' ')
  for (const word of TARGET_FILLER) text = text.split(word).join(' ')
  return [...new Set(text.split(/[、,，/|;；:：\s]+/).map((part) => part.trim()).filter((part) => part.length >= 2))]
}

function hits(text, words) {
  const found = []
  for (const word of words) if (text.includes(word) && !found.includes(word)) found.push(word)
  return found
}

/**
 * Judge one danmaku message against a target audience.
 * @param {string} text - message body.
 * @param {{ minScore?: number, extraTopics?: string[] }} [options] - `extraTopics`
 *   adds the words derived from a typed target audience to the built-in topic list.
 * @returns {{ isLead: boolean, score: number, topics: string[], intents: string[], questions: string[] }}
 */
export function classify(text, options = {}) {
  const minScore = options.minScore ?? 4
  const plain = normalize(text)
  const topics = hits(plain, [...TOPICS, ...(options.extraTopics ?? [])])
  const intents = hits(plain, INTENTS)
  const questions = plain.length > 0 ? hits(plain, QUESTIONS) : []
  // A topic alone is a viewer; an intent alone may be anyone. Both, plus score, is a lead.
  const score = topics.length * 2 + intents.length * 2 + (questions.length > 0 ? 1 : 0)
  const isLead = topics.length > 0 && intents.length > 0 && score >= minScore
  return { isLead, score, topics, intents, questions }
}

/** True for join / gift / moderator chatter that carries no customer intent. */
export function isNoise(text) {
  return NOISE.test(String(text ?? ''))
}

function splitSpeaker(line) {
  const match = /^(.{1,24}?)\s*[：:]\s*([\s\S]+)$/.exec(line.trim())
  if (match === null) return { nickname: '', content: line.trim() }
  return { nickname: match[1].trim(), content: match[2].trim() }
}

/**
 * Turn raw extracted DOM rows into `{ nickname, content }` messages.
 * Rows may already carry a nickname and body; a missing pair is split from the
 * rendered line, which is how a Douyin chat item usually reads.
 */
export function parseDanmaku(rows) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    const rawUser = typeof row.user === 'string' ? row.user.trim() : ''
    const rawText = typeof row.text === 'string' ? row.text.trim() : ''
    const full = typeof row.full === 'string' ? row.full.trim() : ''
    const split = splitSpeaker(rawUser !== '' && rawText !== '' ? `${rawUser}：${rawText}` : full || rawText)
    const nickname = (rawUser !== '' ? rawUser : split.nickname).replace(/[：:]\s*$/, '').trim()
    const content = rawText !== '' ? rawText : split.content
    if (content === '' || isNoise(content)) continue
    out.push({ nickname: nickname === '' ? '匿名观众' : nickname, content, url: typeof row.url === 'string' ? row.url : '' })
  }
  return out
}

/** Merge one detected lead into the nickname-keyed table, keeping the best message. */
export function upsertLead(leads, message, verdict, at) {
  const key = message.nickname
  const previous = leads.get(key)
  const candidate = {
    nickname: key,
    content: message.content,
    score: verdict.score,
    topics: verdict.topics,
    intents: verdict.intents,
    at,
    hits: 1,
    url: message.url,
  }
  if (previous === undefined) {
    leads.set(key, candidate)
    return
  }
  candidate.hits = previous.hits + 1
  // Same customer again: newest message wins only when it scores at least as high.
  if (candidate.score < previous.score) {
    previous.hits = candidate.hits
    previous.at = at
    return
  }
  leads.set(key, candidate)
}
