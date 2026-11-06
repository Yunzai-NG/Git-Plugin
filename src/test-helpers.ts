/**
 * 模块职责：单元测试共用的替身 —— 订阅工厂、动态工厂、插件上下文与平台客户端替身
 * 依赖方向：config.ts 与各模块的类型
 * 生命周期：仅测试使用；tsconfig.json 排除本文件，不进 dist
 * 注意事项：上下文替身只实现服务、命令与入口真正用到的成员，按需 cast 成插件上下文。
 *          集成测试另用真实内核（createApp + mock 适配器），不走这里的替身。
 */
import type { MessageContent, PluginContext, SendTarget } from "@yunzai-ng/types"
import { configSchema } from "./config.js"
import type { GitConfigInput, SubscriptionInput } from "./config.js"
import type { EventType, GitEvent } from "./model.js"
import type { PageOptions, Provider, RepoMetadata } from "./providers.js"
import type { GitContext } from "./service.js"

/** 一条展开后的订阅（一个仓库对一个会话）；未给的字段取 schema 默认值 */
export function row(patch: Record<string, unknown> = {}): SubscriptionInput {
  const { accountId = "bot-account", scene = "group", targetId = "123", ...repo } = patch
  const config = configSchema.parse({
    chats: [{ accountId, scene, targetId, repos: [{ platform: "github", repo: "owner/repo", ...repo }] }],
    credentials: patch.credential ? [{ name: patch.credential, platform: patch.platform || "github", token: "test-token" }] : []
  })
  const chat = config.chats[0]
  const first = chat?.repos[0]
  if (!chat || !first) throw new Error("row() 未生成订阅")
  return { ...first, accountId: chat.accountId, scene: chat.scene, targetId: chat.targetId }
}

/** 按会话把订阅分组成配置里的 chats；同一会话的仓库按出现顺序放进同一项 */
export function chats(...rows: SubscriptionInput[]): GitConfigInput["chats"] {
  const out: GitConfigInput["chats"] = []
  for (const { accountId, scene, targetId, ...repo } of rows) {
    let chat = out.find(item => item.accountId === accountId && item.scene === scene && item.targetId === targetId)
    if (!chat) {
      chat = { enabled: true, remark: "", accountId, scene, targetId, repos: [] }
      out.push(chat)
    }
    chat.repos.push(repo)
  }
  return out
}

/** 一条归一化后的动态 */
export const event = (id: string | number, type: EventType = "commit", time = 2000): GitEvent => ({ id: String(id), type, time,
  title: `title ${id}`, author: "tester", url: `https://github.com/owner/repo/commit/${id}` })

/** 平台 commit 列表里的一项 */
export const apiCommit = (id: string, date = "2026-01-01T00:00:00Z") => ({ sha: id, commit: { message: `Commit ${id}`,
  author: { name: "Tester", date }, committer: { date } } })

/** 替身机器人 */
export interface FakeBot {
  online: boolean
  sendMessage(target: SendTarget, content: MessageContent): Promise<{ ok: boolean }>
}

/** 记录下来的定时任务 */
export interface FakeTask {
  interval: unknown
  handler: (signal: AbortSignal) => unknown
  opts: unknown
  disposed: boolean
}

/** 内存 KV、可写配置与记录型 Bot 组成的插件上下文替身 */
export function harness(input: Record<string, unknown> = {}, persisted = new Map<string, unknown>()) {
  let config = configSchema.parse(input)
  const listeners = new Set<(change: { next: unknown }) => void>()
  const sent: { target: SendTarget, content: MessageContent }[] = []
  const warnings: string[] = []
  const tasks: FakeTask[] = []
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  const controller = new AbortController()
  const bot: FakeBot = { online: true, async sendMessage(target, content) { sent.push({ target, content }); return { ok: true } } }
  const fake = {
    signal: controller.signal,
    kv: {
      async get(key: string) { return structuredClone(persisted.get(key)) },
      async set(key: string, value: unknown) { persisted.set(key, structuredClone(value)) },
      async del(key: string) { persisted.delete(key) },
      async *keys(prefix = "") { for (const key of persisted.keys()) if (key.startsWith(prefix)) yield key }
    },
    config: {
      get: () => config,
      async patch(patch: Partial<GitConfigInput>) {
        config = configSchema.parse({ ...config, ...patch, tokens: { ...config.tokens, ...patch.tokens } })
        for (const listener of listeners) listener({ next: config })
        return config
      },
      onChange(listener: (change: { next: unknown }) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
    },
    app: {
      bots: { get: (id: string) => id === "bot-account" ? bot : undefined },
      accounts: { list: () => [{ record: { id: "bot-account", adapterId: "mock", selfId: "bot" }, status: "online" }] }
    },
    logger: { warn: (value: unknown) => { warnings.push(String(value)) }, info() {} },
    render: async (): Promise<unknown> => { throw new Error("No renderer") },
    cache: () => { const map = new Map<string, unknown>(); return { get: (key: string) => map.get(key), set: (key: string, value: unknown) => { map.set(key, value) } } },
    provide(name: string, value: unknown) { services.set(name, value) },
    command() { return { action() {} } },
    every(interval: unknown, handler: FakeTask["handler"], opts: unknown) {
      const task: FakeTask = { interval, handler, opts, disposed: false }
      tasks.push(task)
      return () => { task.disposed = true }
    },
    onDispose(fn: () => void) { disposers.push(fn) },
    http: { request: async () => { throw new Error("Unexpected real HTTP") } }
  }
  return {
    /** 当作服务的上下文使用 */
    ctx: fake as unknown as GitContext,
    /** 当作完整插件上下文使用（入口 setup） */
    plugin: fake as unknown as PluginContext<GitConfigInput>,
    /** 可直接改写成员的原始替身 */
    fake,
    bot, sent, warnings, persisted, tasks, services, controller,
    dispose() { controller.abort(); disposers.reverse().forEach(fn => fn()) }
  }
}

/** 内存列表驱动的平台客户端替身 */
export function fakeProvider(initial: Partial<Record<EventType, GitEvent[]>> = {}) {
  const lists: Record<EventType, GitEvent[]> = { commit: [], issue: [], pr: [], release: [], ...initial }
  const calls: { type: EventType, pageNumber: number, token: string, options: PageOptions | undefined }[] = []
  const provider: Provider & { lists: typeof lists, calls: typeof calls } = {
    lists, calls,
    beginRound() {},
    metadata: async (): Promise<RepoMetadata> => ({ public: true }),
    async page(_row, token, _config, type, pageNumber, options) {
      calls.push({ type, pageNumber, token, options })
      let list = lists[type]
      if (type === "commit" && options?.head) {
        const offset = list.findIndex(item => item.id === options.head)
        if (offset >= 0) list = list.slice(offset)
      }
      const events = list.slice((pageNumber - 1) * 100, pageNumber * 100)
      return { events, count: events.length }
    }
  }
  return provider
}
