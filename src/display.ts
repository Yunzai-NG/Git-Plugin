/**
 * 模块职责：动态推送与订阅列表 —— 纯文字摘要和共用样式的图片卡片（自包含 HTML，经 ctx.render 截图）
 * 依赖方向：model.ts；config/service 仅引用类型，头像由 avatars.ts 的加载器提供
 * 生命周期：页面生成是纯函数；动态按批调用，订阅列表按页顺序渲染
 * 注意事项：卡片宽 600 CSS px、以 2 倍出图，手机全屏看也清楚；渲染失败才退回文字，
 *          发送失败交给可靠队列重试。卡片里的远端文本一律转义；头像以 data URI 传入，
 *          页面不访问网络。卡片设计记录见 DESIGN.md。
 */
import type { Logger, MessageContent, RenderOptions, RenderablePage, RenderedImage } from "@yunzai-ng/types"
import type { AvatarLoader } from "./avatars.js"
import type { GitConfig } from "./config.js"
import { PLATFORMS, cleanBody, cleanText, eventTypes } from "./model.js"
import type { CommitFile, EventType, GitEvent, Platform } from "./model.js"
import type { StatusEntry } from "./service.js"

const labels: Readonly<Record<EventType, string>> = { commit: "新 Commit", issue: "新 Issue", pr: "新 PR", release: "新 Release" }
const date = (time: number) => time ? new Date(time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "时间未提供"
const code = (event: GitEvent) => event.type === "commit" ? event.id.slice(0, 8) : event.type === "release" ? "" : `#${event.id}`
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, character =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character)

/** 卡片与摘要用到的订阅字段 */
export interface DisplayRow {
  /** 平台 */
  readonly platform: Platform
  /** owner/repo */
  readonly repo: string
  /** Commit 分支，空串为默认分支 */
  readonly branch: string
  /** 推送样式 */
  readonly format: "default" | "text" | "image"
}

const heading = (row: DisplayRow) => `${PLATFORMS[row.platform].name} · ${row.repo}${row.branch ? ` · ${row.branch}` : ""}`
const count = (value: number | undefined, sign: "+" | "−") => value === undefined ? "—" : `${sign}${value}`
/** 卡片的增删数字按语义着色；未知数值保持中性色，符号仍保留 */
const coloredCount: typeof count = (value, sign) => value === undefined ? "—" :
  `<span class="${sign === "+" ? "additions" : "deletions"}">${escape(count(value, sign))}</span>`
const filename = (file: CommitFile) => file.previousFilename ? `${file.previousFilename} → ${file.filename}` : file.filename

/** 正文只展示摘要；保留分行，避免单个提交把整批图片撑得过长 */
function descriptionPreview(event: GitEvent): string {
  return cleanBody(event.description, 1200).split("\n").slice(0, 8).join("\n")
}

/** 总增删统计使用平台的提交级数据，不从截断的文件列表估算 */
function changeSummary(event: GitEvent, formatCount = count): string {
  const changes = event.changes
  if (!changes) return "增删详情暂不可用"
  return [changes.fileCount === undefined ? "文件总数未提供" : `${changes.fileCount} 个文件`,
    `新增 ${formatCount(changes.additions, "+")} 行`, `删除 ${formatCount(changes.deletions, "−")} 行`].join(" · ")
}

/** 文件明细的截断提示：不把当前页长度假装成完整文件总数 */
function fileRemainder(event: GitEvent): string {
  const changes = event.changes
  if (!changes?.filesTruncated) return ""
  const left = changes.fileCount === undefined ? undefined : Math.max(0, changes.fileCount - Math.min(changes.files.length, 8))
  return left === undefined ? "仅展示部分文件，完整明细见提交链接。" : `另有 ${left} 个文件，完整明细见提交链接。`
}

/**
 * 生成纯文字摘要，动态标题不按 Markdown 或消息段解析
 * @param row 订阅
 * @param events 本批动态
 * @returns 文字摘要
 */
