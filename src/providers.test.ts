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

describe("Commit 详情", () => {
  it("第一行为标题，正文保留换行；清理控制字符并限制长度", () => {
    const raw = apiCommit("new")
    raw.commit.message = "feat: 新功能\r\n\r\n详细说明\r\n- 新增 A\u0000\n- 删除 B"
    const parsed = normalizeEvent("github", "a/b", "commit", raw)!
    expect(parsed.title).toBe("feat: 新功能")
    expect(parsed.description).toBe("详细说明\n- 新增 A\n- 删除 B")
    raw.commit.message = "title\n\n" + "x".repeat(5000)
    expect(normalizeEvent("github", "a/b", "commit", raw)?.description).toHaveLength(2048)
    expect(normalizeEvent("github", "a/b", "commit", apiCommit("single"))?.description).toBe("")
  })

  it("三平台按 SHA 查询详情并共用同轮请求；保留完整统计、前 8 个文件，不存 patch", async () => {
    for (const platform of PLATFORM_KEYS) {
      const calls: { url: string, options?: HttpRequestOptions }[] = []
      const raw = { ...apiCommit("new"), stats: { additions: 241, deletions: 100 },
        files: Array.from({ length: 14 }, (_, index) => ({ filename: `src/file-${index}.ts`, additions: index, deletions: 1,
          ...(index === 0 ? { previous_filename: "src/old.ts" } : {}), patch: "very large diff" })) }
      raw.commit.message = "feat!: 新功能\n\n详细说明\n\nBREAKING CHANGE: 配置改变"
      const provider = createProvider({ async request(url, options) {
        calls.push({ url, options })
        return { ok: true, headers: {}, data: raw }
      } })
      const original = normalizeEvent(platform, "owner/repo", "commit", apiCommit("new"))!
      const [first, second] = await Promise.all([
        provider.commitDetail(row({ platform }), "secret", config, original),
        provider.commitDetail(row({ platform, targetId: "456" }), "secret", config, original)
      ])
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(`${PLATFORMS[platform].api}/repos/owner/repo/commits/new`)
      expect(calls[0]?.options?.headers?.Authorization).toBe("Bearer secret")
      expect(calls[0]?.options?.followRedirect).toBe(false)
      expect(first.title).toBe("feat!: 新功能")
      expect(first.description).toBe("详细说明\n\nBREAKING CHANGE: 配置改变")
      expect(first.changes).toMatchObject({ additions: 241, deletions: 100, fileCount: 14, filesTruncated: true })
      expect(first.changes?.files).toHaveLength(8)
      expect(first.changes?.files[0]).toEqual({ filename: "src/file-0.ts", previousFilename: "src/old.ts", additions: 0, deletions: 1 })
      expect(JSON.stringify(first)).not.toContain("very large diff")
      expect(first).toEqual(second)
      expect(first.commitDetailsLoaded).toBe(true)
      expect(original.commitDetailsLoaded).toBeUndefined()
      provider.beginRound()
      await provider.commitDetail(row({ platform }), "secret", config, first)
      expect(calls).toHaveLength(1)
    }
  })

  it("文件分页或平台截断时不谎报总数；未知行数、负数不是零", async () => {
    const headersList: Record<string, string>[] = [{ link: '<https://api.github.com/next>; rel="next"' }, {}]
    for (const headers of headersList) {
      const provider = createProvider({ async request() {
        return { ok: true, headers, data: { ...apiCommit("new"), truncated: !headers.link,
          stats: { additions: -1, deletions: "100" }, files: [{ filename: "image.png" }, { filename: "zero.ts", additions: 0, deletions: 0 }] } }
      } })
      const result = await provider.commitDetail(row(), "", config, normalizeEvent("github", "owner/repo", "commit", apiCommit("new"))!)
      expect(result.changes).toMatchObject({ fileCount: undefined, additions: undefined, deletions: undefined, filesTruncated: true })
      expect(result.changes?.files[0]?.additions).toBeUndefined()
      expect(result.changes?.files[1]?.additions).toBe(0)
    }
  })

  it("详情格式错误、SHA 不匹配、网络失败都不会变成有效统计", async () => {
    for (const data of [[], { private: false }, { ...apiCommit("other"), stats: { additions: 1, deletions: 1 } }]) {
      const provider = createProvider({ request: async () => ({ ok: true, data }) })
      await expect(provider.commitDetail(row(), "", config, normalizeEvent("github", "owner/repo", "commit", apiCommit("new"))!)).rejects.toThrow()
    }
  })
})
