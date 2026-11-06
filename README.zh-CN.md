# pi-extensions

[pi coding agent](https://pi.dev) 的小扩展合集。一个仓库就是一个 pi 包，每个扩展放在 `extensions/<名称>/index.ts`，安装后自动加载。

## 安装

```bash
pi install git:github.com/szxypi/pi-extensions
```

只加载其中几个，可以在 `~/.pi/agent/settings.json` 里用过滤写法：

```json
{ "source": "git:github.com/szxypi/pi-extensions", "extensions": ["extensions/session-autoname/index.ts"] }
```

## 扩展

### session-autoname 会话自动命名

pi 默认不会给会话起名。这个扩展在后台把第一条请求发给模型，生成短标题后调用 `pi.setSessionName()`，`/resume` 列表、状态栏和终端标题都会显示它。

- 每个会话只跑一次，和第一轮对话并行，不拖慢主流程。
- 不覆盖 `/name`、`--name` 或其他扩展设置的名称。
- 模型调用失败时，用请求的第一行做标题。
- print/json 模式和 pi-subagents 子进程里不运行。
- `/autoname` 重新生成标题，`/autoname status` 查看配置。

配置文件 `~/.pi/agent/session-autoname.json`（都可省略）：

```json
{ "enabled": true, "model": "provider/model-id", "maxLength": 40, "timeoutMs": 20000 }
```

`model` 默认用当前会话的模型，换成小而快的模型更省。第一条请求（最多 2000 字）会发给这个模型。

### terminal-status 终端状态

参考 Claude Code，把 pi 的运行状态显示在终端标签页上。

| 状态 | 标签标题 | OSC 9;4（Windows Terminal 标签进度环和任务栏） |
|---|---|---|
| 运行中 | `◐`/`◑` 每 960 ms 切换 | 不定进度 |
| 等你确认（对话框） | `⏸` | 警告（黄） |
| 完成 | `✓`，按任意键后恢复 | 清除 |
| 出错 | `✗`，按任意键后恢复 | 错误（红） |
| 空闲 | `✳` | 清除 |

标题格式是 `<图标> <会话名> · <目录名>`。

pi 本身已经支持 [OSC 7501](https://www.superlogical.com/rex/docs/build/program-status)，终端回应支持查询后（Ghostty 等）就会上报这些状态。Windows Terminal 目前还不支持 OSC 7501，所以这个扩展用 OSC 9;4 和标题把同样的状态显示出来。

- OSC 9;4 默认只在能显示的终端上开启：Windows Terminal（`WT_SESSION`，WSL 里也有）、ConEmu、Ghostty ≥ 1.2、iTerm2 ≥ 3.6.6；tmux/screen/zellij 里跳过。如果开了 pi 自带的 `terminal.showTerminalProgress`，OSC 9;4 交给 pi，扩展不重复写。
- `/terminal-status` 查看检测结果。

配置文件 `~/.pi/agent/terminal-status.json`：`{ "progress": "auto" | "on" | "off", "title": true }`。设置 `PI_TERMINAL_STATUS=0` 关闭扩展。

### image-paste 粘贴图片占位符

粘贴剪贴板图片时，输入框显示 `[Image #1]`，效果与 Claude Code 相同。

- 用 `Ctrl+V` 读取剪贴板（Windows 原生终端为 `Alt+V`）。读取沿用 pi 自带的实现，WSL 下依次尝试 wl-paste 和 PowerShell。
- 输入框不再显示临时文件路径，改显示 `[Image #N]`。退格和方向键把占位符当成一个整体处理。
- 提交时，图片作为附件发给模型，占位符保留在消息文本里。
- bash 模式（`!` 开头）保留临时文件路径，因为文本会作为 shell 命令执行。
- 清空输入后，编号从 1 重新开始。
- 从历史记录召回的占位符不再带图。
- 设置 `PI_IMAGE_PASTE=0` 关闭扩展。

### claude-synced-skills Claude 同步技能去重

Claude Code 把 claude.ai 的技能同步到 `~/.claude/skills/synced/<桶ID>/`，每个 claude.ai 账号一个桶。多个账号同时同步时，同一个技能会出现在多个桶里，版本各不相同。pi 会扫描整棵目录，对每个重名技能打印一行 `[Skill warnings] ... collision`，并按桶目录的字母序取第一个，常常是旧版本。

这个扩展替换了这次扫描。它在 `resources_discover`（启动和 `/reload`）时读取每个桶的 `manifest.json`，每个技能名只返回一个 `SKILL.md` 文件路径。不需要人工维护桶 ID，新桶在下次启动或 `/reload` 时自动生效。

- 选 `updatedAt` 最新的一份。相同时，选桶 `lastUpdated` 大的；再相同时，选桶目录名大的。
- manifest 列出但 `SKILL.md` 不存在的条目会跳过，所以正在同步的桶不会遮住技能。manifest 缺失或损坏的桶整体跳过。
- 默认跳过的技能（它们依赖 pi 没有的 claude.ai 连接器或记忆工具）：`skill-creator`、`docs`、`google-workspace`、`import-memory`、`morning`、`setup-writing-style`。

必须配合忽略规则使用。在 `~/.claude/skills/.gitignore` 里加一行，让 pi 自己的扫描跳过这棵目录：

```
/synced/
```

没有这一行，pi 仍会加载整棵目录，碰撞告警不会消失。Claude Code 不读这个文件。

配置文件 `~/.pi/agent/claude-synced-skills.json`（可省略）。`skip` 会替换默认跳过列表，空数组表示全部加载。JSON 损坏或类型错误时，使用默认列表。

```json
{ "skip": ["skill-creator", "docs"] }
```

## 开发

```bash
npm test                            # 单元测试（node --test，无需安装依赖）
pi -e ./extensions/<名称>/index.ts   # 不安装，单次试用某个扩展
```

每个扩展的纯逻辑放在 `index.ts` 旁边，不引用 pi，测试直接用 Node 22.6+ 的类型剥离运行。

## 许可

MIT
