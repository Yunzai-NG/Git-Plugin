/**
 * 模块职责：平台常量、动态记录类型、订阅身份键与安全错误
 * 依赖方向：仅依赖 node:crypto 与 config.ts 的类型
 * 生命周期：纯函数与常量
 * 注意事项：订阅编号由平台、仓库、分支、账号与目标算出，改备注、样式、凭据不会变；
 *          对外报错只用 GitError 的文案，绝不把远端响应、URL 或异常栈发到聊天。
 */
import { createHash } from "node:crypto"
import type { GitConfig, Subscription } from "./config.js"

/** 支持的代码托管平台 */
export type Platform = "github" | "gitee" | "gitcode"

/** 可订阅的动态类型 */
export type EventType = "commit" | "issue" | "pr" | "release"

/** 平台的展示名、API 基址与网页基址 */
export interface PlatformInfo {
  /** 展示名 */
  name: string
  /** REST API 基址 */
  api: string
  /** 网页基址，动态链接只允许落在这个源下 */
  web: string
}

/** 支持的平台及其固定官方入口 */
export const PLATFORMS: Readonly<Record<Platform, PlatformInfo>> = {
  github: { name: "GitHub", api: "https://api.github.com", web: "https://github.com" },
  gitee: { name: "Gitee", api: "https://gitee.com/api/v5", web: "https://gitee.com" },
  gitcode: { name: "GitCode", api: "https://api.gitcode.com/api/v5", web: "https://gitcode.com" }
}

/** 平台键的固定顺序 */
export const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[]

/** 可订阅的新动态 */
export const EVENTS = ["commit", "issue", "pr", "release"] as const satisfies readonly EventType[]

/** 归一化后的一条动态；与抓取进度一起持久化在 KV 的待发队列里 */
export interface GitEvent {
  /** Commit 为 SHA，Issue/PR 为编号，Release 为平台 id 或标签名 */
  id: string
  /** 动态类型 */
  type: EventType
  /** 创建或发布时间（毫秒）；Commit 取提交时间，缺失为 0 */
  time: number
  /** 官方网页链接 */
  url: string
  /** 单行标题，已去除控制字符并限长 */
  title: string
  /** 作者登录名或姓名 */
  author: string
  /** 作者头像地址，已校验为官方头像 CDN；旧版本入队的记录没有此字段 */
  avatar?: string
}

/** 订阅的会话身份：精确的机器人账号记录与接收会话 */
export interface Destination {
  /** NG 账号记录 id（UUID） */
  accountId: string
  /** 接收类型 */
  scene: "group" | "private"
  /** 群号或用户 id */
  targetId: string
}

/** 仓库身份：平台与两段路径 */
export interface RepoRef {
  /** 平台 */
  platform: Platform
  /** owner/repo */
  repo: string
}

/**
 * 验证两段仓库路径，拒绝路径穿越和查询参数
 * @param value 待验证的值
 * @returns 是否为合法的 owner/repo
 */
export function validRepo(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && value.split("/").length === 2 &&
    value.split("/").every(part => /^[\w.-]+$/.test(part) && part !== "." && part !== "..")
}

/**
 * 解析聊天中的官方 HTTPS 仓库 URL 或 platform:owner/repo
 * @param value 用户输入
 * @returns 平台与仓库路径
 */
