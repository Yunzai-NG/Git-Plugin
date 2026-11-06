/**
 * 模块职责：插件配置 schema —— 同时是面板「插件 → git-plugin → 配置」的表单
 * 依赖方向：`@yunzai-ng/core` 的 schema 工具、model.ts 的常量与校验
 * 生命周期：模块加载期构造一次，之后只读
 * 注意事项：订阅按接收会话分组（`chats[].repos[]`），面板里一个群一项；服务用 subscriptionRows() 展开成
 *          一个仓库对一个会话的平铺订阅。聊天命令与面板共用同一份配置文件；数组整体保存，最后一次保存为准。
 *          跨字段约束（凭据存在、订阅不重复）用 `.check()` 写在这里，面板据此标红。
 */
import { s } from "@yunzai-ng/core"
import type { Infer } from "@yunzai-ng/core"
import type { DeepReadonly } from "@yunzai-ng/types"
import { EVENTS, targetKey, validRepo } from "./model.js"
import type { Destination } from "./model.js"

/** 平台下拉项；写成字面量元组，`s.select` 才能推出 "github" | "gitee" | "gitcode" */
const PLATFORM_ITEMS = [
  { value: "github", label: "GitHub" },
  { value: "gitee", label: "Gitee" },
  { value: "gitcode", label: "GitCode" }
] as const

const text = (title: string, value = "") => s.string().default(value).title(title)
const platform = () => s.select(PLATFORM_ITEMS).default("github").title("代码托管平台")
const repo = () => text("仓库（owner/repo）").check("请输入两段仓库路径，如 Yunzai-NG/yunzai-ng；不要填写完整 URL", validRepo)
const credential = () => text("凭据名称（留空使用该平台默认 Token）").max(64)
const events = () => s.array(s.enum(EVENTS)).widget("multiselect")
  .check("事件类型不能重复", values => new Set(values).size === values.length)
const token = (title: string) => s.password().default("").max(2048).title(title)
  .desc("可留空尝试公开仓库；私有仓库还需下方会话授权。")
const destination = () => ({
  accountId: text("机器人账号记录 ID").min(1).max(100)
    .desc("填写 NG 账号记录 UUID，不是机器人 QQ 号。在面板「账号」查看记录 ID；也可用主人命令 #git状态 查看在线账号 ID。"),
  scene: s.select([{ value: "group", label: "群聊" }, { value: "private", label: "私聊" }] as const).default("group").title("接收类型"),
  targetId: text("接收群号 / 用户 ID").min(1).max(128).pattern(/^[A-Za-z0-9_.:-]+$/, "接收 ID 只能含字母、数字、下划线、点、冒号或连字符")
})
const branchOk = (value: string) => !/\s/.test(value) && [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)

/** 仓库订阅总数上限，所有会话合计 */
const MAX_SUBSCRIPTIONS = 200
/** 同一会话内的仓库比较键：仓库不区分大小写，分支区分 */
const repoBranchKey = (row: { platform: string, repo: string, branch: string }) => JSON.stringify([row.platform, row.repo.toLowerCase(), row.branch])

/** 会话下的一个仓库订阅 */
const repoSubscription = s.object({
  enabled: s.boolean().default(true).title("启用"),
  platform: platform(),
  repo: repo(),
  branch: text("Commit 分支（留空跟踪默认分支）").max(256).check("分支不能含空白或控制字符", branchOk),
  events: events().default([]).title("事件类型").desc("留空沿用基础设置；只推送新增，不推送后续状态变更。"),
  format: s.select([{ value: "default", label: "沿用默认" }, { value: "text", label: "文字" }, { value: "image", label: "图片" }] as const)
    .default("default").title("推送样式"),
  credential: credential()
}).strict()

/** 一个接收会话（群聊或私聊）及它订阅的仓库 */
const chat = s.object({
  enabled: s.boolean().default(true).title("启用此会话的推送").desc("关闭后此会话下的仓库全部暂停，进度与队列保留。"),
  remark: text("备注（如群名）").max(100),
  ...destination(),
  repos: s.array(repoSubscription).default([]).title("订阅的仓库")
    .desc("此会话接收哪些仓库的动态。聊天命令 #git订阅 添加的仓库也在这里。")
    .check("同一会话里不能重复订阅相同仓库与分支", rows => new Set(rows.map(repoBranchKey)).size === rows.length)
}).strict()

