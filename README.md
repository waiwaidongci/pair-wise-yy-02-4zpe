# FlowPilot 节点式数据工作流编辑器

基于 React、TypeScript、Vite、React Flow、Ant Design、Zustand、Immer 与 React Router。

## 功能

- 从节点库拖拽数据源、变换、过滤、聚合、双流关联和输出节点。
- 连线时校验输入/输出端口类型，实时拒绝类型冲突和环形依赖。
- 支持框选、复制粘贴、删除、撤销重做、缩略图与依赖层级自动布局。

## 排队执行引擎

- **依赖驱动的并发调度**：上游全部完成后节点才开始，互不依赖的节点并发执行；工具栏可设置并发上限（含「顺序」档），占满槽位后其余节点排队等待。
- **可中断**：执行中可随时点「中断」，运行中的尝试结束后整体收尾，已完成节点的结果保留，再次执行即从中断处继续。
- **按节点重试**：每个节点可在属性面板单独配置失败重试次数（0–5）；重试耗尽后该节点判失败，其下游自动跳过，其他分支照常跑完。
- **结果失效与增量重算**：节点结果带有依据哈希（自身业务参数 + 入边连线 + 各上游依据）。参数或连线一旦改动，受影响节点（及全部下游）沿用的旧结果立即标记为「已失效」，下次执行只重算失效节点，依据未变的节点直接复用。
- **运行记录随流程导出**：导出的 v2 JSON 包含每个节点的状态、耗时、处理行数、尝试次数、失败原因、结果依据与时间戳；重新导入后恢复运行现场。导入没有运行记录的旧文件时，自动按顺序执行（并发 1）打开。

## 运行

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```

## 行为校验脚本

`scripts/` 下提供三个不依赖测试框架的校验脚本（经 esbuild 打包后用 Node 运行），覆盖调度引擎、失效级联与 store 端到端行为：

```bash
node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild scripts/scheduler-check.ts --bundle --platform=node --format=esm --outfile=/tmp/s.mjs && node /tmp/s.mjs
```
