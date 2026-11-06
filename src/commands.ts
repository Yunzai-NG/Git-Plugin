/**
 * 模块职责：聊天命令 —— #git帮助 / 订阅 / 列表 / 取消 / 检查 / 样式 / 状态
 * 依赖方向：model.ts 与 service.ts 的公开接口
 * 生命周期：setup 时注册一次，随插件卸载由内核回收
 * 注意事项：主人管理全部；群主和群管理员仅管理本群；私聊管理仅主人可用。
 *          群管理员不能在聊天中指定 Token 或命名凭据，只能用主人已授予本会话的凭据。
 */
import type { MessageEvent, PluginContext } from "@yunzai-ng/types"
import type { GitConfigInput, Subscription, SubscriptionInput } from "./config.js"
import { EVENTS, PLATFORMS, GitError, eventTypes, parseRepo, safeError, targetKey } from "./model.js"
import type { EventType } from "./model.js"
import type { GitService } from "./service.js"

const HELP = `Git-Plugin · GitHub / Gitee / GitCode
#git订阅 github:owner/repo 分支=main 事件=commit,issue,pr,release 样式=文字
也可使用完整 HTTPS 仓库首页地址；可选参数均可省略。
#git列表 / #git取消 <编号> / #git检查 [编号]
#git样式 <编号> <文字或图片>
主人：#git状态 / #git列表 全部 / #git检查 全部
群主、群管仅管理本群，私聊仅主人可管理。
首次成功检查建立基线，不发送历史；Token 与私有仓库授权请到面板 → 插件 → git-plugin → 配置。`

const PATTERN = /^#git(订阅|列表|取消|检查|样式|状态)(?:\s+(.*))?$/i
const isEventType = (value: string): value is EventType => (EVENTS as readonly string[]).includes(value)

/** 命令需要的插件能力，`PluginContext` 满足它 */
export type CommandContext = Pick<PluginContext<GitConfigInput>, "command" | "config" | "app">

/**
 * 注册具有固定前缀的命令，避免与普通消息匹配
 * @param ctx 插件上下文
 * @param service Git 服务
 */
