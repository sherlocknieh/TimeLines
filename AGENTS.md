# TimeLines · Agent 索引

给在本仓库工作的编码 Agent 的入口。先读这里，再按任务打开对应文件；面向人的概览在 `README.md`，运行与目录细节在 `docs/development.mdx`。

## 项目是什么

TimeLines 是一个通用的时间线整理与可视化工具。仓库同时生成两样东西：

- **文档站**：`docs/` 下的 MDX，由 Blume 构建，开发端口 `4321`。
- **前端应用**：`web/` 下的 Vue 3 + TypeScript + Vite，占 `/timeline`，使用 hash 路由。

两者同源构建、同一端口访问。整站部署在 `/timeline/` 下：应用是 `/timeline`，文档是 `/timeline/docs`（由 Blume 的 `deployment.base` + `basePath` 实现）。当前内置「英国 × 美国，100 个事件」的 demo，唯一的显示方案是缩放时间轴；demo 只是示例，工具本身不绑定这个主题。

## 先看哪里

| 你要做的事 | 入口 |
| --- | --- |
| 改交互或显示逻辑 | `docs/views.mdx` 先确认交互契约，再进 `web/src/views/ZoomView.vue` |
| 加减事件、改数据字段 | `web/src/data/events.ts` |
| 改泳道标签、通用工具 | `web/src/lib/dataset.ts` |
| 改标签遮挡筛选 | `web/src/lib/timeline.ts` |
| 改文档内容 | `docs/*.mdx`，Blume 按文件树自动生成路由与侧边栏 |
| 改开发/构建流程 | `.dev/*.mjs`、`blume.config.ts`、`web/vite.config.ts` |

## 目录与职责

```text
docs/                     Blume 文档内容
web/src/
├── main.ts               挂载 Vue、注入路由与全局样式
├── App.vue               应用外壳：品牌、阅读进度、回到顶部
├── router.ts             hash 路由，只有缩放轴一条视图
├── views/
│   └── ZoomView.vue      竖向缩放轴及其全部交互
├── data/events.ts        唯一 demo 数据源
├── lib/dataset.ts        泳道与 clamp 等通用工具
├── lib/timeline.ts       标签遮挡筛选 pickVisible
└── styles/views.css      全局基础样式、外壳与缩放轴样式
```

开发与构建管线：

- `.dev/dev.mjs`：先构建一次前端，再同时启动 Vite watch 与 Blume dev。
- `.dev/build.mjs`：前端构建到 `_build/` → Blume 构建到 `dist/` → 改名为 `_dist/` → 把 `_build/` 复制到 `_dist/` 根目录（文档在 `_dist/docs/`）。
- `blume.config.ts`：`deployment.base=/timeline`、`basePath=/docs` 决定文档落在 `/timeline/docs`；开发时把 `_build/` 以 `/timeline/` 提供，并放行带尾斜杠的目录地址。
- `web/vite.config.ts`：`base=/timeline/`，输出到 `../_build/`。

## 数据模型

`TimelineEvent`（`web/src/data/events.ts`）：

```ts
{ y, s?, tag, t, d, lvl?, date? }
```

- `y`：年份，缩放轴用于生成年份标签与遮挡排序。
- `s`：`"uk" | "us"`，缺省为 `us`；当前泳道固定为英国、美国两条。
- `lvl`：语义层级，`1` 主脉 / `2` 通史 / `3` 细节，缺省 `2`。`ZoomView` 按可视跨度自动选层：>220 年只显示 L1，45–220 年显示到 L2，<45 年展开 L3。
- `date`：可选精确日期 `YYYY-MM-DD`。没有 `date` 的事件按该年 7 月 1 日定位，但只显示年份；不要在展示层给它补月份/日，避免制造虚假精度。
- 年份范围、可视跨度与安全边界由 `ZoomView.vue` 从数据推导，没有固定的 `1200–2030` 常量。

## 改动落点

