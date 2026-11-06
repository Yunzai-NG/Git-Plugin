import { describe, expect, it } from "vitest"
import { cardPage, messageContent, subscriptionListMessages, subscriptionListPage, textDigest } from "./display.js"
import type { GitEvent } from "./model.js"
import type { StatusEntry } from "./service.js"
import { event, harness, row } from "./test-helpers.js"

const commit = (): GitEvent => ({ ...event("abcdef0123456789"), title: "feat!: 标题不混进正文",
  description: "这是详细内容\n\n- 添加会话设置\n- 删除旧配置",
  changes: { additions: 241, deletions: 100, fileCount: 14, filesTruncated: true,
    files: [{ filename: "src/config.ts", additions: 46, deletions: 16 },
      { filename: "src/new.ts", previousFilename: "src/old.ts", additions: 0, deletions: 0 }] } })

describe("Commit 推送卡片", () => {
  it("底栏只保留插件和内核版本，空卡片同样显示，版本文字经过转义", () => {
    const options = { pluginVersion: "1.2.3", frameworkVersion: "9.8.7" }
    for (const events of [[commit()], []]) {
      const html = cardPage(row(), events, options).html
      expect(html).toContain('<footer><b>Git-Plugin v1.2.3</b><span>Yunzai NG v9.8.7</span></footer>')
      expect(html).not.toContain("时间为 UTC+8")
      expect(html).not.toContain("链接见图片下方文字")
    }
    const escaped = cardPage(row(), [], { pluginVersion: '<script>"', frameworkVersion: "<img>" }).html
    expect(escaped).toContain('Git-Plugin v&lt;script&gt;&quot;')
    expect(escaped).toContain("Yunzai NG v&lt;img&gt;")
    expect(escaped).not.toContain("<script>")
  })

  it("图片推送底栏使用上下文中的实际运行版本，不写死版本号", async () => {
    const h = harness()
    h.fake.version = "1.2.3"
    h.fake.app.version = "9.8.7"
    let html = ""
    h.fake.render = async page => {
      html = (page as { html: string }).html
      return { type: "image", file: { kind: "buffer", data: Buffer.from("png") } }
    }
    const content = await messageContent(h.ctx, row({ format: "image" }), h.ctx.config.get(), [commit()])
    expect(Array.isArray(content)).toBe(true)
    expect(html).toContain('<footer><b>Git-Plugin v1.2.3</b><span>Yunzai NG v9.8.7</span></footer>')
  })

  it("标题与多行正文分开；展示总增删行数、逐文件明细、重命名与剩余文件提示", () => {
    const html = cardPage(row(), [commit()]).html
    expect(html).toContain('<h2 class="title">feat!: 标题不混进正文</h2>')
    expect(html).toContain('<p class="detail-label">详细内容</p>')
    expect(html).toContain("这是详细内容\n\n- 添加会话设置\n- 删除旧配置")
    expect(html).toContain('14 个文件 · 新增 <span class="additions">+241</span> 行 · 删除 <span class="deletions">−100</span> 行')
    expect(html).toContain("src/config.ts")
    expect(html).toContain('<span class="file-count mono"><span class="additions">+46</span></span>')
    expect(html).toContain('<span class="file-count mono"><span class="deletions">−16</span></span>')
    expect(html).toContain('<span class="additions">+0</span>')
    expect(html).toContain('<span class="deletions">−0</span>')
    expect(html).toContain(".additions{color:#1a7f37}")
    expect(html).toContain(".deletions{color:#991b1b}")
    expect(html).toContain("src/old.ts → src/new.ts")
    expect(html).toContain("另有 12 个文件")
    expect(html).toContain("white-space:pre-wrap")
  })

  it.each([1, 2, 3])("同图 %i 条 Commit：两条以内展开文件表，超过两条仅保留正文和总统计", amount => {
    const events = Array.from({ length: amount }, (_, i) => ({ ...commit(), id: `commit-${i}` }))
    const html = cardPage(row(), events).html
    expect(html.match(/class="title"/g)).toHaveLength(amount)
    expect(html.match(/class="commit-description"/g)).toHaveLength(amount)
    expect(html.match(/class="additions">\+241/g)).toHaveLength(amount)
    expect(html.match(/class="deletions">−100/g)).toHaveLength(amount)
    expect(html.match(/class="files"/g) ?? []).toHaveLength(amount > 2 ? 0 : amount)
    if (amount > 2) {
      expect(html).not.toContain("src/config.ts")
      expect(html).not.toContain("另有 12 个文件")
      expect(html.match(/文件明细已收起/g)).toHaveLength(amount)
    } else {
      expect(html).toContain("src/config.ts")
      expect(html).not.toContain("文件明细已收起")
    }
  })

  it("混合动态按 Commit 数量而非总条数决定是否收起文件", () => {
    const two = [{ ...commit(), id: "a" }, { ...commit(), id: "b" }, event("1", "issue"), event("2", "pr")]
    expect(cardPage(row(), two).html.match(/class="files"/g)).toHaveLength(2)
    const three = [...two, { ...commit(), id: "c" }]
    const html = cardPage(row(), three).html
    expect(html).not.toContain('class="files"')
    expect(html.match(/文件明细已收起/g)).toHaveLength(3)
    expect(html).toContain("title 1")
    expect(html).toContain("title 2")
  })

  it("无明细的提交仍提示不可用；收起只影响图片，不修改事件或文字回退", async () => {
    const events = [commit(), { ...commit(), id: "second" }, event("unknown")]
    const original = structuredClone(events)
    const html = cardPage(row(), events).html
    expect(html).toContain("增删详情暂不可用")
    expect(html.match(/文件明细已收起/g)).toHaveLength(2)
    expect(html).not.toContain('class="files"')
    expect(events).toEqual(original)
    const h = harness()
    const fallback = await messageContent(h.ctx, row({ format: "image" }), h.ctx.config.get(), events)
    expect(fallback).toBe(textDigest(row(), events))
    expect(fallback).toContain("src/config.ts  +46 / −16")
    expect(fallback).not.toContain("文件明细已收起")
    expect(events).toEqual(original)
  })

  it("正文与文件路径不解析为 HTML；长正文限行，明细最多 8 个文件", () => {
    const input = commit()
    input.description = "<script>alert(1)</script>\n" + Array.from({ length: 100 }, (_, i) => `body-${i}`).join("\n")
    input.changes!.files = Array.from({ length: 20 }, (_, i) => ({ filename: `<img src=x onerror=alert(1)>-${i}.ts`, additions: i, deletions: i }))
    const html = cardPage(row(), [input]).html
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;-0.ts")
    expect(html).not.toContain("body-8")
    expect(html.match(/class="file-row"/g)).toHaveLength(8)
  })

  it("无法获取详情时明确提示；未知统计不伪装成 0，非 Commit 不加详情区", () => {
    const html = cardPage(row(), [event("new"), { ...commit(), changes: {
      additions: undefined, deletions: undefined, fileCount: undefined, filesTruncated: true,
      files: [{ filename: "binary.png" }] } }, event("2", "issue")]).html
    expect(html).toContain("增删详情暂不可用")
    expect(html).toContain("文件总数未提供 · 新增 — 行 · 删除 — 行")
    expect(html).toContain("仅展示部分文件")
    expect(html).not.toContain(">+0</span>")
    expect(html).toContain('<span class="file-count mono">—</span>')
    expect(html).not.toContain('<span class="additions">')
    expect(html).not.toContain('<span class="deletions">')
    expect(html.match(/class="commit-changes"/g)).toHaveLength(2)
  })

  it("纯文字也包含分开的正文与增删明细；图片渲染失败后同样保留", async () => {
    const input = commit()
    const text = textDigest(row(), [input])
    expect(text).toContain("feat!: 标题不混进正文")
    expect(text).toContain("这是详细内容\n\n- 添加会话设置\n- 删除旧配置")
    expect(text).toContain("14 个文件 · 新增 +241 行 · 删除 −100 行")
    expect(text).toContain("src/config.ts  +46 / −16")
    expect(text).toContain(input.url)
    const h = harness()
    expect(await messageContent(h.ctx, row({ format: "image" }), h.ctx.config.get(), [input])).toBe(text)
  })
})

