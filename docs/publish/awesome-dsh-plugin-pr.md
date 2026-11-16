# awesome-dsh-plugin · 收录 PR 条目模板

> 目标仓库：[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（DSH 插件索引；dsh-market 市场读的就是它）。
>
> **一个 PR 只加一个文件**：`data/plugins/<owner>__<repo>.yml`。两个 README 由脚本生成，**不要手改**；合并后 `main` 上会自动重生成。

---

## 0. 硬性门槛 / Hard requirements

| 项 | 说明 | ACut 现状 |
| --- | --- | --- |
| `dsh.bundle` manifest | `package.json` 里必须有 `dsh.bundle.patch`；只有 `dsh.client` 装不上，这是最常见的被拒原因 | ✅ 已有 |
| 配套 `cordis.patch.yml` | 仓库根目录，`insert` 一行 | ✅ 已有 |
| 真实可用的代码 | 占位仓库、纯 README 仓库不收 | ✅ |
| 仓库创建满 1 天 | CI 自动检查 | ⏳ 建仓后等一天 |
| 仓库带 `dsh-plugin` topic | GitHub 仓库设置里加 | ⏳ 待加 |
| 描述属实、无营销词 | 评审会对着代码数功能；夸大必被打回 | ⚠️ 只写实际做到的 |
| 分类贴切 | 选错不打回，维护者会改 | `tools` |
| 建议发 npm | 预构建安装免 `allowBuilds` 构建授权；不发 npm 就把预构建 tarball 挂 Release 并写 `tarball:` | ⏳ 包名须改小写 |

> npm 包名不接受大写字母：现在的 `dsh-ACut` 发不上去，**必须改成 `dsh-acut`**（同时改 profile 依赖名、`cordis.patch.yml` 的 `name`）。界面上的显示名保持「ACut 截图」，不受影响。

---

## 1. 条目文件：`data/plugins/<owner>__<repo>.yml`

```yaml
url: https://github.com/<owner>/<repo>        # 必须与仓库 URL 完全一致
name: <owner>/<repo>                          # 列表里显示的链接文字
category: tools                               # 见下方分类取值
description:
  en: 'One-line description ending with a period.'
  zh: 一句话描述，以句号结尾。                # 可选，缺了维护者会补
# 可选：GitHub 托管的位图（市场卡片图标），不写就用作者头像
# icon: https://raw.githubusercontent.com/<owner>/<repo>/main/assets/icon-180.png
# 可选：不发 npm 时指向 Release 里的预构建 tarball
# tarball: https://github.com/<owner>/<repo>/releases/download/v0.1.0/dsh-acut-0.1.0.tgz
```

**描述里含 `: `（冒号+空格）必须加引号**，否则 YAML 会当成嵌套键：

```yaml
  en: 'Screenshot plugin: region capture, annotation.'   # ✅
  en: Screenshot plugin: region capture, annotation.     # ❌ 解析失败
```

分类取值：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`。
ACut 是截图工具 → **`tools`**（`vision` 留给 OCR / 定位 / 像素比对那类）。

---

## 2. 填好的 ACut 版本

文件名：`data/plugins/Azopt__dsh-acut.yml`（owner/repo 按你实际建的仓库改）

```yaml
url: https://github.com/Azopt/dsh-acut
name: Azopt/dsh-acut
category: tools
description:
  en: 'Screenshot plugin for DeepSeek Harness: region capture, annotation, scrolling long capture with a live stitched preview, and pin-to-screen — the same engine is exposed to the agent as a screenshot tool.'
  zh: '截图插件：区域框选、标注、滚屏拼接长截图、悬浮预览拼接结果、一键钉住置顶；同一套能力也作为 screenshot 工具交给 Agent 调用。'
```

可选图标（有 180×180 位图再写）：

```yaml
icon: https://raw.githubusercontent.com/Azopt/dsh-acut/main/assets/icon-180.png
```

---

## 3. PR 标题与正文

标题：

```text
Add Azopt/dsh-acut — screenshot plugin for DSH
```

正文：

```md
## Entry

`data/plugins/Azopt__dsh-acut.yml`

## What it does

Screenshot plugin for DeepSeek Harness:

- `Ctrl+Shift+X` opens a frozen-screen region selector; annotate and `Enter` copies + saves
- `S` starts a scrolling capture: you scroll, it stitches the frames into one long image, with a
  floating preview of the stitched result
- pin-to-screen keeps a capture in an always-on-top window
- the same engine is exposed to the agent as a `screenshot` tool (`list` / `screen` / `window` / `scroll`)

## Checklist

- [ ] `package.json` declares `dsh.bundle.patch` and ships `cordis.patch.yml`
- [ ] repo has the `dsh-plugin` topic
- [ ] installs with `dsh plugin --profile <p> add dsh-acut`
- [ ] description matches the code — no superlatives
- [ ] only this one entry file is touched
```

---

## 4. 评审真正会看什么 / What review checks

1. **代码是否做到条目里写的事**——包括描述里出现的数字与 API 名。
2. **分类是否合理**（选错不打回，会直接改）。
3. **是不是真的能跑**，不是占位或空壳。
4. **是否与已有条目重复**：两个插件做同一件事时，更好维护的那个赢；先来后到只是平局规则。
5. **源码里有没有可疑东西**：混淆代码、外传凭据、异常安装期行为。
6. **PR 是否动了无关条目**——gate 会列出被修改的每一个既有条目。
7. **是不是纯聚合包**：只有依赖清单、自己不干活的包不收录。
8. **依赖是否指向上游原作者**。

CI 通过只是前置条件，不是结论；合并前维护者会实际读仓库。

---

## 5. 发布顺序（建议）

```text
1. npm 包名改小写 dsh-acut  →  npm publish --access public
2. 建 GitHub 仓库 dsh-acut，push，加 dsh-plugin topic
3. 等满 1 天（CI 硬性检查）
4. 开 PR：一个 data/plugins/Azopt__dsh-acut.yml
5. 合并后市场与 awesome-dsh-plugin.com 通常一天内自动收录
```

---

## 6. 提交前的诚实检查

- 英文描述与中文描述说的是同一件事，功能点数量一致。
- 不写「最好用」「最强」这类词；只写做不到的事别写。
- 描述里提到的命令、快捷键、工具名，在仓库里都能找到。
- PR 只碰 `data/plugins/` 下新建的那一个文件。
