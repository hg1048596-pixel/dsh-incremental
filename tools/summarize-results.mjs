import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
async function latest(folder) {
  const names=(await readdir(path.join(root,folder),{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort();
  if(!names.length)throw new Error(`No report in ${folder}`);
  const relative=path.join(folder,names.at(-1),'benchmark.json');
  return {file:relative.replaceAll('\\','/'),data:JSON.parse(await readFile(path.join(root,relative),'utf8'))};
}
const fixture=await latest('artifacts/benchmark-fixture-native');
const baseline=await latest('artifacts/benchmark-real');
const followup=await latest('artifacts/benchmark-real-numbered');
const tests=await readFile('artifacts/tests-final.log','utf8');
const count=key=>Number(tests.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]);
if(!Number.isFinite(count('tests'))||count('fail')!==0)throw new Error('A completed passing final test report is required');
const stages=source=>source.data.trials.flatMap(trial=>trial.stages.map(stage=>({repetition:trial.repetition,...stage})));
const average=values=>values.reduce((sum,value)=>sum+value,0)/values.length;
const observed=stages(fixture);
const expectedFixtureStages={
  'seed-incremental':{executed:4,reused:0,findings:3},
  'unchanged-incremental':{executed:0,reused:4,findings:3},
  'modified-full':{executed:4,reused:0,findings:2},
  'modified-incremental':{executed:2,reused:2,findings:2},
};
if(fixture.data.mode!=='fixture' || fixture.data.trials.length!==3 || observed.length!==12 ||
   fixture.data.controls.permissionVerification!=='native' || fixture.data.controls.fullAndIncrementalUseIdenticalChangedSnapshot!==true) {
  throw new Error('A completed native three-repetition fixture experiment is required');
}
for(const trial of fixture.data.trials) {
  if(new Set(trial.stages.map(stage=>stage.stage)).size!==4)throw new Error('Fixture stages are incomplete or duplicated');
  for(const stage of trial.stages) {
    const expected=expectedFixtureStages[stage.stage];
    if(!expected || stage.status!=='completed' || stage.totals.executed!==expected.executed || stage.totals.reused!==expected.reused ||
       stage.totals.modelCalls!==0 || stage.score.matchedCount!==expected.findings || stage.score.expectedCount!==expected.findings) {
      throw new Error(`Fixture acceptance failed: repetition ${trial.repetition}, ${stage.stage}`);
    }
  }
}
const fixtureSummary={repetitions:3,fullMeanMs:average(observed.filter(s=>s.stage==='modified-full').map(s=>s.totals.totalMs)),incrementalMeanMs:average(observed.filter(s=>s.stage==='modified-incremental').map(s=>s.totals.totalMs)),unchangedMeanMs:average(observed.filter(s=>s.stage==='unchanged-incremental').map(s=>s.totals.totalMs)),modelCalls:0,usage:null};
const baselineStages=stages(baseline),followupStages=stages(followup);
const calls=baseline.data.totals.modelCalls+followup.data.totals.modelCalls;
if(![baseline.data.totals.modelCalls,followup.data.totals.modelCalls].every(value=>Number.isSafeInteger(value)&&value>=0))throw new Error('Actual model dispatch counts must be known');
if(calls>48)throw new Error('Experiment exceeded authorized request budget');
const knownUsage={};
for(const field of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens']) {
  const a=baseline.data.totals.usage?.[field],b=followup.data.totals.usage?.[field];
  knownUsage[field]=Number.isFinite(a)&&Number.isFinite(b)?a+b:null;
}
const summary={schemaVersion:1,date:'2026-11-11',timezone:'Asia/Shanghai',tests:{total:count('tests'),passed:count('pass'),failed:count('fail'),skipped:count('skipped')},
  fixture:fixtureSummary,baseline:{calls:baseline.data.totals.modelCalls,runs:baselineStages.length,completed:baselineStages.filter(s=>s.status==='completed').length,partial:baselineStages.filter(s=>s.status==='partial').length,usage:baseline.data.totals.usage},
  followup:{calls:followup.data.totals.modelCalls,protocol:followup.data.protocol??'supplemental-numbered-lines-pair-v1',stages:followupStages.map(s=>({stage:s.stage,status:s.status,totals:s.totals,score:s.score}))},
  totalModelCalls:calls,authorizedMaxModelCalls:48,knownUsage,
  rawReports:{fixture:'docs/evidence/fixture.json',baseline:'docs/evidence/real-baseline.json',followup:'docs/evidence/real-numbered-followup.json'},
  localRawReports:{fixture:fixture.file,baseline:baseline.file,followup:followup.file}};
await writeFile('docs/measurement-summary.json',JSON.stringify(summary,null,2)+'\n');
await writeFile('artifacts/experiment-budget-ledger.json',JSON.stringify({authorizedMax:48,baseline:{report:baseline.file,modelCalls:baseline.data.totals.modelCalls},followup:{report:followup.file,modelCalls:followup.data.totals.modelCalls},total:calls,remaining:48-calls},null,2)+'\n');
const sec=value=>(value/1000).toFixed(2);
const lines=[
  '# 实现、验证与实验记录','',
  '日期：2026-11-11（Asia/Shanghai）。所有模型实验只使用本项目生成的三个合成模块；没有向模型上传真实受审项目代码，没有修改或升级 DSH，也没有发布 npm 包。','',
  '## 实际实现','',
  '- 声明式任务 DAG、受控冻结输入、内容哈希与递归目录清单、上游结果版本、执行来源及严格复用判定。',
  '- 原子提交、对象校验、单写者锁、失败/中断恢复、损坏隔离及逐任务原因报告；新失败不会回退旧成功结果。',
  '- CLI、休眠默认的 DSH bundle、三个工具及独立 Cordis 模型执行器；已验证本机 rc.6 公开接口。',
  '- Windows owner/DACL 和用户/组 SID 指纹；无法证明权限的环境不复用。POSIX 扩展 ACL 尚未实现，因此默认不复用。',
  '- JSON 与 Markdown 报告、确定性示例执行器、真实模型接口、独立答案、配对实验和请求预算。','',
  '补充审查发现的边界问题及修复见 [补充审查记录](followup-audit.md)。该记录区分本轮回归验证与此前真实模型实验。','',
  '## 测试','',
  `最终本机测试：**${summary.tests.passed}/${summary.tests.total} 通过，${summary.tests.failed} 失败，${summary.tests.skipped} 跳过**。本机完整日志为 artifacts/tests-final.log；仓库 [CI 记录](https://github.com/hg1048596-pixel/dsh-incremental/actions) 单独保留缺少宿主时的跳过数量。`,
  '覆盖首次/无变化/修改/增删重命名、目录与权限变化、上游版本、未知依赖、腐败对象、失败和取消、进程 SIGKILL 后恢复、并发锁、路径越界、最终漂移、输入行号、错误证据、用量未知以及 CLI 的链接输出边界。',
  'DSH 测试使用实际安装的工具注册表、LLM 服务和官方适配器。HTTP 替身检查实际发送的 system/user 字段、无工具、4096 上限，以及拒绝工具调用后中止请求；这些测试不联网。','',
  '真实公开 CLI 与现有 pnpm 的隔离离线安装、配置组合、安装副本的工具加载和卸载也已通过，详情见 [安装验证](installation-verification.md)。预先取消和中途取消的回归保证未开始任务保留缓存，已开始新代次不回退旧成功。','',
  '## 原生离线机制实验','',
  '三个独立重复实验，每轮四个任务。所有轮次都是首次执行 4、无变化复用 4、修改 pricing 后执行 pricing 与 summary 两个任务并复用另外两个。固定证据评分首次为 3/3，修复 pricing 后为 2/2。使用真实 Windows 权限检查，没有注入假权限。','',
  '| 测试条件 | 平均端到端耗时 | 执行 / 复用 | 模型调用 / token |',
  '|---|---:|---:|---|',
  `| 修改后全量 | ${sec(fixtureSummary.fullMeanMs)} s | 4 / 0 | 0 / 不适用 |`,
  `| 相同修改后增量 | ${sec(fixtureSummary.incrementalMeanMs)} s | 2 / 2 | 0 / 不适用 |`,
  `| 无变化增量 | ${sec(fixtureSummary.unchangedMeanMs)} s | 0 / 4 | 0 / 不适用 |`,'',
  '这是规则执行器的机制数据，不是 AI 节省证据。该小仓库中 Windows ACL 子进程启动和反复检查占据主要开销；三个重复样本不支持普遍提速结论。','',
  '## 真实 DeepSeek 实验','',
  '固定模型：deepseek-flash；官方 DeepSeek API；thinking disabled；每请求最多 4096 输出 tokens；并发 1、无自动重试。模型没有可核实的不可变服务端版本，因此严格策略下所有 AI 结果均不复用。',
  `原始三轮协议共 ${summary.baseline.runs} 个运行、${summary.baseline.calls} 次调用，其中 ${summary.baseline.completed} 个运行完成、${summary.baseline.partial} 个部分完成。模型错误行号导致证据校验拒绝，并阻塞汇总；没有自动修复、补调用或丢弃这些失败。`,
  '为修复实际暴露的引用问题，随后将提示版本改为 scoped-review-2-numbered-lines，附带明确行号，并单独进行一次配对复测。它使用两个独立空状态目录，不测量已填充缓存的节省，也不与原始实验混合统计。','',
  '| 补充复测 | 状态 | 时间 | 执行 / 复用 | 未缓存输入 | 缓存读取 | 输出 | 固定证据评分 |',
  '|---|---|---:|---:|---:|---:|---:|---:|',
  ...followupStages.map(s=>`| ${s.stage} | ${s.status} | ${sec(s.totals.totalMs)} s | ${s.totals.executed} / ${s.totals.reused} | ${s.totals.usage.inputTokens} | ${s.totals.usage.cacheReadTokens} | ${s.totals.usage.outputTokens} | ${s.score.matchedCount}/${s.score.expectedCount} |`),'',
  `合计 **${calls}/48 次模型分发**。已返回的总计数：未缓存输入 ${knownUsage.inputTokens}、缓存读取 ${knownUsage.cacheReadTokens}、输出 ${knownUsage.outputTokens}。cacheWrite、reasoning 和完整 totalTokens 未由该适配器提供，保留 null，不将缺失当零。`,
  '补充全量结果还包含一个未匹配预设答案的发现；保留它供审阅，不自动判为误报。评分核对预先固定的源码位置和证据，不是完整语义正确性评估。两次上游模型输出不同、供应商缓存与运行噪声会影响 token 和耗时；零复用条件下的时间差不能解释为增量算法带来的 AI 提速。','',
  '## 原始记录与复现','',
  '- [原生离线逐任务证据](evidence/fixture.json)',
  '- [原始三轮真实实验投影，包含失败](evidence/real-baseline.json)',
  '- [增加行号后的独立配对复测投影](evidence/real-numbered-followup.json)',
  '- [机器可读汇总](measurement-summary.json) 与 [证据说明及预算](evidence/README.md)。',
  '- 以上可移植证据随源码及插件包分发，按允许字段投影，移除绝对宿主路径、权限/SID、完整请求和缓存对象；原始文件哈希及实际保留/缺失的来源分别注明。',
  '- 完整原始日志、缓存、预算账本和接口诊断保留在本机 artifacts，不上传 GitHub。README 给出全部命令，实验协议定义任务和评分。','',
  '## 文件与未解决限制','',
  '新增 src 下的任务校验、请求构造、快照、缓存、执行、报告、DSH 适配、诊断及实验模块；新增 bin CLI、examples 示例与配置、test 回归测试、标准 bundle/package 文件和 docs 文档。原工作区为空，没有覆盖已有实现。',
  '未实现：普通 Agent 自由探索结果的可信缓存、服务端不可变模型版本证明、账户登录适配、后台静默 jobs、POSIX 完整 ACL、跨仓库或任意源代码执行验证。完整依赖语义和模型结论正确性仍需独立验证。',
  '下一步优先接入可验证模型版本的本地/固定部署，才能在当前严格策略下测量真实 AI 复用；其次降低 ACL 检查进程开销，并扩大包含跨模块依赖与盲置缺陷的样本。','',
];
await writeFile('docs/implementation-report.md',lines.join('\n'));
console.log(JSON.stringify({report:'docs/implementation-report.md',tests:summary.tests,fixture:fixtureSummary,totalModelCalls:calls}));
