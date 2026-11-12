# dsh-incremental

DSH 的只读 AI 增量审查插件：将审查拆成有依赖关系的任务，保存每项任务的实际输入与结果，在输入、路线、权限和缓存期限均符合条件时复用结果。修改一个模块后，只重新执行受影响的任务及其下游。

**状态：本地核心功能已通过真实 DeepSeek API 验收。** 四任务首次执行 4 次推理，无变化时复用全部结果、推理 0 次；只修改 pricing 后，仅 pricing 和汇总重跑、推理 2 次。这是一个小型示例的功能验收；各阶段仍查询模型元数据，不代表普遍性能或结论正确性已获验证。详见 [核心功能与实测数据](docs/core-functionality.md) 和 [可移植验收证据](docs/evidence/core-acceptance.json)。

兼容基线为 Windows 上已有的 **DSH 0.1.0-rc.6 / Node 22.23.2**；未宣称兼容其他 DSH 版本。插件不修改 DSH 核心，不运行被审查仓库的脚本，不自动安装模型或切换路线。

## 安装到已有 DSH

在本项目目录打包，再用已有 DSH 的公开入口安装本地包。无需先运行 `npm install`；插件没有构建或安装脚本。

```powershell
npm pack --ignore-scripts
dsh plugin --profile incremental-demo add C:\path\dsh-incremental-0.1.0.tgz
```

将第二条命令的路径替换为实际生成的 tgz。未配置的插件保持休眠，不扫描仓库或发出请求。以下先说明配置和 CLI 用法，随后给出 DSH 宿主配置。

## 配置真实 DeepSeek 审查

复制 [配置模板](examples/dsh-config.example.json) 到仓库外的私有配置位置，修改以下字段：

- `runtimeRoot`：已有 DSH 安装中包含 `package.json` 和 `node_modules` 的 `dsh-app` 目录。
- `approvedRepoRoot`：明确批准发送给该模型的仓库绝对路径。
- `model`、`connection`：固定模型 ID、DeepSeek 适配器和 API 地址。
- `credentialEnv`：存放真实 API 密钥的环境变量名称。通过自己的密钥管理方式向进程提供该变量；不要把密钥写入配置、任务清单或源码。
- `allowRemote`：模板为 `false`。确认仓库和请求路线已获授权后，主动改为 `true` 才能发送请求。

模板显式选择允许短期复用的策略：

```json
"reusePolicy": {
  "mode": "visible-model",
  "maxAgeMs": 86400000
}
```

`visible-model` 只支持直接 DeepSeek 适配器。每次已获授权的 `plan`、`run` 或 `resume` 会尝试向配置端点发送一次受控、带认证的 `GET /models`，确认所选模型仍被公布，并将选中条目的可见元数据、固定路线及执行器身份纳入复用检查。查询失败或所选模型未被公布时不复用，报告中保留原因。模型列表中公布的 ID **不能证明该次生成使用了某个不变的服务器版本**。供应商在相同 ID 下更新模型可能无法被发现；选择此模式表示接受这一风险。

`maxAgeMs` 从原结果的生成时间计算，命中缓存不会延长有效期。示例期限为 24 小时，可配置为 1 毫秒至 30 天；到期后重新请求模型。期限只控制是否复用，不自动删除已保存结果。任何时候都可用 `--full` 强制重跑全部任务。

未配置 `reusePolicy` 时默认采用 `strict`。目前 DeepSeek 路线没有供应商证明的不变模型版本，因此严格模式以 `model_revision_unknown` 禁用跨运行复用，每次执行真实审查。手填版本号不能改变这一点。

## 声明任务

