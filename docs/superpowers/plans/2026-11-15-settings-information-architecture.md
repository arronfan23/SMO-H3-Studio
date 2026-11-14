# 设置页信息架构与响应式布局实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。当前侧会话禁止使用子代理，全部内联执行。

**目标：** 设置页采用运行概览与生成环境/AI 服务分区，减少寻找成本，保持现有全部配置功能。

**架构：** `SettingsPage` 按状态概览、生成环境、AI 服务组织，顶部显示 ComfyUI、硬件和版本摘要。硬件高级操作放入展开区，窄屏单栏。

**技术栈：** React、TypeScript、CSS、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-15-studio-sanmao-experience-design.md`

---

## 文件职责

- 修改 `src/renderer/SettingsPage.tsx`：信息架构和状态概览。
- 修改 `src/renderer/styles.css`：分区、响应式、按钮/状态对齐和展开区。
- 修改 `tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`：分组与布局回归。

### 任务 1：状态概览与分区

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/studio.test.tsx` 断言出现 `region[aria-label="设置概览"]`，包含 ComfyUI、硬件和应用版本；存在 `region[aria-label="生成环境"]` 和 `region[aria-label="AI 服务"]`，AI tab 仍在对应区域内，硬件高级操作位于 `details` 元素中。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/studio.test.tsx -t "设置概览|生成环境|AI 服务"`

- [ ] **步骤 3：重构 SettingsPage 结构**

在现有加载完成后渲染顶部 `settings-overview`，下方 `settings-workspace` 两栏。左栏包含硬件和 ComfyUI，右栏包含 AI tab 与面板。模型目录、应用推荐和恢复默认放入 `<details><summary>高级工作流设置</summary></details>`，不改变任何业务处理函数。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/studio.test.tsx && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/SettingsPage.tsx tests/unit/studio.test.tsx
git commit -m "Organize settings by runtime overview and workflows"
```

### 任务 2：专业布局与响应式状态

- [ ] **步骤 1：编写布局失败测试**

在 `tests/e2e/studio.spec.ts` 验证顶部状态概览全宽、两栏分区在宽屏不重叠，960px 以下单栏；按钮、错误和保存状态位于对应分组，没有横向溢出或嵌套卡片。

- [ ] **步骤 2：运行测试确认失败**

运行：`npm run test:e2e -- tests/e2e/studio.spec.ts -t "设置概览|设置页|settings"`

- [ ] **步骤 3：实现样式**

新增 `settings-overview`、`settings-workspace`、`settings-environment`、`settings-ai-services`、`settings-advanced` 样式。概览使用全宽摘要行，两栏使用 `minmax(0, 1.1fr) minmax(0, .9fr)`，960px 以下单列。统一按钮、状态、展开区和焦点样式，避免嵌套卡片和装饰动效。

- [ ] **步骤 4：运行布局回归**

运行：`npm run test:e2e -- tests/e2e/studio.spec.ts && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/styles.css tests/e2e/studio.spec.ts
git commit -m "Refine responsive settings layout"
```

### 任务 3：完整验证

- [ ] **步骤 1：运行最终回归**

```powershell
npm run typecheck
npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot
npm run test:e2e -- tests/e2e/studio.spec.ts
npm run test:e2e:package
```

- [ ] **步骤 2：检查工作树并提交**

确认仅本计划相关代码、测试和计划文件进入提交，保留环境向导和缓存改动。
