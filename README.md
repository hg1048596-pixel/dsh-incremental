# dsh-incremental

面向单个本地代码仓库的声明式、只读审查任务缓存。输入未变化且来源可核实时复用结果；输入、任务定义、权限或上游结果变化时，只重跑受影响任务及其下游。

**缓存有效不等于结论正确。** 首版只保证模型实际收到的局部输入可追溯，不证明任务声明覆盖完整语义依赖。无法确定依赖或权限时不复用。

当前兼容基线是 Windows 上已安装的 **DSH 0.1.0-rc.6 / Node 22.23.2**。官方 0.2.2-rc.1 只做接口对照，未宣称运行兼容。详细检查见 [兼容性记录](docs/compatibility.md)。

本次交付的测试、原始失败、修正后复测和实际性能数据见 [实现与实验记录](docs/implementation-report.md)。真实模型共使用 46 次调用；其结果因模型版本无法核实而不复用。

继续验收时发现的问题、修复与剩余边界见 [补充审查记录](docs/followup-audit.md)。

[可移植逐任务实验记录](docs/evidence/README.md) 随仓库分发，保留原始失败与未知计数，移除了本机路径、权限记录和请求正文。[安装验证](docs/installation-verification.md) 已覆盖真实公开 CLI 与 pnpm 的隔离离线安装；[发布检查](docs/release-readiness.md) 记录了取消与恢复的最终行为。

## 快速开始

核心与离线演示只使用 Node 内置模块，不需要 `npm install`。在本项目目录运行：

```powershell
git clone https://github.com/hg1048596-pixel/dsh-incremental.git
cd dsh-incremental
```

```powershell
npm test
node bin/dsh-incremental.js doctor --json
node bin/dsh-incremental.js demo --output artifacts/demo
node bin/dsh-incremental.js benchmark --output artifacts/benchmark --repetitions 3
```

`demo` 和默认 `benchmark` 使用确定性规则执行器，**不是 AI 审查**。示例包含 auth、pricing、pagination 三个模块及一个汇总任务。预期执行数量为：首次 4，无变化 0，修改 pricing 后 2。每次演示都会新建独立目录，不覆盖上一份结果。

Windows 演示真实读取 owner/DACL；若执行环境禁止读取必要目录的 ACL，则会保守重跑，不能达到预期命中数量。命令会返回非零状态，并在报告中说明 `permissions_unverified`。不要通过伪造权限记录来产生性能结论。单元测试中的注入式权限提供器仅用于确定性故障测试。

GitHub Actions 使用 Windows、Ubuntu 和 Node 22.23.2 运行内置测试及打包。缺少已有 DSH 或包管理器时，依赖本机安装的测试会明确跳过；CI 通过不代替本机 DSH 兼容验证。

## 任务清单与命令

任务清单是纯 JSON，不包含可执行脚本、模型路由或权限。示例：

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "auth",
      "description": "只审查提供的认证代码，找出具有源码证据的访问控制问题。",
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

输入路径相对于仓库根目录。目录递归包含所有条目，包括未跟踪文件、隐藏文件和空目录；不会默默应用 `.gitignore`。应声明所需子目录，不应把整个仓库连同依赖与凭据目录无差别加入任务。新增、删除、重命名均改变相应目录清单。明确声明的文件删除会使任务失败并阻塞下游。

```powershell
node bin/dsh-incremental.js plan --repo C:\work\sample --manifest C:\work\review.json --state C:\review-state
node bin/dsh-incremental.js run --repo C:\work\sample --manifest C:\work\review.json --state C:\review-state
node bin/dsh-incremental.js run --repo C:\work\sample --manifest C:\work\review.json --state C:\review-state --full
node bin/dsh-incremental.js resume --repo C:\work\sample --manifest C:\work\review.json --state C:\review-state --run-id RUN_ID
node bin/dsh-incremental.js report --repo C:\work\sample --state C:\review-state --run-id RUN_ID
```

不传 `--dsh-config` 时，上述命令仍是合成规则执行器，不能替代通用代码审查。`plan` 不创建缓存、持有写锁或调用模型。`resume` 使用原清单重新核对当前输入，不盲目继续旧快照；改变清单后应开始新运行。`--full` 强制执行当前 DAG。

