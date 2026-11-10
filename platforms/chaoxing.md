# 超星学习通（形势与政策广场）

本包提供超星学习广场（`tsjy.chaoxing.com`）的只读查询与测评提交 CLI。它与 `icourse163` 是两套完全不同的协议，不能混用命令。

## 命令

```sh
node scripts/chaoxing.mjs status   --course-id ID --class-id ID --managed --headless
node scripts/chaoxing.mjs chapters --course-id ID --class-id ID --managed --headless
node scripts/chaoxing.mjs quiz     --course-id ID --class-id ID --chapter ID --managed --headless
node scripts/chaoxing.mjs run      --course-id ID --class-id ID --target 800 --managed --headless
```

| 命令       | 性质            | 说明                                                         |
| ---------- | --------------- | ------------------------------------------------------------ |
| `status`   | 只读            | 读取 `window.userId` / `courseId` / `classId` 与积分接口     |
| `chapters` | 只读            | 从分类接口/广场页取分类，再分页读取知识点 ID                 |
| `quiz`     | 预览 → 提交     | 默认只预览题目结构与摘要；`--submit --confirm DIGEST` 才作答 |
| `run`      | 预览 → 批量提交 | 默认只输出计划；`--submit --confirm DIGEST` 才逐章执行       |

连接方式与 MOOC CLI 相同：显式 `--endpoint` / `--user-data-dir`，或 `--managed [--headless] [--data-dir DIR]` 使用隔离的受管浏览器。

## 页面与接口

| 用途     | 位置                                                                                                      |
| -------- | --------------------------------------------------------------------------------------------------------- |
| 广场页   | `https://tsjy.chaoxing.com/plaza/?courseId=...`                                                           |
| 积分     | `GET /plaza/score/{courseId}/user-score-detail?classId=`                                                  |
| 分类     | `GET /plaza/classify-list?courseId=..&classId=..&userId=..`，或广场页 `classifyId=` 链接                  |
| 知识点   | `GET /plaza/knowledge-list?classifyId=..&courseId=..&classId=..&page=N`，HTML 中 `goKnowledge(<i>, <id>)` |
| 学习入口 | `GET /plaza/user/{courseId}/{knowledgeId}/modify-node?classId=` → `{mode, enc, domain, classId}`          |
| 学习页   | `<domain>/mycourse/transfer?...refer=<studentstudy URL>`                                                  |

`mode !== 'study'` 表示只读预览页，没有测评，直接跳过。`enc` 与账号绑定，必须每章现取；写死旧值会得到「enc 校验失败」错误页。

测评位于三层 iframe：`#iframe` → `iframe[src*="modules/work/"]` → `#frame_content` → `.TiMu`。题型从题干 `【判断题】/【单选题】/【多选题】` 读取，选项为 `li.font-cxsecret`，提交为 `a.btnSubmit`，二次确认为 `onclick` 含 `submitCheckTimes` 的 `a.bluebtn`。

## 作答策略与边界

- 默认 `--strategy first`：判断题/单选题选第 1 项，多选题选前 2 项；不读取题干语义，正确率取决于题目分布，不保证达标。
- 本地答案库（2026-11-11 新增）：只有整卷 100 分的作答才写入 `.local/answer-bank.json`，键为题干指纹（font-cxsecret 混淆文本 + 题型 + 选项数的 SHA-256）+ 选项数；命中时优先复用，冲突保留旧值并计数。指纹依赖 DOM 文本确定性，平台改版会退化为启发式，不会答错。
- 字体混淆（`font-cxsecret`）使 DOM 文本不可读；策略不依赖文本，因此不受影响。
- 提交前必须预览并取得摘要；摘要绑定课程、班级、章节与题目结构（题型 + 选项数）。页面结构变化会导致摘要不匹配并拒绝提交。
- 不自动重试。提交后未确认、出现风控或结果含糊时写 `uncertain` 并停止。
- 遇到验证码、`操作频繁`、`已在其他页面学习`、`enc 校验失败`、登录失效时停止并报告。
- 单学习标签页：`run` 只复用一个学习页，避免「账号已在其他页面学习」。
- 日志默认 `.local/journals/chaoxing-<digest>.jsonl`，已存在时拒绝重跑。继续未完成的批量任务时用新的 `--journal` 路径；平台已完成的测评会显示「已完成」，据此跳过。换日志路径或新摘要不是全局幂等保证。

## 班级解析与入班信号（2026-11-10 实测）

- **classId 是账号相关的**：同一个广场课程（courseId）下，不同学生属于不同班级。复用其他账号的 classId 时，广场页会显示「您尚未报名，学习行为将不计分」横幅，`modify-node` 返回 `mode=preview、classId=""`——章节全部只读、无测评、不计分。
- **自动解析**：打开不带 classId 的广场页（`/plaza/?courseId=<courseId>`），服务端按当前账号解析班级，`window.classId` 即为该账号的正确班级。CLI 的 `--class-id` 因此可选；省略时自动解析，解析不到即报错。
- **入班守卫**：显式传入不属于当前账号的 classId 时，`run`/`quiz` 在动手前报错并给出指引；`status`/`chapters` 照常只读并在输出中带 `enrolled` 字段。run/quiz 不会在未入班时把章节静默跳过。
- 报名接口 `user/<courseId>/add-course-class-user?classId=...&fid=...` 对关闭自助报名的课程返回 `{code:0,data:{msg:"课程不允许报名"}}`；入班只能由老师/管理员导入或用邀请链接。

## 2026-10-28 实测记录

环境：Windows、Node 24、Chrome 155、受管 headless 实例。

| 步骤        | 结果                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| 登录        | 手机号 + 密码成功，未出现验证码                                                                      |
| `status`    | 总积分 1、达标线 800，分项 7 项                                                                      |
| `chapters`  | 8 个分类、256 个知识点                                                                               |
| `quiz` 预览 | 5 题（3 判断 + 2 单选），摘要生成                                                                    |
| `quiz` 提交 | 提交并二次确认成功，本次成绩 60，广场积分 1 → 7                                                      |
| `run` 批量  | 跳过已完成章节，逐章作答提交；积分 13 → 21                                                           |
| 完整批量    | 处理 173 章（164 提交、5 已完成、3 跳过、1 章命中验证码模式停止）；积分 21 → 801（答题 800、登录 1） |
| 重启实例    | 登录态丢失；鉴权 cookie 均为会话型                                                                   |

## 已知限制

- 登录态不跨实例重启持久（会话型 cookie）；保持受管实例运行可复用。
- 启发式作答不保证 800 分；未实现视频、阅读、笔记、讨论等计分项。
- 页面结构、接口或风控变化可能使命令失效；失败时停止，不绕过。
- 一次通过不代表后续学期或账号通用。
