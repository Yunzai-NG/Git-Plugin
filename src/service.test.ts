import { describe, expect, it } from "vitest"
import type { GitConfigInput } from "./config.js"
import { configSchema } from "./config.js"
import { cardPage, messageContent } from "./display.js"
import plugin from "./index.js"
import { GitError, PLATFORM_KEYS, subscriptionId } from "./model.js"
import { createProvider } from "./providers.js"
import type { RepoMetadata } from "./providers.js"
import { createGitService } from "./service.js"
import type { GitService, SubState } from "./service.js"
import { apiCommit, event, fakeProvider, harness, row } from "./test-helpers.js"

describe("配置 schema", () => {
  it("面板可见 Token、订阅、目标、样式与授权，并给出有用的校验", () => {
    const schema = configSchema.describe()
    expect(schema.properties?.tokens?.properties?.github?.widget).toBe("password")
    expect(schema.properties?.tokens?.properties?.gitcode?.secret).toBe(true)
    expect(schema.properties?.subscriptions?.items?.properties?.events?.widget).toBe("multiselect")
    expect(schema.properties?.subscriptions?.items?.properties?.scene?.enum).toHaveLength(2)
    expect(() => configSchema.parse({ intervalSeconds: 59 })).toThrow()
    expect(() => configSchema.parse({ subscriptions: [row(), row()] })).toThrow(/不能重复/)
    expect(() => configSchema.parse({ subscriptions: [row({ credential: "missing" })] })).toThrow(/不存在的凭据/)
  })
})

