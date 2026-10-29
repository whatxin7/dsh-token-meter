# dsh-token-meter

> **一句话**：扫 DSH 的会话日志，把「谁、哪天、哪类活、花了多少 token、折多少钱」算清楚，一条命令出 Markdown 账单。
>
> 这是 `qq-bridge` 工具链拆出来的独立项目之一，对应成本统计里 **「用量与成本核算」** 这条线。
> 不依赖 DSH 运行：只要有 `~/.dsh/sessions/` 就能离线算账。

---

## 为什么需要它

1. **DSH 不算钱。** provider 只回 token 数，`dsh-llm-*` 明确写了不做消费侧报表。想知道「这个月烧了多少」只能自己按价目表乘。
2. **账本不能只看总量。** 会话日志里每个 `assistant/message` 都带 `usage`，但 `inputTokens` 是**缓存未命中**的输入、缓存命中单独走 `cacheReadTokens`。把两者混在一起算，命中率 97% 的场景会把费用算高一个数量级。
3. **会话日志是多帧 zstd。** 追加写导致一个文件里几十个 zstd frame 首尾相接；`zstdDecompressSync()` 只解第一帧 —— 实测一个 13.8 KB 的日志只解出 1 行（真正有 20 行）。按这个数据统计会**静默少算 95%**。
4. **峰谷价。** 官方按北京时间工作日 9–12 / 14–18 收双倍、节假日与夜间半价，判定必须脱离本机时区。

这四条是真实踩过的坑，都已固化成代码 + 测试。

## 安装

```bash
git clone https://github.com/Derpyu520/dsh-token-meter.git
cd dsh-token-meter
node --test          # 29 个用例，全部离线
```

无第三方依赖，Node ≥ 22.15（需要 `zlib.zstdDecompressSync`）。可直接 `node bin/token-meter.mjs`，也可 `npm i -g .` 得到 `token-meter` 命令。

## 用法

```bash
# 1. 概览：文件数 / 会话数 / 采样数 / 缓存命中率 / 费用 / Top 会话
token-meter scan

# 2. 出报告（Markdown 到文件，或直接打到标准输出）
token-meter report --out out/token-report.md
token-meter report --format json > usage.json

# 3. 指定别的日志目录
token-meter report --root D:\backup\dsh\sessions --out report.md

# 4. 给定任意单价折算总量（元 / 百万 tokens）
token-meter cost --in 1 --cache 0.2 --output 4

# 5. 打印内置价目表 + 当前属于高峰还是空闲
token-meter prices
```

默认根目录：`$DSH_HOME/sessions`，其次 `~/.dsh/sessions`。

### 报告长什么样

`examples/token-report.sample.md` 是脱敏后的真实输出（会话 id 保留前 22 位、标题按主题改写）。结构：

| 段落 | 回答的问题 |
|---|---|
| 总量 | 输入未命中 / 缓存命中 / 输出 / 合计 |
| 费用（官方峰谷口径） | 高峰花了多少、空闲花了多少、合计多少 |
| 换价目表对比 | 同一份用量在 5 个价目档位下各多少钱（含"缓存不打折"） |
| 每日用量 | 哪天烧得凶 |
| 用量最大的会话 | 钱集中在哪几个会话（超长会话是主要成本来源） |
| 按项目目录分布 | 手开会话 vs 自动起的会话各占多少 |
| 按功能主题分布 | 聊天 / 插件联调 / 人格 / 语音 / 表情包…各占多少 |
| 按模型分布 | 有没有跑错模型 |
| 口径与校验 | 每一条统计口径的出处 |

## 计费口径

```
费用 = 输入未命中 × P_in + 输入缓存命中 × P_cache + 缓存写入 × P_write + 输出 × P_out
```

- **高峰**：北京时间周一至周五 `[9,12)` 与 `[14,18)`，且不在内置法定节假日表（2026/2027）内 → 单价 ×2。
- **空闲**：其余全部时段（含周末、节假日、夜间）→ 单价 ×1。
- `inputTokens` 只算缓存未命中；`cacheReadTokens` 单独计价。这是本项目的核心口径，测试里有专门用例守着。
- 未知模型按兜底价（flash）折算，并全程标 `estimated`。
- 价目表可覆盖：`token-meter report --config config.json`，其中 `pricing` 段与 `src/model-prices.js` 的 `DEFAULT_PRICE_TABLE` 同构。

价目表版本记录在 `PRICE_TABLE_VERSION`，改了就是新版本 —— 报账单要能对上「按哪天公布的价算的」。

## 主题归类

