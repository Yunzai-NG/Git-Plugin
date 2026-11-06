import { describe, expect, it } from "vitest"
import type { HttpRequestOptions } from "@yunzai-ng/types"
import { avatarUrl, createAvatarLoader } from "./avatars.js"
import type { AvatarContext } from "./avatars.js"
import { cardPage } from "./display.js"
import { event, row } from "./test-helpers.js"

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
const GITHUB = "https://avatars.githubusercontent.com/u/1?v=4"
const GITEE = "https://foruda.gitee.com/avatar/1/1_user_1.png"

/** 记录请求的头像上下文；responder 决定每个 URL 的响应 */
function context(responder: (url: string) => { ok: boolean, data: unknown } | Error) {
  const calls: { url: string, options: HttpRequestOptions | undefined }[] = []
  const ctx = {
    http: { async request(url: string, options?: HttpRequestOptions) {
      calls.push({ url, options })
      const response = responder(url)
      if (response instanceof Error) throw response
      return response
    } },
    cache: () => { const map = new Map<string, unknown>(); return { get: (key: string) => map.get(key), set: (key: string, value: unknown) => { map.set(key, value) } } }
  }
  return { ctx: ctx as unknown as AvatarContext, calls }
}

describe("avatarUrl", () => {
  it("只接受各平台官方头像 CDN 上的 HTTPS 地址", () => {
    expect(avatarUrl("github", GITHUB)).toBe(GITHUB)
    expect(avatarUrl("gitee", GITEE)).toBe(GITEE)
    expect(avatarUrl("gitcode", "https://cdn-img.gitcode.com/ab/cd/x.jpg")).toBe("https://cdn-img.gitcode.com/ab/cd/x.jpg")
    for (const bad of ["http://avatars.githubusercontent.com/u/1", "https://user:pw@avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com:8443/u/1", "https://evil.example/a.png", "javascript:alert(1)", ""]) {
      expect(avatarUrl("github", bad)).toBe("")
    }
    // 主机要与平台对应；Gitee 的默认头像改用首字母
    expect(avatarUrl("gitcode", GITHUB)).toBe("")
    expect(avatarUrl("gitee", "https://gitee.com/assets/no_portrait.png")).toBe("")
    expect(avatarUrl("github", 42)).toBe("")
  })
})

describe("createAvatarLoader", () => {
  it("下载缩略图转成 data URI；不带 Token、不跟随重定向；结果缓存", async () => {
    const { ctx, calls } = context(() => ({ ok: true, data: PNG }))
    const loader = createAvatarLoader(ctx)
    const events = [{ ...event("1"), avatar: GITHUB }, { ...event("2"), avatar: GITHUB }]
    const result = await loader.load(events)
    expect(result.get(GITHUB)).toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`)
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0]!.url).searchParams.get("s")).toBe("96")
    expect(calls[0]?.options?.headers?.Authorization).toBeUndefined()
    expect(calls[0]?.options?.followRedirect).toBe(false)
    expect(calls[0]?.options?.responseType).toBe("buffer")
    await loader.load(events)
    expect(calls).toHaveLength(1)
  })

  it("Gitee 缩略图不可用时退回原图", async () => {
    const { ctx, calls } = context(url => url.endsWith("!avatar100") ? { ok: false, data: new Uint8Array() } : { ok: true, data: PNG })
    const result = await createAvatarLoader(ctx).load([{ ...event("1"), avatar: GITEE }])
    expect(calls.map(call => call.url)).toEqual([`${GITEE}!avatar100`, GITEE])
    expect(result.has(GITEE)).toBe(true)
  })

  it("SVG、超过大小上限与网络失败都不显示；失败 10 分钟内不重试", async () => {
    const svg = new TextEncoder().encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><script/></svg>")
    const huge = new Uint8Array(300 * 1024)
    huge.set(PNG)
    let response: { ok: boolean, data: unknown } | Error = { ok: true, data: svg }
    const { ctx, calls } = context(() => response)
    const loader = createAvatarLoader(ctx)
    const events = [{ ...event("1"), avatar: GITHUB }]
    expect((await loader.load(events, 0)).size).toBe(0)
    response = { ok: true, data: huge }
    expect((await loader.load(events, 60_000)).size).toBe(0)
    expect(calls).toHaveLength(1)
    expect((await loader.load(events, 11 * 60_000)).size).toBe(0)
    response = new Error("network")
    expect((await loader.load(events, 22 * 60_000)).size).toBe(0)
    response = { ok: true, data: PNG }
    expect((await loader.load(events, 33 * 60_000)).size).toBe(1)
    expect(calls).toHaveLength(4)
  })

  it("队列里不合格的旧地址不下载", async () => {
    const { ctx, calls } = context(() => ({ ok: true, data: PNG }))
    const result = await createAvatarLoader(ctx).load([{ ...event("1"), avatar: "https://evil.example/a.png" }, { ...event("2"), avatar: "" }, event("3")])
    expect(result.size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe("cardPage 头像", () => {
  it("有头像时嵌入 data URI，没有时显示转义后的首字母；同批同作者可借用头像", () => {
    const data = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`
    const events = [
      { ...event("1", "pr"), author: "alice", avatar: GITHUB },
      { ...event("2"), author: "alice", avatar: "" },
      { ...event("3", "issue"), author: "<b>", avatar: "" }
    ]
    const html = cardPage(row(), events, { avatars: new Map([[GITHUB, data]]) }).html
    expect(html.split(`src="${data}"`)).toHaveLength(3)
    expect(html).toContain("class=\"face initial\"")
    expect(html).toContain("&lt;</span>")
    expect(html).not.toContain(GITHUB)
  })
})