任务清单是纯 JSON，只声明输入、依赖和审查要求。例如保存为 `C:\private\review.json`：

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "auth",
      "description": "按此本地契约审查：roles 是字符串数组时，只有精确等于 admin 的角色授予权限；缺少用户或 roles 不是数组时返回 false。调用方过滤和其他授权系统不在本任务范围。仅报告该契约下由源码支持的问题及确实必需但缺失的事实。",
      "inputs": { "files": ["src/auth.js"], "directories": [] },
      "dependsOn": [],
      "acceptance": ["返回符合结构的观察结果，并明确缺少的上下文。"]
    },
    {
      "id": "summary",
      "description": "汇总上游发现，不引入未提供的源码。",
      "inputs": { "files": [], "directories": [] },
      "dependsOn": ["auth"],
      "acceptance": ["每条发现沿用上游的源码证据。"]
    }
  ]
}
```

输入路径相对于被审查仓库。完整示例见 [四项任务清单](examples/demo-repo/review-tasks.json) 和 [示例源码](examples/demo-repo/src)。目录输入递归包含未跟踪文件、隐藏文件和空目录，不自动应用 `.gitignore`。请声明所需文件或子目录，避免把凭据和依赖目录一并发送。

**缓存有效不等于结论正确，也不证明依赖声明完整。** 未声明文件不会使局部缓存失效；任务需要更多代码、环境或外部资料时，应扩展清单。模型明确报告未知依赖时，该结果及下游不复用。

任务应提供审查结论实际依赖的契约。需要的业务规则可写入会被指纹记录的任务定义，或作为声明的输入文件提供。示例任务明确了各模块的本地契约和边界。缺少契约导致的未知依赖会阻止复用；不能通过删除模型的依赖说明来制造命中。

## 运行、复用与恢复

在本项目目录运行；将示例路径替换为自己的配置。缓存状态目录必须在被审查仓库之外。

```powershell
node bin/dsh-incremental.js plan --repo C:\work\sample --manifest C:\private\review.json --state C:\review-state --dsh-config C:\private\review-config.json
node bin/dsh-incremental.js run --repo C:\work\sample --manifest C:\private\review.json --state C:\review-state --dsh-config C:\private\review-config.json
```

首次 `run` 执行全部任务。后续使用相同命令：仍有效的结果标为 `reused`，输入或上游结果变化的任务重新执行。`plan` 展示当前失效原因，不生成模型回答、不创建缓存或持有写锁；`visible-model` 模式仍会查询已授权端点的模型元数据，因此需要凭据和远程授权。

```powershell
# 强制重新审查全部任务
node bin/dsh-incremental.js run --repo C:\work\sample --manifest C:\private\review.json --state C:\review-state --dsh-config C:\private\review-config.json --full

# 中断后恢复指定运行，重新核对当前输入与上游版本
node bin/dsh-incremental.js resume --repo C:\work\sample --manifest C:\private\review.json --state C:\review-state --dsh-config C:\private\review-config.json --run-id RUN_ID

# 读取已保存的报告；省略 --run-id 可读取最新报告
node bin/dsh-incremental.js report --repo C:\work\sample --state C:\review-state --run-id RUN_ID
```

清单改变后开始新运行。`plan`、`run`、`resume` 均要求 `--dsh-config`；不会默认退回模拟执行器。CLI 也支持 `--credential-file C:\private\deepseek-key.txt`，私下读取仅含一条密钥的 UTF-8 文件，只用于配置中的凭据引用。

报告分别记录执行状态、失效原因、复用资格、当前源码适用性、模型调用与 usage，以及已执行的 `validation[]`。缺失 usage 保留为未知；结构和证据检查通过不表示结论已经正确。复用项保留原始结果来源，原生成检查在 `reusedFrom.validation` 中，不冒充本次重新检查。使用 `--json` 输出 JSON，或用 `--output C:\review-output\report.json` 保存到仓库外。

## 在 DSH 中调用

通过宿主 patch 固定路径、路线和数据授权。例如保存为 `C:\private\incremental.yml`；`allowRemote: true` 表示宿主已明确批准所配仓库向该路线发送输入。

```yaml
- id: incremental
  config:
    repoRoot: 'C:\work\sample'
    manifestPath: 'C:\private\review.json'
    stateDir: 'C:\review-state'
    runtimeRoot: 'C:\path\DeepSeek Harness\resources\dsh-app'
    provider: deepseek-official
    model: deepseek-flash
    connection:
      adapter: deepseek
      baseURL: https://api.deepseek.com
      thinking: disabled
      reasoningEffort: off
    credentialEnv: DEEPSEEK_API_KEY
    allowRemote: true
    reusePolicy:
      mode: visible-model
      maxAgeMs: 86400000
    maxRequests: 48
    maxTokens: 4096
    timeoutMs: 120000
