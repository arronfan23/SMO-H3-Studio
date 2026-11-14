# 三脚猫 Claude 助手实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。当前侧会话禁止使用子代理，全部内联执行。

**目标：** 在 SMO.H3 Studio 增加顶级“三脚猫”导航，使用官方 Claude Agent SDK 提供安全、可取消的流式对话和独立连接配置。

**架构：** 渲染进程只负责表单和聊天展示；主进程负责 DPAPI 配置、SDK 调用、内存会话和权限限制。首版禁用全部 Agent 工具，不使用磁盘会话；主进程用内存消息构造上下文，应用重启后自然清除。

**技术栈：** Electron、React、TypeScript、Zod、`@anthropic-ai/claude-agent-sdk@0.3.323`、DPAPI、Vitest、Playwright。

---

## 文件结构

- `package.json`、`package-lock.json`：加入并锁定官方 SDK。
- `src/shared/sanmao.ts`：连接配置、消息、流事件和测试结果类型。
- `src/main/sanmao-config.ts`：原子写入、DPAPI 加密和只读配置视图。
- `src/main/sanmao-service.ts`：SDK query、内存上下文、流式文本、取消和关闭。
- `src/main/sanmao-ipc.ts`：严格 IPC 注册与事件转发。
- `src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/app-services.ts`：公开受控 API 并接入应用生命周期。
- `src/renderer/SanmaoPage.tsx`、`src/renderer/App.tsx`、`src/renderer/styles.css`：顶级导航和完整聊天页面。
- `tests/unit/sanmao-*.test.ts*`、`tests/unit/ipc.test.ts`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`、`tests/e2e/package.spec.ts`：覆盖服务、界面和打包。

### 任务 1：安装 SDK 并实现加密配置

- [x] **步骤 1：安装并检查官方 SDK 类型**

运行：

```powershell
npm install --save-exact @anthropic-ai/claude-agent-sdk@0.3.323
```

阅读安装包中的 `query`、`Options`、消息和 `AbortController` 类型，确认 `includePartialMessages`、`tools: []`、`maxTurns`、环境变量和结果字段。若实际类型与计划示例不同，以安装包类型为准并同步修正测试，不凭猜测调用。

- [x] **步骤 2：先编写配置存储失败测试**

创建 `tests/unit/sanmao-config.test.ts`：

```ts
test('stores Sanmao credentials encrypted and never returns the API key', async () => {
  await store.saveProfile({
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-test',
    apiKey: 'secret-sanmao-key',
  });

  expect(await store.getProfile()).toEqual({
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-test',
    keyStatus: 'valid',
  });
  expect(await readFile(configPath, 'utf8')).not.toContain('secret-sanmao-key');
});
```

补充首次缺少密钥、空模型、非法 URL、空密钥复用旧密钥、DPAPI 故障和损坏配置的测试。

- [x] **步骤 3：运行测试确认模块不存在**

运行：`npx vitest run tests/unit/sanmao-config.test.ts`

预期：FAIL，找不到 `src/main/sanmao-config.ts`。

- [x] **步骤 4：实现最小配置存储**

创建 `SanmaoProfile`、`SanmaoProfileView` 和 `SanmaoCredentials`；实现与现有 `FileLlmConfigStore` 相同模式的原子写入和 DPAPI：

```ts
export interface SanmaoProfile {
  baseUrl: string;
  model: string;
}

