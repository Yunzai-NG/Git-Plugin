/**
 * 模块职责：订阅、抓取与投递服务 —— 权限验证、增量扫描、可靠队列与配置同步
 * 依赖方向：model / config / providers / scanner / display / avatars
 * 生命周期：setup 时创建一次；`ctx.signal` abort 后不再写状态、不再发送
 * 注意事项：每次 KV 写入同时保存游标和待发事件，崩溃时不会只存游标而漏存消息。
 *          发送返回 ok 才出队，是「至少一次」投递。公开性无法验证时不投递；
 *          明确的权限拒绝会清空可能敏感的待发内容。
 */
import type { MessageEvent, PluginContext } from "@yunzai-ng/types"
import { createAvatarLoader } from "./avatars.js"
import type { AvatarLoader } from "./avatars.js"
import { subscriptionRows } from "./config.js"
import type { GitConfig, GitConfigInput, RepoSubscriptionInput, Subscription, SubscriptionInput } from "./config.js"
import { messageContent } from "./display.js"
import { createProvider } from "./providers.js"
import type { Provider } from "./providers.js"
import { scanEvents } from "./scanner.js"
import type { StreamState } from "./scanner.js"
import {
  GitError, errorCode, eventTypes, grantFor, repoKey, safeError, sendTarget, subscriptionId, targetKey, tokenFor
} from "./model.js"
import type { Destination, EventType, GitEvent } from "./model.js"

const PREFIX = "subscription:"
const MAX_PENDING = 20_000
const retryOf = (error: unknown) => error instanceof GitError ? error.retryAt : 0

/** 服务需要的插件能力，`PluginContext` 满足它 */
export type GitContext = Pick<PluginContext<GitConfigInput>, "signal" | "kv" | "config" | "app" | "logger" | "render" | "http" | "cache">

/** 一条订阅在 KV 里的状态 */
export interface SubState {
  /** 各类动态的扫描进度 */
  streams: Partial<Record<EventType, StreamState>>
  /** 待发送动态 */
  pending: GitEvent[]
  /** 最近检查时间 */
  lastCheck: number
  /** 最近成功发送时间 */
  lastSent?: number
  /** 最近错误，空串表示正常 */
  error: string
  /** 退避截止时间 */
  retryAt?: number
  /** 是否以私有仓库授权访问 */
  privateAccess: boolean
  /** 上次使用的凭据名称；变化时清理私有待发 */
  credential?: string
}

/** 一条订阅本轮的检查结果 */
export interface CheckSummary {
  /** 订阅编号 */
  id: string
  /** 本轮发送的动态数 */
  sent: number
  /** 本轮是否建立了某类动态的基线 */
  initialized: boolean
  /** 本轮错误，空串表示正常 */
  error: string
}

/** 一轮检查的结果 */
export interface RunResult {
  /** 已有检查在执行，本次未运行 */
  busy?: boolean
  /** 总开关关闭 */
  disabled?: boolean
  /** 各订阅结果 */
  results: CheckSummary[]
}

/** `#git列表` 等命令展示的订阅状态 */
export interface StatusEntry {
  /** 订阅编号 */
  id: string
  /** 订阅配置 */
  row: Subscription
  /** 所有启用的事件类型都已建立基线 */
  initialized: boolean
  /** 是否有未扫完的翻页进度 */
  scanning: boolean
  /** 待发送条数 */
  pending: number
  /** 最近检查时间 */
  lastCheck: number
  /** 最近成功发送时间 */
  lastSent: number | undefined
  /** 最近错误 */
  error: string
  /** 退避截止时间 */
  retryAt: number | undefined
}

/** 可原地修改的订阅字段；平台、仓库、分支决定订阅编号，改它们等于新建订阅 */
export type RepoPatch = Partial<Omit<RepoSubscriptionInput, "platform" | "repo" | "branch">>

/** 对外提供的服务（服务键 `git-plugin`） */
export interface GitService {
  /** 执行一轮检查；已有检查在执行时立即返回 busy */
  tick(ids?: readonly string[], signal?: AbortSignal): Promise<RunResult>
  /** 配置变更后同步状态；正在检查时排到本轮结束后 */
  refresh(): Promise<void>
  /** 验证后保存订阅，返回编号 */
  subscribe(input: SubscriptionInput): Promise<string>
  /** 修改或删除（patch 为 undefined）订阅；只能改不影响编号的字段 */
  update(id: string, canManage: (row: Subscription) => boolean, patch: RepoPatch | undefined): Promise<void>
  /** 订阅状态列表 */
  status(filter?: (row: Subscription) => boolean): Promise<StatusEntry[]>
  /** 命令所在会话对应的机器人账号与目标 */
  contextFor(event: MessageEvent): Destination
  /** 聊天添加订阅时可用的凭据名称 */
  commandCredential(row: SubscriptionInput): string
  /** 等待正在执行的检查结束 */
  idle(): Promise<void>
  /** 是否有检查正在执行 */
  isRunning(): boolean
}