| 改动 | 需要同步的地方 |
| --- | --- |
| 新增一个视图 | `views/` 新组件 + `router.ts` + `docs/views.mdx` + `styles/views.css` |
| 新增/删除事件 | `data/events.ts`；若总数变化，搜索并更新文案里的事件总数 |
| 新增共享派生数据 | `lib/dataset.ts` |
| 文档新增页面 | `docs/` 新 MDX，front matter 至少 `title`、`description` |
| 调整 `/timeline/` 挂载 | `web/vite.config.ts`、`blume.config.ts`、`.dev/build.mjs`、`.dev/preview.mjs` 四处一起改 |

## 不可破坏的约定

- **前端源码在 `web/`**：应用代码改 `web/src/`，构建配置改 `web/vite.config.ts`；`_build/`、`_dist/`、`.blume/` 是可删构建产物。
- **路由使用 HTML5 history**，打开 `/timeline/` 即进入缩放轴；应用只有根页面，静态托管不需要 SPA 回退。
- **文档链接按根路径书写**：`basePath` 会把 `/demo` 这类链接改写成 `/timeline/docs/demo`；指向应用 `/timeline/` 的链接必须用裸 `<a href>`，否则会被再拼一层 `/docs`。
- **缩放轴是竖向的**：轴线默认水平居中，左右拖动移动轴线，上下拖动平移时间。时间方向可切换，默认历史在上、今天在下，反向时今天在上、历史向下；屏幕映射统一走 `dir`，缩放锚点与滚轮/拖动方向都依赖它。轴上 64px 热区滚轮缩放，热区外的滚轮平移时间而不是滚动页面；这是刻意划分的交互边界。
- **拖拽容器不要用 pointer capture**：会抢走事件标签按钮的 `click`。现有拖拽代码在 `pointerdown` 时跳过 `button, a`，新交互沿用这个做法。
- **事件卡片在原地展开**：点选气泡后，卡片取代气泡显示在同一位置，垂直居中于事件锚点并夹在画布内；点空白处、关闭按钮或 `Esc` 收起。不要再把详情放回画布下方。
- **标签只做遮挡筛选，不做位移**：`pickVisible` 返回与输入顺序一致的可见标记；标签始终落在真实日期的锚点上，与轴线之间保留水平连线，改它之前先看 `ZoomView.vue` 的 `placed` 计算。
- **滚出画布的元素交给裁剪**：标签与「今天」标记不因越界而卸载，由 `.axis` 的 `overflow: hidden` 自然遮挡；滚动时不要用 `v-if` 让它们突然消失。
- **文档站不加载外部字体**：`blume.config.ts` 的 `theme: { fonts: false }` 让样式回落到系统字体栈，构建不访问 Google Fonts。该开关由 `patches/blume@1.7.3.patch` 提供，升级 Blume 时要重新打补丁并验证构建日志里不再出现字体抓取。

## 验证

改完代码至少跑：

```bash
pnpm typecheck
pnpm build
```

- `pnpm build` 成功后产物在 `_dist/`，整体即 `/timeline/` 子目录内容；`pnpm preview` 按 `/timeline/` 提供，应用在 `/timeline/`、文档在 `/timeline/docs/`。
- 改 UI 时打开 `/timeline/`，检查浏览器控制台无报错；额外验证：轴上滚轮缩放、轴外滚轮平移时间、悬停日期读数、轴线左右拖动、L3 细节事件出现、对数与天/月/年切换、对数起点的输入与准星切换。
- 只改文档时可用 `pnpm doctor` 检查 Blume 配置与内容。

## 现状与待办

已经完成：单一缩放时间轴视图、hash 路由、数据驱动的年份范围、语义层级与线性/对数切换、可指定起点的双对数压缩、事件搜索与定位。

仍是 demo 定制、尚未通用化：任意数量泳道、时间线的创建/切换/持久化、事件增删改与 JSON 导入导出。详见 `README.md` 的 TODO 与 `docs/index.mdx` 的「通用化路线」。
