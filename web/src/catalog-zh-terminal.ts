/** @file Simplified Chinese messages for Workers → Scratch terminals. */

/** Scratch terminal workspace, panes and keyboard controls. */
export const ZH_TERMINAL: Readonly<Record<string, string>> = {
  'Worker logs & handoffs': '工作者日志与交接',
  'Scratch terminals': '临时终端',
  'Start scratch terminal': '启动临时终端',
  'Refresh sessions': '刷新会话',
  'Open session output': '打开会话输出',
  'Worker workspace mode': '工作者工作区模式',
  'Scratch terminal provider': '临时终端提供方',
  'Existing scratch terminal session': '现有临时终端会话',
  'Operator scratch terminals': '操作员临时终端',
  'Real native CLI sessions in separate scratch worktrees. These are distinct from managed worker logs, durable conversations, instructions, and delivery evidence. Hidden views stop reading; native sessions retain backend idle and lifetime limits.':
    '在独立临时工作树中运行的真实原生 CLI 会话。它们不同于受管工作者日志、持久对话、指令和交付证据。隐藏的视图会停止读取；原生会话仍受后端空闲和生命周期限制。',
  'Session refresh failed. Reconnect to the local console; no start request was sent.':
    '会话刷新失败。请重新连接本地控制台；未发送任何启动请求。',
  'Starting an owned scratch terminal…': '正在启动自有临时终端…',
  'Session created. Current native process and connection state are shown in its pane.':
    '会话已创建。当前原生进程和连接状态显示在其窗格中。',
  '{reason} Refresh sessions before retrying; requests are never replayed automatically.':
    '{reason} 重试前请先刷新会话；请求绝不会自动重放。',
  'Start was not confirmed.': '启动未得到确认。',
  'Two panes are open. Close and remove a settled pane before opening another.':
    '已打开两个窗格。请先关闭并移除一个已结束的窗格，再打开新的窗格。',
  'Close session': '关闭会话',
  'Reconnect output': '重新连接输出',
  'Remove pane': '移除窗格',
  '{provider} scratch terminal': '{provider} 临时终端',
  '{provider} terminal output': '{provider} 终端输出',
  'Recent scrollback (memory only)': '最近的回滚内容（仅在内存中）',
  'Recorded {state}': '已记录：{state}',
  'Closing requested. Waiting for owned process cleanup…': '已请求关闭。正在等待自有进程清理…',
  '{state} · output {phase}': '{state} · 输出 {phase}',
  'Replay is unavailable after a backend restart or retention limit. Retained metadata does not verify a live native process. Input stays disabled.':
    '后端重启或达到保留上限后无法重放。保留的元数据不能证明原生进程仍在运行。输入保持禁用。',
  'Earlier output was evicted. Display reset; request a CLI redraw if needed.':
    '较早的输出已被清除。显示已重置；如有需要，请让 CLI 重绘。',
  'No retained scrollback.': '没有保留的回滚内容。',
  'Close was not confirmed. Inspect or refresh sessions before deciding whether to try again.':
    '关闭未得到确认。请先检查或刷新会话，再决定是否重试。',
  'Capture keyboard': '捕获键盘',
  'Release keyboard': '释放键盘',
  'Send Tab': '发送 Tab',
  'Send Escape': '发送 Escape',
  'Apply size': '应用尺寸',
  'Captured terminal keyboard input': '已捕获的终端键盘输入',
  'Capture keyboard to send native input. Escape releases; Tab moves focus.':
    '捕获键盘以发送原生输入。按 Escape 释放；按 Tab 移动焦点。',
  'Input goes directly to this scratch CLI. It is not a durable worker instruction and is never saved or replayed.':
    '输入会直接发送到此临时 CLI。它不是持久的工作者指令，绝不会被保存或重放。',
  'Input was not confirmed. Unsent keys were discarded. Inspect the CLI before capturing again; nothing was retried.':
    '输入未得到确认。未发送的按键已丢弃。再次捕获前请检查 CLI；没有进行任何重试。',
  'Paste exceeds the raw clipboard or 16 KiB native input limit. Split it into smaller explicit pastes.':
    '粘贴内容超出原始剪贴板或 16 KiB 原生输入上限。请拆分为更小的多次粘贴。',
  'Terminal input queue is full. This input was not queued; wait before trying again.':
    '终端输入队列已满。此输入未加入队列；请稍后再试。',
  'Terminal columns': '终端列数',
  'Terminal rows': '终端行数',
  'Terminal pane height': '终端窗格高度',
  'Fit to pane': '适应窗格',
  'Resize was not confirmed. Auto fit is disabled; inspect the native size before retrying.':
    '调整尺寸未得到确认。自动适应已禁用；重试前请检查原生尺寸。',
  Compact: '紧凑',
  Standard: '标准',
  Tall: '加高',
};