```

```powershell
dsh --profile incremental-demo --patch C:\private\incremental.yml
```

插件提供三个公开工具：

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `incremental_plan` | 无 | 检查哪些任务需要执行及原因。 |
| `incremental_run` | 可选 `full: true` | 前台运行或强制全量运行。 |
| `incremental_report` | 必填 `runId` | 读取指定已保存报告。 |

工具参数不能改变仓库、凭据、模型或授权。插件从已有 credentials 服务解析所配引用；没有该服务时使用对应环境变量。运行支持取消，`background: true` 明确报错：当前 rc.6 公开 jobs 接口无法保证完成时不额外唤醒父模型。插件不会自行发起后续对话。

## 复用边界

- 每次重新读取全部声明输入，以同一批字节构造哈希和请求；不依赖时间戳或 Git 状态。完整任务、目录清单、上游结果版本、实际请求、路线、执行器、提示词和验证器身份、权限与仓库身份均参与检查。
- 新增、删除、重命名影响对应目录清单。明确声明的文件消失会失败并阻塞下游。路径越界、链接/reparse point、Windows ADS、非法 UTF-8、读取失败和超限均明确失败，不静默截断；完整任务请求默认上限 256 KiB。
- 输入或上游改变、缓存损坏、结果未完成、期限到期或权限无法核实时重新执行。上游每次成功执行生成新结果版本，即使输出文字相同也使下游重跑。前后复核检测输入漂移，但不构成跨文件原子快照。
- DSH 宿主的 sandbox 与 approval 策略都必须可核实，未知时禁用复用。会话安全身份也进入指纹，因此切换 DSH 会话可能使已有缓存失效。
- 失败、取消或中断不使旧结果冒充本次成功；成功的独立分支可保留。持久缓存使用内容寻址、摘要校验、fsync 和原子替换；Windows 突然断电仍可能丢失最近元数据，下次检查会重算。单写者锁只在能确认同机旧进程已结束时恢复。
- 执行器只使用已有 DSH 的公开 LLM/适配器 API，创建独立 Cordis root，固定一条路线，不继承聊天历史、工具、AGENTS.md、记忆或宿主 LLM 中间件。模型请求不含工具；工具调用、截断、非正常结束、无效结构和不匹配的源码证据均不能提交为成功结果。
- 每个执行器最多 48 次模型分发，每次最多 4096 输出 tokens，并发为 1，无自动重试；元数据查询独立记录。仅允许 HTTPS 远程端点或 HTTP 回环地址。插件不执行目标仓库中的代码、包管理器、测试命令或配置脚本。

缓存包含模型可见源码和分析结果，应按源码保护。摘要检测意外损坏，不能抵抗能同时改写本机代码和缓存的同权限攻击者；独立 Cordis root 不提供操作系统沙箱。已有 DSH 运行时及适配器属于信任边界。未知权限机制会禁用复用；其他平台未经与 Windows 同等级的实际环境验证。首版不支持跨仓库缓存、自动推导完整语义依赖，或缓存修改文件、发消息等有副作用的行为。

核心公开入口为 `./core` 的 `runReview`、`planReview`；插件入口为 `src/plugin.js`。实现只依赖 Node 内置模块，实际模型执行使用指定 DSH 安装提供的公开包，不捆绑或升级 DSH 核心。

Windows 权限读取现使用直接 .NET API，每次仍启动独立进程、重新读取完整权限；检查时点和次数不变。本机五组配对中，无变化运行的中位总耗时从 23.72 秒降到 15.40 秒。范围、原始数据与复现步骤见[权限读取优化](docs/permission-performance.md)。升级后因实现摘要变化，旧缓存会按原有规则失效一次。

## 开发诊断与历史记录

这些命令用于开发检查；`demo`、默认 `benchmark` 和显式 `--fixture` 使用确定性规则执行器，**不是 AI 审查**。

```powershell
npm test
node bin/dsh-incremental.js doctor --json
node bin/dsh-incremental.js demo --output artifacts/demo
```

`--fixture` 仅用于 `plan`、`run`、`resume` 的显式诊断，与 `--dsh-config` 互斥。`doctor` 只检查已有运行时，不调用模型或改动安装。离线安装检查可用 `npm run verify:installation` 复现，需已有 rc.6、Node 和 pnpm。

当前能力与兼容范围见 [核心功能状态](docs/core-functionality.md)、[发布检查](docs/release-readiness.md) 和 [兼容性记录](docs/compatibility.md)。以下文档保留早期策略、失败与独立实验；它们不替代本次真实增量验收，也不与本次结果合并计算性能：

- [实现与实验记录](docs/implementation-report.md)、[补充审查记录](docs/followup-audit.md)
- [离线安装验证](docs/installation-verification.md)
- [实验协议](docs/experiment-protocol.md)、[可移植逐任务证据](docs/evidence/README.md)