标题关键词 → 主题桶（`src/aggregate.mjs` 的 `THEME_RULES`）。桶的口径是"钱花在哪类活上"：

| 主题 | 关键词举例 |
|---|---|
| 她在线聊天（bridge 自动起的会话） | 项目路径命中 `qq-bridge/state/agents` |
| 插件安装与桥接 | 插件、桥接、onebot、snowluma、接入、联调 |
| 好友 / 白名单 / 权限 | 好友、白名单、权限、allow、申请 |
| 能力扩展（视觉 / 搜索 / 语感） | 视觉、搜索、mcp、黑话、多模态 |
| 人格 / 角色卡 | 人格、角色卡、提示词、语气 |
| 群聊私聊行为调优 | 群聊、私聊、唤醒、潜水、节奏、跨会话 |
| 形象与社交动作 | 头像、名片、空间、撤回、点赞 |
| 语音 / 唱歌 / 音色 | 语音、唱歌、音色、tts、歌本 |
| 表情包 / 斗图 | 表情、斗图、sticker |
| 用量与成本核算 | token、用量、花费、账单 |
| 其他 / 未归类（排障类） | 以上都不命中 |

归类是**启发式且只影响归属展示**，不参与计费；归不进去的落到兜底桶，绝不静默丢样本。

## 作为库用

```js
import { scanSessions } from 'dsh-token-meter/scan';
import { aggregate } from 'dsh-token-meter';
import { renderReport } from 'dsh-token-meter/report';

const scan = scanSessions('C:/Users/me/.dsh/sessions');
const agg = aggregate(scan.records);
console.log(agg.cost.total, agg.themes[0].theme);
```

模块分工：

| 文件 | 职责 |
|---|---|
| `src/zstd-frames.mjs` | 多帧 zstd 解码（含假 magic 切点自愈） |
| `src/scan.mjs` | 遍历会话日志、抽 usage、补标题/模型/cwd |
| `src/model-prices.js` | 价目表、峰谷判定、桶归一、单次计价 |
| `src/token-ledger.js` | 在线账本：事件幂等折叠 + 投影基线 + 落盘/压缩/淘汰 |
| `src/aggregate.mjs` | 按天/会话/项目/主题/模型聚合 + 平价档位 |
| `src/report.mjs` | Markdown / JSON 输出 |

`token-ledger.js` 是给**在线**场景用的（DSH 事件流里直接记账），`scan.mjs` 是给**离线**场景用的（翻历史日志）。两者共用同一套价目与桶定义，所以同一个时间段的总额能对上。

## 已知边界

- 只在 `assistant/message` / `assistant/attempt` / `compaction/summary` 三类事件上取 usage。DSH 若改事件名，需要同步 `USAGE_EVENT_TYPES`。
- 主题靠标题关键词，标题被 LLM 起成"【当前时间】2026/10/26…"这类时归不进桶，会落到"其他 / 未归类"。
- 峰谷判定依赖内置节假日表；**官方公布次年安排后要更新 `CN_HOLIDAYS_2027`**，否则节假日会被按高峰计价（静默高估，不报错）。
- 报告不含任何聊天正文，只有 id、标题、token 桶与金额。

## 项目家族

| 项目 | 对应成本条目 |
|---|---|
| **dsh-token-meter**（本仓库） | 用量与成本核算 |
| [dsh-qq-access](https://github.com/Derpyu520/dsh-qq-access) | 好友 / 白名单 / 权限 |
| [dsh-qq-voice](https://github.com/Derpyu520/dsh-qq-voice) | 语音 / 唱歌 / 音色 |
| [dsh-qq-stickers](https://github.com/Derpyu520/dsh-qq-stickers) | 表情包 / 斗图 |
| [dsh-mcp-safe-tools](https://github.com/Derpyu520/dsh-mcp-safe-tools) | 能力扩展（视觉 / 搜索 / 语感） |
| [dsh-session-link](https://github.com/Derpyu520/dsh-session-link) | 联通会话 / 行为调优 |
| [dsh-persona-kit](https://github.com/Derpyu520/dsh-persona-kit) | 人格 / 角色卡 |
| [qq-bridge](https://github.com/Derpyu520/qq-bridge) | 桥接内核（旗舰仓库） |

## English

`dsh-token-meter` reads DeepSeek Harness session logs (multi-frame zstd included), extracts per-call `usage`, and prices them with DeepSeek's peak/off-peak table (Beijing time, holidays excluded). One command produces a Markdown bill split by day, session, project, feature theme, and model — with a 29-case offline test suite. No DSH runtime required.

## License

MIT © Derpyu520