export function textDigest(row: DisplayRow, events: readonly GitEvent[]): string {
  return [`Git 动态 | ${heading(row)}`, ...events.map(event => {
    const details = event.type === "commit" ? [event.description ? `详细内容：\n${descriptionPreview(event)}` : "", `变更详情：${changeSummary(event)}`,
      ...(event.changes?.files.slice(0, 8).map(file => `${cleanText(filename(file), 500)}  ${count(file.additions, "+")} / ${count(file.deletions, "−")}`) ?? []),
      fileRemainder(event)].filter(Boolean).join("\n") : ""
    return `${labels[event.type]} ${code(event)} · ${cleanText(event.title, 120)}\n${event.author} · ${date(event.time)}${details ? `\n\n${details}` : ""}\n${event.url}`
  })].join("\n\n")
}

/** 卡片宽度（CSS 像素）与出图倍率：600 × 2 = 1200px 宽 */
const CARD_WIDTH = 600
const CARD_SCALE = 2
const CARD_RENDER_OPTIONS: RenderOptions = { type: "png", viewport: { width: CARD_WIDTH, scale: CARD_SCALE }, timeout: 15_000 }
const LIST_PAGE_SIZE = 5

/** 事件类型的短名、浅底配色、深色页头上的圆点色与 24×24 线框图标 */
interface Kind {
  name: string
  fg: string
  bg: string
  dot: string
  icon: string
}
const kinds: Readonly<Record<EventType, Kind>> = {
  commit: { name: "Commit", fg: "#1f5fc9", bg: "#e8f0fd", dot: "#6ea8ff", icon: "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M2.5 12h5.5m8 0h5.5\"/>" },
  issue: { name: "Issue", fg: "#16774c", bg: "#e2f4ea", dot: "#4cc38a", icon: "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><circle cx=\"12\" cy=\"12\" r=\"2\" fill=\"currentColor\" stroke=\"none\"/>" },
  pr: { name: "PR", fg: "#6b3fcf", bg: "#efe9fc", dot: "#a98bf5", icon: "<circle cx=\"6\" cy=\"5\" r=\"2\"/><circle cx=\"6\" cy=\"19\" r=\"2\"/><circle cx=\"18\" cy=\"19\" r=\"2\"/><path d=\"M6 7v10m12 0v-6a6 6 0 0 0-6-6m0 0 3-3m-3 3 3 3\"/>" },
  release: { name: "Release", fg: "#a3530a", bg: "#fdefd9", dot: "#f0a640", icon: "<path d=\"M3 3h8l10 10-8 8L3 11Z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\"1.5\" fill=\"currentColor\" stroke=\"none\"/>" }
}
const branchIcon = "<circle cx=\"6\" cy=\"5\" r=\"2\"/><circle cx=\"6\" cy=\"19\" r=\"2\"/><circle cx=\"18\" cy=\"6\" r=\"2\"/><path d=\"M6 7v10m12-9c0 6-12 3-12 9\"/>"
const svg = (paths: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`

const zoned = (time: number) => Object.fromEntries(new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(time)).map(part => [part.type, part.value]))

/** 卡片里的短时间：今年省略年份，不显示秒；全卡统一 UTC+8 */
function shortDate(time: number, now: number): string {
  if (!Number.isFinite(time) || time <= 0) return "时间未知"
  const at = zoned(time)
  return `${at.year === zoned(now).year ? "" : `${at.year}-`}${at.month}-${at.day} ${at.hour}:${at.minute}`
}

/** 没有头像时的首字母底色，与白字对比度均不低于 4.5:1；按作者名固定取色 */
const faceColors = ["#3b5bdb", "#0b7285", "#862e9c", "#c2410c", "#2b7a3b", "#a61e4d", "#1864ab", "#5f3dc4"]
function face(author: string, picture: string | undefined): string {
  if (picture) return `<img class="face" src="${escape(picture)}" alt="">`
  const chars = [...(author || "?")]
  const color = faceColors[chars.reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 7) % faceColors.length]
  return `<span class="face initial" style="background:${color}">${escape((chars[0] ?? "?").toUpperCase())}</span>`
}

/** Commit 标题之外的正文、提交级增删汇总及文件明细；全部只作为纯文本 */
function commitDetails(event: GitEvent, showFiles: boolean): string {
  if (event.type !== "commit") return ""
  const description = descriptionPreview(event)
  const files = event.changes?.files.slice(0, 8) ?? []
  const remainder = !showFiles && files.length ? "文件明细已收起，完整明细见提交链接。" : fileRemainder(event)
  return `${description ? `<section class="commit-description"><p class="detail-label">详细内容</p><p class="description">${escape(description)}</p></section>` : ""}
    <section class="commit-changes"><p class="detail-label">变更详情</p><p class="change-summary">${changeSummary(event, coloredCount)}</p>
      ${showFiles && files.length ? `<div class="files"><div class="file-head"><span>文件</span><span>新增</span><span>删除</span></div>${files.map(file =>
        `<div class="file-row"><span class="file-name mono">${escape(cleanText(filename(file), 500))}</span><span class="file-count mono">${coloredCount(file.additions, "+")}</span><span class="file-count mono">${coloredCount(file.deletions, "−")}</span></div>`).join("")}</div>` : ""}
      ${remainder ? `<p class="detail-note">${escape(remainder)}</p>` : ""}
    </section>`
}

/** 卡片选项 */
export interface CardOptions {
  /** 当前时间，决定日期是否带年份 */
  now?: number
  /** 头像地址 → data URI；缺失的显示首字母 */
  avatars?: ReadonlyMap<string, string>
  /** 运行中的插件版本；未提供时显示未知 */
  pluginVersion?: string
  /** 运行中的 Yunzai NG 内核版本；未提供时显示未知 */
  frameworkVersion?: string
}

/**
 * 自包含动态卡片（图片推送用）
 *
 * 深色页头放平台、分支、仓库和数量；正文每条动态一行：作者头像（右下角为类型图标）、
 * 标题（最多两行）、类型、编号、作者、时间；Commit 另列多行正文与增删明细。
 * 四种类型各有一套颜色，扫一眼即可分辨。
 * @param row 订阅
 * @param events 本批动态
 * @param options 当前时间、头像与运行版本
 * @returns 可交给 ctx.render 的页面
 */
export function cardPage(row: DisplayRow, events: readonly GitEvent[], {
  now = Date.now(), avatars = new Map(), pluginVersion = "未知", frameworkVersion = "未知"
}: CardOptions = {}): RenderablePage {
  const [owner = "", ...rest] = row.repo.split("/")
  // 只按本张图的 Commit 数量判断；混入其他类型不影响两条以内的文件展示。
  const showFiles = events.filter(event => event.type === "commit").length <= 2
  const types = (Object.keys(kinds) as EventType[]).filter(type => events.some(event => event.type === type))
  // 只有一种类型时右上角的总数已经够用，不再重复一行统计。
  const stats = types.length > 1 ? `<div class="stats">${types.map(type => `<span class="stat"><i style="background:${kinds[type].dot}"></i><b>${
    events.filter(event => event.type === type).length}</b>${kinds[type].name}</span>`).join("")}</div>` : ""
  // GitCode 的 Commit 不带头像：同一批里该作者若有带头像的 Issue/PR，就借用那张。
  const byAuthor = new Map(events.filter(event => event.avatar && avatars.has(event.avatar))
    .map(event => [event.author, avatars.get(event.avatar ?? "")]))
  const items = events.map(event => {
    const kind = kinds[event.type] ?? kinds.commit
    const id = event.type === "release" ? "" : code(event)
    const picture = (event.avatar && avatars.get(event.avatar)) || byAuthor.get(event.author)
    return `<li class="item" style="--fg:${kind.fg};--bg:${kind.bg}"><span class="avatar">${face(event.author, picture)}<span class="kind">${svg(kind.icon)}</span></span><div class="body">
      <h2 class="title">${escape(cleanText(event.title, 160))}</h2>
      <div class="meta"><span class="badge">${kind.name}</span>${id ? `<span class="id mono">${escape(id)}</span>` : ""}<span class="author">${escape(event.author)}</span><span class="time">${escape(shortDate(event.time, now))}</span></div>
      ${commitDetails(event, showFiles)}
    </div></li>`
  }).join("")
  return cardShell("git-digest", `${row.repo} · Git 动态`, `
      <div class="tags"><span class="tag platform">${escape(PLATFORMS[row.platform].name)}</span>${row.branch ? `<span class="tag mono">${svg(branchIcon)}<span>${escape(row.branch)}</span></span>` : ""}</div>
      <div class="headline"><div class="repo">${rest.length ? `<p class="owner">${escape(owner)} /</p>` : ""}<h1>${escape(rest.join("/") || owner)}</h1></div><div class="total"><b>${events.length}</b>条新动态</div></div>
      ${stats}`, events.length ? `<ol>${items}</ol>` : '<section class="empty"><h2>暂无新增动态</h2><p>本次没有可展示的仓库更新。</p></section>',
    { pluginVersion, frameworkVersion })
}

/** 动态和订阅列表共用页面外壳、样式及版本底栏，避免两套设计逐渐漂移 */
function cardShell(name: string, title: string, header: string, content: string, {
  pluginVersion = "未知", frameworkVersion = "未知"
}: CardOptions): RenderablePage {
  return { name, tailwind: false, html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(title)}</title><style>
    *{box-sizing:border-box}
    body{margin:0;background:#fff;color:#1b2433;font-family:"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased}
    h1,h2,p,ol{margin:0;padding:0}ol{list-style:none}
    .mono{font-family:"JetBrains Mono",Consolas,"Liberation Mono",Menlo,monospace}
    #container{width:${CARD_WIDTH}px;background:#fff;overflow:hidden}
    header{position:relative;padding:24px 28px 22px;background:#141d2e;color:#fff}
    header::after{content:"";position:absolute;left:0;right:0;bottom:0;height:3px;background:linear-gradient(90deg,#6ea8ff 0 25%,#4cc38a 25% 50%,#a98bf5 50% 75%,#f0a640 75%)}
    .tags{display:flex;align-items:center;gap:8px;margin-bottom:16px}
    .tag{display:inline-flex;align-items:center;gap:6px;min-width:0;height:26px;padding:0 10px;border-radius:13px;background:rgba(255,255,255,.1);font-size:13px;color:rgba(255,255,255,.82)}
    .tag.platform{flex:none;font-weight:600;color:#fff}.tag svg{width:14px;height:14px;flex:none}
    .tag span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .headline{display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.repo{min-width:0}
    .owner{font-size:15px;color:rgba(255,255,255,.62);overflow-wrap:anywhere}
    h1{font-size:28px;line-height:1.2;font-weight:700;overflow-wrap:anywhere}
    .total{flex:none;text-align:right;font-size:13px;line-height:1.2;color:rgba(255,255,255,.62)}
    .total b{display:block;margin-bottom:4px;font-size:36px;line-height:1;font-weight:700;color:#fff;font-variant-numeric:tabular-nums}
    .stats{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:16px;padding-top:14px;border-top:1px solid rgba(255,255,255,.12);font-size:13px;color:rgba(255,255,255,.72)}
    .stat{display:inline-flex;align-items:center;gap:6px}.stat i{width:8px;height:8px;border-radius:50%}
    .stat b{color:#fff;font-weight:600;font-variant-numeric:tabular-nums}
    ol{padding-top:6px}
    .item{display:flex;gap:14px;padding:0 28px}
    .avatar{position:relative;flex:none;width:40px;height:40px;margin-top:16px}
    .face{display:block;width:40px;height:40px;border-radius:50%;object-fit:cover;background:#eef1f5;box-shadow:0 0 0 1px rgba(27,36,51,.08)}
    .initial{display:grid;place-items:center;color:#fff;font-size:17px;font-weight:600;line-height:1}
    .kind{position:absolute;right:-4px;bottom:-4px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--fg);color:#fff;box-shadow:0 0 0 2px #fff}
    .kind svg{width:12px;height:12px;stroke-width:2.4}
    .body{flex:1;min-width:0;padding:16px 0}.item+.item .body{border-top:1px solid #edf0f4}
    .title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-size:18px;line-height:1.45;font-weight:600}
    .meta{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:14px;color:#647186;white-space:nowrap}
    .badge{flex:none;padding:0 8px;border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;line-height:22px;font-weight:600}
    .id{flex:none;font-size:13px;color:#4a5568}.author{min-width:0;overflow:hidden;text-overflow:ellipsis}
    .time{flex:none;margin-left:auto;font-variant-numeric:tabular-nums}
    .commit-description,.commit-changes{margin-top:14px}
    .detail-label{margin-bottom:5px;font-size:12px;font-weight:600;color:#647186}
    .description{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:8;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.65;color:#3d4757}
    .change-summary{font-size:13px;color:#3d4757;font-variant-numeric:tabular-nums}
    .additions{color:#1a7f37}.deletions{color:#991b1b}
    .files{margin-top:8px;padding:6px 10px;background:#f6f8fa;border:1px solid #edf0f4;border-radius:8px}
    .file-head,.file-row{display:grid;grid-template-columns:minmax(0,1fr) 62px 62px;gap:8px;align-items:start;padding:5px 0}
    .file-head{font-size:11px;color:#647186}.file-head span:not(:first-child){text-align:right}
    .file-row+.file-row{border-top:1px solid #edf0f4}
    .file-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;font-size:12px;line-height:1.5;color:#3d4757}
    .file-count{text-align:right;font-size:12px;line-height:1.5;color:#1b2433;font-variant-numeric:tabular-nums}
    .detail-note{margin-top:6px;font-size:12px;color:#647186}
    .empty{padding:40px 28px;text-align:center;font-size:14px;color:#647186}.empty h2{margin-bottom:4px;font-size:18px;color:#1b2433}
    footer{display:flex;justify-content:space-between;gap:16px;padding:12px 28px;background:#f6f8fa;border-top:1px solid #edf0f4;font-size:12px;color:#647186}
    footer b{font-weight:600;color:#3d4757}
    .list-index{flex:none;display:grid;place-items:center;width:40px;height:40px;margin-top:16px;border-radius:10px;background:#e8f0fd;color:#1f5fc9;font-size:16px;font-weight:600}
    .list-heading{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:12px;color:#647186}
    .list-platform{font-weight:600;color:#3d4757}.list-state{margin-left:auto;padding:1px 7px;border:1px solid #edf0f4;border-radius:6px}
    .list-branch,.list-id{margin-top:5px;font-size:13px;color:#4a5568;overflow-wrap:anywhere}
    .list-branch{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
    .list-events{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px}.list-format{font-size:12px;color:#647186}
    .list-info{margin-top:10px;padding:9px 11px;background:#f6f8fa;border:1px solid #edf0f4;border-radius:8px;font-size:12px;color:#647186;overflow-wrap:anywhere}
    .list-target{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-bottom:4px}
    .list-check{display:flex;justify-content:space-between;flex-wrap:wrap;gap:4px 10px;font-variant-numeric:tabular-nums}
    .list-error{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin-top:7px;color:#3d4757}
    </style></head><body><main id="container"><header>${header}</header>
    ${content}
    <footer><b>Git-Plugin v${escape(pluginVersion)}</b><span>Yunzai NG v${escape(frameworkVersion)}</span></footer>
    </main></body></html>` }
}