/** 配置与面板表单共用同一份校验规则 */
export const configSchema = s.object({
  enabled: s.boolean().default(true).title("启用 Git 动态推送").group("基础设置"),
  intervalSeconds: s.number().int().min(60).max(86400).default(300).title("检查间隔（秒）").group("基础设置"),
  timeoutSeconds: s.number().int().min(1).max(120).default(20).title("请求超时（秒）").group("基础设置"),
  defaultEvents: events().min(1).default([...EVENTS]).title("默认事件类型").group("基础设置"),
  defaultFormat: s.select([{ value: "text", label: "文字摘要" }, { value: "image", label: "图片卡片" }] as const)
    .default("text").title("默认推送样式").group("基础设置"),
  tokens: s.object({
    github: token("GitHub 默认 Token"),
    gitee: token("Gitee 默认 Token"),
    gitcode: token("GitCode 默认 Token")
  }).title("平台默认 Token").group("平台 Token"),
  credentials: s.array(s.object({
    name: text("凭据名称").pattern(/^[a-zA-Z0-9_-]{1,64}$/, "凭据名称使用 1–64 位字母、数字、下划线或连字符"),
    platform: platform(),
    token: s.password().default("").max(2048).title("Token")
  }).strict()).default([]).title("额外命名凭据").group("平台 Token")
    .check("凭据名称不能重复", rows => new Set(rows.map(row => row.name)).size === rows.length),
  chats: s.array(chat).default([]).title("推送会话").group("推送订阅")
    .desc("按群聊、私聊配置：每个会话一项，在其中添加要推送的仓库。修改前重新读取，避免覆盖其他管理者刚保存的内容。")
    .check("同一个机器人会话只能出现一次，请把仓库合并到同一项里", rows => new Set(rows.map(targetKey)).size === rows.length)
    .check(`仓库订阅总数不能超过 ${MAX_SUBSCRIPTIONS}`, rows => rows.reduce((sum, row) => sum + row.repos.length, 0) <= MAX_SUBSCRIPTIONS),
  privateRepositories: s.array(s.object({
    platform: platform(),
    repo: repo(),
    credential: credential(),
    targets: s.array(s.object(destination()).strict()).min(1).title("允许接收的会话")
  }).strict()).default([]).title("私有仓库授权").group("私有仓库授权")
    .desc("由主人明确授权。仓库、凭据名称、机器人账号与接收会话须与订阅一致；撤销后清理该会话待发送的私有动态。")
}).deprecated("subscriptions").check("订阅或授权引用了不存在的凭据，或凭据平台不匹配", config =>
  [...config.chats.flatMap(row => row.repos), ...config.privateRepositories].every(row => !row.credential ||
    config.credentials.some(item => item.name === row.credential && item.platform === row.platform)))

/** 可写的配置形态，构造补丁时用 */
export type GitConfigInput = Infer<typeof configSchema>

/** `ctx.config.get()` 返回的只读配置快照 */
export type GitConfig = DeepReadonly<GitConfigInput>

/** 会话下的一个仓库订阅（可写形态） */
export type RepoSubscriptionInput = GitConfigInput["chats"][number]["repos"][number]

/** 展开后的一条订阅：一个仓库对一个会话（可写形态，聊天命令新建订阅时用） */
export type SubscriptionInput = RepoSubscriptionInput & Destination

/** 展开后的一条订阅（只读）；服务按它抓取、排队和发送 */
export type Subscription = DeepReadonly<SubscriptionInput>

/**
 * 把按会话分组的配置展开成一条条订阅；会话停用时其下仓库一律视为停用
 * @param config 当前配置
 * @returns 订阅列表，按会话、仓库的配置顺序
 */
export function subscriptionRows(config: Pick<GitConfig, "chats">): Subscription[] {
  return config.chats.flatMap(chat => chat.repos.map(repo => ({ ...repo, enabled: chat.enabled && repo.enabled,
    accountId: chat.accountId, scene: chat.scene, targetId: chat.targetId })))
}
