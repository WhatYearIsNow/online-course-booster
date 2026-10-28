# online-course-booster

面向 AI 代理的网课辅助 skill，附带零运行时依赖的中国大学 MOOC CLI。用于读取课程状态、审阅成绩规则、检查考试入口，以及按已确认的计划提交讨论回复。

本目录是可独立移出的项目根目录，按 [MIT 许可证](LICENSE) 授权。GitHub 源码仓库已公开；尚未发布 GitHub Release 或 npm 包。真实平台接口与页面结构可能变化；**离线测试通过不代表当前课程或账号已完成真实平台验证**。

## 当前能力

| 平台 / 功能 | 实现状态 | 验证边界 |
|---|---|---|
| 中国大学 MOOC：`status`、`grading`、`exam` | 有 CLI | 页面与接口适配需真实环境复测 |
| 中国大学 MOOC：`discuss` | 离线预览、摘要确认、提交日志 | 接口回复 ID 只表示收到确认，仍需人工读回 |
| 中国大学 MOOC：`videos` | 默认扫描；显式开启历史实验 | DOM 标记与服务端汇总分别记录，不承诺逐项最终完成或成绩 |
| 超星学习通 | 只有研究文档 | 未包含实现或其他 skill |
| 智慧树 / 知到 | 只有研究文档 | 未包含登录、验证码或课程自动化实现 |
| 单元测试、期末考试作答与提交 | 未实现 | `exam` 仅检查列表状态 |

平台历史观察见 [证据说明](references/verification.md)。旧版本中的个人浏览器账户、私有中继和外部 skill 路径已从默认运行流程中移除。

## 环境与安装

需要 Node.js **22.15.0 或以上版本**（使用原生 `WebSocket`、`fetch` 和 `node:test`），以及用户自行启动、登录的 Chrome。当前 CI 配置为 Windows × Node.js 22.15.0 / 24，Linux 阶段暂缓；配置不等于已在远端运行。Windows 的隔离 Chrome 启动检查建议使用已验证的 Node 24，Node 22 的已知启动差异见 [阶段记录](docs/IMPLEMENTATION_STATUS.md)。

在本目录运行：

```sh
npm ci
npm run check
npm test
```

运行时没有第三方依赖；`npm ci` 仅安装锁定的开发格式工具并验证清单一致。作为 skill 使用时，将审查过的候选包解压到代理支持的 skills 目录，并让代理读取 [SKILL.md](SKILL.md)；CLI 也可以独立使用。没有安装钩子，不自动修改代理配置。

### 准备浏览器