/** 生成推送内容所需的插件能力，`PluginContext` 满足它 */
export interface DisplayContext {
  /** 运行中的插件版本 */
  readonly version: string
  /** 内核只读视图，仅使用运行版本 */
  readonly app: { readonly version: string }
  /** 本插件日志器 */
  readonly logger: Pick<Logger, "warn">
  /** 渲染页面为图片段 */
  render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>
}

/** 订阅列表卡片选项；分页由完整的权限过滤结果计算 */
export interface ListCardOptions extends CardOptions {
  /** 展示范围，例如当前会话或全部会话 */
  scope?: string
  /** 页码，从 1 开始，每页最多 5 个订阅 */
  page?: number
}

/** 一条订阅的状态文字，图片和文字回退使用同一语义 */
const subscriptionState = (item: StatusEntry) =>
  `${item.row.enabled ? item.initialized ? "已初始化" : "待初始化" : "已停用"}${item.scanning ? " / 续查中" : ""}`

/** 一条订阅的文字明细，只选择展示字段，不输出凭据或原始配置 */
function subscriptionText(item: StatusEntry, config: GitConfig): string {
  return `${item.id} | ${subscriptionState(item)}\n` +
    `${PLATFORMS[item.row.platform].name} ${cleanText(item.row.repo)}${item.row.branch ? ` [${cleanText(item.row.branch)}]` : ""}\n` +
    `${eventTypes(item.row, config).join(",")} · 待发 ${item.pending} · ${item.row.scene}:${cleanText(item.row.targetId)}\n` +
    `账号：${cleanText(item.row.accountId)}\n` +
    `最近检查：${item.lastCheck ? date(item.lastCheck) : "尚未检查"}${item.error ? `\n${cleanText(item.error)}` : ""}`
}