describe("createGitService", () => {
  it("队列跨失败与重启保留；各接收方互不影响，已确认的不重发", async () => {
    const a = row({ events: ["commit"] }), b = row({ targetId: "456", events: ["commit"] })
    const h = harness({ subscriptions: [a, b] })
    const provider = fakeProvider({ commit: [event("old")] })
    let service = createGitService(h.ctx, { provider, now: () => 1000 })
    await service.tick()
    expect(h.sent).toHaveLength(0)
    provider.lists.commit.unshift(event("new"))
    const send = h.bot.sendMessage
    h.bot.sendMessage = async (target, content) => target.scene === "group" && target.gid === "456" ? { ok: false } : send(target, content)
    await service.tick()
    expect(h.sent).toHaveLength(1)
    expect((await service.status())[1]?.pending).toBe(1)
    h.bot.sendMessage = send
    service = createGitService(h.ctx, { provider, now: () => 2000 })
    await service.tick()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]?.target).toMatchObject({ gid: "456" })
    expect((await service.status()).every(item => item.pending === 0)).toBe(true)
    await service.tick()
    expect(h.sent).toHaveLength(2)
  })

  it("离线、暂停、删除与身份变化遵循面板配置；改样式与 Token 保留基线", async () => {
    const sub = row({ events: ["commit"] })
    const h = harness({ subscriptions: [sub], tokens: { github: "one" } })
    const provider = fakeProvider({ commit: [event("old")] })
    const service = createGitService(h.ctx, { provider })
    await service.tick()
    h.bot.online = false
    provider.lists.commit.unshift(event("new"))
    await service.tick()
    expect((await service.status())[0]?.pending).toBe(1)
    await h.ctx.config.patch({ subscriptions: [{ ...sub, enabled: false }] })
    h.bot.online = true
    await service.tick()
    expect(h.sent).toHaveLength(0)
    await h.ctx.config.patch({ subscriptions: [{ ...sub, format: "image", remark: "new remark" }], tokens: { github: "two" } })
    await service.tick()
    expect(h.sent).toHaveLength(1)
    expect(h.warnings.some(line => /渲染失败/.test(line))).toBe(true)
    expect((await service.status())[0]?.initialized).toBe(true)
    await h.ctx.config.patch({ subscriptions: [{ ...sub, branch: "other" }] })
    await service.tick()
    expect(h.persisted.has(`subscription:${subscriptionId(sub)}`)).toBe(false)
    expect(h.sent).toHaveLength(1)
    await h.ctx.config.patch({ subscriptions: [] })
    await service.tick()
    expect(h.persisted.size).toBe(0)
  })

  it("私有仓库要求显式且匹配的授权；撤销授权时清掉私有待发", async () => {
    const sub = row({ events: ["commit"], credential: "private" })
    const grant: GitConfigInput["privateRepositories"][number] = { platform: "github", repo: sub.repo, credential: "private",
      targets: [{ accountId: sub.accountId, scene: sub.scene, targetId: sub.targetId }] }
    const h = harness({ subscriptions: [sub], credentials: [{ name: "private", platform: "github", token: "secret" }] })
    const provider = fakeProvider({ commit: [event("old")] })
    provider.metadata = async (_row, token) => { if (!token) throw new GitError("无访问权限", "404"); return { public: false } }
    const service = createGitService(h.ctx, { provider })
    await service.tick()
    expect(provider.calls).toHaveLength(0)
    await h.ctx.config.patch({ privateRepositories: [grant] })
    await service.tick()
    expect((await service.status())[0]?.initialized).toBe(true)
    h.bot.online = false
    provider.lists.commit.unshift(event("secret-new"))
    await service.tick()
    expect((await service.status())[0]?.pending).toBe(1)
    await h.ctx.config.patch({ privateRepositories: [] })
    h.bot.online = true
    await service.tick()
    expect((await service.status())[0]?.pending).toBe(0)
    expect(h.sent).toHaveLength(0)
    expect(h.warnings.join("\n")).not.toContain("secret")
  })

  it("新增的事件类型单独建立基线；关掉的类型移除其待发", async () => {
    const sub = row({ events: ["commit"] })
    const h = harness({ subscriptions: [sub] })
    const provider = fakeProvider({ commit: [event("old")], issue: [event("history", "issue", 100)] })
    const service = createGitService(h.ctx, { provider, now: () => 1000 })
    await service.tick()
    await h.ctx.config.patch({ subscriptions: [{ ...sub, events: ["commit", "issue"] }] })
    await service.tick()
    expect(h.sent).toHaveLength(0)
    provider.lists.issue.unshift(event("new", "issue", 2000))
    h.bot.online = false
    await service.tick()
    expect((await service.status())[0]?.pending).toBe(1)
    await h.ctx.config.patch({ subscriptions: [sub] })
    await service.tick()
    expect((await service.status())[0]?.pending).toBe(0)
  })

  it("GitCode 带认证读公开仓库元数据可用；可读的私有仓库仍需授权", async () => {
    const sub = row({ platform: "gitcode", events: ["commit"] })
    const h = harness({ subscriptions: [sub], tokens: { gitcode: "secret" } })
    const provider = fakeProvider({ commit: [event("baseline")] })
    let isPublic = true
    provider.metadata = async (_row, token) => {
      if (!token) throw new GitError("需要认证", "401")
      return { public: isPublic }
    }
    const service = createGitService(h.ctx, { provider })
    await service.tick()
    expect((await service.status())[0]?.initialized).toBe(true)
    isPublic = false
    provider.lists.commit.unshift(event("private-new"))
    await service.tick()
    expect(h.sent).toHaveLength(0)
    expect((await service.status())[0]?.error).toMatch(/非公开/)
  })

  it("摘要分批投递并保留余量；持久化失败时不发送未落盘的数据", async () => {
    const h = harness({ subscriptions: [row({ events: ["commit"] })] })
    const provider = fakeProvider({ commit: [event("old")] })
    const service = createGitService(h.ctx, { provider })
    await service.tick()
    provider.lists.commit = [...Array.from({ length: 35 }, (_, index) => event(index)), event("old")]
    const set = h.fake.kv.set
    h.fake.kv.set = async (key, value) => {
      if ((value as SubState).pending.length) throw new Error("disk failure secret")
      await set(key, value)
    }
    await service.tick()
    expect(h.sent).toHaveLength(0)
    h.fake.kv.set = set
    await service.tick()
    expect(h.sent).toHaveLength(3)
    expect((await service.status())[0]?.pending).toBe(5)
    await service.tick()
    expect(h.sent).toHaveLength(4)
    expect((await service.status())[0]?.pending).toBe(0)
  })

  it("手动与定时检查共用一把锁；配置变化让过期的发送作废", async () => {
    const h = harness({ subscriptions: [row({ events: ["commit"] })] })
    const provider = fakeProvider({ commit: [event("old")] })
    const service = createGitService(h.ctx, { provider })
    await service.tick()
    provider.lists.commit.unshift(event("new"))
    const gate: { release?: (value: RepoMetadata) => void } = {}
    provider.metadata = () => new Promise(resolve => { gate.release = resolve })
    const running = service.tick()
    // 等异步的 KV 对账走到 metadata
    while (!gate.release) await new Promise(resolve => setTimeout(resolve, 1))
    expect((await service.tick()).busy).toBe(true)
    await h.ctx.config.patch({ enabled: false })
    gate.release({ public: true })
    await running
    expect(h.sent).toHaveLength(0)
  })

  it("中止的上下文在进行中的检查之后不再发送或修改", async () => {
    const sub = row({ events: ["commit"] })
    const h = harness({ subscriptions: [sub] })
    const provider = fakeProvider({ commit: [event("old")] })
    const service = createGitService(h.ctx, { provider })
    await service.tick()
    provider.lists.commit.unshift(event("new"))
    const original = provider.page
    provider.page = async (...args) => { const result = await original(...args); h.controller.abort(); return result }
    await service.tick()
    expect(h.sent).toHaveLength(0)
    await expect(service.update(subscriptionId(sub), () => true, undefined)).rejects.toThrow(/卸载/)
  })

  it("三个平台的四类动态一起工作：同仓库共用请求，私密条目被过滤", async () => {
    for (const platform of PLATFORM_KEYS) {
      const subscriptions = [row({ platform }), row({ platform, targetId: "456" })]
      const h = harness({ subscriptions })
      const data: Record<string, Record<string, unknown>[]> = { commits: [apiCommit("old")], issues: [], pulls: [], releases: [] }
      let calls = 0
      const provider = createProvider({ async request(url) {
        calls++
        const endpoint = url.split("/").at(-1) ?? ""
        return { ok: true, status: 200, headers: {}, data: structuredClone(data[endpoint] ?? { private: false }) }
      } })
      const service = createGitService(h.ctx, { provider, now: () => Date.parse("2026-01-01T00:00:00Z") })
      await service.tick()
      // 元数据加四个列表，两个接收方共用
      expect(calls).toBe(5)
      data.commits!.unshift(apiCommit("new"))
      const created_at = "2026-02-01T00:00:00Z"
      data.issues = [{ number: 1, title: "new issue", created_at }, { number: 2, created_at, pull_request: {} }, { number: 3, created_at, confidential: true }]
      data.pulls = [{ number: 2, title: "new pull", created_at }]
      data.releases = [{ tag_name: "v1", name: "release", created_at, prerelease: true }, { tag_name: "draft", created_at, draft: true }]
      await service.tick()
      expect(h.sent).toHaveLength(2)
      for (const item of h.sent) {
        expect(item.content).toMatch(/新 Commit/)
        expect(item.content).toMatch(/新 Issue/)
        expect(item.content).toMatch(/新 PR/)
        expect(item.content).toMatch(/新 Release/)
        expect(item.content).not.toMatch(/draft|#3/)
      }
      Object.assign(data.issues[0]!, { state: "closed", updated_at: "2026-03-01T00:00:00Z" })
      Object.assign(data.pulls[0]!, { merged_at: "2026-03-01T00:00:00Z" })
      await service.tick()
      expect(h.sent).toHaveLength(2)
    }
  })
})

