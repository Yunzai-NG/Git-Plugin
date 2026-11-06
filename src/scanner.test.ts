import { describe, expect, it } from "vitest"
import { configSchema } from "./config.js"
import { scanEvents } from "./scanner.js"
import type { StreamState } from "./scanner.js"
import type { EventType } from "./model.js"
import { event, fakeProvider, row } from "./test-helpers.js"

const config = configSchema.parse({})
const scan = (provider: ReturnType<typeof fakeProvider>, type: EventType, state?: StreamState, now = 1000) =>
  scanEvents(provider, row(), "", config, type, state, { now: () => now })

describe("scanEvents", () => {
  it("基线不推历史；Commit 不看作者时间，Issue 编辑不算新增", async () => {
    const provider = fakeProvider({ commit: [event("old")], issue: [event("1", "issue", 100)] })
    let commit = await scan(provider, "commit")
    let issue = await scan(provider, "issue")
    expect(commit.events).toEqual([])
    expect(issue.events).toEqual([])
    provider.lists.commit.unshift(event("new", "commit", 1))
    provider.lists.issue[0]!.title = "edited and closed"
    provider.lists.issue.unshift(event("2", "issue", 2000))
    commit = await scan(provider, "commit", commit.state)
    issue = await scan(provider, "issue", issue.state)
    expect(commit.events.map(item => item.id)).toEqual(["new"])
    expect(issue.events.map(item => item.id)).toEqual(["2"])
    expect((await scan(provider, "issue", issue.state)).events).toEqual([])
  })

  it("Commit 积压分页续查，起点固定在 SHA 上", async () => {
    const provider = fakeProvider({ commit: [event("baseline")] })
    const baseline = await scan(provider, "commit")
    provider.lists.commit = [...Array.from({ length: 350 }, (_, index) => event(`new-${350 - index}`)), event("baseline")]
    const first = await scan(provider, "commit", baseline.state)
    expect(first.state.scan?.page).toBe(4)
    expect(first.state.scan?.staged).toHaveLength(300)
    expect(first.events).toHaveLength(0)
    provider.lists.commit.unshift(event("arrived-during-scan"))
    const resumed = await scan(provider, "commit", structuredClone(first.state))
    expect(resumed.events).toHaveLength(350)
    expect(resumed.events[0]?.id).toBe("new-1")
    expect((await scan(provider, "commit", resumed.state)).events.map(item => item.id)).toEqual(["arrived-during-scan"])
  })

  it("历史边界丢失时报错且不推进；空仓库的首个 Commit 正常", async () => {
    const provider = fakeProvider({ commit: [event("old")] })
    const initial = await scan(provider, "commit")
    provider.lists.commit = [event("force-push")]
    await expect(scan(provider, "commit", initial.state)).rejects.toThrow(/历史无法衔接/)
    expect(initial.state.head).toBe("old")
    provider.lists.commit = []
    const empty = await scan(provider, "commit")
    provider.lists.commit = [event("first")]
    expect((await scan(provider, "commit", empty.state)).events[0]?.id).toBe("first")
  })

  it("Release 遍历旧记录以发现刚发布的旧草稿；同一时刻去重", async () => {
    const provider = fakeProvider({ release: Array.from({ length: 120 }, (_, index) => event(`old-${index}`, "release", 100)) })
    const baseline = await scan(provider, "release")
    provider.lists.release.push(event("published-old-draft", "release", 2000))
    const result = await scan(provider, "release", baseline.state)
    expect(result.events.map(item => item.id)).toEqual(["published-old-draft"])
    provider.lists.release.push(event("same-time", "release", 2000))
    expect((await scan(provider, "release", result.state)).events.map(item => item.id)).toEqual(["same-time"])
  })
})
