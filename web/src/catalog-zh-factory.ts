/**
 * Simplified Chinese messages for factory setup, capacity, model policy, triage and recovery, keyed by English source text.
 *
 * @file
 */

/** Messages of this area. */
export const ZH_FACTORY: Readonly<Record<string, string>> = {
  'Job cap reached: resources.maxActiveJobs.': '已达作业上限：resources.maxActiveJobs。',
  'Provider cap reached: providers.<name>.concurrency.': '已达提供方上限：providers.<name>.concurrency。',
  'Provider cooldown or observed subscription limit reached; wait for actual reset evidence.':
    '提供方处于冷却或已达到观测到的订阅上限；请等待实际的重置证据。',
  'No provider is currently eligible; inspect enabled providers and diagnostic policy.':
    '当前没有符合条件的提供方；请检查已启用的提供方和诊断策略。',
  'CPU pressure: resources.maxCpuPercent.': 'CPU 压力：resources.maxCpuPercent。',
  'Memory pressure: resources.minFreeMemoryMb or resources.minFreeMemoryPercent.':
    '内存压力：resources.minFreeMemoryMb 或 resources.minFreeMemoryPercent。',
  'No capacity gate reported. Dispatch still requires eligible work and workflow gates; spare capacity does not guarantee launch.':
    '未报告容量关卡。分派仍需要可执行的工作和工作流关卡；有空闲容量并不保证会启动。',
  'sample age unknown': '采样时间未知',
  '{seconds}s old · {status}': '{seconds} 秒前 · {status}',
  '{resources} · total memory {memory} MiB · {freshness}': '{resources} · 总内存 {memory} MiB · {freshness}',
  'Broker reservations {reserved} / resources.maxActiveJobs {limit}. Other broker pipelines/reservations: {other} (identities private).':
    'Broker 预留 {reserved} / resources.maxActiveJobs {limit}。其他 Broker 流水线/预留：{other}（身份不公开）。',
  'resources.maxCpuPercent {cpu}% · resources.minFreeMemoryMb {memory} · resources.minFreeMemoryPercent {memoryPercent}%.':
    'resources.maxCpuPercent {cpu}% · resources.minFreeMemoryMb {memory} · resources.minFreeMemoryPercent {memoryPercent}%。',
  'Admission evidence unavailable; refresh the console or configure the paused factory.':
    '准入证据不可用；请刷新控制台或配置已暂停的工厂。',
  'none reported or unknown': '未报告或未知',
  '{name}: {count} selected-project pipelines · providers.{name}.concurrency {limit} · gate {gate}.':
    '{name}：所选项目的 {count} 条流水线 · providers.{name}.concurrency {limit} · 关卡 {gate}。',
  unavailable: '不可用',
  none: '无',
  '{role} · {kind} · {state} · objective: {objective} · ticket: {ticket} · process activity, not delivery success.':
    '{role} · {kind} · {state} · 目标：{objective} · 工单：{ticket} · 进程活动，不代表交付成功。',
  'No selected-project pipeline is currently owned. Idle roles use no model process.':
    '当前没有属于所选项目的流水线。空闲角色不使用模型进程。',
  'Change admission policy in Project setup while the factory is paused and settled.':
    '请在工厂暂停且稳定后，在项目设置中修改准入策略。',
  'Why work is running or parked': '工作为何在运行或被搁置',
  'Weekly window': '每周窗口',
  'usage unknown': '用量未知',
  '{percent}% used{limit}': '已用 {percent}%{limit}',
  'Individual subscription windows not reported · usage unknown.': '未报告各订阅窗口 · 用量未知。',
  '{minutes} minute window': '{minutes} 分钟窗口',
  '{label}: {usage} · resets {deadline}': '{label}：{usage} · {deadline} 重置',
  'freshness unknown': '新鲜度未知',
  'source unknown': '来源未知',
  'Observed {at} | {freshness} | {source}': '观测于 {at} | {freshness} | {source}',
  '{role}: process usage unavailable or stale.': '{role}：进程用量不可用或已过时。',
  'Owned processes · CPU is percentage of the whole machine': '所属进程 · CPU 为整台机器的百分比',
  Role: '角色',
  'Resident MiB': '常驻内存 MiB',
  'Windows samples come from owned Job Objects. Resident memory can include shared pages. Unavailable measurements stay unknown.':
    'Windows 采样来自所属的 Job 对象。常驻内存可能包含共享页。不可用的测量值保持未知。',
  'Subscription quota and CPU/memory limits govern dispatch. Reported tokens do not use API credits.':
    '分派由订阅配额和 CPU/内存限制决定。报告的 token 不消耗 API 额度。',
  'Subscription limits': '订阅限制',
  'Disabled · not eligible for dispatch': '已禁用 · 不参与分派',
  'Legacy summary only: {usage} · window duration unavailable': '仅有旧版摘要：{usage} · 窗口时长不可用',
  '{provider} reported subscription usage': '{provider} 报告的订阅用量',
  'Absolute allowance unavailable. Observations are not a guarantee of remaining capacity.':
    '绝对额度不可用。观测值不能保证剩余容量。',
  'Configure subscription providers and local resource limits in Project setup.':
    '请在项目设置中配置订阅提供方和本地资源限制。',
  'Diagnostic usage': '诊断用量',
  '{provider}: {used} reported tokens · {reserved} estimated tokens in flight':
    '{provider}：已报告 {used} 个 token · 估计在途 {reserved} 个 token',
  'Local machine': '本地机器',
  'Idle roles consume no model processes. Admission and managed process ceilings protect local resources.':
    '空闲角色不消耗模型进程。准入和托管进程上限会保护本地资源。',
  'Model and effort policy': '模型与推理强度策略',
  'Pause and settle before saving. Use subscription-available models; declared capability and interface evidence are checked before dispatch.':
    '保存前请暂停并等待稳定。请使用订阅可用的模型；分派前会检查声明的能力和接口证据。',
  'Open the policy editor before saving.': '保存前请先打开策略编辑器。',
  'No effort override': '不覆盖推理强度',
  'Policy entry ID': '策略条目 ID',
  Provider: '提供方',
  'Literal model identifier': '模型标识符（原样）',
  'Declared capability': '声明的能力',
  'Verified effort interface': '已验证的推理强度接口',
  'Allow {effort} effort': '允许 {effort} 推理强度',
  'Interface evidence source / notes': '接口证据来源 / 备注',
  'Exact verified CLI version': '已验证的确切 CLI 版本',
  'Evidence timestamp (Unix milliseconds)': '证据时间戳（Unix 毫秒）',
  'Evidence must match the installed CLI. Saving does not certify model capability or available quota.':
    '证据必须与已安装的 CLI 相符。保存并不证明模型能力或可用配额。',
  'Unknown support: this entry cannot launch an explicit-policy assignment.':
    '支持情况未知：此条目无法启动显式策略任务。',
  'Editing revision {revision}. Save requires a paused, settled factory. Unknown quota stays unknown.':
    '正在编辑修订 {revision}。保存需要工厂已暂停且稳定。未知配额保持未知。',
  'Add allowed model': '添加允许的模型',
  'Add provider/tier default': '添加提供方/等级默认值',
  'Allowed model': '允许的模型',
  'Provider/tier default': '提供方/等级默认值',
  'Default provider': '默认提供方',
  'Default capability floor': '默认能力下限',
  'Allowed policy entry ID': '允许的策略条目 ID',
  'Default requested effort': '默认请求的推理强度',
  'Remove this entry': '移除此条目',
  'Allowed models': '允许的模型',
  Defaults: '默认值',
  '# Area: what exists after this change': '# 范围：此变更之后存在什么',
  '## Goal': '## 目标',
  'One sentence describing the outcome.': '用一句话描述结果。',
  '## Changes': '## 变更',
  '1. Each change can be checked against the diff.': '1. 每项变更都可以对照 diff 检查。',
  '## Out of scope': '## 不在范围内',
  '- What this delivery must not touch.': '- 此交付项不得改动的内容。',
  '## Acceptance': '## 验收',
  '- A mechanically checkable result.': '- 可机械检查的结果。',
  'The objective workflow picker is missing from the console shell.': '控制台外壳中缺少目标的工作流选择器。',
  '{name} (project default)': '{name}（项目默认）',
  'Define the next mission': '定义下一项任务',
  'Describe the outcome and boundaries, then choose how it is delivered. Planned workflows turn it into small, reviewable deliveries; direct workflows treat it as one brief.':
    '描述结果和边界，然后选择交付方式。带规划的工作流会将其拆分为可评审的小型交付项；直接工作流将其视为一份简报。',
  'Agent types & reporting hierarchy': '代理类型与汇报层级',
  'Reusable types specialize the eight managed execution seats. Reporting handoffs are durable and delivered on the manager’s next relevant assignment. Mandatory QA and merge gates remain independent.':
    '可复用的类型用于细化八个托管执行席位。汇报交接会持久保存，并在管理者的下一个相关任务中送达。强制的 QA 和合并关卡保持独立。',
  'Edit agent types & hierarchy': '编辑代理类型与层级',
  'Configure the factory in Project setup to establish its managed organization.':
    '请在项目设置中配置工厂以建立其托管组织。',
  'Capability floor: {tier} · prioritized skills: {skills}': '能力下限：{tier} · 优先技能：{skills}',
  'stage baseline only': '仅阶段基线',
  'Reporting handoffs': '汇报交接',
  'Pause managed work before saving. Edit types, prioritized skills, capability floors and member reporting links. Every seat must reference an existing type; cycles and unknown roles are rejected.':
    '保存前请暂停托管工作。可编辑类型、优先技能、能力下限和成员汇报关系。每个席位都必须引用已有类型；循环和未知角色会被拒绝。',
  'Paste an existing https://github.com/users/OWNER/projects/NUMBER or /orgs/OWNER/projects/NUMBER URL.':
    '粘贴已有的 https://github.com/users/OWNER/projects/NUMBER 或 /orgs/OWNER/projects/NUMBER 链接。',
  'Use owner/repository, a positive Project number and the exact existing workflow field name.':
    '请使用 owner/repository、正整数的 Project 编号以及确切的现有工作流字段名称。',
  'Connect GitHub Project': '连接 GitHub Project',
  'Review the saved connection for this repository. This connects an existing Project; it does not create a board.':
    '检查此仓库已保存的连接。这会连接已有的 Project；不会创建看板。',
  Repository: '仓库',
  'GitHub Project URL': 'GitHub Project 链接',
  'Workflow status field': '工作流状态字段',
  'Paste the Project link; its owner and number are derived automatically. Use Status to match the existing board. GitHub CLI verifies repository access, Project permission and all workflow options before saving. Saved views are not changed.':
    '粘贴 Project 链接；其所有者和编号会自动推导。使用“Status”以匹配现有看板。保存前 GitHub CLI 会验证仓库访问、Project 权限和所有工作流选项。已保存的视图不会被更改。',
  'Configure factory policy': '配置工厂策略',
  'Use this project’s actual commands and executable paths. Pause before updating an active factory. Authentication stays with the native CLI.':
    '使用此项目实际的命令和可执行文件路径。更新运行中的工厂前请先暂停。身份验证仍由原生 CLI 负责。',
  'Maximum changed lines per PR': '每个 PR 的最大变更行数',
  'Planning target: 1–500 added/deleted lines, including tests and docs. Larger indivisible scopes require explicit lead justification and must fit this publication ceiling.':
    '规划目标：新增/删除 1–500 行，包括测试和文档。更大且不可拆分的范围需要团队负责人明确说明理由，并且必须在此发布上限之内。',
  'Required workflow gates': '必需的工作流关卡',
  'Every factory ticket belongs to the connected Project. Backlog → reviewed Ready → Development → independent QA → verified merge. Duplicate consolidation requires a separate human decision.':
    '每个工厂工单都属于已连接的 Project。待办 → 已评审的就绪 → 开发 → 独立 QA → 经验证的合并。合并重复项需要单独的人工决定。',
  'Pause the factory before saving. The advanced policy below retains provider, resource and validation settings; no inferred credentials or model billing changes.':
    '保存前请暂停工厂。下方的高级策略会保留提供方、资源和校验设置；不会推断凭据，也不会更改模型计费。',
  'Maximum changed lines must be a positive safe integer.': '最大变更行数必须是正的安全整数。',
  'Continue with team lead': '交由团队负责人继续',
  'Resume independent lead refinement using the retained diagnosis and local ticket evidence. Explain what evidence or decision resolves the blocker.':
    '使用保留的诊断和本地工单证据，恢复团队负责人的独立细化。请说明哪些证据或决定可以解决该阻塞。',
  'Clarify with product owner': '与产品负责人澄清',
  'Return this objective to product refinement with your answer. Existing tickets and source remain intact.':
    '带着你的答复将此目标退回产品细化。已有工单和源码保持不变。',
  'Work existing deliveries': '处理已有交付项',
  'Authorize dispatch of retained delivery tickets across objectives. Hold all new objective planning; preserve dependencies, ownership, QA, tests and merge gates. This does not close the campaign.':
    '授权跨目标分派保留的交付工单。暂停所有新目标的规划；保留依赖、归属、QA、测试和合并关卡。这不会结束本轮工作。',
  'Mission recovery': '任务恢复',
  'MISSION / RECOVERY': '任务 / 恢复',
  'Choose the next safe step.': '选择下一个安全步骤。',
  'Existing deliveries only: retained tickets can progress across objectives. New product planning is held. The campaign remains open until verified.':
    '仅限已有交付项：保留的工单可以跨目标推进。新的产品规划已暂停。在验证之前本轮工作保持开放。',
  'Return to objective dispatch': '返回目标分派',
  'Decision needed': '需要决定',
  'This objective stopped before delivery could continue. Choose a recovery; no issue is silently closed or duplicated.':
    '此目标在交付继续之前已停止。请选择一种恢复方式；不会悄悄关闭或复制任何议题。',
  'Read diagnosis and missing evidence': '阅读诊断和缺失的证据',
  'Backlog clearance: existing delivery tickets across objectives may run. New objective planning is held.':
    '清理积压：跨目标的已有交付工单可以运行。新目标的规划已暂停。',
  'Focused objective: {title}. Other objectives are held from new dispatch.':
    '聚焦目标：{title}。其他目标暂停新的分派。',
  Assignment: '任务',
  'No assignment was claimed': '未认领任何任务',
  'Requested provider': '请求的提供方',
  Unknown: '未知',
  'Requested model': '请求的模型',
  'CLI default · model unknown': 'CLI 默认 · 模型未知',
  'Requested effort': '请求的推理强度',
  'No native effort override recorded': '未记录原生推理强度覆盖',
  'Unknown · historical record has no effort evidence': '未知 · 历史记录中没有推理强度证据',
  'Enforced capability floor': '强制的能力下限',
  'Policy revision': '策略修订',
  'Legacy / not recorded': '旧版 / 未记录',
  'Reviewed recommendation': '已评审的建议',
  'Not recorded for this assignment': '此任务未记录',
  'Reviewed policy revision': '已评审的策略修订',
  'Not recorded / stage default': '未记录 / 阶段默认',
  'Review rationale': '评审理由',
  'Not recorded': '未记录',
  'Selection / override reason': '选择 / 覆盖原因',
  'No routing evidence recorded': '未记录路由证据',
  'Execution confirmation': '执行确认',
  'Requested CLI arguments only; provider-applied model/effort is not independently confirmed.':
    '仅为请求的 CLI 参数；提供方实际采用的模型/推理强度未经独立确认。',
  'Model selection evidence · requested launch': '模型选择证据 · 请求的启动参数',
  'Current supervisor diagnostic (separate from this recorded job): {diagnostic}':
    '当前监督器诊断（与此已记录作业无关）：{diagnostic}',
  'Adopt external merge': '采纳外部合并',
  'Name the full commit already delivered on this project’s main and explain its scope. This queues mandatory merged-main verification; source, worktrees and missing QA evidence are preserved.':
    '填写已交付到此项目 main 上的完整提交，并说明其范围。这会排队进行强制的合并后 main 验证；源码、工作树以及缺失的 QA 证据都会保留。',
  'Approve this size exception': '批准此规模例外',
  'Allow only this validated head/base and measured diff. Explain why splitting would be harmful. Tests, two QA reviews and merge gates remain required; changed source requires a new decision.':
    '仅允许这一经过验证的 head/base 和测量过的 diff。请说明为何拆分有害。测试、两次 QA 评审和合并关卡仍然必需；源码变更后需要新的决定。',
  Acknowledge: '确认已知',
  'Record that you have seen this exact revision. It remains blocked until resolved.':
    '记录你已看过这一确切修订。在解决之前它仍保持阻塞。',
  'Ask the lead': '询问团队负责人',
  'Queue one bounded, read-only lead diagnosis. The lead returns evidence, a recommended action and any question for you, then spins down.':
    '排队一次受限的只读团队负责人诊断。负责人会返回证据、建议的操作以及给你的问题，然后停止。',
  'Send to owner': '发回负责人',
  'Return this scope to its original developer with your instructions. Source and evidence are preserved; new work requires fresh reviews.':
    '带着你的指令将此范围退回给原开发者。源码和证据会保留；新的工作需要重新评审。',
  'Request fresh QA': '请求重新 QA',
  'Review the latest published source independently. Existing approvals are cleared. This does not approve or merge the PR.':
    '独立评审最新发布的源码。已有的批准会被清除。这不会批准或合并该 PR。',
  'Verify merged main': '验证合并后的 main',
  'Explicitly accept investigation of this confirmed external merge through final merged-main checks. Missing pre-merge factory approvals remain missing; no approval is fabricated.':
    '明确接受通过最终的合并后 main 检查来调查这次已确认的外部合并。缺失的合并前工厂批准仍然缺失；不会伪造任何批准。',
  'Wait for decision': '等待决定',
  'Keep this delivery parked with a clear question or reason. No model process is kept open while waiting.':
    '带着明确的问题或原因将此交付项搁置。等待期间不会保留模型进程。',
  'Evidence changed': '证据已变化',
  'Lead queued': '已排队给团队负责人',
  Acknowledged: '已确认',
  'Your decision': '你的决定',
  'Action queued': '操作已排队',
  'Investigation failed': '调查失败',
  'Latest disposition': '最新处置',
  'Lead diagnosis & next action': '团队负责人诊断与下一步',
  'Validated size: {lines} changed lines / {files} files. Approval covers only head {head} against base {base}.':
    '已验证的规模：{lines} 行变更 / {files} 个文件。批准仅覆盖 head {head} 相对于 base {base}。',
  'An assignment owns this delivery. Inspect or safely cancel it in Workers before changing its disposition.':
    '某个任务正占用此交付项。修改其处置前，请先在“工作者”中检查或安全取消该任务。',
  'Read complete blocker report': '阅读完整的阻塞报告',
  'Dispatcher triage': '分派分诊',
  'DISPATCH / FINISH FIRST': '分派 / 先完成',
  'Clear the path.': '扫清障碍。',
  '{length} need attention': '{length} 项需要处理',
  'Supervisor enabled. Existing PR reviews, repairs and verification take priority. Roles spin down while decisions wait.':
    '监督器已启用。已有的 PR 评审、修复和验证优先。等待决定期间角色会停止。',
  'Factory paused. Decisions are saved; jobs start after you resume.': '工厂已暂停。决定已保存；恢复后作业才会开始。',
  'Supervisor diagnostic': '监督器诊断',
  '✓ No delivery blockers awaiting attention.': '✓ 没有等待处理的交付阻塞。',
  'Additional scopes are available in the delivery board.': '更多范围可在交付看板中查看。',
  '{action} · issue #{issue}': '{action} · 议题 #{issue}',
  'Reviewed the current blocker.': '已评审当前阻塞。',
  'ISSUE {issue}': '议题 {issue}',
  'PR {pr}': 'PR {pr}',
  'OWNER {owner}': '负责人 {owner}',
  'External merge commit (full SHA)': '外部合并提交（完整 SHA）',
  'Use the selected repository’s merged main. Verification must pass before completion; this does not grant an approval or merge a PR.':
    '使用所选仓库合并后的 main。完成前验证必须通过；这不会授予批准，也不会合并 PR。',
};
