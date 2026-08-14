# dsh-bilibili-ticket

**超好用的 Bilibili 会员购抢票项目（力荐）！**

一个 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 插件，用于 B 站「会员购」抢票 + 蹲回流（回流票监控自动下单），全程都可交给 AI 托管，保证精准查找所有内容。

自带一个**可拖拽的网页监控面板**（支持手动编辑、搜索演出、各项数值调节、日志监测）与**进程级抢票引擎**（后台高频下单 + 库存轮询）——让 DSH 里的 AI 帮你搜演出、看票档、建任务、盯回流、看状态，全程不用离开对话或面板。

> **风险声明（务必阅读）**
> 仅用于个人自用、学习研究。自动化抢票可能违反 B 站《用户协议》与会员购票务规则，存在账号被风控、限制甚至封禁的风险；批量抢票、倒卖票源还可能触犯相关法律法规。请自行评估并承担全部后果，控制请求频率，且不要绕过验证码——本插件不内置任何验证码破解。

## 它能做什么

- **扫码登录**（推荐）—— 手机 B 站 App 扫码确认后，插件自动完成登录；Cookie 导入为备用方式。
- **搜索 / 查票** —— 真实关键词搜索，读票档、价格、实时库存。
- **抢票 / 蹲回流** —— 在开售时刻进入高频下单风暴；轮询库存，一有回流票立即下单。
- **按任务调频 + 参数持久化** —— 每个任务可单独设轮询/风暴间隔（或全局统一），可调参数重启后仍生效。
- **网页监控面板** —— 可拖拽、登录态、实时任务列表（启动/停止/删除）、滚动日志、参数调整、搜索-选票-建任务。

<p align="center">
  <img src="assets/demo.jpg" alt="实机使用演示" width="680" />
  <br />
  <sub>实机使用演示</sub>
</p>

## 安装

```bash
# 最简单：直接从 GitHub 装（自动 clone + 装依赖）
dsh plugin --profile web add https://github.com/alingalingling/bilibili-ticketer.git
dsh web
```

`dsh web` 等价于 `dsh --profile web`。其他安装方式：

```bash
# 源码安装
git clone https://github.com/alingalingling/bilibili-ticketer.git
cd bilibili-ticketer
pnpm install
dsh plugin --profile web add .

# 或直接装 tgz 包
dsh plugin --profile web add ./dsh-bilibili-ticket-0.1.19.tgz
```

本包在 `package.json` 声明了 `dsh.bundle.patch`，`dsh plugin add` 会自动把它加入 profile 的 bundles 层，无需手写 YAML。插件在宿主平面启动一次，后台引擎常驻；网页面板通过 `dsh.client` 清单自动加载。

## 快速开始

1. 安装并重启 DSH，打开网页 UI。
2. 登录：对 AI 说「帮我扫码登录会员购」，或打开面板（侧边栏底部「抢票」按钮）点「扫码登录」。
3. 建任务：说「帮我搜『某某演唱会』，建一个蹲回流任务盯 480 元票档，数量 1」—— 或直接在面板里搜索 → 选项目 → 选票档 → 创建。
4. 在面板自动刷新 或问「任务进展如何？」查看进度。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `bili_ticket_login_qr` | 扫码登录（推荐） |
| `bili_ticket_login` | 导入 Cookie 并校验（备用） |
| `bili_ticket_search` | 关键词搜索 |
| `bili_ticket_detail` | 票档 / 价格 / 库存 |
| `bili_ticket_buyers` | 列出实名购票人（打码） |
| `bili_ticket_task_create` | 创建抢票 / 蹲回流任务 |
| `bili_ticket_tasks` | 列出任务 |
| `bili_ticket_task_start` / `stop` / `delete` | 控制任务 |
| `bili_ticket_status` | 引擎状态与最近日志 |

## 配置

写在 `bilibili-ticket` row 的 `config` 里（缺省用内置默认值）：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `dataDir` | `$DSH_HOME/bilibili-ticket` | 持久化目录（`state.json`） |
| `pollIntervalMs` | `3000` | 蹲回流轮询间隔 |
| `stormLeadMs` | `2000` | 开售前提前多少毫秒进入抢票 |
| `stormIntervalMs` | `150` | 高频下单单次间隔下限（加随机抖动） |
| `orderTimeoutMs` | `60000` | 单任务抢票/下单总超时 |
| `enabled` | `true` | 设为 `false` 关闭插件 |

## 目录结构

```
lib/index.js     插件入口（工具 + 系统提示词 + 引擎生命周期）
lib/client.js    会员购 HTTP 客户端（端点、扫码登录、WBI、指纹、bili_ticket）
lib/engine.js    抢票 + 蹲回流引擎（调度 / 轮询 / 下单）
lib/rpc.js       网页面板的宿主 RPC 通道（/bili-ticket）
lib/web.js       网页监控面板（客户端 bundle）
lib/wbi.js       WBI 签名
lib/state.js     JSON 持久化（cookie / 任务 / 日志 / 可调参数）
lib/util.js      工具函数
lib/qr.js        二维码 PNG 渲染
```

## 接口说明

客户端对接当前会员购接口面（`show.bilibili.com/api/ticket/*`）：`search/list`（关键词）、`project/getV2`/`get`、`stock/check`、`buyer/list`、`order/prepare`、`order/createV2`、`order/createstatus`；扫码登录用 `passport.bilibili.com/x/passport-login/web/qrcode/generate` + `poll`。已实现 WBI 签名、`buvid3/4` 指纹与 `bili_ticket`（`GenWebTicket`）。下单载荷与本地确定性 `token` 在源码中标注 ⚠️/🔬，为易变的逆向细节，需实测；`ctoken`/`feSign`/`deviceFingerprint` 为已记录的未实现项。

## 许可与免责声明

[MIT](./LICENSE)。仅供学习研究，使用本插件进行的一切操作及其后果由使用者自行承担。