/**
 * 生成订阅列表的一页，共用动态卡片的页面外壳、配色、字体和版本底栏
 * @param entries 已按命令权限过滤的完整订阅列表
 * @param config 当前配置，仅选择展示字段
 * @param options 范围、页码、时间和运行版本
 * @returns 自包含页面，不访问网络
 */
export function subscriptionListPage(entries: readonly StatusEntry[], config: GitConfig, options: ListCardOptions = {}): RenderablePage {
  const { now = Date.now(), scope = "当前会话" } = options
  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE))
  const page = Math.min(pages, Math.max(1, Math.trunc(options.page ?? 1)))
  const offset = (page - 1) * LIST_PAGE_SIZE
  const items = entries.slice(offset, offset + LIST_PAGE_SIZE).map((item, index) => {
    const { row } = item
    const format = (row.format === "default" ? config.defaultFormat : row.format) === "image" ? "图片推送" : "文字推送"
    return `<li class="item"><span class="list-index mono">${offset + index + 1}</span><div class="body">
      <div class="list-heading"><span class="list-platform">${escape(PLATFORMS[row.platform].name)}</span><span class="list-state">${escape(subscriptionState(item))}</span></div>
      <h2 class="title">${escape(cleanText(row.repo))}</h2>
      <p class="list-branch">分支 · ${escape(cleanText(row.branch) || "默认分支")}</p>
      <div class="list-events">${eventTypes(row, config).map(type => `<span class="badge" style="--fg:${kinds[type].fg};--bg:${kinds[type].bg}">${kinds[type].name}</span>`).join("")}<span class="list-format">${format}</span></div>
      <p class="list-id">编号 <span class="mono">${escape(item.id)}</span></p>
      <div class="list-info"><p class="list-target">${row.scene === "group" ? "群聊" : "私聊"} ${escape(cleanText(row.targetId))} · 账号 ${escape(cleanText(row.accountId))}</p>
        <div class="list-check"><span>最近检查 · ${item.lastCheck ? escape(shortDate(item.lastCheck, now)) : "尚未检查"}</span><span>待发 ${item.pending}</span></div>
        ${item.error ? `<p class="list-error">最近错误 · ${escape(cleanText(item.error))}</p>` : ""}
      </div>
    </div></li>`
  }).join("")
  return cardShell("git-subscriptions", "Git 推送订阅", `
    <div class="tags"><span class="tag platform">Git-Plugin</span><span class="tag"><span>${escape(cleanText(scope))}</span></span>${pages > 1 ? `<span class="tag">第 ${page} / ${pages} 页</span>` : ""}</div>
    <div class="headline"><div class="repo"><p class="owner">仓库动态订阅</p><h1>推送订阅</h1></div><div class="total"><b>${entries.length}</b>个订阅</div></div>
    <div class="stats"><span>推送${config.enabled ? "开启" : "已暂停"}</span><span>每 ${config.intervalSeconds} 秒检查</span></div>`,
    entries.length ? `<ol>${items}</ol>` : '<section class="empty"><h2>尚无订阅</h2><p>使用 #git订阅 或在面板配置推送。</p></section>', options)
}