报告可用 `--json` 输出 JSON，并用 `--output PATH` 保存到仓库外。默认状态目录是 Windows `%LOCALAPPDATA%/dsh-incremental`；其他平台使用用户缓存目录。源码只读，缓存必须位于被审查仓库之外。

## 真实模型与数据授权

使用本机 DSH 的公开 LLM 服务和官方适配器。执行器创建独立 Cordis root，只注册固定路线；不继承聊天历史、工具、自动 AGENTS.md、记忆或宿主的 LLM 中间件。

复制 [配置模板](examples/dsh-config.example.json) 到你控制的配置位置，填入已有运行时路径、模型、端点、凭据引用及明确批准的仓库。**密钥不应写入 JSON、任务清单或仓库。**

```powershell
node bin/dsh-incremental.js run --repo C:\work\sample --manifest C:\work\review.json --state C:\review-state --dsh-config C:\private\review-config.json
```

凭据默认从配置的具名环境变量取得。CLI 也支持 `--credential-file C:\private\deepseek-key.txt`，私下读取仅含一条密钥的 UTF-8 文件；只为配置的引用返回该值，不写入身份、日志或报告。

合成实验的授权另设明确开关，自动批准的目录仅来自实验生成器：

```powershell
node bin/dsh-incremental.js benchmark --dsh-config C:\private\review-config.json --credential-file C:\private\deepseek-key.txt --allow-synthetic-remote --output artifacts/benchmark-real --repetitions 3
```

每次实验最多 48 次请求，每次输出最多 4096 tokens，无自动重试、并发为 1。凭据不进入模型提示词。仅支持 HTTPS 远程端点或 HTTP 回环地址；不会自动安装模型、升级 DSH、切换模型或调用账户登录路线。

**当前 DSH 适配器只提供模型 ID，没有可核实的不可变服务端版本。严格策略因此始终将这些 AI 结果标记为 `model_revision_unknown`，仅保存结果、不跨运行复用。** 不接受环境变量或自定义 epoch 冒充模型版本。这使真实模型实验能够检查接口、usage 和检出情况，但不能据此宣称 AI 缓存节省。

## 安装为 DSH 插件

插件包不带构建或安装脚本。先在本项目运行 `npm pack --ignore-scripts`，再由用户在独立 DSH profile 中安装生成的 tgz：

```powershell
dsh plugin --profile incremental-demo add C:\path\dsh-incremental-0.1.0.tgz
```

若已有本机 rc.6、Node 和 pnpm，可用 `npm run verify:installation` 复现离线安装验证。它先打包本项目，再通过公开安装入口安装到独立临时 profile；不提供模型凭据。具体隔离、禁止联网和验证边界见安装验证文档。

无配置时插件保持休眠并给出提示，不扫描仓库或发出模型请求。通过宿主 patch 提供完整配置，示例：

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
    maxRequests: 48
    maxTokens: 4096