export function parseRepo(value: string): RepoRef {
  let platform: Platform | undefined
  let repo: string | undefined
  if (value.startsWith("https://")) {
    const url = new URL(value)
    platform = PLATFORM_KEYS.find(key => url.origin === PLATFORMS[key].web)
    if (url.username || url.password || url.search || url.hash) throw new Error("请填写不含凭据和查询参数的仓库地址。")
    repo = url.pathname.replace(/^\//, "").replace(/\/$/, "").replace(/\.git$/, "")
  } else {
    const match = /^(github|gitee|gitcode):(.+)$/i.exec(value)
    platform = match?.[1]?.toLowerCase() as Platform | undefined
    repo = match?.[2]?.replace(/\.git$/, "")
  }
  if (!platform || !validRepo(repo)) throw new Error("仓库格式：github:owner/repo，或 GitHub / Gitee / GitCode 的 HTTPS 仓库首页地址。")
  return { platform, repo }
}

/**
 * 仓库比较键：不区分大小写，分支名仍区分大小写
 * @param row 带平台与仓库的记录
 * @returns 比较键
 */
export const repoKey = (row: RepoRef): string => `${row.platform}:${row.repo.toLowerCase()}`

/**
 * 会话比较键：绑定精确机器人记录与会话，不回退到其他在线账号
 * @param row 带会话身份的记录
 * @returns 比较键
 */
export const targetKey = (row: Destination): string => JSON.stringify([row.accountId, row.scene, row.targetId])

/**
 * 稳定订阅编号；显示设置、凭据轮换不影响编号
 * @param row 订阅
 * @returns 16 位十六进制编号
 */
export const subscriptionId = (row: RepoRef & Destination & { branch?: string }): string => createHash("sha256")
  .update(JSON.stringify([repoKey(row), row.branch || "", targetKey(row)]))
  .digest("hex").slice(0, 16)

/**
 * 构造框架的发送目标
 * @param row 订阅
 * @returns 发送目标
 */
export const sendTarget = (row: Destination): { scene: "group", gid: string } | { scene: "private", uid: string } =>
  row.scene === "group" ? { scene: "group", gid: row.targetId } : { scene: "private", uid: row.targetId }

/**
 * 获取当前订阅实际启用的事件
 * @param row 订阅
 * @param config 当前配置
 * @returns 事件类型列表
 */
export const eventTypes = (row: Subscription, config: GitConfig): readonly EventType[] =>
  row.events.length ? row.events : config.defaultEvents

/**
 * 返回指定订阅的私有仓库授权
 * @param row 订阅
 * @param config 当前配置
 * @returns 匹配的授权；没有则 undefined
 */
export function grantFor(row: Subscription, config: GitConfig): GitConfig["privateRepositories"][number] | undefined {
  return config.privateRepositories.find(grant => repoKey(grant) === repoKey(row) &&
    grant.credential === row.credential && grant.targets.some(target => targetKey(target) === targetKey(row)))
}

/**
 * 从配置解析凭据；此值仅在服务端使用
 * @param row 订阅
 * @param config 当前配置
 * @returns Token，可能为空串
 */
export function tokenFor(row: Subscription, config: GitConfig): string {
  if (!row.credential) return config.tokens[row.platform]
  const found = config.credentials.find(item => item.name === row.credential && item.platform === row.platform)
  if (!found) throw new GitError("找不到订阅指定的平台凭据，请在面板检查凭据名称。")
  return found.token
}

/**
 * 外部文本只作为有长度上限的单行文本展示
 * @param value 远端文本
 * @param limit 最大长度
 * @returns 去除控制字符、合并空白后的单行文本
 */
export const cleanText = (value: unknown, limit = 240): string =>
  // eslint-disable-next-line no-control-regex -- 有意移除远端文本的控制字符。
  String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit)

/** 插件定义的错误：只有它的文案会出现在聊天和面板里 */
export class GitError extends Error {
  /** 错误分类，如 rate / network / permission / 401 */
  readonly code: string
  /** 退避截止时间（毫秒），0 表示不退避 */
  readonly retryAt: number

  /**
   * 构造插件错误
   * @param message 可展示的中文说明
   * @param code 错误分类
   * @param retryAt 退避截止时间
   */
  constructor(message: string, code = "request", retryAt = 0) {
    super(message)
    this.name = "GitError"
    this.code = code
    this.retryAt = retryAt
  }
}

/**
 * 取插件错误的分类；其他异常一律视为无分类
 * @param error 任意异常
 * @returns 错误分类，非 GitError 时为空串
 */
export const errorCode = (error: unknown): string => error instanceof GitError ? error.code : ""

/**
 * 将未知底层异常换成不包含凭据的说明
 * @param error 任意异常
 * @returns 可展示的中文说明
 */
export const safeError = (error: unknown): string =>
  error instanceof GitError ? error.message : "操作失败，请检查网络、框架存储及账号状态。"
