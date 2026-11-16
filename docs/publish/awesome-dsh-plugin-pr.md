# awesome-dsh-plugin · 收录 PR（提交手册）

> 目标仓库：[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)（DSH 插件索引，dsh-market 读的就是它）。
>
> **一个 PR 只加一个文件**：`data/plugins/<owner>__<repo>.yml`。两个 README 由脚本生成，**不要手改**，合并后 `main` 自动重生成。

---

## 0. 现在的状态

| 门槛 | 状态 |
| --- | --- |
| `package.json` 声明 `dsh.bundle.patch` + 根目录 `cordis.patch.yml` | ✅ |
| 真实可用的代码（非占位、非空壳） | ✅ |
| 仓库带 `dsh-plugin` topic | ✅（另有 `screenshot` `screen-capture` `deepseek-harness`） |
| 已发布 npm（预构建安装免 `allowBuilds`） | ✅ `dsh-acut@0.1.0` |
| 仓库创建满 1 天（CI 硬查） | ⏳ 仓库建于 `2026-11-16 16:56 UTC`，**约 24 小时后**才可提 |
| 描述属实、无营销词 | ✅ 见下，逐条对得上代码 |

> GitHub 的规范 slug 是 **小写 `azopt`**（`api.github.com/orgs/Azopt` 返回 `"login":"azopt"`）。`github.com/Azopt/dsh-acut` 一样能打开，但注册表条目**一律用小写**，避免 CI 逐字比对失败。

---

## 1. 要提交的文件

文件名 `data/plugins/azopt__dsh-acut.yml`，内容就是本目录里的 [`azopt__dsh-acut.yml`](azopt__dsh-acut.yml)：

```yaml
url: https://github.com/azopt/dsh-acut
name: azopt/dsh-acut
category: tools
description:
  en: 'Screenshot plugin: annotated region capture (rectangle, ellipse, arrow, pen, text, mosaic), scrolling capture stitched into one long image with a floating preview, pin-to-screen, and the same engine as an agent screenshot tool.'
  zh: '截图插件：框选截图并标注（矩形、椭圆、箭头、画笔、文字、马赛克），滚屏截图拼接成长图并悬浮预览，可钉住置顶；同一套能力也作为截图工具提供给 Agent 调用。'
icon: https://raw.githubusercontent.com/azopt/dsh-acut/main/assets/icon-180.png
```

- 描述含 `: `（冒号+空格）**必须加引号**，否则 YAML 会当成嵌套键解析失败。
- 分类用 `tools`（`vision` 留给 OCR / 定位 / 像素比对那类；`ui` 指界面类插件）。
- `icon` 必须是 GitHub 托管的位图——`assets/icon-180.png` 已入库。

---

## 2. PR 标题与正文

标题：

```text
Add azopt/dsh-acut — screenshot plugin for DSH
```

正文：

```md
## Entry

`data/plugins/azopt__dsh-acut.yml` — new file, nothing else touched.

## What it does

Screenshot plugin for DeepSeek Harness:

- `Ctrl+Shift+X` freezes the screen and opens a region selector; annotate with rectangle, ellipse,
  arrow, pen, text or mosaic, then `Enter` copies and saves
- `S` starts a scrolling capture: you scroll the page yourself, the frames are stitched into one long
  image with a floating preview of the result
- pin-to-screen keeps a capture in an always-on-top window
- the same engine is exposed to the agent as a `screenshot` tool (`list` / `screen` / `window` / `scroll` / `diag`)

Published on npm as `dsh-acut@0.1.0`; the repo declares `dsh.bundle.patch` and ships `cordis.patch.yml`.

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
```

---

## 3. 提交方式（fork → 分支 → PR）

注册表仓库没有写权限，必须先 fork 到 `azopt` 下再开 PR：

```sh
# 1) fork
POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks        {"organization":"azopt"}

# 2) 在新分支上写文件（一次 PUT 即建分支 + 建文件）
PUT  /repos/azopt/awesome-dsh-plugin/contents/data/plugins/azopt__dsh-acut.yml
     {"message":"Add azopt/dsh-acut","content":"<base64>","branch":"add-acut"}

# 3) 开 PR
POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls
     {"title":"Add azopt/dsh-acut — screenshot plugin for DSH","head":"azopt:add-acut","base":"main","body":"<上文正文>"}
```

提交前用 `GET /repos/azopt/dsh-acut` 复查一眼 `created_at`，确认已满 24 小时（CI 会拒掉不足 1 天的仓库）。

---

## 4. 评审真正会看什么

1. **代码是否做到条目里写的事**——包括描述里出现的数字与 API 名。
2. **分类是否合理**（选错不打回，维护者会直接改）。
3. **是不是真能跑**，不是占位或空壳。
4. **是否与已有条目重复**——目前列表里的截图类只有 `dsh-wsl-shot` / `dsh-wsl-winshot`（WSL 剪贴板）与 `dsh-snapshot-manager`（会话快照），与 ACut 不冲突。
5. **源码有没有可疑东西**：混淆代码、外传凭据、异常安装期行为。
6. **PR 是否动了无关条目**——gate 会列出被修改的每一个既有条目。
7. **是不是纯聚合包**（只有依赖清单、自己不干活的不收）。
8. **依赖是否指向上游原作者**（我们不是聚合包，此项不适用）。

CI 通过只是前置条件，不是结论；合并前维护者会实际读仓库。

---

## 5. 时间线

```text
1. ✅ npm 发布 dsh-acut@0.1.0
2. ✅ GitHub 仓库 azopt/dsh-acut + dsh-plugin topic
3. ⏳ 等满 1 天（仓库建于 2026-11-16 16:56 UTC → 2026-11-17 16:56 UTC 之后可提）
4. ⬜ 开 PR：只加 data/plugins/azopt__dsh-acut.yml
5. ⬜ 合并后市场与 awesome-dsh-plugin.com 一天内自动收录
```

---

## 6. 提交前的诚实检查

- 英文与中文描述说的是同一件事，功能点一一对应。
- 不写「最好用」「最强」这类词；做不到的别写。
- 描述里提到的快捷键、按钮、工具名（`Ctrl+Shift+X`、`S`、`screenshot` 及其 action）在仓库里都能找到。
- PR 只碰 `data/plugins/` 下新建的那一个文件。