export function registerCommands(ctx: CommandContext, service: GitService): void {
  ctx.command(/^#git帮助$/i, { desc: "Git 动态订阅帮助", group: "Git" }).action(async event => { await event.reply(HELP) })
  ctx.command(PATTERN, { admin: true, cooldown: "3s", desc: "管理 Git 动态订阅", group: "Git" })
    .action(async event => {
      if (!event.isMaster && !(event.isGroup && event.isGroupAdmin)) return
      try {
        await handle(ctx, service, event)
      } catch (error) {
        await event.reply(error instanceof Error && error.name === "SchemaError"
          ? "配置校验失败，请检查仓库、分支、目标 ID 和订阅数量（最多 200）。" : safeError(error))
      }
    })
}

async function handle(ctx: CommandContext, service: GitService, event: MessageEvent): Promise<void> {
  const match = PATTERN.exec(event.text)
  if (!match) return
  const action = match[1] ?? ""
  const raw = match[2] ?? ""
  const current = service.contextFor(event)
  const local = (row: Subscription) => targetKey(row) === targetKey(current)
  const manageable = (row: Subscription) => event.isMaster || local(row)
  const all = raw.trim() === "全部"
  if ((all || action === "状态") && !event.isMaster) throw new GitError("只有主人可以查看或检查全部订阅。", "permission")

  if (action === "订阅") {
    const [repoInput, ...options] = raw.trim().split(/\s+/)
    if (!repoInput) throw new GitError("用法：#git订阅 github:owner/repo；更多参数见 #git帮助。", "input")
    let parsed
    try {
      parsed = parseRepo(repoInput)
    } catch (error) {
      throw new GitError(error instanceof Error ? error.message : String(error), "input")
    }
    const row: SubscriptionInput = { ...parsed, ...current, enabled: true, branch: "", events: [], format: "default", credential: "" }
    const supplied = new Set<string>()
    for (const option of options) {
      const separator = option.indexOf("=")
      const key = option.slice(0, separator)
      const value = option.slice(separator + 1)
      if (separator < 1 || !value || supplied.has(key)) throw new GitError("选项格式不正确或重复，见 #git帮助。", "input")
      supplied.add(key)
      const types = value.split(",")
      if (key === "分支") row.branch = value
      else if (key === "样式" && (value === "文字" || value === "图片")) row.format = value === "文字" ? "text" : "image"
      else if (key === "事件" && types.every(isEventType)) row.events = [...new Set(types.filter(isEventType))]
      else throw new GitError("未知选项；支持 分支=、事件=、样式=文字或图片。", "input")
    }
    row.credential = service.commandCredential(row)
    const id = await service.subscribe(row)
    await event.reply(`订阅已保存：${id}\n${row.platform}:${row.repo}\n首次成功检查建立基线，不推历史。可用 #git列表 查看初始化结果，面板也可编辑此订阅。`)
    return
  }

  if (action === "取消" || action === "样式") {
    const parts = raw.trim().split(/\s+/)
    const id = parts[0] ?? ""
    const style = parts[1]
    const valid = /^[a-f0-9]{16}$/.test(id) && (action === "取消" ? parts.length === 1 : parts.length === 2 && (style === "文字" || style === "图片"))
    if (!valid) throw new GitError(action === "取消" ? "用法：#git取消 <完整订阅编号>" : "用法：#git样式 <完整订阅编号> <文字或图片>", "input")
    await service.update(id, manageable, action === "取消" ? undefined : { format: style === "文字" ? "text" : "image" })
    await event.reply(action === "取消" ? "订阅已删除。" : "推送样式已更新。")
    return
  }

  let entries = await service.status(all || action === "状态" ? () => true : local)
  if (action === "检查") {
    if (raw && !all) {
      entries = (await service.status(manageable)).filter(item => item.id === raw.trim())
      if (!entries.length) throw new GitError("订阅不存在或无权管理。", "permission")
    }
    const result = await service.tick(entries.map(item => item.id))
    const errors = result.results.filter(item => item.error).map(item => `${item.id}：${item.error}`).join("\n")
    await event.reply(result.busy ? "已有检查正在执行，请稍后查看 #git列表。" : result.disabled ? "Git 推送总开关已关闭。" :
      `检查完成：${result.results.length} 个订阅，推送 ${result.results.reduce((sum, item) => sum + item.sent, 0)} 条动态。\n${errors || "首次初始化只建立基线；无新增时不发送动态。"}`)
    return
  }

  if (raw && !all) throw new GitError("列表参数只支持“全部”。", "input")
  const config = ctx.config.get()
  const lines = entries.map(item => `${item.id} | ${item.row.enabled ? item.initialized ? "已初始化" : "待初始化" : "已停用"}${item.scanning ? " / 续查中" : ""}\n` +
    `${PLATFORMS[item.row.platform].name} ${item.row.repo}${item.row.branch ? ` [${item.row.branch}]` : ""}\n` +
    `${eventTypes(item.row, config).join(",")} · 待发 ${item.pending} · ${item.row.scene}:${item.row.targetId}\n` +
    `最近检查：${item.lastCheck ? new Date(item.lastCheck).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未检查"}${item.error ? `\n${item.error}` : ""}`)
  if (action === "状态") {
    lines.unshift(`Git 推送：${config.enabled ? "开启" : "关闭"}，间隔 ${config.intervalSeconds} 秒`)
    lines.push("机器人账号记录 ID：", ...ctx.app.accounts.list().map(item =>
      `${item.record.id} · ${item.record.adapterId} · ${item.record.selfId || "未连接"} · ${item.status}`))
  }
  if (!lines.length) lines.push("尚无订阅，使用 #git订阅 或在面板配置推送。")
  // 大量订阅时按小段回复，避免单条超过适配器消息限制。
  for (let offset = 0; offset < lines.length; offset += 5) await event.reply(lines.slice(offset, offset + 5).join("\n\n"))
}
