/**
 * 模块职责：插件入口 —— 创建服务、注册命令、按配置调度定时检查
 * 依赖方向：`@yunzai-ng/core` 的 definePlugin 与本目录各模块
 * 生命周期：setup 不等待网络；首轮检查异步启动，避免超过加载超时。卸载时取消定时任务与配置监听。
 * 注意事项：检查间隔变化时只重建一次定时任务；其余配置变化只触发一次状态同步。
 *          服务以 `git-plugin` 键对外提供，供其他插件查询订阅状态。
 */
import { definePlugin } from "@yunzai-ng/core"
import { registerCommands } from "./commands.js"
import { configSchema } from "./config.js"
import { createGitService } from "./service.js"

export default definePlugin({
  name: "git-plugin",
  version: "0.3.2",
  description: "GitHub、Gitee、GitCode 仓库新动态订阅与推送",
  configSchema,
  setup(ctx) {
    const service = createGitService(ctx)
    ctx.provide("git-plugin", service)
    registerCommands(ctx, service)
    let cancel: (() => void) | undefined
    let interval: number | undefined
    const sync = () => {
      const config = ctx.config.get()
      const next = config.enabled ? config.intervalSeconds : 0
      if (interval !== next) {
        cancel?.()
        interval = next
        cancel = next ? ctx.every(next * 1000, async signal => { await service.tick(undefined, signal) },
          { name: "Git 仓库动态检查", overlap: "skip", timeout: "10m" }) : undefined
      }
      void service.refresh()
    }
    const off = ctx.config.onChange(sync)
    ctx.onDispose(() => { off(); cancel?.() })
    sync()
    ctx.logger.info("Git-Plugin 已加载。面板配置支持三平台 Token、推送订阅与私有仓库会话授权。")
  }
})
