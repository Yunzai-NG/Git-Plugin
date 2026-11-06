import { describe, expect, it } from "vitest"
import { configSchema } from "./config.js"
import { GitError, PLATFORMS, PLATFORM_KEYS, parseRepo } from "./model.js"
import { createProvider, normalizeEvent } from "./providers.js"
import type { ProviderResponse } from "./providers.js"
import type { HttpRequestOptions } from "@yunzai-ng/types"
import { apiCommit, row } from "./test-helpers.js"

const config = configSchema.parse({})

/** 取出被拒绝的 GitError，便于逐项断言 */
async function caught(promise: Promise<unknown>): Promise<GitError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GitError) return error
    throw error
  }
  throw new Error("预期抛出 GitError")
}

describe("createProvider", () => {
  it("三个官方 API：认证、分页、创建时间排序、分支与本轮去重", async () => {
    for (const platform of PLATFORM_KEYS) {
      const calls: { url: string, options: HttpRequestOptions | undefined }[] = []
      const http = { async request(url: string, options?: HttpRequestOptions): Promise<ProviderResponse> {
        calls.push({ url, options })
        return { ok: true, headers: {}, data: url.endsWith("/issues") ? [{ number: 1, created_at: "2026-01-01T00:00:00Z" }] : [apiCommit("abc")] }
      } }
      const provider = createProvider(http)
      const sub = row({ platform, branch: "feature/a" })
      const result = await provider.page(sub, "secret", config, "commit", 2)
      await provider.page(sub, "secret", config, "commit", 2)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(`${PLATFORMS[platform].api}/repos/owner/repo/commits`)
      expect(calls[0]?.options?.query).toEqual({ page: 2, per_page: 100, sha: "feature/a" })
      expect(calls[0]?.options?.headers?.Authorization).toBe("Bearer secret")
      expect(calls[0]?.options?.followRedirect).toBe(false)
      expect(result.events[0]?.id).toBe("abc")
      provider.beginRound()
      await provider.page(sub, "different-secret", config, "commit", 2)
      expect(calls).toHaveLength(2)
      await provider.page(sub, "secret", config, "issue", 1)
      expect(calls[2]?.options?.query?.sort).toBe("created")
      expect(calls[2]?.options?.query?.state).toBe("all")
    }
  })

  it("限流按服务端时间退避，不忙等重试，也不泄漏响应里的密钥", async () => {
    let clock = 1000
    let calls = 0
    const client = createProvider({ async request() {
      calls++
      return { ok: false, status: 429, headers: { "retry-after": "120" }, data: { message: "secret-token" } }
    } }, { now: () => clock })
    const limited = await caught(client.metadata(row(), "secret-token", config))
    expect(limited.retryAt).toBe(121000)
    expect(limited.message).not.toContain("secret-token")
    client.beginRound()
    expect((await caught(client.metadata(row(), "secret-token", config))).code).toBe("backoff")
    expect(calls).toBe(1)
    clock = 122000
    await expect(client.metadata(row(), "secret-token", config)).rejects.toThrow()
    expect(calls).toBe(2)
  })

  it("拒绝不可信的仓库输入与格式错误的成功响应", async () => {
    expect(parseRepo("https://gitcode.com/owner/repo.git")).toEqual({ platform: "gitcode", repo: "owner/repo" })
    for (const input of ["https://github.com.evil/a/b", "http://gitee.com/a/b", "https://secret@github.com/a/b", "github:../repo", "github:a/b/issues"]) {
      expect(() => parseRepo(input)).toThrow()
    }
    const provider = createProvider({ request: async () => ({ ok: true, data: { message: "bad" } }) })
    await expect(provider.page(row(), "", config, "issue", 1)).rejects.toThrow(/不是数组/)
    expect(() => normalizeEvent("github", "a/b", "issue", { number: 1 })).toThrow(/缺少创建/)
  })
})

describe("normalizeEvent", () => {
  it("排除 PR 伪装的 Issue、私密条目与草稿；保留已发布的预发布版", () => {
    const item = { number: "IABC", title: "<b>issue</b>", created_at: "2026-01-01T00:00:00Z", user: { login: "user" } }
    for (const platform of PLATFORM_KEYS) {
      expect(normalizeEvent(platform, "owner/repo", "issue", { ...item, pull_request: {} })).toBeUndefined()
      expect(normalizeEvent(platform, "owner/repo", "issue", { ...item, visibility_reason: "confidential" })).toBeUndefined()
      expect(normalizeEvent(platform, "owner/repo", "issue", { ...item, confidential: true }, true)?.id).toBe("IABC")
      const release = { ...item, id: 2, tag_name: "v2", published_at: "2026-02-01T00:00:00Z", prerelease: true }
      expect(normalizeEvent(platform, "owner/repo", "release", { ...release, draft: true })).toBeUndefined()
      expect(normalizeEvent(platform, "owner/repo", "release", release)?.time).toBe(Date.parse(release.published_at))
      const parsed = normalizeEvent(platform, "owner/repo", "issue", { ...item, html_url: "javascript:alert(1)" })
      expect(parsed?.url.startsWith(PLATFORMS[platform].web)).toBe(true)
    }
  })

  it("按类型取作者头像：Issue/PR 取 user，Commit/Release 取 author；只收官方头像 CDN", () => {
    const github = "https://avatars.githubusercontent.com/u/1?v=4"
    const created_at = "2026-01-01T00:00:00Z"
    expect(normalizeEvent("github", "a/b", "issue", { number: 1, created_at, user: { login: "u", avatar_url: github } })?.avatar).toBe(github)
    expect(normalizeEvent("github", "a/b", "pr", { number: 1, created_at, user: { login: "u", avatar_url: github } })?.avatar).toBe(github)
    expect(normalizeEvent("github", "a/b", "release", { id: 1, tag_name: "v1", created_at, author: { login: "u", avatar_url: github } })?.avatar).toBe(github)
    expect(normalizeEvent("github", "a/b", "commit", { ...apiCommit("x"), author: { login: "u", avatar_url: github } })?.avatar).toBe(github)
    // GitHub 上未关联账号的 Commit：author 为 null
    expect(normalizeEvent("github", "a/b", "commit", { ...apiCommit("x"), author: null })?.avatar).toBe("")
    // GitCode 的 Commit 作者对象不带头像
    expect(normalizeEvent("gitcode", "a/b", "commit", { ...apiCommit("x"), author: { login: "u", name: "U" } })?.avatar).toBe("")
    // 非官方 CDN、Gitee 默认头像一律丢弃
    expect(normalizeEvent("github", "a/b", "issue", { number: 1, created_at, user: { avatar_url: "https://evil.example/a.png" } })?.avatar).toBe("")
    expect(normalizeEvent("gitee", "a/b", "issue", { number: 1, created_at, user: { avatar_url: "https://gitee.com/assets/no_portrait.png" } })?.avatar).toBe("")
  })
})