/**
 * 顺序生成订阅列表图片及可复制编号，每页最多 5 项；渲染失败后剩余页直接回退文字
 * @param ctx 插件渲染能力和运行版本
 * @param entries 已按权限过滤的订阅，不能传入未过滤的全局列表
 * @param config 当前配置
 * @param scope 展示范围
 * @returns 逐页回复内容，发送失败由命令层处理，不触发渲染回退
 */
export async function* subscriptionListMessages(ctx: DisplayContext, entries: readonly StatusEntry[], config: GitConfig,
  scope = "当前会话"): AsyncGenerator<MessageContent> {
  const pages = Math.max(1, Math.ceil(entries.length / LIST_PAGE_SIZE))
  const now = Date.now()
  let renderFailed = false
  for (let page = 1; page <= pages; page++) {
    const rows = entries.slice((page - 1) * LIST_PAGE_SIZE, page * LIST_PAGE_SIZE)
    let image: RenderedImage | undefined
    if (!renderFailed) {
      try {
        image = await ctx.render(subscriptionListPage(entries, config, {
          scope, page, now, pluginVersion: ctx.version, frameworkVersion: ctx.app.version
        }), CARD_RENDER_OPTIONS)
      } catch {
        renderFailed = true
        ctx.logger.warn("Git 订阅列表渲染失败，剩余页面使用文字列表。")
      }
    }
    yield image ? [image, rows.length ? `可复制订阅编号：\n${rows.map(item => `${cleanText(item.row.repo)}：${item.id}`).join("\n")}` : "尚无订阅，使用 #git订阅 或在面板配置推送。"] :
      [`Git 订阅列表 | ${cleanText(scope)} · 第 ${page} / ${pages} 页`, `推送${config.enabled ? "开启" : "已暂停"} · 间隔 ${config.intervalSeconds} 秒`,
        ...(rows.length ? rows.map(item => subscriptionText(item, config)) : ["尚无订阅，使用 #git订阅 或在面板配置推送。"])].join("\n\n")
  }
}

