/**
 * 模块职责：三个平台的官方 REST 客户端 —— 认证、本轮请求复用、限流退避与列表归一化
 * 依赖方向：model.ts 与 avatars.ts
 * 生命周期：由服务创建一次；`beginRound()` 清空本轮请求缓存，退避状态跨轮保留
 * 注意事项：请求缓存只按「仓库 + 凭据指纹 + 路径 + 查询」共享于同一轮，不落 KV、不进日志；
 *          不跟随重定向，避免把 Token 带到别的主机。远端错误响应体不会出现在任何报错文案里。
 */
import { createHash } from "node:crypto"
import type { HttpRequestOptions } from "@yunzai-ng/types"
import { avatarUrl } from "./avatars.js"
import { PLATFORMS, GitError, cleanText, errorCode, repoKey } from "./model.js"
import type { EventType, GitEvent, Platform } from "./model.js"

const paths: Readonly<Record<EventType, string>> = { commit: "commits", issue: "issues", pr: "pulls", release: "releases" }
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex")
const stamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0

/** 列表接口里与归一化有关的字段；三平台字段名基本一致，缺的按 undefined 处理 */
interface RawPerson {
  login?: unknown
  name?: unknown
  avatar_url?: unknown
}
interface RawItem {
  sha?: unknown
  id?: unknown
  number?: unknown
  iid?: unknown
  tag_name?: unknown
  name?: unknown
  title?: unknown
  html_url?: unknown
  web_url?: unknown
  created_at?: unknown
  published_at?: unknown
  draft?: unknown
  release_status?: unknown
  pull_request?: unknown
  confidential?: unknown
  private?: unknown
  visibility_reason?: unknown
  user?: RawPerson | null
  author?: RawPerson | null
  commit?: { message?: unknown, author?: { name?: unknown, date?: unknown } | null, committer?: { date?: unknown } | null } | null
}
const restricted = (item: RawItem) => item.confidential === true || item.private === true ||
  Boolean(item.visibility_reason && item.visibility_reason !== "public")

/**
 * 归一化官方列表响应中的一条记录；只使用官方站点网页链接
 * @param platform 平台
 * @param repo owner/repo
 * @param type 动态类型
 * @param value 列表中的一项
 * @param privateAccess 是否已获私有仓库授权；未授权时过滤平台标记为私密的条目
 * @returns 动态；属于应过滤的条目（PR 伪装的 Issue、草稿、私密）时 undefined
 */
export function normalizeEvent(platform: Platform, repo: string, type: EventType, value: unknown, privateAccess = false): GitEvent | undefined {
  if (!value || typeof value !== "object") throw new GitError("平台返回了无效的动态记录。", "response")
  const item = value as RawItem
  if ((!privateAccess && restricted(item)) || (type === "issue" && item.pull_request) ||
    (type === "release" && (item.draft || item.release_status === "draft" || item.release_status === "unpublished"))) return undefined
  const rawId = type === "commit" ? item.sha : type === "release" ? item.id ?? item.tag_name : item.number ?? item.iid
  if (rawId == null || String(rawId).length > 256) throw new GitError("平台动态缺少有效编号。", "response")
  const id = String(rawId)
  const time = type === "commit" ? stamp(item.commit?.committer?.date || item.commit?.author?.date) :
    type === "release" ? stamp(item.published_at || item.created_at) : stamp(item.created_at)
  if (type !== "commit" && !time) throw new GitError("平台动态缺少创建或发布时间，暂不推进检查进度。", "response")
  const base = `${PLATFORMS[platform].web}/${repo}`
  const route = type === "commit" ? "commit" :
    type === "pr" ? (platform === "github" ? "pull" : "pulls") : type === "release" ? "releases/tag" : "issues"
  let url = `${base}/${route}/${encodeURIComponent(String(type === "release" ? item.tag_name || id : id))}`
  try {
    const supplied = new URL(String(item.html_url || item.web_url))
    if (supplied.origin === PLATFORMS[platform].web && !supplied.username && !supplied.password) {
      supplied.search = ""
      supplied.hash = ""
      url = supplied.href
    }
  } catch { /* 缺少网页链接时使用官方仓库地址构造。 */ }
  // Issue/PR 的作者在 user，Commit/Release 在 author；GitCode 的 Commit 不带头像，卡片显示首字母。
  const person = type === "issue" || type === "pr" ? item.user : item.author
  return {
    id, type, time, url,
    title: cleanText(type === "commit" ? item.commit?.message : type === "release" ? item.name || item.tag_name : item.title),
    author: cleanText(item.user?.login || item.author?.login || item.author?.name || item.commit?.author?.name || "未知作者", 60),
    avatar: avatarUrl(platform, person?.avatar_url)
  }
}

