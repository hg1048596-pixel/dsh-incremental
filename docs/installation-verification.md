# 公开安装入口离线验证

本机已验证 DSH `0.1.0-rc.6`、Node `22.23.2`、pnpm `11.22.0` 的真实包管理器安装流程。使用已有软件，不下载 DSH、pnpm 或其他依赖，不改真实用户 profile 或 DSH 安装目录。

## 复现

在仓库根目录运行：

```powershell
node tools/verify-installation.mjs
```

默认先用现有 npm 离线打包当前源码，再运行已安装 DSH 的公开 CLI：

```text
node <installed-dsh>/lib/bin.js plugin --profile incremental-install-smoke add <local.tgz> --offline --ignore-scripts ...
```

也可指定现成 tarball 和运行时：

```powershell
node tools/verify-installation.mjs --tarball artifacts/dsh-incremental-0.1.0.tgz --runtime-root 'C:\path\to\dsh-app'
```

每次在 `artifacts/installation-verification/run-*` 创建独立的 `DSH_HOME`、pnpm store、缓存、配置和临时目录，保留命令、stdout/stderr、profile、lockfile、配置 dump 与 `result.json`。通过 `--output PATH` 可以指定证据父目录。测试 `test/installation.test.js` 也运行完整流程，测试结束删除自己的临时目录；缺少已有运行时或包管理器时明确跳过，不自动安装软件。

## 实际检查

1. 公开 `dsh plugin` 初始化隔离 profile，由现有 pnpm 安装本地 tgz；不使用 checkout junction 冒充安装。
2. DSH 自动把 `dsh-incremental` 登记到 `dsh.profile.bundles`，保留默认 `@deepseek-ai/dsh-base`。检查插件版本及 bundle 声明。
3. 新打包模式逐一比较安装副本与源码的所有打包文件哈希。指定现成 tgz 时记录 tgz SHA256，不宣称它与后来修改的源码一致。
4. 公开 `--dump-config` 成功组合完整 profile；随后只将安装副本的 incremental 条目加载到真实 rc.6 Cordis/ToolRuntime，确认三个工具注册及卸载。
5. 模型和工具操作均不执行；注册所用固定配置设置 `allowRemote: false`，未提供任何凭据，也未创建审阅状态目录。

所有包管理命令使用 `--offline` 和 `--ignore-scripts`，关闭 peer 自动安装与更新提示，禁用包管理器自动获取，使用空用户/全局 npm 配置与隔离存储。子进程只继承运行所需的系统路径变量，不继承 provider key、代理或原有 npm/DSH 配置。额外的 Node preload 阻断 TCP/TLS、HTTP(S)、DNS、UDP 和 fetch，记录任何被阻断尝试，并要求计数为零。pnpm 输出中的 `downloaded 1` 是本地 tgz 导入计数；此流程禁止网络，不能据此解释为下载了远端包。

## 结果与边界

先前交付的本地 tgz 已通过该安装和加载检查，证据位于 `artifacts/installation-verification/run-EH35RN/result.json`，该次 tgz SHA256 为 `5f8dd2b9ea00c88785a121714feeba9cd4e1e0ba0a4c2a5d21b097052a339d86`。当前源码新打包后的独立检查位于 `run-KKuIfD/result.json`，逐一比较的 35 个文件一致。它们是各次检查的历史记录，后续包以各自 `result.json` 的 SHA256 为准。三个工具为 `incremental_plan`、`incremental_report`、`incremental_run`，网络尝试记录为零。

此检查证明本地 tgz 经当前 rc.6 公开安装入口后能组合、注册和卸载；没有启动完整桌面会话，没有验证 registry 发布/在线安装、其他 DSH 版本或真实模型调用。Node 阻断是此验证子进程的附加保护，不等同于操作系统级网络抓包或网络沙箱。

受限 Windows 沙箱曾拒绝 pnpm 在隔离 store 登记项目时创建目录链接（`EPERM`）。相同验证命令在自动审批允许的沙箱外环境通过，写入仍限定在上述隔离目录。这是运行环境限制，不能把失败当作插件安装成功。
