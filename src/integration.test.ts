/**
 * 真实内核端到端：createApp 从磁盘加载本插件，mock 适配器收发消息，面板 API 改配置。
 *
 * 插件源码复制到临时主目录，入口指向 src/index.ts：vitest 下内核与插件都走框架源码，
 * 只有一份 @yunzai-ng/core 实例，也不必先构建 dist。
 * 插件的 ctx.http 被替换为假实现；面板访问仍走真实的框架 HTTP 路由与鉴权。
 */
import { once } from "node:events"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import type { AddressInfo } from "node:net"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createApp } from "@yunzai-ng/core"
import type { App } from "@yunzai-ng/core"
import { createMockAdapter } from "@yunzai-ng/core/testing"
import type { HttpRequestOptions } from "@yunzai-ng/types"
import { subscriptionId } from "./model.js"
import type { GitService } from "./service.js"
import { apiCommit, chats, row } from "./test-helpers.js"

const root = fileURLToPath(new URL("../", import.meta.url))
const TOKEN = "local-panel-test-token"

/** 面板配置接口的响应体 */
interface ConfigResponse {
  schema: { properties: { tokens: { properties: { github: { widget: string } } } } }
  value: { tokens: { github: string }, chats: { targetId: string, remark: string, repos: { repo: string, enabled: boolean }[] }[] }
}

/** 占一个空闲端口再释放，给框架 HTTP 服务用 */
async function freePort(): Promise<number> {
  const server = createServer()
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  await new Promise(done => server.close(done))
  return port
}