const listEntry = (index: number, patch: Partial<StatusEntry> = {}): StatusEntry => ({
  id: index.toString(16).padStart(16, "0"), row: row({ repo: `owner/repo-${index}` }),
  initialized: true, scanning: false, pending: 0, lastCheck: 2000, lastSent: undefined, error: "", retryAt: undefined, ...patch
})

describe("订阅列表图片", () => {
  it("与动态卡片共用完整样式和底栏，展示实际事件、样式、状态及目标", () => {
    const h = harness({ defaultFormat: "image", defaultEvents: ["commit", "release"] })
    const entries = [listEntry(1), listEntry(2, { initialized: false, row: row({ platform: "gitee", branch: "dev", events: ["issue"], format: "text" }) }),
      listEntry(3, { pending: 7, scanning: true, row: row({ platform: "gitcode", enabled: false, scene: "private", targetId: "789" }) })]
    const options = { pluginVersion: "1.2.3", frameworkVersion: "9.8.7", now: 2000 }
    const html = subscriptionListPage(entries, h.ctx.config.get(), options).html
    const dynamic = cardPage(row(), [commit()], options).html
    expect(html.match(/<style>([\s\S]*?)<\/style>/)?.[1]).toBe(dynamic.match(/<style>([\s\S]*?)<\/style>/)?.[1])
    expect(html).toContain('<footer><b>Git-Plugin v1.2.3</b><span>Yunzai NG v9.8.7</span></footer>')
    for (const text of ["GitHub", "Gitee", "GitCode", "已初始化", "待初始化", "已停用 / 续查中", "图片推送", "文字推送", "分支 · dev", "待发 7", "私聊 789", "账号 bot-account", "Release", "Issue"]) expect(html).toContain(text)
    expect(html).toContain(entries[0]!.id)
    expect(html).not.toContain("链接见图片下方文字")
  })

  it("每页最多 5 项，完整编号不截断，多页无丢失；空列表仍有卡片", () => {
    const h = harness()
    const entries = Array.from({ length: 11 }, (_, i) => listEntry(i + 1))
    const pages = [1, 2, 3].map(page => subscriptionListPage(entries, h.ctx.config.get(), { page }).html)
    expect(pages.map(html => html.match(/class="list-index mono"/g)?.length)).toEqual([5, 5, 1])
    for (const entry of entries) expect(pages.filter(html => html.includes(entry.id))).toHaveLength(1)
    expect(pages[2]).toContain("第 3 / 3 页")
    const empty = subscriptionListPage([], h.ctx.config.get()).html
    expect(empty).toContain("尚无订阅")
    expect(empty).toContain("<b>0</b>个订阅")
  })

  it("仓库、分支、目标、错误和范围全部转义，不输出凭据；长错误限长", () => {
    const h = harness({ tokens: { github: "never-show-this-token" } })
    const entry = listEntry(1, { row: { ...row(), repo: "owner/<img src=x>", branch: '<script>"', targetId: "<target>", accountId: "<account>" },
      error: "<script>alert(1)</script>" + "x".repeat(1000) })
    const html = subscriptionListPage([entry], h.ctx.config.get(), { scope: "<scope>" }).html
    for (const text of ["&lt;img src=x&gt;", "&lt;script&gt;", "&lt;target&gt;", "&lt;account&gt;", "&lt;scope&gt;"]) expect(html).toContain(text)
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("<img src=x>")
    expect(html).not.toContain("never-show-this-token")
    expect(html).not.toContain("x".repeat(250))
  })

  it("默认文字推送也生成列表图片，附可复制编号并传入运行版本", async () => {
    const h = harness({ defaultFormat: "text" })
    const entries = [listEntry(1)]
    let html = ""
    h.fake.render = async page => {
      html = (page as { html: string }).html
      return { type: "image", file: { kind: "buffer", data: Buffer.from("png") } }
    }
    const messages = []
    for await (const content of subscriptionListMessages(h.ctx, entries, h.ctx.config.get(), "全部会话")) messages.push(content)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject([{ type: "image" }, expect.stringContaining(entries[0]!.id)])
    expect(html).toContain(`Git-Plugin v${h.ctx.version}`)
    expect(html).toContain(`Yunzai NG v${h.ctx.app.version}`)
    expect(html).toContain("全部会话")
  })

  it("渲染失败后剩余页只发文字；已成功的图片不重复，编号、状态和错误仍完整", async () => {
    const h = harness({ tokens: { github: "never-show-this-token" } })
    const entries = Array.from({ length: 11 }, (_, i) => listEntry(i + 1, { error: "请求正在退避", pending: i }))
    let renders = 0
    h.fake.render = async () => {
      if (++renders === 2) throw new Error("never-show-this-token")
      return { type: "image", file: { kind: "buffer", data: Buffer.from("png") } }
    }
    const messages = []
    for await (const content of subscriptionListMessages(h.ctx, entries, h.ctx.config.get())) messages.push(content)
    expect(renders).toBe(2)
    expect(messages).toHaveLength(3)
    expect(Array.isArray(messages[0])).toBe(true)
    expect(typeof messages[1]).toBe("string")
    expect(typeof messages[2]).toBe("string")
    expect(messages[1]).toContain("请求正在退避")
    for (const entry of entries.slice(5)) expect(messages.slice(1).filter(text => String(text).includes(entry.id))).toHaveLength(1)
    expect(JSON.stringify(messages)).not.toContain("never-show-this-token")
    expect(h.warnings).toHaveLength(1)
    const failed = harness()
    let attempts = 0
    failed.fake.render = async () => { attempts++; throw new Error("No renderer") }
    for await (const content of subscriptionListMessages(failed.ctx, entries, failed.ctx.config.get())) expect(typeof content).toBe("string")
    expect(attempts).toBe(1)
  })
})
