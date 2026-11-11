# 来源、集成决策与修改记录

核验日期：2026-11-11。会话中未提供 Exa MCP，因此本次使用网页搜索、官方文档、GitHub 官方仓库和实际安装包交叉核对。版本快照与部署时实际可用性要分开判断。

## 来源

| 来源 | 本次依据 | 本项目的使用方式 |
| --- | --- | --- |
| [LuJie CareerKit](https://github.com/Chozzc/Lujie-Careerkit) | commit `1aa4d01447d706617f2f9399fa5389cd2461abf3`；package 0.4.0；Apache-2.0 | 导入工作台源码、迁移、测试、样例与技能文件作为底座 |
| [Codex 官方源码](https://github.com/openai/codex) | GitHub API 与包内许可均显示 Apache-2.0 | 不分叉 Rust / CLI 核心；使用官方 SDK 依赖 |
| [Codex SDK 文档](https://developers.openai.com/codex/sdk/) | 文档与安装包的 TypeScript 声明核对 startThread / run / env / outputSchema | 固定 `@openai/codex-sdk@0.167.1`，单次结构化证据复盘 |
| [Codex 平台说明](https://developers.openai.com/blog/codex-as-a-platform) | 区分 exec、SDK 与 app-server 的集成定位 | 将运行时与应用事实库分开，避免先维护核心分叉 |
| [app-server 文档](https://developers.openai.com/codex/app-server/) | 线程、轮次、流事件与审批生命周期 | 作为长任务阶段的集成依据，当前未实现应用内完整迁移 |
| [Codex 配置参考](https://developers.openai.com/codex/config-reference/) | shell_tool、view_image、apps 等开关 | 复盘封装禁用无关工具；不把该配置等同于多租户隔离 |
| [OpenAI 服务地域列表](https://developers.openai.com/api/docs/supported-countries) | 模型服务与开源代码许可分别存在条件 | 商业部署前核对服务对象与供应商可用性，未承诺中国版默认可用 OpenAI |

上游 README 明确说明其跨对话记忆未实现，且已有工具写入需用户确认。TRACEFOLIO 新增的是独立领域库和检索，不将上游对话保存机制称作完整职业长期记忆。Codex 集成能力也不等于已实现可独立核验的职业能力评估。

## 许可与分发

保留根目录 LICENSE 和原 NOTICE；JadeAI 署名及许可位于 `third-party/JadeAI-LICENSE.txt`。Codex SDK 的许可副本位于 `third-party/Codex-LICENSE.txt`。Apache-2.0 正文第 2、4、6、9 条分别涉及复制 / 衍生权、再分发要求、商标边界和收费责任；具体条件以许可全文为准。

本版继续保留该开源许可，不擅自更换上游版权声明。TRACEFOLIO 使用自己的品牌和标记，不表示 LuJie、JadeAI 或 OpenAI 对本项目背书。后续商业分发应继续保留许可、署名和修改说明；模型服务使用条款不是由代码许可证授予。

导入时不包含上游宣传视频、GIF 演示、营销图片和自动发布 Docker 镜像的 workflow。`docs/upstream/` 中保留原 README 供来源对照；里面的宣传图片路径可能没有随本项目分发。校招目录属于上游静态快照，不是实时岗位服务，商业阶段需确定数据源授权、更新与失效机制。

## TRACEFOLIO 修改清单

- 新增 `src/lib/career/`、`src/components/career/`、`src/app/api/career/`、职业数据迁移和文档。
- package 身份、版本、启动脚本、类型检查、Node.js 要求、Codex 固定依赖与锁文件。
- `src/lib/navigation.ts`、应用导航和主工作台增加 `/intelligence`。
- `src/app/page.tsx`、layout、sidebar、topbar、品牌 SVG 与语言文件改为 TRACEFOLIO 入口和身份。
- layout / globals.css 使用本机字体回退，构建无需下载 Google 字体。
- topbar 与 Agent 提示气泡修复窄屏横向溢出，保留移动端导航和语言切换。
- `src/lib/agent/career-agent.ts` 新增只读职业记忆检索工具，保留上游写入确认机制。
- `src/lib/ai/tasks.ts` 增加显式职业背景开关；简历、面试、准备资料与申请文案调用启用该开关，提取 / 连接测试不启用。
- `src/lib/ai/secrets.ts` 去除已知默认值加密密钥回退；setup 生成随机密钥，测试配置使用仅供测试的固定值。
- `scripts/migrate.mjs` 支持读取本机环境；新增 setup、CI 检查与本机 Docker 配置。
- 原 README 归档并替换，NOTICE 追加独立衍生项目信息。修改过的源文件带修改说明，JSON 使用专门字段记录。

原始架构设计和历史开发计划仍可能保留在上游导入文档中；当前产品能力、边界和下一步以 TRACEFOLIO 根 README、架构与路线图为准。