describe("插件入口", () => {
  it("间隔变化只重建一次定时任务；卸载后注销监听；没有订阅时不联网", async () => {
    const h = harness()
    await plugin.setup(h.plugin)
    const service = h.services.get("git-plugin") as GitService
    await service.idle()
    expect(h.tasks).toHaveLength(1)
    await h.ctx.config.patch({ intervalSeconds: 60 })
    await service.idle()
    expect(h.tasks[0]?.disposed).toBe(true)
    expect(h.tasks[1]?.interval).toBe(60_000)
    await h.ctx.config.patch({ tokens: { github: "secret" } })
    await service.idle()
    expect(h.tasks).toHaveLength(2)
    h.dispose()
    expect(h.tasks[1]?.disposed).toBe(true)
    await h.ctx.config.patch({ intervalSeconds: 120 })
    expect(h.tasks).toHaveLength(2)
  })
})

describe("messageContent", () => {
  it("图片与文字样式都转义并限长，链接可用；渲染失败时退回文字", async () => {
    const sub = row({ format: "image" })
    const events = [{ ...event("1"), title: "<script>alert(1)</script>" + "x".repeat(1000) }]
    const page = cardPage(sub, events)
    expect(page.html).not.toContain("<script>")
    expect(page.html).toContain("&lt;script&gt;")
    const h = harness()
    const fallback = await messageContent(h.ctx, sub, h.ctx.config.get(), events)
    expect(typeof fallback).toBe("string")
    expect(fallback).toContain(events[0]!.url)
    h.fake.render = async () => ({ type: "image", file: { kind: "buffer", data: Buffer.from("png") } })
    const content = await messageContent(h.ctx, sub, h.ctx.config.get(), events)
    expect(Array.isArray(content)).toBe(true)
    const [image, links] = content as readonly unknown[]
    expect(image).toMatchObject({ type: "image" })
    expect(links).toContain(events[0]!.url)
  })
})
