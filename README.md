# 楚河棋局

一个可**离线运行**的中国象棋人机对战网页小游戏。玩家执红先行，电脑执黑应战。棋盘、棋子、音效、字体均为本地资源，运行时无任何外部网络请求。

技术栈：Vue 3 + TypeScript + Vite + Web Worker + Vitest。

## 直接试玩

从 Gitee 下载仓库 ZIP 并解压，用 Edge 或 Chrome 打开根目录的 **开始游戏.html**，点击「开始对弈」。

试玩版已内置封面、棋盘、字体、音效和电脑走棋引擎。解压后可离线游玩，浏览器即可运行。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（默认 http://localhost:5173）
npm run dev

# 运行单元测试
npm test

# 生产构建（输出到 dist/）
npm run build

# 本地预览构建产物（默认 http://localhost:4173）
npm run preview
```

## 玩法

- 玩家执红先行，点击己方棋子会显示其合法落点（绿色圆点）。
- 点击落点完成走子；电脑（黑方）随后自动应招。
- 顶部显示当前回合、电脑思考状态与胜负结果。
- 「电脑」下拉框可在两档间切换：
  - **随机**：从合法走法中随机选择（主线程）。
  - **搜索（Minimax）**：在 Web Worker 中使用 Minimax + Alpha-Beta 搜索（深度 3）选择走法。
- 「静音 / 开启声音」切换音效；「重新开始」可随时重开，重开后会忽略上一局尚未返回的计算结果。

## 规则范围

已实现并覆盖以下棋规（有 Vitest 用例验证）：

- 各棋子走法：帅/将（九宫一步）、仕/士（九宫斜一步）、相/象（田字且塞象眼、不能过河）、马（日字且蹩马腿）、车（直线）、炮（隔一子吃子）、兵/卒（过河前只能前进，过河后可横走、不能后退）。
- 九宫限制、象眼、马腿、过河限制、炮架。
- 将帅照面：两将同列且中间无子视为被将军，撤开挡子造成照面属于自陷将军（非法）。
- 自陷将军过滤：所有走法均不得使己方将军处于被将军状态。
- 被将军时仅允许解将的走法（吃子、垫子、应将）。
- 将死与困毙：轮到的一方无合法走法即判负。

**首版范围之外**：长将（长照）与长捉（重复将军/捉子导致循环）的禁止与判和规则不在本版实现，后续版本再补充。

## 素材来源与授权

素材位于 `public/assets/xiangqi/`，保留原始授权文件于 `licenses/`。

| 文件 | 用途与来源 | 授权 |
|---|---|---|
| `board.svg` | 为项目新绘制的棋盘（viewBox `0 0 600 660`，交点坐标 `x=60+60×col`、`y=60+60×row`） | 随项目使用与分发 |
| `pieces-preview.svg` | 红黑棋子样式参考，实际棋子用 CSS 实现 | 随项目使用与分发 |
| `NotoSerifSC.ttf` | 棋子字体（Noto Serif SC） | SIL OFL 1.1，见 `licenses/NotoSerifSC-OFL.txt` |
| `move.ogg` | 落子音效（Kenney Interface Sounds 的 `click_001.ogg`） | CC0 1.0，见 `licenses/Kenney-CC0.txt` |
| `capture.ogg` | 吃子音效（Kenney Interface Sounds 的 `drop_001.ogg`） | CC0 1.0，见 `licenses/Kenney-CC0.txt` |

更多来源说明见 `reference/素材说明.md`。

## 目录结构

```
src/
  chess/           纯 TypeScript 棋规（与 UI 无关，可独立测试）
    types.ts       类型定义
    board.ts       棋盘初始化与常量
    moves.ts       走法生成（伪合法）
    rules.ts       将军检测、合法走法、胜负判定
    index.ts       统一导出
    rules.test.ts  棋规测试
  ai/
    search.ts      Minimax + Alpha-Beta 搜索与评估
    worker.ts      Web Worker 入口
    search.test.ts 搜索测试
  App.vue          棋盘渲染与交互
  main.ts          应用入口
  style.css        全局样式与字体
```

## 实际验证结果

- **单元测试**：`npm test` 通过，共 20 个用例（棋规 17 + 搜索 3），覆盖炮隔一子吃子、蹩马腿、撤开将帅间挡子、被将军时仅允许解将、无合法走法判负、象眼/过河/九宫限制、AI 返回合法走法与吃大子、将死返回 null 等。
- **类型检查与构建**：`npm run build` 通过（`vue-tsc --noEmit` 无错误 + Vite 生产构建成功，Web Worker 被正确打包为独立产物）。
- **浏览器实测**：`npm run dev` 启动后，棋盘、棋子（红朱红/黑墨黑）正确渲染；点击红方兵出现绿色合法落点；玩家走子后电脑（Web Worker 中的 Minimax 搜索）在 3 秒内应招（实测走法为「炮二平三」等合理开局），控制台无错误。
- **离线验收**：`src/` 与 `index.html` 中不存在任何 `http(s)://` 外部引用，字体/音效/SVG 全部由 `public/` 本地提供，构建产物仅引用本地资源。断开外网后启动本地服务仍可正常走棋、加载素材并让电脑应战。

## 部署说明

生产构建产物 `dist/` 为纯静态文件，可部署到任意静态托管（如 Gitee Pages、Nginx、任意 HTTP 服务器）。运行时仅使用本地资源，支持全程离线游玩。