为自动化使用独立的浏览器数据目录，手动完成登录，并打开目标课程学习页。调试服务仅在本机使用，不要对公网开放。Chrome 对默认资料目录的远程调试有限制，见 [Chrome 官方说明](https://developer.chrome.com/blog/remote-debugging-port)。

以下只是启动形态，按系统替换 Chrome 可执行文件；参数内的目录也应由使用者选择：

```sh
chrome --remote-debugging-port=0 --user-data-dir=/path/to/automation-data
node scripts/doctor.mjs --user-data-dir /path/to/automation-data
```

`/path/to/automation-data` 是占位路径。Windows 可将 `--user-data-dir` 指向自己创建的独立目录。以下课程命令用 `.local/chrome` 表示使用者配置好的目录；须与 Chrome 启动时的真实目录一致，建议启动 Chrome 时使用绝对路径。脚本不会复制现有浏览器资料，也不自动启动或关闭浏览器。

连接可通过 `--endpoint` 或 `--user-data-dir` 配置。后者用于读取该目录的 `DevToolsActivePort`，不是将资料复制到项目内。推荐启动时用动态端口 `--remote-debugging-port=0` 生成文件。固定端口下文件可能缺失或陈旧；端点需使用当前 Chrome 提供的浏览器 WebSocket 地址，形如 `ws://127.0.0.1:9222/devtools/browser/EXAMPLE`，其中 EXAMPLE 必须替换为当前实例的真实值。HTTP 地址不受支持。

项目不假定固定账户编号。当前实现无法从 CDP 证明浏览器资料目录身份，指定 `--expect-profile` 会报告未验证并阻断。实际账户需要由使用者在选中的课程页核对；该选项不是切换账户功能。

也可通过环境变量配置连接，优先级依次为：`--endpoint`、`--user-data-dir`、`CDP_ENDPOINT`、`CDP_RELAY_URL`、`CHROME_USER_DATA_DIR`。显式命令行配置优先于环境变量；同时给出两个命令行连接参数时，端点优先。`CDP_RELAY_URL` 只连接使用者已经配置的本机服务，不自动启动中继。`CDP_EXPECT_PROFILE` 等同于 profile 要求；不需要该要求时不要设置。

## CLI

```sh
node scripts/icourse163.mjs --help
node scripts/doctor.mjs --help
```

共同选项：

| 参数 | 用途 |
|---|---|
| `--course <id>`、`--term <id>` | 明确指定课程与学期，均为正整数字符串 |
| `--target <targetId>` | 选择匹配的浏览器标签页；多个匹配页时必须提供 |
| `--endpoint <url>` | 显式的本机浏览器 WebSocket CDP 端点，不接受 HTTP |
| `--user-data-dir <path>` | 读取独立 Chrome 资料目录中的调试连接信息 |
| `--expect-profile <name>` | 要求资料目录证据；当前无法证明时阻断 |
| `--school <code>` | 可选核对 URL 中的学校代码 |
| `--out <path>` | 将结构化结果写入本地 JSON 文件，父目录须存在且拒绝覆盖 |
| `--timeout-ms <ms>` | 有限的操作超时 |

课程 URL 例如 `https://www.icourse163.org/learn/SCHOOL-123456?tid=654321#/learn/content`。其中 `123456` / `654321` / `SCHOOL` 都是**合成示例**。使用真实操作前，改成当前学习页中的课程与学期，不能沿用例子。CLI 只接受 HTTPS 的 `icourse163.org` / `www.icourse163.org` 学习页，精确匹配路径、课程及学期，不以子串选择任意页面。

### 读取状态与规则

```sh
node scripts/icourse163.mjs status --course 123456 --term 654321 --user-data-dir .local/chrome
node scripts/icourse163.mjs grading --course 123456 --term 654321 --user-data-dir .local/chrome
node scripts/icourse163.mjs exam --course 123456 --term 654321 --user-data-dir .local/chrome
```

`grading` 读取成绩规则页面文本，需要人工结合课程公告审阅。权重、讨论所在板块、数量门槛、截止时间与考试尝试次数以当前课程为准。`exam` 的 `OPEN` / `NOT_OPEN` / `UNKNOWN` 表示页面观察结果；只有考试列表中可见、可用且文本精确为“开始考试”“进入考试”或“继续考试”的操作才作为 OPEN 的正向证据，条目存在不够。冲突提示或证据不足仍是 UNKNOWN，不能解释为已开放。

成绩规则页若明确未发布标准，`grading` 返回 `NOT_PUBLISHED` 与退出码 3；不能把导航标题当作评分内容。最新验证范围见 [阶段记录](docs/IMPLEMENTATION_STATUS.md)。

这些命令不提交答案或回复；页面检查可能会切换**目标标签页**内的课程栏目。

### 讨论：离线预览，再提交确认计划

先准备 `[{ "pid": 123, "html": "<p>回复正文</p>" }]` 格式的 JSON，并将人工审阅过的当期成绩规则保存为文本。示例文件仅供离线演示。

```sh
mkdir .local
node scripts/icourse163.mjs discuss --course 123456 --term 654321 --file examples/replies.json --rules examples/grading.txt --plan .local/plan.json
```

此命令完全离线，不连接浏览器、不读取 Cookie、不发送请求。默认就是预览；`--dry-run` 是兼容别名。`--plan` 保存包含课程、学期、回复正文、规则证据及摘要的计划，已存在的文件不会被覆盖。

审阅全部目标与正文，获得用户针对这份计划的授权后，才执行：

```sh
node scripts/icourse163.mjs discuss --course 123456 --term 654321 --plan .local/plan.json --submit --confirm REPLACE_WITH_PREVIEW_DIGEST --user-data-dir .local/chrome
```

将 `REPLACE_WITH_PREVIEW_DIGEST` 替换为预览返回的摘要。修改正文、目标或规则后应重新预览与确认。摘要证明内容一致，不能证明用户曾经授权；调用方仍需完成确认。

提交前核对课程身份与话题归属。默认日志存于 `.local/journals/<digest>.jsonl`，也可用 `--journal <path>` 指定。脚本不自动重试写请求，已有同一任务日志时拒绝直接重跑。请求可能已发出却未得到响应时，应先在讨论区人工读回；确认未提交的条目另建单条计划和日志。不要删除日志后盲目重复整批。

防重复检查只针对同一日志路径，不是全局事务或平台幂等。换日志路径，或修改规则/内容后产生新摘要，都不能保证没有提交过。CDP 关闭或取消只停止 Node 端等待，无法保证撤销网页已发出的 fetch；网页 fetch 有 10 秒超时，超时也不证明服务端没有接收。日志为 `uncertain` 时必须先人工读回。

返回回复 ID 只标记为 `acknowledged`。需要在课程的正确讨论板块核对正文与目标，才能报告已读回；参与成绩与否还要按课程规则核验。

### 视频：默认扫描，实验行为显式开启

```sh
node scripts/icourse163.mjs videos --course 123456 --term 654321 --user-data-dir .local/chrome
```

默认只扫描目录。历史版本的快进与短暂播放方法仍作为实验保留，使用前必须查看本课程规则，并明确开启：

```sh
node scripts/icourse163.mjs videos --course 123456 --term 654321 --execute --rules .local/grading.txt --user-data-dir .local/chrome --out .local/video-result.json
```

该实验可能失效或不满足课程要求。结果分别记录播放器动作、目录 DOM 标记和服务端汇总；目录的 `learned` 样式不构成逐条服务端最终记录。任何一层未知都应如实保留，不能承诺学习时长、完成成绩或学分。

网页播放步骤有自己的时间边界；Node 断连或取消后，页面中的动作仍可能继续，到网页代码执行 `finally` 中的暂停才停止。不能将本地取消描述为立即停止播放或回滚学习记录。

### 退出码

| 码 | 含义 | 处理 |
|---|---|---|
| 0 | 该命令定义的本地流程完成 | 按输出中的证据级别汇报 |
| 1 | 参数、输入或确认计划错误 | 修正输入后再执行 |
| 2 | 环境、目标或平台页面不符合要求 | 检查本机连接、登录与课程身份 |
| 3 | 部分失败或结果不完整 | 查看逐条结果，不称全部成功 |
| 4 | 中断、上下文失效或结果含糊 | 保存证据；写请求先人工核对再决定后续 |

非零退出不自动触发重试。即使退出码为 0，也不等于平台最终计分。

## 项目结构

- [SKILL.md](SKILL.md)：代理入口、路由与操作约束。
- `scripts/`：CDP、环境体检、MOOC CLI 和纯解析模块。
- `test/`：Node 内置测试与本地模拟；不需要真实账号。
- [platforms/](platforms/)：分平台说明及历史适配知识。
- [references/verification.md](references/verification.md)：证据级别与历史观察。
- [references/troubleshooting.md](references/troubleshooting.md)：错误定位。
- [docs/REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md)：重构方案与验收标准。
- [docs/TESTING.md](docs/TESTING.md)、[evals/README.md](evals/README.md)：测试层次与代理行为评估。
- `examples/`：合成讨论输入与规则文本。

## 开发与发布

运行 `npm run check`、`npm test`、`npm run test:coverage` 和 `npm pack --dry-run`。本次结果见 [验收记录](docs/TEST_REPORT.md)，验证边界见 [测试说明](docs/TESTING.md)，提交规范见 [CONTRIBUTING.md](CONTRIBUTING.md)，敏感数据报告见 [SECURITY.md](SECURITY.md)。

本包采用 [MIT 许可证](LICENSE)，`private: true` 用于防止误发 npm，不限制按 MIT 条款公开源码。[GitHub 仓库](https://github.com/WhatYearIsNow/online-course-booster) 已公开。本项目没有自动发布工作流；候选构建、公开 Release 和本地安装切换分别执行。

开发、测试、候选构建和回退约定见[维护流程](MAINTENANCE.md)。
