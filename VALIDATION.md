# 验证记录

验证日期：2026-11-05；框架版本：Yunzai NG 0.7.1。

## 自动化验证

插件已改为 TypeScript，`pnpm run verify` 全部通过：`tsc -b` 构建、测试代码类型检查、ESLint、28 项 vitest。测试覆盖平台客户端、分页状态机、推送队列、私有授权、配置同步、头像下载与过滤、渲染回退与插件生命周期。真实 NG 集成测试由 `createApp()` 从磁盘加载插件，通过本机 HTTP 面板配置接口增删改订阅，经过真实消息路由和 Mock 适配器验证权限、推送、YAML 保存与重载。

另用框架构建产物（`packages/core/dist`）加载插件的 `dist/`，确认编译后的入口可加载，`#git帮助` 有回复，`git-plugin` 服务可用。

API 测试中的三个 Git 平台均为固定响应模拟，不需要平台 Token。集成测试只监听本机临时端口，不向真实群聊发消息。分层约束由插件 ESLint 配置的 `no-restricted-imports` 检查。

## 公开 API 只读实测

| 平台与仓库 | 结果 |
|---|---|
| GitHub `Yunzai-NG/yunzai-ng` | 仓库元数据、Commit、Issue、PR、Release 均 HTTP 200，列表响应为数组 |
| Gitee `mirrors/vue` | 元数据、Commit、Release HTTP 200；该镜像仓库的 Issue、PR 接口 HTTP 404 |
| GitCode `openharmony/docs` | 匿名元数据 HTTP 401，需配置 Token 后继续验证 |

Gitee 的 Issue/PR 404 没有被当作空列表：插件会记录对应事件类型错误，其余类型继续检查。GitCode 对公开仓库元数据要求认证时，插件使用配置 Token 获取元数据并检查公开标记；私有仓库仍需显式授权。

未提供真实 Token，因此私有仓库和 GitCode 认证后的端到端连通性未做真实账号验证。相关行为已通过模拟测试覆盖。

## 图片视觉验证

本地按渲染器的方式（视口 600、2 倍、截 `#container`）生成卡片，检查中文、长标题、换行、边距、作者头像与首字母回退，详见 [`DESIGN.md`](./DESIGN.md)。头像用真实 GitHub 头像地址下载验证，非白名单地址与 `javascript:` 地址被拒绝。已安装的 chrome-headless-shell 在此环境启动失败，预览改用本机 Edge 无头模式成功渲染。插件本身仍使用框架 `ctx.render()`，不会启动系统 Edge；部署中渲染器不可用时回退文字。

这次交付没有修改运行中的机器人账号、创建实际订阅或向真实会话发送测试通知。
