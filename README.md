# 直播弹幕获客（dsh-danmaku-leads）

DeepSeek Harness（DSH）插件：通过 **BrowserSkill** 读取抖音直播间的弹幕，按目标人群筛出潜在客户。
左侧栏有独立入口和扫描面板，智能体也能用 `danmaku_leads` 工具完成同样的事。

- 目标人群可配置，默认测试人群：**想学习嵌入式的人**（`target: 想学习嵌入式的人`）
- BrowserSkill 浏览器实例名：**测试抖音链接**
- BrowserSkill 守护进程：**ws://127.0.0.1:52800**

## 目录

```
dsh-danmaku-leads/
├─ index.js            Host 半：驱动 bsk、扫描循环、HTTP 面板接口、danmaku_leads 工具
├─ client.js           Client 半：左侧栏入口 + 主区面板
├─ lib/bsk.js          bsk CLI 封装（命令、JSON 信封、超时、守护进程探测）
├─ lib/leads.js        弹幕解析 + 目标客户判定（纯函数）
├─ locale/             插件列表里的标题/描述（zh、en）
├─ icon.svg            插件图标
├─ test/selftest.mjs   无浏览器自检
└─ dist/               打包产物（安装/分发用）
```

## 前置条件

插件本身不启动浏览器，它调用本机的 BrowserSkill：

1. 安装 `bsk` CLI（官方脚本装到 `C:\Users\<你>\.local\bin\bsk.exe`；插件会自己找到它，不必改 PATH、也不用重启 DSH）：

   ```powershell
   irm https://raw.githubusercontent.com/Tencent/BrowserSkill/main/install.ps1 | iex
   & "$env:USERPROFILE\.local\bin\bsk.exe" --version
   ```

2. 在 Chrome / Edge 安装 **BrowserSkill** 扩展，并在扩展里把该浏览器实例命名为 **测试抖音链接**。
   脚本读取需要扩展协议 **1.9**；扩展 0.4.2（协议 1.8）会提示更新。
3. 守护进程走 `127.0.0.1:52800`（对应 `daemonUrl`），首次执行 `bsk` 命令时会自动启动；扩展显示 **Connected**。
   若宿主进程不允许 daemon 脱离（报 `os error 5` / breakaway），在独立终端执行 `bsk daemon start --foreground` 常驻。
4. 在该浏览器里**打开目标抖音直播间**。留空 `roomUrl` 时插件借用这个已打开的标签页——无人值守时请先在扩展
   Automation settings 关闭「Confirm before borrowing tabs」；或直接填 `roomUrl`，插件会新开标签页导航过去（无需确认）。

## 安装

用 DSH 的插件管理装本地目录（推荐，目录更新后即时生效）：

```
plugin_manager → action: install_bundle → target: E:\code\PycharmProjects\guo_proj\dsh-danmaku-leads
```

或在 Web UI 的 **Plugins → Add plugin** 里选择这个目录。
安装后左侧栏出现「弹幕获客」入口；`danmaku_leads` 工具对本 profile 的会话生效。

打包产物 `dist/dsh-danmaku-leads-1.0.1.tgz` 用于分发给别人：对方解压/`npm i` 该 tgz 后按上面的方式安装目录。

## 配置

安装后的行 id 是 `danmaku-leads`，在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 覆盖：

```yaml
- id: danmaku-leads
  config:
    bskPath: bsk                    # 默认自动查找 ~/.local/bin/bsk.exe；自定义安装位置时填绝对路径
    browserName: 测试抖音链接        # BrowserSkill 里的浏览器实例名
    daemonUrl: "ws://127.0.0.1:52800"  # 仅用于说明/排障，端口由 bsk 自己管理
    target: 想学习嵌入式的人
    roomUrl: ""                     # 空 = 借用已打开的抖音直播标签页
    minScore: 4                     # 命中阈值，见下
    pollMs: 4000                    # 轮询间隔
    timeoutMs: 120000               # 单条 bsk 命令超时
    noFocus: true                   # Agent 窗口不抢焦点
    selectors:                      # 弹幕节点选择器，抖音改版时在此覆盖
      - '[data-e2e="chat-message"]'
      - '[class*="webcast-chatroom" i] [class*="item" i]'
```

这是一次性替换整个 `config` 对象，需要的键要一起写上。

