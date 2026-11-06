/**
 * 模块职责：作者头像 —— 校验平台返回的头像地址、下载并转成 data URI 供卡片嵌入
 * 依赖方向：仅依赖 `@yunzai-ng/types` 的类型
 * 生命周期：加载器随服务创建，缓存在首次使用时向 `ctx.cache` 申请，随插件卸载清空
 * 注意事项：头像在插件侧下载而不是交给渲染器去拉：渲染器联网慢或不通时整张卡会超时，
 *          而这里取不到只是退回首字母。只访问官方头像 CDN，不携带 Token，不跟随重定向；
 *          按文件头判断类型，不接受 SVG（SVG 能带脚本）。
 */
import type { ContactCache, ContactCacheOptions, HttpRequestOptions } from "@yunzai-ng/types"
import type { GitEvent, Platform } from "./model.js"

/** 各平台头像 CDN。Gitee 的 no_portrait 占位图在 gitee.com 上，不在其中，改用首字母 */
const HOSTS: Readonly<Record<Platform, readonly string[]>> = {
  github: ["avatars.githubusercontent.com"],
  gitee: ["foruda.gitee.com"],
  gitcode: ["cdn-img.gitcode.com"]
}
const MAX_BYTES = 200 * 1024
const TIMEOUT = 5_000
const RETRY_AFTER = 10 * 60_000

/** 头像下载所需的 HTTP 能力，`ctx.http` 满足它 */
export interface AvatarHttp {
  /** 发起请求，返回完整响应 */
  request(url: string, opts?: HttpRequestOptions): Promise<{ ok: boolean, data: unknown }>
}

/** 头像加载器需要的插件能力，`PluginContext` 满足它 */
export interface AvatarContext {
  /** HTTP 客户端 */
  readonly http: AvatarHttp
  /** 创建 LRU+TTL 缓存 */
  cache<V>(opts: ContactCacheOptions): ContactCache<V>
}

/** 头像加载器 */
export interface AvatarLoader {
  /** 返回 头像地址 → data URI；取不到的地址不在结果里 */
  load(events: readonly GitEvent[], now?: number): Promise<Map<string, string>>
}

/**
 * 校验平台返回的头像地址：仅 HTTPS、仅官方头像 CDN、无凭据与端口
 * @param platform 平台
 * @param value 平台返回的 avatar_url
 * @returns 合格时为规范化地址，否则空串
 */
export function avatarUrl(platform: Platform, value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 500) return ""
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.port || !HOSTS[platform].includes(url.hostname)) return ""
    url.hash = ""
    return url.href
  } catch { return "" }
}

/** 任一平台的合格头像地址；队列里的旧记录也要过这一关才下载 */
const trusted = (value: string | undefined): value is string =>
  Boolean(value) && (Object.keys(HOSTS) as Platform[]).some(platform => avatarUrl(platform, value) === value)

/** 请求平台缩略图以减小下载量；失败时调用方会再试原图 */
function sized(href: string): string {
  const url = new URL(href)
  if (url.hostname === "avatars.githubusercontent.com") { url.searchParams.set("s", "96"); return url.href }
  if (url.hostname === "foruda.gitee.com" && !url.pathname.includes("!")) { url.pathname += "!avatar100"; return url.href }
  return href
}

/** 按文件头判断图片类型；不信任响应头，也不接受 SVG */
function sniff(bytes: Uint8Array): string {
  if (bytes.length < 12) return ""
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  if (bytes[0] === 0x89 && ascii(1, 4) === "PNG") return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (ascii(0, 3) === "GIF") return "image/gif"
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp"
  return ""
}

/** 缓存条目：成功时有 data；失败时 data 为空串，retryAt 之前不再重试 */
interface Entry {
  data: string
  retryAt: number
}

/**
 * 创建头像加载器：成功缓存 6 小时；失败 10 分钟内不再重试，期间显示首字母
 * @param ctx 插件上下文
 * @returns 头像加载器
 */
export function createAvatarLoader(ctx: AvatarContext): AvatarLoader {
  let store: ContactCache<Entry> | undefined
  const cache = () => (store ??= ctx.cache<Entry>({ max: 64, ttl: "6h" }))

  async function download(href: string): Promise<string> {
    for (const url of new Set([sized(href), href])) {
      try {
        const response = await ctx.http.request(url, { responseType: "buffer", timeout: TIMEOUT, retry: 0,
          throwOnError: false, followRedirect: false, headers: { "User-Agent": "Yunzai-NG-Git-Plugin/0.3" } })
        if (!response.ok || !(response.data instanceof Uint8Array)) continue
        const bytes = Buffer.from(response.data)
        const mime = bytes.length <= MAX_BYTES ? sniff(bytes) : ""
        return mime ? `data:${mime};base64,${bytes.toString("base64")}` : ""
      } catch { return "" }
    }
    return ""
  }

  return {
    async load(events, now = Date.now()) {
      const urls = [...new Set(events.map(event => event.avatar).filter(trusted))]
      const result = new Map<string, string>()
      await Promise.all(urls.map(async url => {
        let entry = cache().get(url)
        if (!entry || (!entry.data && entry.retryAt <= now)) {
          entry = { data: await download(url), retryAt: now + RETRY_AFTER }
          cache().set(url, entry)
        }
        if (entry.data) result.set(url, entry.data)
      }))
      return result
    }
  }
}
