# Windows 权限读取优化

本次只优化 Windows 权限观察的实现：每次仍启动新的 `pwsh`，读取新的进程身份、所有输入和祖先路径的权限；将 `Get-Item`、`Get-Acl` 换成直接的 .NET API，减少 PowerShell 命令模块加载和 provider 调用开销。没有引入权限缓存、长期存活的权限工作进程或跨任务复用的 ACL 观察。

## 保持的检查

- 每个快照仍进行两次内容扫描和两次权限观察；任务执行后及整个 DAG 结束时的复核保持不变。
- 每次观察重新获取用户和组 SID、文件属性及 reparse 标志、owner 和 SDDL。覆盖声明输入、目录条目及全部祖先路径。
- `GetAccessControl` 读取 Access、Owner、Group，与原有不带 `-Audit` 的 `Get-Acl` 范围一致。owner 名称无法映射时保留原有 owner-only SDDL 回退，不把其他读取异常转换为成功。
- 30 秒超时、4 MiB 输出上限、取消及失败时禁止复用的行为保持不变。未知权限和链接仍不能形成可复用成功结果。
- 子进程输入、输出明确使用 UTF-8，与 Node 的 JSON 字节协议一致，避免 Windows 系统代码页把中文或其他非 ASCII 路径解释成不同的文件名。

实现依据：[.NET GetAccessControl](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemaclextensions.getaccesscontrol)、[PowerShell Get-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl?view=powershell-7.6)。原有权限模型的范围没有扩大为完整操作系统安全证明。

## 本机结果

2026-11-12，在同一台 Windows 机器、Node 22.23.2、PowerShell 7.6 下，旧提交 `d32f848` 与本次实现进行五组交替次序配对。结果见[完整逐次数据](evidence/permission-performance.json)。

| 中位耗时 | 旧实现 | 新实现 | 减少 |
| --- | ---: | ---: | ---: |
| 总耗时（含新 Node 进程启动） | 23.717 秒 | 15.403 秒 | 8.314 秒 |
| 核心 runReview | 23.517 秒 | 15.108 秒 | 8.409 秒 |
| 输入与权限快照 | 22.821 秒 | 14.695 秒 | 8.126 秒 |

十次计时运行均执行零项、复用四项、模型调用零次，每次均观察到 16 个新启动的权限子进程。两种实现各五次，分别执行 80 次权限观察；检查次数没有减少。测量前后的完整权限和快照摘要相同，源文件没有变化。

这是一个四任务小型样例的五组本地测量；绝对耗时受普通机器负载和进程调度影响。没有重新运行真实模型，没有测量模型目录查询或 DSH 桌面初始化，不据此承诺其他仓库的速度或模型质量。原有真实 API 验收记录仍独立保留。

## 验证与复现

新增原生 Windows 检查覆盖：普通文件、目录和祖先路径与旧实现的完整元数据一致；中文、重音字母和 shell 特殊字符文件名；缺失路径禁止复用；junction 检测与拒绝；真实 DACL 变化使内容未变的快照失效，以及两次观察之间发生变化时检测漂移。测试只修改自行创建的临时文件 ACL，并恢复原始描述符。

本机完整回归：128/128 通过，0 失败、0 跳过，包含已有 DSH rc.6 的集成与安装检查。日志保存在 `artifacts/tests-permissions-final.log`；未安装 DSH 的 CI 会另行标记相关跳过，不能替代本机兼容性验证。

在含有基线提交 `d32f848609e4be68e03135d4b8e87f7b5f26691e` 的本地 checkout 中运行：

```powershell
node tools/benchmark-permissions.mjs --repetitions 5
```

该命令使用同一新建合成仓库、两个独立缓存空间、每次全新的 Node 进程和真实 Windows 权限检查。两种实现分别建立缓存并预热一次，随后交替执行五组无变化运行。每个计时样本必须复用四项、执行零项、生成调用零次，并实际启动 16 个新的权限子进程。对比前后都核对原生权限与快照摘要一致、源码未变化。

这是本地检查路径的性能测量，使用确定性结果填充缓存，不调用模型，不测量模型速度或审查质量。原始记录写入被 Git 忽略的 `artifacts/permission-benchmark/`；其中缓存包含权限来源，应留在本机。

升级会因实现摘要变化而使旧结果按现有规则失效一次；耗时对比针对重新建立缓存后的无变化运行。
