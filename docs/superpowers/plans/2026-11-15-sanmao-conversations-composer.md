# 三脚猫会话、思考档位、附件与输入区实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。当前侧会话禁止使用子代理，全部内联执行。

**目标：** 三脚猫支持本地旧会话、思考深度选择、真实图片/文本附件、思考动效和固定底部的 Claude Code 风格输入区。

**架构：** `SanmaoConversationStore` 使用现有 SQLite 保存会话、消息、草稿和附件元数据。`SanmaoService` 负责 SDK 查询与持久化，`SanmaoPage` 负责状态编排，拆分会话列表、消息区和输入区组件。附件在主进程校验后转成 SDK 内容块。

**技术栈：** Electron、React、TypeScript、SQLite、Claude Agent SDK、Zod、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-15-studio-sanmao-experience-design.md`

---

## 文件职责

- 新建 `src/main/sanmao-conversations.ts`：SQLite 会话、消息、草稿和附件存储。
- 新建 `src/main/sanmao-attachments.ts`：授权文件类型、大小和 SDK 内容块转换。
- 修改 `src/main/sanmao-service.ts`、`src/main/app-services.ts`、`src/main/ipc.ts`、`src/preload/index.ts`、`src/shared/ipc.ts`、`src/shared/sanmao.ts`：会话、草稿、附件和 effort 契约。
- 新建 `src/renderer/SanmaoConversationList.tsx`、`SanmaoMessageLog.tsx`、`SanmaoComposer.tsx`。
- 修改 `src/renderer/SanmaoPage.tsx`、`src/renderer/styles.css`。
- 新建 `tests/unit/sanmao-conversations.test.ts`、`tests/unit/sanmao-attachments.test.ts`。
- 修改 `tests/unit/sanmao-service.test.ts`、`tests/unit/sanmao-form.test.tsx`、`tests/unit/ipc.test.ts`、`tests/e2e/studio.spec.ts`、`tests/e2e/package.spec.ts`。

### 任务 1：SQLite 会话与草稿存储

- [x] **步骤 1：编写失败测试**

创建 `tests/unit/sanmao-conversations.test.ts`，验证首次发送创建会话、标题取首条用户消息前 40 字、模型/effort/草稿/附件元数据可更新，重开数据库后消息与草稿仍在，删除只删除目标会话及其消息/附件，其他会话不受影响。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/sanmao-conversations.test.ts`

预期：找不到 `sanmao-conversations.ts`。

- [x] **步骤 3：实现版本化存储**

`SanmaoConversationStore` 使用 `DatabaseSync`，创建 `sanmao_conversations`、`sanmao_messages`、`sanmao_draft_attachments` 表和外键。提供 `createConversation`、`appendMessage`、`listConversations`、`getConversation`、`updateDraft`、`deleteConversation`。首次 `appendMessage` 自动创建会话；助手消息只在显式调用时写入。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/sanmao-conversations.test.ts && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/main/sanmao-conversations.ts tests/unit/sanmao-conversations.test.ts
git commit -m "Persist Sanmao conversations locally"
```

### 任务 2：会话服务、IPC 与旧会话管理

- [x] **步骤 1：编写失败测试**

在 `tests/unit/sanmao-service.test.ts` 验证用户消息立即持久化、成功回复才保存助手消息、失败不写半截回复，list/get/delete 调用对应存储。`tests/unit/ipc.test.ts` 覆盖 `sanmao:listConversations`、`getConversation`、`deleteConversation`、`saveDraft` 的严格 schema 和授权。

- [x] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/sanmao-service.test.ts tests/unit/ipc.test.ts -t "conversation|会话"`

- [x] **步骤 3：接入存储与严格 IPC**

`createAppServices` 注入同一个 SQLite 会话存储。`SanmaoService` 在发送前写用户消息，成功后写助手消息，提供会话查询/删除和草稿保存。preload 暴露对应方法，所有返回不包含 API Key 或附件完整路径。