/** 可注入的依赖，测试用 */
export interface ServiceOptions {
  /** 平台客户端 */
  provider?: Provider
  /** 头像加载器 */
  avatars?: AvatarLoader
  /** 时钟 */
  now?: () => number
}

/** 访问检查的结论 */
interface Access {
  token: string
  privateAccess: boolean
  defaultBranch: string
}

/**
 * 创建订阅、抓取与投递服务
 * @param ctx 插件上下文
 * @param options 可注入的平台客户端、头像加载器与时钟
 * @returns 服务
 */
export function createGitService(ctx: GitContext, options: ServiceOptions = {}): GitService {
  const { provider = createProvider(ctx.http), avatars = createAvatarLoader(ctx), now = Date.now } = options
  let running: Promise<RunResult> | undefined
  let mutations: Promise<unknown> = Promise.resolve()
  let dirty = false

  const rows = () => subscriptionRows(ctx.config.get())
  const active = (id: string, config: GitConfig) => !ctx.signal.aborted && ctx.config.get() === config && config.enabled &&
    subscriptionRows(config).some(row => subscriptionId(row) === id && row.enabled)
  const load = async (id: string): Promise<SubState> => structuredClone(await ctx.kv.get<SubState>(`${PREFIX}${id}`) ||
    { streams: {}, pending: [], lastCheck: 0, error: "", privateAccess: false })

  async function access(row: Subscription, config: GitConfig, signal?: AbortSignal): Promise<Access> {
    const token = tokenFor(row, config)
    const grant = grantFor(row, config)
    let anonymous
    try {
      anonymous = await provider.metadata(row, "", config, signal)
    } catch (error) {
      // GitCode 等平台连公开元数据也要求 Token。此时携带凭据读取元数据，
      // 仍必须证明 private=false；绝不能把「Token 可读」当成「公开」。
      const code = errorCode(error)
      if ((!grant && !(token && code === "401")) || !["401", "403", "404"].includes(code)) throw error
    }
    if (anonymous && !anonymous.public && !grant) throw new GitError("仓库不是可验证的公开仓库，请主人在面板授权此会话。", "permission")
    if ((!anonymous?.public || grant) && !token) throw new GitError("此仓库需要配置有效 Token；非公开仓库还需会话授权。", "permission")
    const authenticated = token ? await provider.metadata(row, token, config, signal) : anonymous
    if (!authenticated?.public && !grant) throw new GitError("仓库已变为非公开，推送已停止，请主人授权。", "permission")
    return { token, privateAccess: Boolean(grant), defaultBranch: authenticated?.defaultBranch || "" }
  }

  async function reconcile(): Promise<void> {
    const config = ctx.config.get()
    const all = new Map(subscriptionRows(config).map(row => [subscriptionId(row), row]))
    for await (const key of ctx.kv.keys(PREFIX)) {
      const row = all.get(key.slice(PREFIX.length))
      if (!row) { await ctx.kv.del(key); continue }
      const state = await load(subscriptionId(row))
      const allowed = eventTypes(row, config)
      let changed = false
      for (const type of Object.keys(state.streams) as EventType[]) {
        if (!allowed.includes(type)) { delete state.streams[type]; changed = true }
      }
      const pending = state.pending.filter(event => allowed.includes(event.type))
      if (pending.length !== state.pending.length) { state.pending = pending; changed = true }
      if (state.privateAccess && (!grantFor(row, config) || state.credential !== row.credential)) {
        state.pending = []
        state.streams = {}
        state.privateAccess = false
        state.error = "私有仓库授权已撤销或变更，已清理待发送记录。"
        changed = true
      }
      if (changed) await ctx.kv.set(key, state)
    }
  }

  async function checkRow(row: Subscription, config: GitConfig, signal?: AbortSignal): Promise<CheckSummary> {
    const id = subscriptionId(row)
    const key = `${PREFIX}${id}`
    let state = await load(id)
    const summary: CheckSummary = { id, sent: 0, initialized: false, error: "" }
    const save = async () => {
      if (!active(id, config)) throw new GitError("配置已变更，等待下一轮检查。", "changed")
      await ctx.kv.set(key, state)
    }
    try {
      const permission = await access(row, config, signal)
      if (!active(id, config)) return summary
      state.privateAccess = permission.privateAccess
      state.credential = row.credential
      state.lastCheck = now()
      state.error = ""
      state.retryAt = 0
      // 先检查所有事件，再发送；某类 API 失败不会丢弃其他类的进度。
      const failures: string[] = []
      for (const type of eventTypes(row, config)) {
        if (!active(id, config) || signal?.aborted) return summary
        if (state.pending.length >= MAX_PENDING) { failures.push("发送积压已达上限，暂停抓取，先重试投递。"); break }
        try {
          const initialized = state.streams[type]?.initialized
          const result = await scanEvents(provider, row, permission.token, config, type, state.streams[type],
            { privateAccess: permission.privateAccess, now, signal })
          const present = new Set(state.pending.map(event => `${event.type}:${event.id}`))
          const added = result.events.filter(event => !present.has(`${event.type}:${event.id}`))
          if (state.pending.length + added.length > MAX_PENDING) throw new GitError("待发送动态过多，暂缓推进此类抓取进度。", "overflow")
          // 单次 KV 写入：无论在哪一步崩溃，都不会只存游标而漏存消息。
          state.streams[type] = result.state
          state.pending.push(...added)
          state.privateAccess = permission.privateAccess
          state.credential = row.credential
          await save()
          if (!initialized) summary.initialized = true
        } catch (error) {
          if (["changed", "aborted"].includes(errorCode(error))) return summary
          failures.push(safeError(error))
          // KV 写入也可能失败；重新加载已提交状态，避免后续发送未持久化消息。
          state = await load(id)
          state.retryAt = Math.max(state.retryAt || 0, retryOf(error))
        }
      }
      if (active(id, config) && !signal?.aborted && state.pending.length) {
        const bot = ctx.app.bots.get(row.accountId)
        if (!bot?.online) failures.push("机器人离线，动态已保留，上线后重试。")
        else {
          for (let batch = 0; batch < 3 && state.pending.length; batch++) {
            if (!active(id, config) || signal?.aborted) break
            const events = state.pending.slice(0, 10)
            const content = await messageContent(ctx, row, config, events, avatars)
            if (!active(id, config) || signal?.aborted) break
            try {
              const result = await bot.sendMessage(sendTarget(row), content)
              if (!result?.ok) throw new GitError("平台未确认消息送达，保留批次重试。", "send")
            } catch {
              failures.push("消息发送失败，已保留批次，稍后重试。")
              break
            }
            state.pending.splice(0, events.length)
            state.lastSent = now()
            await save()
            summary.sent += events.length
          }
        }
      }
      state.lastCheck = now()
      state.error = [...new Set(failures)].join("；")
      await save()
      summary.error = state.error
    } catch (error) {
      summary.error = safeError(error)
      if (active(id, config)) {
        state = await load(id)
        // 公开性无法验证时不投递；明确权限拒绝会删除可能敏感的待发送内容。
        if (["permission", "401", "403", "404"].includes(errorCode(error))) {
          state.pending = []
          if (state.privateAccess) state.streams = {}
        }
        state.error = summary.error
        state.retryAt = retryOf(error)
        state.lastCheck = now()
        await ctx.kv.set(key, state)
      }
    }
    if (summary.error) ctx.logger.warn(`Git 订阅 ${id}：${summary.error}`)
    return summary
  }
  async function run(ids: readonly string[] | undefined, signal?: AbortSignal): Promise<RunResult> {
    provider.beginRound()
    await reconcile()
    const config = ctx.config.get()
    if (!config.enabled || ctx.signal.aborted) return { disabled: true, results: [] }
    const results: CheckSummary[] = []
    for (const row of subscriptionRows(config)) {
      if (signal?.aborted || ctx.signal.aborted || ctx.config.get() !== config) break
      if (row.enabled && (!ids || ids.includes(subscriptionId(row)))) results.push(await checkRow(row, config, signal))
    }
    return { results }
  }

  function tick(ids?: readonly string[], signal: AbortSignal = ctx.signal): Promise<RunResult> {
    if (running) return Promise.resolve({ busy: true, results: [] })
    const current = run(ids, signal).finally(() => {
      running = undefined
      if (dirty && !ctx.signal.aborted) { dirty = false; void refresh() }
    })
    running = current
    return current
  }

  async function refresh(): Promise<void> {
    if (running) { dirty = true; return }
    try { await tick() } catch { ctx.logger.warn("Git 配置同步或持久化失败，下一轮将重试。") }
  }

  function mutate<T>(fn: () => Promise<T>): Promise<T> {
    const task = mutations.then(() => {
      if (ctx.signal.aborted) throw new GitError("插件已卸载。", "aborted")
      return fn()
    })
    mutations = task.catch(() => {})
    return task
  }

  /** 配置里的会话是只读快照；写回前复制成普通对象 */
  const writable = () => structuredClone(ctx.config.get().chats) as unknown as GitConfigInput["chats"]
  /** 会话里某个仓库对应的订阅编号 */
  const idOf = (chat: Destination, repo: RepoSubscriptionInput) => subscriptionId({ ...repo, accountId: chat.accountId,
    scene: chat.scene, targetId: chat.targetId })

  return {
    tick,
    refresh,

    async subscribe(input) {
      // 验证失败不保存。聊天来源只会由命令层选择已授权凭据。
      const snapshot = ctx.config.get()
      await access(input, snapshot, ctx.signal)
      return mutate(async () => {
        if (ctx.config.get() !== snapshot) throw new GitError("配置刚刚发生变化，请重试订阅命令。", "changed")
        const id = subscriptionId(input)
        const { accountId, scene, targetId, ...repo } = input
        const chats = writable()
        let chat = chats.find(row => targetKey(row) === targetKey(input))
        if (!chat) {
          chat = { enabled: true, remark: "", accountId, scene, targetId, repos: [] }
          chats.push(chat)
        }
        const index = chat.repos.findIndex(row => idOf(input, row) === id)
        if (index < 0) chat.repos.push(repo)
        else chat.repos[index] = { ...chat.repos[index], ...repo }
        await ctx.config.patch({ chats })
        return id
      })
    },

    async update(id, canManage, patch) {
      return mutate(async () => {
        const row = rows().find(item => subscriptionId(item) === id)
        if (!row || !canManage(row)) throw new GitError("订阅不存在或你没有管理此会话的权限。", "permission")
        const chats = writable().map(chat => ({ ...chat, repos: patch
          ? chat.repos.map(repo => idOf(chat, repo) === id ? { ...repo, ...patch } : repo)
          : chat.repos.filter(repo => idOf(chat, repo) !== id) }))
          // 删掉最后一个仓库时，聊天里建出来的空会话（没有备注）一并移除；面板里写过备注的保留
          .filter(chat => chat.repos.length || chat.remark)
        await ctx.config.patch({ chats })
      })
    },

    async status(filter = () => true) {
      const result: StatusEntry[] = []
      for (const row of rows().filter(filter)) {
        const id = subscriptionId(row)
        const state = await load(id)
        result.push({ id, row, initialized: eventTypes(row, ctx.config.get()).every(type => state.streams[type]?.initialized),
          scanning: Object.values(state.streams).some(stream => stream?.scan), pending: state.pending.length,
          lastCheck: state.lastCheck, lastSent: state.lastSent, error: state.error, retryAt: state.retryAt })
      }
      return result
    },

    /** 为命令解析精确账号记录，不使用可能跨适配器冲突的 selfId 单独匹配 */
    contextFor(event) {
      const account = ctx.app.accounts.list().find(item => ctx.app.bots.get(item.record.id) === event.bot)
      const target = event.target
      if (!account || (target.scene !== "group" && target.scene !== "private")) {
        throw new GitError("无法确定机器人账号，或此会话类型暂不支持。", "target")
      }
      return { accountId: account.record.id, scene: target.scene, targetId: target.scene === "group" ? target.gid : target.uid }
    },

    /** 聊天添加只能使用当前会话已授权的私有凭据，或平台默认公开凭据 */
    commandCredential(row) {
      const matches = ctx.config.get().privateRepositories.filter(grant => repoKey(grant) === repoKey(row) &&
        grant.targets.some(target => targetKey(target) === targetKey(row)))
      if (matches.length > 1) throw new GitError("此会话有多个仓库凭据授权，请在面板选择凭据并添加订阅。", "credential")
      return matches[0]?.credential || ""
    },

    async idle() { while (running) await running },
    isRunning: () => Boolean(running)
  }
}
