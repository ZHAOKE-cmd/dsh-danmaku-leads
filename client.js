/**
 * Client half: the left-sidebar entry and the panel it opens.
 *
 * Registers a global panel icon in `sidebar.panellist` (id `danmaku-leads`) and
 * the matching page in the keyed `main` slot, then reads the Host snapshot from
 * `/danmaku-leads/state`. No Host module imports and no DOM outside the panel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-danmaku-leads',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'danmakuLeads'
    const PANEL_ID = 'danmaku-leads'
    const STATE_URL = '/danmaku-leads/state'
    const ACTION_URL = '/danmaku-leads/action'
    const STATUS_KEY = { idle: 'statusIdle', starting: 'statusStarting', running: 'statusRunning', error: 'statusError' }
    const STATUS_COLOR = { idle: 'idle', starting: 'starting', running: 'running', error: 'error' }

    const zh = {
      panel: '弹幕获客',
      title: '直播弹幕获客',
      subtitle: '目标人群',
      targetLabel: '目标人群（可自定义）',
      targetPlaceholder: '例如：想学嵌入式的人；想学剪辑 / 特效的人',
      terms: '主题词',
      roomPlaceholder: '直播间链接（留空则借用已打开的抖音直播标签页）',
      start: '开始扫描',
      scan: '单次扫描',
      stop: '停止',
      reset: '清空',
      exportCsv: '导出 CSV',
      statusIdle: '未开始',
      statusStarting: '连接中',
      statusRunning: '扫描中',
      statusError: '出错',
      browser: '浏览器',
      daemon: '守护进程',
      session: '会话',
      room: '直播间',
      messages: '弹幕',
      polls: '轮询',
      leads: '目标客户',
      noLeads: '还没有命中目标人群的弹幕。',
      recent: '最新弹幕',
      noRecent: '还没有抓到弹幕。',
      loading: '加载中…',
      hits: '次发言',
      score: '匹配分',
    }
    const en = {
      panel: 'Danmaku leads',
      title: 'Live danmaku leads',
      subtitle: 'Target audience',
      targetLabel: 'Target audience (editable)',
      targetPlaceholder: 'e.g. 想学嵌入式的人; 想学剪辑 / 特效的人',
      terms: 'Topics',
      roomPlaceholder: 'Live-room URL (leave empty to borrow an open Douyin live tab)',
      start: 'Start',
      scan: 'Scan once',
      stop: 'Stop',
      reset: 'Clear',
      exportCsv: 'Export CSV',
      statusIdle: 'Idle',
      statusStarting: 'Connecting',
      statusRunning: 'Scanning',
      statusError: 'Error',
      browser: 'Browser',
      daemon: 'Daemon',
      session: 'Session',
      room: 'Live room',
      messages: 'Messages',
      polls: 'Polls',
      leads: 'Leads',
      noLeads: 'No danmaku has matched the target audience yet.',
      recent: 'Latest danmaku',
      noRecent: 'No danmaku captured yet.',
      loading: 'Loading…',
      hits: 'messages',
      score: 'Score',
    }

    const CSS = `
.dml-page { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0;
  padding: 24px 28px 28px; overflow-y: auto; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base); font-size: 13px; line-height: 1.5; }
.dml-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.dml-title { margin: 0; font-size: 18px; font-weight: 600; }
.dml-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); }
.dml-pill { flex: none; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 500;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dml-pill[data-status="running"] { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.dml-pill[data-status="starting"] { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dml-pill[data-status="error"] { color: var(--dsw-alias-state-error-primary); border-color: currentColor; }
.dml-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; }
.dml-controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dml-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.dml-label { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dml-input { flex: 1 1 320px; min-width: 220px; padding: 7px 10px; border-radius: 8px; font: inherit;
  color: inherit; background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1); }
.dml-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
.dml-button { padding: 7px 14px; border-radius: 8px; font: inherit; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); }
.dml-button:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dml-button:disabled { opacity: .5; cursor: default; }
.dml-button[data-variant="primary"] { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.dml-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dml-meta b { color: var(--dsw-alias-label-primary); font-weight: 500; }
.dml-error { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary);
  border-radius: 10px; padding: 10px 14px; white-space: pre-wrap; word-break: break-word; }
.dml-section-title { margin: 0 0 10px; font-size: 13px; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.dml-count { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.dml-empty { color: var(--dsw-alias-label-secondary); margin: 0; }
.dml-list { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.dml-row { display: grid; grid-template-columns: minmax(90px, 140px) minmax(0, 1fr) auto; gap: 12px;
  padding: 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); align-items: baseline; }
.dml-row:last-child { border-bottom: none; }
.dml-nick { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dml-text { overflow-wrap: anywhere; }
.dml-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.dml-tag { font-size: 11px; padding: 0 6px; border-radius: 4px; color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); }
.dml-score { flex: none; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.dml-recent { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dml-recent li { padding: 3px 0; overflow-wrap: anywhere; }
`

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function callJson(url, init) {
      const response = await fetch(url, init)
      let body = {}
      try { body = await response.json() } catch {}
      if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
      return body
    }

    function csvCell(value) {
      const text = String(value ?? '')
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }

    function downloadCsv(snapshot) {
      const rows = [['nickname', 'danmaku', 'score', 'matched', 'hits', 'time', 'room']]
      for (const lead of snapshot.leads ?? []) {
        rows.push([
          lead.nickname, lead.content, String(lead.score),
          [...(lead.topics ?? []), ...(lead.intents ?? [])].join(' '),
          String(lead.hits ?? 1), new Date(lead.at ?? Date.now()).toLocaleString(), lead.url ?? '',
        ])
      }
      const csv = `\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `danmaku-leads-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    }

    function PanelIcon({ size = 18 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 36 36', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M7 8.5h22a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-8.2l-5.3 4.4v-4.4H7a3 3 0 0 1-3-3v-10a3 3 0 0 1 3-3Z',
          stroke: 'currentColor', strokeWidth: 2.2, strokeLinejoin: 'round',
        }),
        h('circle', { cx: 18, cy: 16.5, r: 5.4, stroke: 'currentColor', strokeWidth: 2.2 }),
        h('circle', { cx: 18, cy: 16.5, r: 1.8, fill: 'currentColor' }))
    }

    /** Build the page component with the panel's own translation function bound. */
    function createPanel(t) {
      return function DanmakuPanel() {
        const [snapshot, setSnapshot] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [roomInput, setRoomInput] = React.useState('')
        const [targetInput, setTargetInput] = React.useState('')
        const [targetDirty, setTargetDirty] = React.useState(false)

        React.useEffect(() => {
          let alive = true
          const load = async () => {
            try {
              const next = await callJson(STATE_URL)
              if (!alive) return
              setSnapshot(next)
              setTargetInput((previous) => (targetDirty ? previous : (next.target ?? '')))
              setError(null)
            } catch (cause) {
              if (alive) setError(messageOf(cause))
            }
          }
          void load()
          const id = setInterval(() => { void load() }, 2000)
          return () => { alive = false; clearInterval(id) }
        }, [targetDirty])

        const run = async (verb) => {
          setBusy(true)
          setError(null)
          try {
            const next = await callJson(ACTION_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                action: verb,
                ...(targetInput.trim() !== '' ? { target: targetInput.trim() } : {}),
                ...(verb === 'start' && roomInput.trim() !== '' ? { roomUrl: roomInput.trim() } : {}),
              }),
            })
            setSnapshot(next)
          } catch (cause) {
            setError(messageOf(cause))
          } finally {
            setBusy(false)
          }
        }

        const status = snapshot?.status ?? 'idle'
        const leads = snapshot?.leads ?? []
        const recent = snapshot?.recent ?? []
        const statusText = t(STATUS_KEY[status] ?? 'statusIdle')

        return h('div', { className: 'dml-page' },
          h('style', { key: 'css' }, CSS),
          h('div', { className: 'dml-head' },
            h('div', null,
              h('h1', { className: 'dml-title' }, t('title')),
              h('p', { className: 'dml-subtitle' }, `${t('subtitle')}：${snapshot?.target ?? '—'}`)),
            h('span', { className: 'dml-pill', 'data-status': STATUS_COLOR[status] ?? 'idle' }, statusText)),
          h('div', { className: 'dml-card' },
            h('label', { className: 'dml-field' },
              h('span', { className: 'dml-label' }, t('targetLabel')),
              h('input', {
                className: 'dml-input',
                value: targetInput,
                placeholder: t('targetPlaceholder'),
                onChange: (event) => { setTargetInput(event.target.value); setTargetDirty(true) },
              })),
            h('div', { className: 'dml-controls' },
              h('input', {
                className: 'dml-input',
                value: roomInput,
                placeholder: t('roomPlaceholder'),
                onChange: (event) => { setRoomInput(event.target.value) },
              }),
              h('button', {
                className: 'dml-button', 'data-variant': 'primary',
                disabled: busy || status === 'running' || status === 'starting',
                onClick: () => { void run('start') },
              }, t('start')),
              h('button', { className: 'dml-button', disabled: busy || status !== 'running', onClick: () => { void run('scan') } }, t('scan')),
              h('button', { className: 'dml-button', disabled: busy || status === 'idle', onClick: () => { void run('stop') } }, t('stop')),
              h('button', { className: 'dml-button', disabled: busy || leads.length === 0, onClick: () => { if (snapshot) downloadCsv(snapshot) } }, t('exportCsv')),
              h('button', { className: 'dml-button', disabled: busy, onClick: () => { void run('reset') } }, t('reset'))),
            h('div', { className: 'dml-meta' },
              h('span', null, `${t('browser')} `, h('b', null, snapshot?.browserName ?? '—')),
              h('span', null, `${t('daemon')} `, h('b', null, snapshot?.daemonUrl ?? '—')),
              h('span', null, `${t('session')} `, h('b', null, snapshot?.sessionId ?? '—')),
              h('span', null, `${t('messages')} `, h('b', null, String(snapshot?.messages ?? 0))),
              h('span', null, `${t('polls')} `, h('b', null, String(snapshot?.scans ?? 0)))),
            snapshot?.roomUrl
              ? h('div', { className: 'dml-meta' }, h('span', null, `${t('room')} `, h('b', null, snapshot.roomUrl)))
              : null,
            snapshot?.targetTerms?.length
              ? h('div', { className: 'dml-meta' }, h('span', null, `${t('terms')} `, h('b', null, snapshot.targetTerms.join(' / '))))
              : null),
          error !== null ? h('div', { className: 'dml-error' }, error) : null,
          snapshot?.error ? h('div', { className: 'dml-error' }, snapshot.error) : null,
          h('div', { className: 'dml-card' },
            h('h2', { className: 'dml-section-title' }, t('leads'), h('span', { className: 'dml-count' }, String(leads.length))),
            leads.length === 0
              ? h('p', { className: 'dml-empty' }, snapshot === null ? t('loading') : t('noLeads'))
              : h('ul', { className: 'dml-list' }, leads.map((lead) => h('li', { className: 'dml-row', key: `${lead.nickname}-${lead.at}` },
                h('span', { className: 'dml-nick', title: lead.nickname }, lead.nickname),
                h('span', { className: 'dml-text' }, lead.content,
                  h('span', { className: 'dml-tags' },
                    [...(lead.topics ?? []), ...(lead.intents ?? [])].map((word) => h('span', { className: 'dml-tag', key: word }, word)),
                    h('span', { className: 'dml-tag', key: 'hits' }, `${lead.hits ?? 1} ${t('hits')}`))),
                h('span', { className: 'dml-score', title: t('score') }, String(lead.score)))))),
          h('div', { className: 'dml-card' },
            h('h2', { className: 'dml-section-title' }, t('recent'), h('span', { className: 'dml-count' }, String(recent.length))),
            recent.length === 0
              ? h('p', { className: 'dml-empty' }, t('noRecent'))
              : h('ul', { className: 'dml-list dml-recent' }, recent.map((item) => h('li', { key: `${item.nickname}-${item.at}-${item.content}` },
                `${item.nickname}：${item.content}`)))))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'danmaku-leads: dictionaries')
        const t = ctx.locale.bind(NS)
        const Panel = createPanel(t)
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          label: () => t('panel'),
          locale: NS,
        }, PanelIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel))
      },
    }
  },
})
