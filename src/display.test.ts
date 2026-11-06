import { describe, expect, it } from "vitest"
import { cardPage, messageContent, textDigest } from "./display.js"
import type { GitEvent } from "./model.js"
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