it("真实 NG：面板配置、聊天权限、持久化、重载与模拟推送", { timeout: 25_000 }, async () => {
  const base = resolve(tmpdir())
  const home = await mkdtemp(join(base, "git-plugin-test-"))
  const port = await freePort()
  const mock = createMockAdapter()
  const commits = [apiCommit("baseline")]
  const requests: string[] = []
  const fakeHttp = { async request(url: string, _options?: HttpRequestOptions) {
    requests.push(url)
    return { ok: true, status: 200, headers: {}, data: url.endsWith("/commits") ? structuredClone(commits) :
      /\/(issues|pulls|releases)$/.test(url) ? [] : { private: false, default_branch: "main" } }
  } }
  const api = async (method: string, path: string, value?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, { method,
      headers: { "x-yunzai-token": TOKEN, "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) })
    return { status: response.status, data: await response.json() as ConfigResponse }
  }
  let app: App | undefined
  try {
    await mkdir(join(home, "config"), { recursive: true })
    await writeFile(join(home, "config/yunzai.yaml"), `store:\n  driver: memory\n  sqlite: false\nbot:\n  masterQQ: ["owner"]\n` +
      `server:\n  enable: true\n  host: 127.0.0.1\n  port: ${port}\n  token: ${TOKEN}\n`)
    // 破坏性更新：旧 subscriptions 被丢弃，不会自动生成推送会话
    await writeFile(join(home, "config/git-plugin.yaml"), [
      "subscriptions:",
      "  - enabled: true",
      "    remark: 旧版",
      "    platform: github",
      "    repo: owner/legacy",
      "    accountId: legacy-account",
      "    scene: group",
      "    targetId: \"999\"",
      ""
    ].join("\n"))
    const destination = join(home, "plugins/Git-Plugin")
    await cp(join(root, "src"), join(destination, "src"), { recursive: true,
      filter: source => !/\.test\.ts$/.test(source) })
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { yunzai: Record<string, unknown> }
    manifest.yunzai.entry = "src/index.ts"
    await writeFile(join(destination, "package.json"), JSON.stringify(manifest, null, 2))

    app = await createApp({ home, console: false, watchConfig: false, stopTimeout: 1000 })
    // 只替换插件拿到的 ctx.http
    Object.assign(app.http, { extend: () => fakeHttp })
    const report = await app.start()
    expect(report.failed).toEqual([])
    expect(report.loaded).toContain("git-plugin")
    app.runtime.adapters.register(mock.provider, "test-only")
    const account = await app.runtime.accounts.create("mock", { selfId: "bot" })
    let service = app.services.get<GitService>("git-plugin")!
    await service.idle()
    expect(requests).toHaveLength(0)
    const initial = await api("GET", "config/git-plugin")
    expect(initial.status).toBe(200)
    expect(initial.data.schema.properties.tokens.properties.github.widget).toBe("password")
    expect(initial.data.value.chats).toEqual([])
    expect(await readFile(join(home, "config/git-plugin.yaml"), "utf8")).not.toMatch(/^subscriptions:/m)
    const sub = row({ accountId: account.id, events: ["commit"] })
    expect((await api("PATCH", "config/git-plugin", { tokens: { github: "fixture-only-token" }, chats: chats(sub) })).status).toBe(200)
    await service.idle()
    expect((await service.status())[0]?.initialized).toBe(true)
    expect(mock.sent).toHaveLength(0)
    commits.unshift(apiCommit("new-commit", "2000-01-01T00:00:00Z"))
    await service.tick()
    await mock.waitForSend(1)
    expect(mock.last()?.text).toMatch(/new-commit/)
    expect(mock.last()?.target).toMatchObject({ gid: "123" })
    expect(requests.every(url => /^https:\/\/(api\.github\.com|gitee\.com|api\.gitcode\.com)\//.test(url))).toBe(true)

    // 面板改样式、间隔不丢 Token，也不重建游标；没有渲染器时退回文字
    expect((await api("PATCH", "config/git-plugin", { intervalSeconds: 60, chats: chats({ ...sub, format: "image" }) })).status).toBe(200)
    await service.idle()
    expect((await api("GET", "config/git-plugin")).data.value.tokens.github).toBe("fixture-only-token")
    expect(mock.sent).toHaveLength(1)
    commits.unshift(apiCommit("image-fallback"))
    await service.tick()
    expect(mock.sent).toHaveLength(2)
    expect(mock.last()?.text).toMatch(/image-fallback/)
    expect((await api("PATCH", "config/git-plugin", { intervalSeconds: 10 })).status).toBe(400)

    // 非群管不能管理；其他群的管理员不能操作本群订阅
    mock.driver.receiveGroup(`#git取消 ${subscriptionId(sub)}`, { gid: "123", uid: "stranger", role: "member" })
    await expect(mock.waitForSend(3, 100)).rejects.toThrow()
    mock.driver.receiveGroup(`#git取消 ${subscriptionId(sub)}`, { gid: "456", uid: "admin-other", role: "admin" })
    await mock.waitForSend(3)
    expect(mock.last()?.text).toMatch(/权限|不存在/)
    expect(await service.status()).toHaveLength(1)

    // 聊天添加的订阅写进同一份 YAML，面板读得到
    mock.driver.receiveGroup("#git订阅 gitee:owner/another 事件=commit", { gid: "456", uid: "admin", role: "owner" })
    await mock.waitForSend(4)
    await service.idle()
    expect(mock.last()?.text).toMatch(/订阅已保存/)
    const list = (await api("GET", "config/git-plugin")).data.value.chats
    expect(list).toHaveLength(2)
    expect(list[1]?.targetId).toBe("456")
    expect(list[1]?.repos.map(item => item.repo)).toEqual(["owner/another"])
    expect(await readFile(join(home, "config/git-plugin.yaml"), "utf8")).toMatch(/another/)
    expect(mock.texts.join("\n")).not.toContain("fixture-only-token")

    // 暂停不推送；重载后延续状态；删除订阅清理队列
    await api("PATCH", "config/git-plugin", { enabled: false })
    await service.idle()
    commits.unshift(apiCommit("while-paused"))
    await service.tick()
    expect(mock.sent).toHaveLength(4)
    await app.plugins.unload("git-plugin")
    expect(app.services.get("git-plugin")).toBeUndefined()
    expect(await app.plugins.reload("git-plugin")).toBe(true)
    service = app.services.get<GitService>("git-plugin")!
    await service.idle()
    expect((await service.status())[0]?.initialized).toBe(true)
    await api("PATCH", "config/git-plugin", { enabled: true, chats: chats(sub) })
    await service.idle()
    expect(mock.sent).toHaveLength(5)
    expect(mock.last()?.text).toMatch(/while-paused/)
    await api("PATCH", "config/git-plugin", { chats: [], tokens: { github: "" } })
    await service.idle()
    expect(await service.status()).toEqual([])
    expect((await api("GET", "config/git-plugin")).data.value.tokens.github).toBe("")
  } finally {
    await app?.stop()
    // 只删系统临时目录里的这一份，路径异常时宁可留下垃圾
    const target = resolve(home)
    if (target.startsWith(base + sep)) await rm(target, { recursive: true, force: true })
  }
})
