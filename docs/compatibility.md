# DSH 兼容性与适配记录

[使用指南](usage.md) · [缓存规则](cache-rules.md) · [返回首页](../README.md)

## 支持版本

| DSH | 验证用 Node.js | DeepSeek 协议 | 集成检查 |
| --- | --- | --- | --- |
| 0.2.2-rc.2 | 24.22.3 | Messages API | 37 项通过；本地插件包安装、激活和卸载通过 |
| 0.1.0-rc.6 | 22.23.2 | Chat Completions | 37 项通过；保留旧版调用路径 |

2026-11-12 核对官方仓库和 npm 发布包，最新发布标签为
[`dsh-v0.2.2-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2)。
该版本要求 Node.js >=24.9.0；插件会在导入新版 DSH 包前检查 Node 版本。
验证使用独立的官方运行环境，没有修改或升级本机已有 DSH。

## 新版接入变化

- **DeepSeek 调用**：通过公开导出识别 Messages 与 Chat Completions 两种适配器。新版提供固定路线的 `resolveAuth`，并显式返回空 API 扩展，独立 Cordis root 不继承宿主中间件。
- **地址与模型目录**：新版示例使用 `https://api.deepseek.com/anthropic` 和 `deepseek-v4-flash`。模型目录地址由官方 `modelListingURL` 计算，查询来源为同一已授权端点的 `/models`。
- **工具执行**：继续使用 `defineTool`、`output.schema`、`output.render`，返回规范 JSON。新版批量工具执行由 DSH 自己的 native executor 负责。
- **权限来源**：记录宿主公开 sandbox/approval 事实，包括新版的 `additionalWritableRoots`；授权信息未知或无效时，结果不进入复用路径。
- **生命周期**：适配新版 `auditStartupEntries`、官方默认 bundle 清单及 CLI 参数转发；保持取消、卸载和前台运行。
- **图标**：通过官方支持的 package `icon` 字段及 `./icon` 资源导出方形 SVG。已用新版 `readPluginMeta` 验证安装包中的图标数据。
- **缓存身份**：记录传输协议、适配器版本、入口摘要及本地执行器和兼容辅助代码摘要，避免升级后复用旧执行路径的结果。

独立执行器只桥接指定凭据引用，传入冻结的文本和空工具列表，不运行目标仓库代码。
输入控制、失败恢复、TTL 和严格默认策略详见[缓存规则](cache-rules.md)。

## 配置迁移

最新版配置模板见 [dsh-config.example.json](../examples/dsh-config.example.json)：

```json
{
  "model": "deepseek-v4-flash",
  "connection": {
    "adapter": "deepseek",
    "baseURL": "https://api.deepseek.com/anthropic",
    "thinking": "disabled",
    "reasoningEffort": "off"
  }
}
```

旧 rc.6 仍使用原来的 Chat Completions 地址，例如 `https://api.deepseek.com`；
模型名称按自己的已配置路线设置。不要把 Messages 地址套用到旧适配器。
完整配置、宿主 patch 和任务清单见[使用指南](usage.md)。

## 实际验证

集成测试加载两个版本的真实公开包，拦截传输并提供固定离线响应，覆盖：

- 真实适配器的成功响应、usage、错误 JSON、输出截断和 HTTP 错误；
- 空工具请求、拒绝工具调用、取消与流清理；
- 独立 root、凭据引用限制、模型元数据、TTL 和来源记录；
- 工具注册、原生执行、profile 合成、启动检查和卸载；
- Node 版本不满足时在导入新版运行时代码前退出。

安装检查通过公开 `dsh plugin` 命令将本地 tgz 安装到临时 profile，
逐文件核对打包字节，检查三项工具与图标，再卸载工具。
安装阶段使用已有 pnpm、禁用生命周期脚本和网络；没有提供供应商凭据。
本次新版适配没有消耗真实模型推理请求。此前真实 API 的功能验收独立保留在
[核心功能记录](core-functionality.md)，不作为新版模型效果测试。

复现完整测试：

```powershell
$env:DSH_TEST_RUNTIME_ROOT = 'C:\path\to\dsh-runtime'
$env:DSH_TEST_NPM_CLI = 'C:\path\to\node_modules\npm\bin\npm-cli.js'
npm test
```

独立安装检查：

```powershell
node tools/verify-installation.mjs --runtime-root C:\path\to\dsh-runtime --expected-dsh-version 0.2.2-rc.2
```

运行目录须包含所选版本的 `package.json`、公开依赖和已有 pnpm。
若使用不带 npm 的独立 Node 可执行文件，另传 `--npm-cli PATH`。
CI 的 `DSH 0.2.2-rc.2 integration` 作业从官方 npm 准备隔离运行环境，
禁用安装脚本后执行完整测试。

## 官方依据

- [发布与运行方式](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/README.md)
- [Node 与包管理器要求](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/package.json)
- [工具接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/core/tools/README.md)
- [LLM 服务](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/llm/llm/README.md)
- [DeepSeek 适配器](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/llm/llm-deepseek/README.md)
- [插件元数据与图标](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.2/packages/util/package-manifest/README.md)
