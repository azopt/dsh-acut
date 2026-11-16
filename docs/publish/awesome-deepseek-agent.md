# awesome-deepseek-agent · 双语教程模板 / Bilingual guide template

> 目标仓库：[`deepseek-ai/awesome-deepseek-agent`](https://github.com/deepseek-ai/awesome-deepseek-agent)（"每个工具怎么接 DeepSeek 模型"，安装 → 配置 → 首次运行）。
>
> **一个 PR = 两个文件 + 两个 README 表格行。** 英文 `docs/<tool_name>.md`，中文 `docs/<tool_name>.zh-CN.md`，在**同一个 PR** 里提交；README.md 与 README.zh-CN.md 各插一行，**按字母序**插入（不追加到末尾）。

---

## 0. 提交前检查 / Pre-flight

| 项 | 要求 |
| --- | --- |
| 文件名 | `docs/<tool_name>.md`、`docs/<tool_name>.zh-CN.md`（`tool_name` 小写下划线，如 `claude_code`） |
| README | `README.md` + `README.zh-CN.md` 都要加行，字母序 |
| 模型名 | 只写 `deepseek-v4-pro` / `deepseek-v4-flash`；`deepseek-chat` / `deepseek-reasoner` / `deepseek-coder` 已废弃 |
| 1M 上下文 | 配置里设出来，或正文明确提到 V4 支持 1M |
| 思考档位 | 能用 `max` 就用，别教用户关掉思考来绕 API 报错 |
| 价格表 | 要写就核对官方 pricing 页，别抄旧数字 |
| 配置字段 | 只写**验证过真的生效**的字段 |
| 图片 | `docs/assets/`，描述性文件名，体积克制，中英两版都要渲染正常 |
| 拆 PR | 一个工具一个 PR，中英版本不许拆 |

---

## 1. 模板 A：`docs/<tool_name>.md`（English）

```md
[English](./{{tool_name}}.md) | [简体中文](./{{tool_name}}.zh-CN.md) · [← Back](../README.md)

# Integrate with {{Tool Display Name}}

{{One sentence: what the tool is — open source? terminal / IDE / web? who maintains it.}}

#### 1. Install {{Tool}}

{{Download page or package command. Note the minimum version you verified, and say that older versions may fail.}}

#### 2. Configure DeepSeek

- Open {{settings location in the tool}}
- Provider: `DeepSeek` (OpenAI-compatible base URL `https://api.deepseek.com`)
- API key: create one at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
- Model: `deepseek-v4-pro` (best) or `deepseek-v4-flash` (faster / cheaper)
- Context window: `1000000` (DeepSeek V4 supports 1M tokens) {{or: this tool has no context setting — mention it in prose}}
- Reasoning effort: `max` {{CLAUDE_CODE_EFFORT_LEVEL=max | reasoning_effort | thinking.enabled …}}

#### 3. First Run

{{Send one prompt, what a healthy answer looks like, and the one-line proof that the DeepSeek provider (not the default one) answered.}}

#### 4. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| {{401 / model not found / …}} | {{…}} | {{…}} |
```

---

## 2. 模板 B：`docs/<tool_name>.zh-CN.md`（简体中文，与 A 逐节对应）

```md
[English](./{{tool_name}}.md) | [简体中文](./{{tool_name}}.zh-CN.md) · [← 返回](../README.zh-CN.md)

# 在 {{工具名}} 中接入 DeepSeek

{{一句话：这个工具是什么，开源吗，终端 / IDE / 网页，谁维护。}}

#### 1. 安装 {{工具名}}

{{下载页或安装命令；写清你验证过的版本下限。}}

#### 2. 配置 DeepSeek

- 打开 {{工具里的设置位置}}
- Provider 选 `DeepSeek`（OpenAI 兼容地址 `https://api.deepseek.com`）
- API Key：[platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 创建
- 模型：`deepseek-v4-pro`（效果最好）或 `deepseek-v4-flash`（更快更便宜）
- 上下文：`1000000`（DeepSeek V4 支持 1M）{{或：该工具没有上下文设置，正文说明一下}}
- 思考档位：`max` {{同上，按工具填}}

#### 3. 首次运行

{{发一句什么，正常回答长什么样，怎么一眼确认是 DeepSeek 在答而不是默认 provider。}}

#### 4. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| {{401 / 找不到模型 / …}} | {{…}} | {{…}} |
```

---

## 3. README 表格行（两处都要，字母序）

`README.md`：

```md
| **{{Tool}}** | {{One-line English description, no marketing adjectives.}} | [Guide](./docs/{{tool_name}}.md) |
```

`README.zh-CN.md`：

```md
| **{{工具名}}** | {{一句话中文描述，跟英文一致，不要营销词。}} | [指南](./docs/{{tool_name}}.zh-CN.md) |
```

---

## 4. PR 标题与正文模板

标题：

```text
docs: add {{Tool}} integration guide (en + zh-CN)
```

正文：

```md
## What

Adds a bilingual guide for **{{Tool}}**: `docs/{{tool_name}}.md` + `docs/{{tool_name}}.zh-CN.md`,
plus one row in `README.md` and `README.zh-CN.md` (alphabetical).

## Checklist

- [ ] Model names are `deepseek-v4-pro` / `deepseek-v4-flash` (no v3 names)
- [ ] 1M context configured or mentioned
- [ ] `max` reasoning effort supported or noted
- [ ] Config fields verified in {{Tool version}}
- [ ] Pricing (if any) checked against api-docs.deepseek.com
- [ ] No workaround for an already-fixed upstream bug
- [ ] Screenshots in `docs/assets/`, readable in both languages
```

---

## 5. 已填好的例子：ACut（English）

`docs/deepseek_harness_acut.md`

[English](./deepseek_harness_acut.md) | [简体中文](./deepseek_harness_acut.zh-CN.md) · [← Back](../README.md)

# Integrate with DeepSeek Harness + ACut

DeepSeek Harness (`dsh`) is DeepSeek's open-source agent harness — a runnable coding agent for the
terminal and the Web, built on a plugin framework where every part is a plugin. ACut is a screenshot
plugin for it: region capture, annotation, scrolling long capture, a live stitched preview and
pin-to-screen, plus a `screenshot` tool the agent itself can call.

#### 1. Install DeepSeek Harness

Install the desktop app, or run `dsh web` — both use the same profile. {{verify the download link and the minimum version you tested}}

#### 2. Configure DeepSeek

- Open **Settings → Models** and choose `deepseek-v4-pro` (or `deepseek-v4-flash`)
- Paste an API key from [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
- DeepSeek V4 supports 1M tokens of context; keep the host default unless you need to trim it
- Use the `max` thinking level for coding work

#### 3. Install ACut

    dsh plugin --profile <your-profile> add dsh-acut

Or install it from the plugin market. Restart the Web host if your host asks for it.

#### 4. First capture

- Press `Ctrl+Shift+X` — the screen freezes and a region selector appears
- Drag a region, annotate it, then press `Enter` to copy and save
- Press `S` to start a scrolling capture, scroll the page yourself, then press `Enter`

#### 5. Let the agent capture

Ask the agent to take a screenshot; it calls the `screenshot` tool (`list` / `screen` /
`window` / `scroll`) and the image comes back in the conversation.

---

## 6. 已填好的例子：ACut（简体中文）

`docs/deepseek_harness_acut.zh-CN.md`

[English](./deepseek_harness_acut.md) | [简体中文](./deepseek_harness_acut.zh-CN.md) · [← 返回](../README.zh-CN.md)

# 在 DeepSeek Harness + ACut 中接入 DeepSeek

DeepSeek Harness（`dsh`）是 DeepSeek 开源的 Agent 运行框架，终端和网页都能跑，内核就是一套插件体系。
ACut 是它的截图插件：框选截图、随手标注、滚屏拼接长截图、悬浮预览拼接结果、一键钉住置顶，
并把同一套能力作为 `screenshot` 工具交给 Agent 调用。

#### 1. 安装 DeepSeek Harness

装桌面版，或直接跑 `dsh web`，两者用同一份 profile。{{补上下载链接与你实测的最低版本}}

#### 2. 配置 DeepSeek

- 打开 **设置 → 模型**，选 `deepseek-v4-pro`（或 `deepseek-v4-flash`）
- 贴入 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 的 API Key
- DeepSeek V4 支持 1M 上下文，一般保持宿主默认即可
- 写代码建议把思考档位开到 `max`

#### 3. 安装 ACut

    dsh plugin --profile <你的 profile> add dsh-acut

也可以在插件市场里一键安装。宿主若提示重启，重启一下 Web 端。

#### 4. 第一次截图

- 按 `Ctrl+Shift+X`，屏幕定格并出现选区
- 拖出一块区域，随手标注，按 `Enter` 复制并保存
- 按 `S` 进入滚屏截图，自己往下滚，再按 `Enter` 收工

#### 5. 让 Agent 自己截

直接让 Agent 截图，它会调用 `screenshot` 工具（`list` / `screen` / `window` / `scroll`），
图片会回到对话里。

---

## 7. 提交前的诚实检查 / Honesty check

- 描述里写了几个功能，就一定对应得上；写「1M 上下文」就要真的能用。
- 不要为别人的上游 bug 写降级方案，指向上游修复。
- 只写验证过的配置字段；不确定的地方留 `{{verify}}`，实测后删掉。
- 一个 PR 只放 ACut 这一件事，不夹带其他工具或无关改动。
- 合并前把 `{{...}}` 全部清掉——评审会逐条对照代码。