- [x] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/sanmao-conversations.test.ts tests/unit/sanmao-service.test.ts tests/unit/ipc.test.ts && npm run typecheck`

- [x] **步骤 5：提交**

```bash
git add src/main/sanmao-conversations.ts src/main/sanmao-service.ts src/main/app-services.ts src/main/ipc.ts src/preload/index.ts src/shared/ipc.ts src/shared/sanmao.ts tests/unit/sanmao-service.test.ts tests/unit/ipc.test.ts
git commit -m "Add Sanmao conversation service and IPC"
```

### 任务 3：旧会话列表、消息区和固定底部输入区

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/sanmao-form.test.tsx` 验证旧会话可打开、删除前确认、无消息时 composer 位于容器底部、消息区独立滚动、回复时显示 `role="status"` 的思考状态，切页恢复消息和草稿。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/sanmao-form.test.tsx -t "旧会话|底部|思考"`

- [ ] **步骤 3：实现会话列表和布局**

`SanmaoConversationList` 显示标题、时间、模型和删除按钮；`SanmaoMessageLog` 使用独立滚动区；`SanmaoComposer` 固定底部，左下角加号，右下角模型、effort 和圆形 `ArrowUp` 发送按钮，回复中变为 `Square` 停止按钮。`SanmaoPage` 管理当前会话和加载状态，保留页面挂载。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/sanmao-form.test.tsx && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/renderer/SanmaoConversationList.tsx src/renderer/SanmaoMessageLog.tsx src/renderer/SanmaoComposer.tsx src/renderer/SanmaoPage.tsx src/renderer/styles.css tests/unit/sanmao-form.test.tsx
git commit -m "Add Sanmao history and fixed composer"
```

### 任务 4：思考档位和真实附件

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/sanmao-service.test.ts` 断言 low/medium/high 映射到 SDK `options.effort`，活动请求不随后续改变。`tests/unit/sanmao-attachments.test.ts` 验证 PNG/JPEG/WebP 图片转 base64 图片块、文本文件转文本块、数量/大小/格式/未授权拒绝，且 prompt 是 `AsyncIterable<SDKUserMessage>`。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/sanmao-service.test.ts tests/unit/sanmao-attachments.test.ts -t "effort|attachment|附件|思考"`

- [ ] **步骤 3：实现 effort 和附件管线**

发送请求捕获 effort 并传给 SDK。新增 `SanmaoAttachmentService` 处理文件选择、拖放授权、5MiB 图片和 1MiB 文本限制，各最多 4 个。`SanmaoQueryInput.prompt` 支持 `AsyncIterable<SDKUserMessage>`，保留现有文本历史，附件仅用于当前请求。preload 增加选择/授权附件接口。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/sanmao-service.test.ts tests/unit/sanmao-attachments.test.ts tests/unit/sanmao-form.test.tsx && npm run typecheck`

- [ ] **步骤 5：提交**

```bash
git add src/main/sanmao-attachments.ts src/main/sanmao-service.ts src/main/ipc.ts src/preload/index.ts src/shared/ipc.ts src/shared/sanmao.ts src/renderer/SanmaoComposer.tsx src/renderer/SanmaoPage.tsx tests/unit/sanmao-service.test.ts tests/unit/sanmao-attachments.test.ts tests/unit/sanmao-form.test.tsx
git commit -m "Add Sanmao effort levels and real attachments"
```

### 任务 5：重启、Electron 与打包验证

- [ ] **步骤 1：补充重启和 Electron 测试**

在 `tests/e2e/studio.spec.ts` 验证旧会话重启恢复、选择/删除、底部 composer、思考动效、模型/effort 切换及真实附件内容块。`tests/e2e/package.spec.ts` 验证数据库可写和包内无测试密钥/聊天记录。

- [ ] **步骤 2：运行完整回归**

```powershell
npm run typecheck
npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot
npm run test:e2e -- tests/e2e/studio.spec.ts
npm run test:e2e:package
```

- [ ] **步骤 3：只提交本计划相关文件**

确认无环境向导、缓存、真实密钥或聊天内容后提交实现、测试和本计划文件。
