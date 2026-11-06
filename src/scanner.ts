/**
 * 模块职责：单个订阅单类动态的增量扫描 —— 基线、翻页续查与新事件判定
 * 依赖方向：model.ts 与 providers.ts 的类型
 * 生命周期：纯函数；进度由调用方与待发队列一起写入 KV
 * 注意事项：Commit 以 SHA 历史边界判定新增，不看作者时间（可被改写）；
 *          其余类型以创建/发布时间水位判定，同一时刻的已见 id 记在 ids 里去重。
 *          每轮至多翻 3 页，未扫完的进度落盘，下一轮接着扫。
 */
import { GitError } from "./model.js"
import type { EventType, GitEvent } from "./model.js"
import type { Provider, ProviderConfig, RepoTarget } from "./providers.js"

const PAGE_BUDGET = 3
const MAX_STAGED = 20_000

/** 未扫完时落盘的续查进度 */
export interface ScanProgress {
  /** 下一页页码 */
  page: number
  /** Commit 扫描固定的起点 SHA */
  head: string
  /** 已暂存的新事件 */
  staged: GitEvent[]
  /** 本次扫描开始时间 */
  startedAt: number
}

/** 一种动态的持久化进度 */
export interface StreamState {
  /** 基线是否已建立 */
  initialized?: boolean
  /** Commit：上次扫到的最新 SHA */
  head?: string | null
  /** 非 Commit：已处理的最大创建/发布时间 */
  watermark?: number
  /** 非 Commit：水位时刻上已见过的 id */
  ids?: string[]
  /** 未扫完时的续查进度 */
  scan?: ScanProgress
}

/** 扫描选项 */
export interface ScanOptions {
  /** 时钟 */
  now?: () => number
  /** 中止信号 */
  signal?: AbortSignal | undefined
  /** 是否已获私有仓库授权 */
  privateAccess?: boolean
}

/** 扫描结果 */
export interface ScanResult {
  /** 新进度 */
  state: StreamState
  /** 尚未入投递队列的新事件，按发生顺序 */
  events: GitEvent[]
}

/**
 * 扫描一种事件，返回尚未入投递队列的新事件和可持久化的新进度
 * @param provider 平台客户端
 * @param row 订阅
 * @param token 凭据
 * @param config 客户端配置
 * @param type 动态类型
 * @param previous 上次进度；首次为 undefined
 * @param options 时钟、中止信号与私有授权
 * @returns 新事件与新进度
 */
export async function scanEvents(provider: Pick<Provider, "page">, row: RepoTarget, token: string, config: ProviderConfig,
  type: EventType, previous: StreamState | undefined, options: ScanOptions = {}): Promise<ScanResult> {
  const { now = Date.now, signal, privateAccess = false } = options
  const state: StreamState = structuredClone(previous || {})
  const page = (number: number, head?: string) => provider.page(row, token, config, type, number, { head, privateAccess, signal })
  if (!state.initialized) {
    const startedAt = now()
    const first = await page(1)
    // 初始化只记录当前边界：既不发送历史，也不扫描整个 commit 历史。
    return { state: { initialized: true, head: first.events[0]?.id || null,
      watermark: startedAt, ids: first.events.filter(event => event.time >= startedAt).map(event => event.id) }, events: [] }
  }

  const watermark = state.watermark ?? 0
  const ids = state.ids ?? []
  const scan: ScanProgress = state.scan || { page: 1, head: "", staged: [], startedAt: now() }
  const staged = new Map(scan.staged.map(event => [event.id, event]))
  let complete = false
  for (let used = 0; used < PAGE_BUDGET; used++) {
    if (signal?.aborted) throw new GitError("检查已中止。", "aborted")
    const result = await page(scan.page, scan.head)
    if (type === "commit" && scan.page === 1) scan.head = result.events[0]?.id || ""
    for (const event of result.events) {
      if (type === "commit") {
        if (event.id === state.head) { complete = true; break }
        staged.set(event.id, event)
      } else if (event.time > watermark || (event.time === watermark && !ids.includes(event.id))) {
        staged.set(event.id, event)
      }
    }
    if (staged.size > MAX_STAGED) throw new GitError("单次积压超过 20000 条，请缩短检查间隔或重新订阅以建立新基线。", "overflow")
    // Release API 不保证按发布时间排序（旧草稿刚发布也属于新增），必须遍历到末页。
    if (type !== "commit" && type !== "release" && result.events.some(event => event.time < watermark)) complete = true
    if (result.count < 100) {
      if (type === "commit" && state.head && !complete) throw new GitError("Commit 历史无法衔接（可能发生强制推送），请确认后取消并重新订阅。", "boundary")
      complete = true
    }
    if (complete) break
    scan.page++
  }
  if (!complete) {
    state.scan = { ...scan, staged: [...staged.values()] }
    return { state, events: [] }
  }
  let events = [...staged.values()]
  if (type === "commit") {
    state.head = scan.head || state.head
    events = events.reverse() // API 返回拓扑倒序；不按可回溯修改的作者时间排序。
  } else {
    events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
    // 以完整扫描的最大事件时间推进，空轮次不推进墙钟，容纳 API 延迟可见。
    const max = Math.max(watermark, ...events.map(event => event.time))
    state.ids = [...new Set([...(max === watermark ? ids : []), ...events.filter(event => event.time === max).map(event => event.id)])]
    state.watermark = max
  }
  delete state.scan
  return { state, events }
}