```

使用 `dsh --profile incremental-demo --patch C:\private\incremental.yml` 启动，然后调用 `incremental_plan`、`incremental_run` 或 `incremental_report`。宿主配置固定路径与数据授权；工具参数不能改变仓库、凭据或模型路线。`incremental_run` 仅接受可选的 `full`；`incremental_report` 接受 `runId`。插件从已有 credentials 服务解析指定引用，否则使用对应环境变量。

旧版 jobs 完成通知可能额外唤醒父模型，且没有已核实的逐任务静默开关，因此首版只提供可取消的前台运行；`background: true` 明确报错。普通子 Agent 不用于可信缓存工作器。插件不修改现有 DSH 核心或安装配置，不自动发布。

## 指纹、失效与恢复

每次运行重新读取全部声明输入，不把时间戳或 Git 状态当内容哈希。SHA-256 的对象包括完整任务、原始文件内容与目录清单、上游结果版本、实际请求、执行器与适配器身份、提示词/工具/验证器版本、实现摘要、权限与仓库身份。

- 同一次读取的字节生成内容哈希和模型输入。前后复核及结束复核检测变化；不声称双扫描提供跨文件原子快照。
- 路径越界、链接/reparse point、Windows ADS、非法 UTF-8、读取失败和超限都明确失败；默认完整任务请求不超过 256 KiB，不静默截断。
- 输入或上游变化、损坏、未完成及不能复用均使节点变脏。上游每次成功执行生成新结果版本，即使文字相同也重跑下游。
- 未声明文件不影响局部缓存；这不是对其语义无关的证明。需要更多代码、运行环境或外部资料时扩展任务清单；明确未知依赖的结果及下游不复用。
- 内容寻址对象、文件 fsync、原子替换、结果摘要与 schema 检查防止半写入被视为成功。Windows 不提供本实现可用的目录 fsync，突然断电仍可能造成最近元数据丢失；下次读取缺失或损坏会重算。
- 新执行开始前，任务 head 持久改为 running；失败、取消或中断后不能回退旧成功对象。成功的独立分支保留；下游失败明确标为 blocked。
- 全局取消时，尚未开始执行的任务保留已有提交；恢复时重新核对输入与上游版本。已经开始新代次的取消仍会淘汰旧成功结果。
- 单写者锁只在同一主机确认旧进程已死时恢复；锁身份不明保持 busy。缓存损坏可隔离至 quarantine。恢复不会重新执行源代码或重放副作用。

如果进程恰好在旧锁恢复期间中断，可能留下 `writer.lock.recovery`。它没有可验证的所有者，后续运行会保守返回 `CACHE_LOCK_BUSY`。人工恢复前必须停止并确认没有相关写进程，再将这个遗留恢复门文件移到隔离位置；不要直接删除 `writer.lock`。之后正常启动仍会独立核实原写进程已结束。该罕见窗口尚不支持无人值守恢复。

报告分别保留执行状态、缓存资格、当前源码适用性及 `validation[]`。schema、证据引用、无工具请求、来源检查成功不代表语义验收已通过；`conclusion_correctness` 始终记录为未执行。模型自报的依赖不是读取边界的唯一证据，实际输入由宿主构造。

`inputSnapshot` 记录本次实际读取的文件摘要与目录清单，`upstreamVersions` 记录实际消费的上游版本。复用时，`validation` 只列本次重新执行的检查，原结果生成时的检查另存于 `reusedFrom.validation`。执行器明确返回截断、工具调用或其他非正常结束原因时，即使 JSON 结构完整，也不会提交为成功结果。

## 实验与限制

完整步骤见 [实验协议](docs/experiment-protocol.md)。三个模块预置三个问题，修改只修复 pricing，留下两个问题。答案与源码指纹放在被审查仓库之外，不向模型提供。实验保留逐次原始报告、缺失 usage、失败尝试和额外发现。

检出评分仅按预先固定的位置及证据引用进行，不是完整语义裁判；额外发现不自动计为误报。输入附带宿主生成的行号，严格证据校验失败仍会使任务失败并阻塞汇总，不自动修复答案或追加请求；失败报告单独保留被拒绝的结构化输出和请求，不供下游消费。`modelCalls` 记录模型分发尝试，前置认证失败时不等于已发送的 HTTP 请求；缺少调用计数的执行器返回未知，不能当作零。模型生成随机、供应商缓存与本机权限检查开销都会影响时间；三个重复实验不能支持普遍性能结论。

缓存包含模型可见的源码文本和分析结果，默认仅写本地专用状态目录；请像源码一样保护该目录。摘要检测意外损坏，不抵抗能改写本机缓存及代码的同权限攻击者。独立 Cordis root 是上下文与注册表隔离，不是操作系统安全沙箱；安装的 DSH 运行时和受审计适配器属于信任边界。

Windows 本机路径和权限已测试；其他平台只保留保守读取路径，未经同等级实际环境验证不宣称完整兼容。未知权限机制（包括不能完整证明的 POSIX ACL）会禁用复用。v1 不支持跨仓库、自动导入依赖闭包、任意脚本验证或修改/消息/联网行为缓存。

## 文件与公共接口

- `src/engine.js`：`runReview`、`planReview`；`src/manifest.js`：`readManifest`、`validateManifest`。
- `src/snapshot.js`、`src/cache.js`：冻结输入、权限证明、持久缓存与写锁。
- `src/dsh-executor.js`、`src/plugin.js`、`src/doctor.js`：受控模型执行与旧版适配。
- `src/benchmark.js`、`src/fixture-executor.js`、`examples/`：可复现合成演示和实验。
- `test/`：失效、权限、失败恢复、协议、预算和真实旧版服务接口测试。

所有可执行测试和示例脚本都是本插件自带代码；不会加载目标仓库的包管理器、测试命令或配置脚本。