/** 推送样式的取值：订阅自己的样式或基础设置里的默认样式 */
export interface FormatConfig {
  /** 默认推送样式 */
  readonly defaultFormat: "text" | "image"
}

/**
 * 生成一批动态的推送内容；图片只在渲染阶段失败时回退为文字
 * @param ctx 插件上下文
 * @param row 订阅
 * @param config 当前配置
 * @param events 本批动态
 * @param avatars 可选的头像加载器；取不到头像不影响出图
 * @returns 图片加链接文字，或纯文字摘要
 */
export async function messageContent(ctx: DisplayContext, row: DisplayRow, config: FormatConfig,
  events: readonly GitEvent[], avatars?: AvatarLoader): Promise<MessageContent> {
  const format = row.format === "default" ? config.defaultFormat : row.format
  if (format === "image") {
    const pictures = avatars ? await avatars.load(events).catch(() => new Map<string, string>()) : new Map<string, string>()
    try {
      const image = await ctx.render(cardPage(row, events, {
        avatars: pictures, pluginVersion: ctx.version, frameworkVersion: ctx.app.version
      }),
        CARD_RENDER_OPTIONS)
      return [image, events.map(event => `${labels[event.type]} ${code(event)} ${event.url}`).join("\n")]
    } catch {
      ctx.logger.warn("Git 卡片渲染失败，本批次使用文字摘要。")
    }
  }
  return textDigest(row, events)
}
