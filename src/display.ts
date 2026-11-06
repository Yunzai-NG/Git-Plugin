/**
 * 模块职责：推送内容 —— 纯文字摘要与图片卡片（自包含 HTML，经 ctx.render 截图）
 * 依赖方向：model.ts；头像由 avatars.ts 的加载器提供
 * 生命周期：纯函数；`messageContent` 每批调用一次
 * 注意事项：卡片宽 600 CSS px、以 2 倍出图，手机全屏看也清楚；渲染失败才退回文字，
 *          发送失败交给可靠队列重试。卡片里的远端文本一律转义；头像以 data URI 传入，
 *          页面不访问网络。卡片设计记录见 DESIGN.md。
 */
import type { Logger, MessageContent, RenderOptions, RenderablePage, RenderedImage } from "@yunzai-ng/types"
import type { AvatarLoader } from "./avatars.js"
import { PLATFORMS, cleanBody, cleanText } from "./model.js"
import type { CommitFile, EventType, GitEvent, Platform } from "./model.js"

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

/** 卡片里的短时间：今年省略年份，不显示秒；全卡统一 UTC+8，页脚注明 */
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
function commitDetails(event: GitEvent): string {
  if (event.type !== "commit") return ""
  const description = descriptionPreview(event)
  const files = event.changes?.files.slice(0, 8) ?? []
  const remainder = fileRemainder(event)
  return `${description ? `<section class="commit-description"><p class="detail-label">详细内容</p><p class="description">${escape(description)}</p></section>` : ""}
    <section class="commit-changes"><p class="detail-label">变更详情</p><p class="change-summary">${changeSummary(event, coloredCount)}</p>
      ${files.length ? `<div class="files"><div class="file-head"><span>文件</span><span>新增</span><span>删除</span></div>${files.map(file =>
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
}

/**
 * 自包含动态卡片（图片推送用）
 *
 * 深色页头放平台、分支、仓库和数量；正文每条动态一行：作者头像（右下角为类型图标）、
 * 标题（最多两行）、类型、编号、作者、时间；Commit 另列多行正文与增删明细。
 * 四种类型各有一套颜色，扫一眼即可分辨。
 * @param row 订阅
 * @param events 本批动态
 * @param options 当前时间与头像
 * @returns 可交给 ctx.render 的页面
 */
export function cardPage(row: DisplayRow, events: readonly GitEvent[], { now = Date.now(), avatars = new Map() }: CardOptions = {}): RenderablePage {
  const [owner = "", ...rest] = row.repo.split("/")
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
      ${commitDetails(event)}
    </div></li>`
  }).join("")
  return { name: "git-digest", tailwind: false, html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(row.repo)} · Git 动态</title><style>
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
    </style></head><body><main id="container"><header>
      <div class="tags"><span class="tag platform">${escape(PLATFORMS[row.platform].name)}</span>${row.branch ? `<span class="tag mono">${svg(branchIcon)}<span>${escape(row.branch)}</span></span>` : ""}</div>
      <div class="headline"><div class="repo">${rest.length ? `<p class="owner">${escape(owner)} /</p>` : ""}<h1>${escape(rest.join("/") || owner)}</h1></div><div class="total"><b>${events.length}</b>条新动态</div></div>
      ${stats}
    </header>
    ${events.length ? `<ol>${items}</ol>` : "<section class=\"empty\"><h2>暂无新增动态</h2><p>本次没有可展示的仓库更新。</p></section>"}
    <footer><b>Git-Plugin</b><span>时间为 UTC+8 · 链接见图片下方文字</span></footer>
    </main></body></html>` }
}

/** 生成推送内容所需的插件能力，`PluginContext` 满足它 */
export interface DisplayContext {
  /** 本插件日志器 */
  readonly logger: Pick<Logger, "warn">
  /** 渲染页面为图片段 */
  render(page: RenderablePage, opts?: RenderOptions): Promise<RenderedImage>
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
      const image = await ctx.render(cardPage(row, events, { avatars: pictures }),
        { type: "png", viewport: { width: CARD_WIDTH, scale: CARD_SCALE }, timeout: 15_000 })
      return [image, events.map(event => `${labels[event.type]} ${code(event)} ${event.url}`).join("\n")]
    } catch {
      ctx.logger.warn("Git 卡片渲染失败，本批次使用文字摘要。")
    }
  }
  return textDigest(row, events)
}