export interface SanmaoProfileView extends SanmaoProfile {
  keyStatus: 'valid' | 'reenter-required';
}
```

`getProfile()` 不返回密钥，`saveProfile()` 接受可选新密钥，空密钥只在已有配置时复用。

- [x] **步骤 5：重跑配置测试**

运行同步骤 3，预期全部 PASS。

### 任务 2：实现无工具的流式三脚猫服务

- [x] **步骤 1：编写模拟 SDK 失败测试**

创建 `tests/unit/sanmao-service.test.ts`，注入 `queryImpl`，模拟 system、assistant、stream event 和 result 消息。至少覆盖：

```ts
test('streams assistant text with tools disabled and no credentials in results', async () => {
  const chunks: string[] = [];
  const result = await service.send({
    conversationId: '00000000-0000-4000-8000-000000000001',
    text: '你好',
    onText: (text) => chunks.push(text),
  });

  expect(result.text).toBe('你好，我是三脚猫');
  expect(chunks.join('')).toBe(result.text);
  expect(queryOptions).toMatchObject({
    tools: [],
    includePartialMessages: true,
    maxTurns: 1,
  });
  expect(result).not.toHaveProperty('credentials');
  expect(chunks.join('')).not.toContain('secret-sanmao-key');
});
```

另外覆盖取消、120 秒超时、同一请求不可重入、会话隔离、旧会话取消后新会话可继续、SDK 错误脱敏和 close 清理。服务用内存消息构造多轮上下文，设置 `persistSession: false`（若安装类型支持）；不依赖 SDK 磁盘会话。

- [x] **步骤 2：运行测试确认服务不存在**

运行：`npx vitest run tests/unit/sanmao-service.test.ts`

预期：FAIL，找不到 `sanmao-service.ts`。

- [x] **步骤 3：实现 SanmaoService**

使用安装后确认的官方类型，核心形态：

```ts
const controller = new AbortController();
const stream = queryImpl({
  prompt: buildConversationPrompt(messages),
  options: {
    model: credentials.model,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: credentials.baseUrl,
      ANTHROPIC_API_KEY: credentials.apiKey,
    },
    tools: [],
    maxTurns: 1,
    includePartialMessages: true,
    abortController: controller,
  },
});
```

只提取 assistant 文本与文本增量，不转发原始消息。每个请求注册 controller，超时或取消时中止，成功后把用户与助手消息写入对应内存会话；失败不得留下半条助手消息。

- [x] **步骤 4：重跑服务测试与类型检查**

运行：`npx vitest run tests/unit/sanmao-service.test.ts && npm run typecheck`

预期：测试 PASS，TypeScript 无错误。

### 任务 3：接入严格 IPC 与应用生命周期

- [x] **步骤 1：先添加 IPC 与 preload 失败测试**

在 `tests/unit/ipc.test.ts` 覆盖：

```ts
expect(createIpcSchema().parse({
  channel: 'sanmao:send',
  payload: { conversationId: 'c1', replyId: 'r1', text: '你好' },
})).toEqual(expect.anything());
```

拒绝额外字段、空文本、超长文本和非法流事件。验证 `getProfile/saveProfile/testConnection/send/cancel` 调用目标服务，且 `getProfile` 不含 `apiKey`。

- [x] **步骤 2：运行测试确认 IPC 尚不支持**

运行：`npx vitest run tests/unit/ipc.test.ts`

预期：FAIL，未知 `sanmao:*` channel。

- [x] **步骤 3：实现 schema、preload 和主进程注册**

增加严格 schema：

```ts
const sanmaoSendSchema = z.object({
  conversationId: z.string().uuid(),
  replyId: z.string().uuid(),
  text: z.string().trim().min(1).max(32_000),
}).strict();
```

`sanmao:send` 立即返回 `{ ok: true }`，实际文本通过 `sanmao:stream` 事件发送 `{ conversationId, replyId, kind: 'delta'|'done'|'error', text? }`。preload 的订阅函数返回取消订阅函数，只接受当前窗口的受控事件。

在 `createAppServices()` 创建 store/service，注册 IPC，并在现有服务清理顺序中关闭三脚猫请求。SDK 不可用时返回脱敏错误，不影响其他模块。

- [x] **步骤 4：重跑 IPC 测试**

运行同步骤 2，预期全部 PASS。

### 任务 4：实现顶级导航与聊天页面

- [x] **步骤 1：编写导航和页面失败测试**

在 `tests/unit/studio.test.tsx` 和新建 `tests/unit/sanmao-form.test.tsx` 覆盖：

```tsx
fireEvent.click(screen.getByRole('button', { name: '三脚猫' }));
fireEvent.change(screen.getByLabelText('发送给三脚猫的消息'), {
  target: { value: '帮我分析这个商品文案' },
});
fireEvent.click(screen.getByRole('button', { name: '发送' }));
expect(await screen.findByText('这是三脚猫的回复')).toBeInTheDocument();
```

覆盖未配置、保存、测试连接、流式回复、停止、新建会话、失败重试、切页保留消息和长文本布局。

- [x] **步骤 2：运行 UI 测试确认导航不存在**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/sanmao-form.test.tsx`

预期：FAIL，找不到三脚猫导航。

- [x] **步骤 3：实现 SanmaoPage 与导航**

在 `NAVIGATION` 的制作台之后加入：

```ts
{ id: 'sanmao', label: '三脚猫', icon: MessageCircle }
```

页面使用 `aria-label="三脚猫"` 的独立 region；提供连接表单、消息列表、自动增高文本框、发送/停止和新建会话按钮。聊天页像 StudioPage 一样保持挂载，通过 `hidden` 切换，避免切页丢失消息。图标使用 Lucide，按钮带可访问名称，错误不显示密钥。

- [x] **步骤 4：运行 UI 测试与类型检查**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/sanmao-form.test.tsx && npm run typecheck`

预期：全部 PASS。

### 任务 5：回归、打包与验收

- [x] **步骤 1：运行完整自动化验证**

```powershell
npm run typecheck
npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot
npm run build
npx playwright test tests/e2e/studio.spec.ts
```

记录实际通过数和跳过数，不把用户既有环境向导文件纳入修改。

- [x] **步骤 2：验证 Electron 打包后的 SDK**

更新 `electron-builder.yml` 的 `asarUnpack`，至少覆盖：

```yaml
asarUnpack:
  - node_modules/@anthropic-ai/claude-agent-sdk/**/*
```

运行 `npm run pack`，检查 SDK JavaScript、CLI 及其必需运行时文件在 `app.asar.unpacked` 中实际存在；使用无真实密钥的模拟/无效本地端点验证打包进程能启动并返回受控连接错误，不得在包中写入测试密钥。

- [x] **步骤 3：构建并报告真实连接边界**

生成 Windows 安装包与便携版，核对文件和哈希。若用户已有可用 Claude 授权，可经用户操作完成一次真实连接；否则明确报告“真实 Claude 连接未验收”，不伪造成功。

- [x] **步骤 4：检查工作树**

运行 `git status --short` 与 `git diff --check`。不得包含环境向导、缓存、测试密钥或聊天记录。实现代码默认不提交、不推送，完成后由用户选择收尾方式。

#### 2026-11-14 发布前补充验收（0.5.0）

- 增加 SDK 隔离：`settingSources: []`、`mcpServers: {}`，并过滤继承的 Anthropic/Claude 凭据和配置，防止读取用户登录态或 MCP。
- 类型检查通过；完整 Vitest 为 65 个文件、2821 通过、1 跳过、0 失败；Studio E2E 为 26/26，打包态 E2E 为 6/6。
- 包内 `claude.exe` 存在且可启动；无效本地端点返回受控、脱敏连接错误。未使用真实 Claude 密钥做连接验收。