## 使用

### 左侧栏面板

1. 点左侧栏「弹幕获客」。
2. **目标人群**：面板顶部输入框可直接改（默认「想学习嵌入式的人」），改完点开始/单次扫描即时生效。
3. （可选）粘贴直播间链接。
4. **开始扫描**：连接 daemon → 打开/借用直播标签页 → 每 `pollMs` 读取一次页面上的弹幕。
5. 面板显示：状态、浏览器、会话、累计弹幕数、轮询次数、当前主题词、目标客户表（昵称 / 弹幕 / 命中词 / 匹配分）和最新弹幕。
6. **单次扫描**：抓一次就结束；**停止**：结束会话；**导出 CSV**：把当前客户表导出（UTF-8 BOM，Excel 可直接打开）。

### 智能体工具

```
danmaku_leads({ action: "start", target: "想学剪辑的人" })
danmaku_leads({ action: "status" })
danmaku_leads({ action: "scan", roomUrl: "https://live.douyin.com/123456" })
danmaku_leads({ action: "stop" })
danmaku_leads({ action: "reset" })
```

`target` 与面板输入框是同一份运行期状态；`status` / `scan` 返回的快照与面板读的是同一份数据。

## 目标客户怎么判定

`lib/leads.js` 里两套词表做规则打分（不用大模型，稳定、可解释、离线可测）：

- **主题词**：嵌入式、单片机、STM32、ESP32、C 语言、Linux、驱动、电路、开发板、物联网、机器人……
- **意向词**：想学、怎么学、零基础、入门、自学、转行、报班、课程、学费、多少钱、求推荐、就业……

```
score = 主题词命中数 × 2 + 意向词命中数 × 2 + 疑问标记(？/怎么/哪…) × 1
是目标客户 ⇔ 至少 1 个主题词 且 至少 1 个意向词 且 score ≥ minScore(默认 4)
```

所以「想学嵌入式，零基础能学吗？」「STM32 单片机怎么入门」「这个开发板多少钱」会命中；
「嵌入式」（只有主题词）、「主播好帅」「666」不会。进场/礼物/系统提示类弹幕直接丢弃。
同一昵称只保留匹配分最高的一条，并累计发言次数。

**自定义人群**：输入框里的话会被拆成主题词并追加到内置词表——去掉「想学/想学习/的人/人群/用户」这类填充词后剩下的词
（如「想学剪辑 / 特效的人」→ `剪辑`、`特效`）参与打分，消息仍然要同时带一个意向词才算客户。
所以换成别的赛道不用改代码；要改判定宽严就调 `minScore`，要内置某赛道的一批同义词就改 `lib/leads.js` 的 `TOPICS`。

## 自检

```powershell
node test/selftest.mjs
```

覆盖：目标人群判定正反例、弹幕解析/昵称归一/去重、bsk JSON 信封与退出码处理、CLI 路径解析、页面脚本语法。

## 已知限制

- **真实观众弹幕尚未抓到**：验证时连上的是 `live.douyin.com/83988997007`，页面处于「直播加载中」、弹幕列表为空。
  链路本身已在真实浏览器里跑通（sync → 读页面 → 解析 → 判定 → 面板显示），用的是临时注入的 3 条测试弹幕，
  测完已删除并清空数据。等有真实弹幕的直播间再扫一次即可。
- **扩展协议要 1.9**：扩展 0.4.2 是协议 1.8，`evaluate --unverified` 会被拒绝；插件会退回「sync + 严格观察」，
  弹幕高频刷新时这一路可能偶尔被拒（面板会显示原因）。在扩展商店更新到 1.9+ 后最稳。
- 抖音直播间是动态且会改版的：弹幕靠 `.webcast-chatroom___list` 子节点 + `selectors` 定位，改版后可能抓不到——
  用开发者工具找到新的弹幕容器选择器写进配置即可。
- 只读取**当前页面已渲染**的可见弹幕：不滚动历史、不调接口、不破解登录态。
- 规则筛选是粗筛，导出前请人工复核；不要采集或外传账号、手机号等敏感信息。
- 借用标签页/人工接管由 BrowserSkill 扩展的自动化设置决定，插件不会绕过；无人值守时请关掉借用确认或用 `roomUrl`。

## 版本

1.0.2 · MIT
