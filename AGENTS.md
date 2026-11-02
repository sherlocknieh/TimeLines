# TimeLines · Agent 索引

给在本仓库工作的编码 Agent 的入口。先读这里，再按任务打开对应文件；面向人的概览在 `README.md`，运行与目录细节在 `docs/development.mdx`。

## 项目是什么

TimeLines 是一个通用的时间线整理与可视化工具。仓库同时生成两样东西：

- **文档站**：`docs/` 下的 MDX，由 Blume 构建，开发端口 `4321`。
- **前端应用**：`web/` 下的 Vue 3 + TypeScript + Vite，挂载在 `/timeline/`，使用 hash 路由。

两者同源构建、同一端口访问。当前内置「英国 × 美国，52 个事件」的 demo，四种显示方案共用同一份数据；demo 只是示例，工具本身不绑定这个主题。

## 先看哪里

| 你要做的事 | 入口 |
| --- | --- |
| 改交互或显示逻辑 | `docs/views.mdx` 先确认各方案的交互契约，再进对应 `web/src/views/*.vue` |
| 加减事件、改数据字段 | `web/src/data/events.ts` |
| 改年份范围、泳道、标签、刻度 | `web/src/lib/dataset.ts` |
| 改等比泳道的比例或避让 | `web/src/lib/timeline.ts`、`web/src/components/TimelineStage.vue` |
| 改文档内容 | `docs/*.mdx`，Blume 按文件树自动生成路由与侧边栏 |
| 改开发/构建流程 | `.dev/*.mjs`、`blume.config.ts`、`web/vite.config.ts` |

## 目录与职责

```text
docs/                     Blume 文档内容
web/src/
├── main.ts               挂载 Vue、注入路由与全局样式
├── App.vue               应用外壳：顶部导航、阅读进度、回到顶部
├── router.ts             hash 路由，五个路由（索引 + 四个方案）
├── views/
│   ├── GalleryView.vue   方案索引页 /
│   ├── LanesView.vue     01 等比泳道 /lanes
│   ├── GanttView.vue     02 横向甘特 /gantt
│   ├── ZoomView.vue      03 竖向缩放轴 /zoom
│   └── ListView.vue      04 世纪清单 /list
├── components/           仅等比泳道使用的舞台与气泡
├── data/events.ts        唯一 demo 数据源
├── lib/dataset.ts        共享派生数据：泳道、年份范围、标签、刻度
├── lib/timeline.ts       等比泳道常量 + 通用上下避让 avoidOverlap
├── styles/main.css      等比泳道专属样式
├── styles/views.css     外壳与其余三个方案的样式
└── types.ts             等比泳道内部布局类型
```

开发与构建管线：

- `.dev/dev.mjs`：先构建一次前端，再同时启动 Vite watch 与 Blume dev。
- `.dev/build.mjs`：前端构建到 `_build/` → Blume 构建到 `dist/` → 改名为 `_dist/` → 把 `_build/` 复制到 `_dist/timeline/`。
- `blume.config.ts`：开发时把 `_build/` 以 `/timeline/` 提供，并放行带尾斜杠的目录地址。
- `web/vite.config.ts`：`base=/timeline/`，输出到 `../_build/`。

## 数据模型

`TimelineEvent`（`web/src/data/events.ts`）：

```ts
{ y, s?, tag, t, d, lvl?, date? }
```

- `y`：年份，所有方案都依赖。
- `s`：`"uk" | "us"`，缺省为 `us`；当前泳道固定为英国、美国两条。
- `lvl`：语义层级，`1` 主脉 / `2` 通史 / `3` 细节，缺省 `2`。`ZoomView` 按可视跨度自动选层：>220 年只显示 L1，45–220 年显示到 L2，<45 年展开 L3。
- `date`：可选精确日期 `YYYY-MM-DD`。没有 `date` 的事件按该年 7 月 1 日定位，但只显示年份；不要在展示层给它补月份/日，避免制造虚假精度。
- `dataset.ts` 的 `YEAR_MIN` / `YEAR_MAX` 由数据推导，供甘特、缩放轴、清单使用；`lib/timeline.ts` 仍保留等比泳道的固定 `1200–2030` 常量。通用化时优先把后者也迁到配置。

## 改动落点

| 改动 | 需要同步的地方 |
| --- | --- |
| 新增一个方案 | `views/` 新组件 + `router.ts` + `GalleryView.vue` + `docs/views.mdx` + `styles/views.css` |
| 新增/删除事件 | `data/events.ts`；若总数变化，搜索并更新文案里的 `52` |
| 新增共享派生数据 | `lib/dataset.ts`，避免各视图各算一份 |
| 文档新增页面 | `docs/` 新 MDX，front matter 至少 `title`、`description` |
| 调整 `/timeline/` 挂载 | `web/vite.config.ts`、`blume.config.ts`、`.dev/build.mjs` 三处一起改 |

## 不可破坏的约定

- **前端源码在 `web/`**：应用代码改 `web/src/`，构建配置改 `web/vite.config.ts`；`_build/`、`_dist/`、`.blume/` 是可删构建产物。
- **路由是 hash 模式**，链接形如 `/timeline/#/gantt`；静态托管不需要 SPA 回退。
- **缩放轴是竖向的**：轴线默认水平居中，左右拖动移动轴线，上下拖动平移时间。轴上 64px 热区滚轮缩放，热区外保持页面原生滚动；这是刻意划分的交互边界。
- **拖拽容器不要用 pointer capture**：会抢走事件标签按钮的 `click`。现有拖拽代码在 `pointerdown` 时跳过 `button, a`，新交互沿用这个做法。
- **`avoidOverlap` 是共享算法**：输入顺序与输出顺序一一对应，改它之前先看 `TimelineStage.vue` 与 `ZoomView.vue` 两处调用。
- **`main.css` 只服务等比泳道**；新方案样式放 `views.css`，避免方案之间互相污染。
- **文档站不加载外部字体**：`blume.config.ts` 的 `theme: { fonts: false }` 让样式回落到系统字体栈，构建不访问 Google Fonts。该开关由 `patches/blume@1.7.3.patch` 提供，升级 Blume 时要重新打补丁并验证构建日志里不再出现字体抓取。

## 验证

改完代码至少跑：

```bash
pnpm typecheck
pnpm build
```

- `pnpm build` 成功后产物在 `_dist/`，前端页面在 `_dist/timeline/`，可用 `pnpm preview` 预览。
- 改 UI 时打开对应 `#/` 路由，检查浏览器控制台无报错；改缩放轴时额外验证：轴上滚轮缩放、轴外页面滚动、悬停日期读数、轴线左右拖动、L3 细节事件出现、对数与天/月/年切换。
- 只改文档时可用 `pnpm doctor` 检查 Blume 配置与内容。

## 现状与待办

已经完成：四种显示方案、hash 路由、数据驱动的年份范围（除等比泳道）、缩放轴的语义层级与线性/对数切换。

仍是 demo 定制、尚未通用化：任意数量泳道、时间线的创建/切换/持久化、事件增删改与 JSON 导入导出。详见 `README.md` 的 TODO 与 `docs/index.mdx` 的「通用化路线」。