/** 平台客户端需要的 HTTP 能力，`ctx.http` 满足它 */
export interface ProviderHttp {
  /** 发起请求，返回完整响应 */
  request(url: string, opts?: HttpRequestOptions): Promise<ProviderResponse>
}

/** 平台响应中客户端用到的部分 */
export interface ProviderResponse {
  /** 是否 2xx */
  ok: boolean
  /** 状态码 */
  status?: number
  /** 响应头，键为小写 */
  headers?: Record<string, string>
  /** 解析后的 JSON */
  data: unknown
}

/** 被查询的仓库：订阅满足它 */
export interface RepoTarget {
  /** 平台 */
  readonly platform: Platform
  /** owner/repo */
  readonly repo: string
  /** Commit 分支，空串跟踪默认分支 */
  readonly branch?: string
}

/** 客户端用到的配置项 */
export interface ProviderConfig {
  /** 单次请求超时（秒） */
  readonly timeoutSeconds: number
}

/** 仓库元数据中与权限判断有关的部分 */
export interface RepoMetadata {
  /** 平台明确标记为公开 */
  public: boolean
  /** 默认分支 */
  defaultBranch?: string
}

/** 一页列表 */
export interface PageResult {
  /** 归一化后的动态（已过滤） */
  events: GitEvent[]
  /** 该页原始条数，用于判断是否末页 */
  count: number
}

/** 翻页选项 */
export interface PageOptions {
  /** Commit 扫描固定在这个 SHA 上，避免翻页中途有新提交插入 */
  head?: string | undefined
  /** 是否已获私有仓库授权 */
  privateAccess?: boolean
  /** 中止信号 */
  signal?: AbortSignal | undefined
}

/** 平台客户端 */
export interface Provider {
  /** 开始新一轮检查：清空本轮请求缓存 */
  beginRound(): void
  /** 读取仓库元数据 */
  metadata(row: RepoTarget, token: string, config: ProviderConfig, signal?: AbortSignal): Promise<RepoMetadata>
  /** 读取一页某类动态 */
  page(row: RepoTarget, token: string, config: ProviderConfig, type: EventType, pageNumber: number, options?: PageOptions): Promise<PageResult>
}

/** 退避状态：截止时间与连续失败次数 */
interface Backoff {
  until: number
  failures: number
}

/**
 * 创建官方 API 客户端
 * @param http HTTP 客户端
 * @param options 可注入的时钟
 * @returns 平台客户端
 */
export function createProvider(http: ProviderHttp, { now = Date.now }: { now?: () => number } = {}): Provider {
  const backoffs = new Map<string, Backoff>()
  let cache = new Map<string, Promise<ProviderResponse>>()

  const backoff = (scope: string, previous: Backoff | undefined) => {
    const failures = (previous?.failures || 0) + 1
    const until = now() + Math.min(30_000 * 2 ** Math.min(failures - 1, 7), 3_600_000)
    backoffs.set(scope, { until, failures })
    return until
  }

  function request(row: RepoTarget, token: string, config: ProviderConfig, suffix = "",
    query: NonNullable<HttpRequestOptions["query"]> = {}, signal?: AbortSignal): Promise<ProviderResponse> {
    const scope = `${row.platform}:${fingerprint(token)}`
    const limit = backoffs.get(scope)
    if (limit && limit.until > now()) return Promise.reject(new GitError("平台请求正在退避，稍后自动重试。", "backoff", limit.until))
    const cacheKey = JSON.stringify([repoKey(row), scope, suffix, query])
    const cached = cache.get(cacheKey)
    if (cached) return cached
    const promise = (async () => {
      const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Yunzai-NG-Git-Plugin/0.2" }
      if (token) headers.Authorization = `Bearer ${token}`
      if (row.platform === "github") headers["X-GitHub-Api-Version"] = "2022-11-28"
      const url = `${PLATFORMS[row.platform].api}/repos/${row.repo.split("/").map(encodeURIComponent).join("/")}${suffix}`
      let response: ProviderResponse
      try {
        response = await http.request(url, { headers, query, timeout: config.timeoutSeconds * 1000,
          retry: 0, throwOnError: false, followRedirect: false, signal })
      } catch {
        if (signal?.aborted) throw new GitError("检查已中止。", "aborted")
        throw new GitError("平台请求超时、网络故障或响应无法解析，稍后自动重试。", "network", backoff(scope, limit))
      }
      if (!response.ok) {
        const status = response.status ?? 0
        const h = response.headers || {}
        if (status === 429 || (status === 403 && (h["x-ratelimit-remaining"] === "0" || h["retry-after"]))) {
          const retry = h["retry-after"]
          const until = Math.max(now() + 60_000, Number(h["x-ratelimit-reset"]) * 1000 || 0,
            retry ? (/^\d+$/.test(retry) ? now() + Number(retry) * 1000 : stamp(retry)) : 0)
          backoffs.set(scope, { until, failures: 0 })
          throw new GitError("平台 API 配额不足，等待限流解除后自动重试。", "rate", until)
        }
        if (status >= 500) throw new GitError(`平台暂时不可用（HTTP ${status}）。`, "server", backoff(scope, limit))
        throw new GitError(status === 401 ? "Token 无效或需要认证，请在面板配置。" :
          status === 403 ? "平台拒绝访问，请检查 Token 权限。" : status === 404 ? "仓库或分支不存在，或当前凭据无权访问。" :
            `平台请求失败（HTTP ${status}）。`, String(status))
      }
      backoffs.delete(scope)
      return response
    })()
    cache.set(cacheKey, promise)
    return promise
  }

  return {
    beginRound() { cache = new Map() },

    async metadata(row, token, config, signal) {
      const { data } = await request(row, token, config, "", {}, signal)
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new GitError("仓库信息响应格式不正确。", "response")
      const repo = data as { private?: unknown, public?: unknown, visibility?: unknown, default_branch?: unknown }
      const publicRepo = repo.private === false || repo.public === true || repo.visibility === "public"
      return {
        public: publicRepo && repo.private !== true && repo.visibility !== "private" && repo.visibility !== "internal",
        defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : ""
      }
    },

    async page(row, token, config, type, pageNumber, { head, privateAccess, signal } = {}) {
      const query: NonNullable<HttpRequestOptions["query"]> = { page: pageNumber, per_page: 100 }
      if (type === "commit") query.sha = head || row.branch || undefined
      if (type === "issue" || type === "pr") Object.assign(query, { state: "all", sort: "created", direction: "desc" })
      if (type === "release" && row.platform !== "github") query.direction = "desc"
      let response: ProviderResponse
      try {
        response = await request(row, token, config, `/${paths[type]}`, query, signal)
      } catch (error) {
        // GitHub 的空仓库 commit 接口返回 409；其他 409 不应默认为空。
        if (type === "commit" && errorCode(error) === "409" && row.platform === "github" && !head && !row.branch) return { events: [], count: 0 }
        throw error
      }
      if (!Array.isArray(response.data)) throw new GitError("平台列表响应不是数组，暂不推进检查进度。", "response")
      const events = response.data.map(item => normalizeEvent(row.platform, row.repo, type, item, privateAccess))
        .filter((event): event is GitEvent => event !== undefined)
      return { count: response.data.length, events }
    }
  }
}
