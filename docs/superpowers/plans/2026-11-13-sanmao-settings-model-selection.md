# 三脚猫设置集中化与模型切换实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）跟踪进度。当前侧会话禁止使用子代理，全部内联执行。

**目标：** 将三脚猫连接配置迁入设置页，在聊天页提供可保存的模型切换、搜索、刷新和手动输入兜底。

**架构：** 主进程负责模型发现、配置和 SDK 请求。设置与聊天页共用同一个 DPAPI 配置存储；三脚猫服务每次新请求读取最新模型，正在运行的请求保持原参数。

**技术栈：** Electron、React、TypeScript、Zod、Claude Agent SDK、Vitest、Playwright。

---

## 文件结构

- `src/main/sanmao-models.ts`：模型发现 URL、鉴权、超时和响应校验。
- `src/main/sanmao-config.ts`：支持使用当前输入或已保存配置解析模型发现连接。
- `src/shared/sanmao.ts`：模型发现连接、结果和页面状态类型。
- `src/main/sanmao-service.ts`：提供模型发现，并证明新请求读取最新模型。
- `src/shared/ipc.ts`、`src/preload/index.ts`、`src/main/ipc.ts`：新增 `sanmao:listModels` 与前往设置契约。
- `src/renderer/SanmaoSettings.tsx`：三脚猫独立设置组件。
- `src/renderer/SettingsPage.tsx`：AI 服务选项卡和设置保存状态。
- `src/renderer/SanmaoPage.tsx`：移除连接表单，增加模型切换和刷新。
- `src/renderer/App.tsx`：设置页焦点与跨页配置刷新。
- `tests/unit/sanmao-*.test.ts*`、`tests/unit/ipc.test.ts`、`tests/unit/studio.test.tsx`、`tests/e2e/studio.spec.ts`：覆盖对应行为。

### 任务 1：实现模型发现与连接解析

- [x] **步骤 1：先写模型发现失败测试**

创建 `tests/unit/sanmao-models.test.ts`：

```ts
test('lists unique model ids using Anthropic authentication', async () => {
  const models = await listSanmaoModels(connection, { fetchImpl });

  expect(models).toEqual(['claude-a', 'claude-b']);
  expect(request.url).toBe('https://api.anthropic.com/v1/models');
  expect(request.headers['x-api-key']).toBe('secret-key');
  expect(request.headers['anthropic-version']).toBe('2023-06-01');
});
```

覆盖已有 `/v1` 地址不重复拼接、空 ID 过滤、401/403 脱敏、超时、非法 JSON、非数组响应和密钥不出现在错误中。

- [x] **步骤 2：运行测试确认模型发现模块不存在**

运行：`npx vitest run tests/unit/sanmao-models.test.ts`

预期：FAIL，找不到 `sanmao-models.ts`。

- [x] **步骤 3：实现模型发现与配置解析**

实现：

```ts
export async function listSanmaoModels(
  connection: SanmaoConnection,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<string[]> {
  const response = await fetchImpl(createModelsUrl(connection.baseUrl), {
    headers: {
      Accept: 'application/json',
      'x-api-key': connection.apiKey,
      'anthropic-version': '2023-06-01',
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  // 校验 HTTP、JSON 和 data[].id，去重排序后返回。
}
```

在 `FileSanmaoConfigStore` 增加 `resolveConnection({ baseUrl?, apiKey? })`：缺省地址复用已保存地址；密钥为空时复用已保存密钥；首次配置缺少任一必需项时拒绝。

- [x] **步骤 4：重跑模型发现和配置测试**

运行：`npx vitest run tests/unit/sanmao-models.test.ts tests/unit/sanmao-config.test.ts`

预期：全部 PASS。

### 任务 2：接入模型发现 IPC 和运行时模型刷新

- [x] **步骤 1：添加失败测试**

在 `tests/unit/ipc.test.ts` 验证 `sanmao:listModels` 接受空对象和当前地址/密钥，拒绝额外字段；验证主进程先解析配置再返回模型。

在 `tests/unit/sanmao-service.test.ts` 先保存模型 A，再改为模型 B，断言下一请求的 `options.model === 'claude-b'`，且已开始的请求仍使用 A。

- [x] **步骤 2：运行测试确认功能缺失**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/sanmao-service.test.ts`

预期：FAIL，缺少模型发现 channel 或运行时模型刷新断言。

- [x] **步骤 3：实现 IPC 与服务调用**

新增严格 schema：

```ts
const sanmaoModelDiscoverySchema = z.object({
  baseUrl: httpUrlSchema.optional(),
  apiKey: z.string().optional(),
}).strict();
```

在 `IpcServices.sanmao` 增加 `listModels`，主进程调用：

```ts
return services.sanmao.listModels(
  await services.sanmaoConfig.resolveConnection(request.payload),
);
```

preload 暴露 `listModels(input)`，服务在 `send()` 和 `testConnection()` 开始时重新读取配置，不把模型缓存为永久字段。

- [x] **步骤 4：重跑 IPC 和服务测试**

运行同步骤 2，预期全部 PASS。

### 任务 3：将三脚猫连接配置迁入设置页

- [x] **步骤 1：编写设置页失败测试**

在 `tests/unit/studio.test.tsx` 或新建 `tests/unit/sanmao-settings.test.tsx` 覆盖：

```tsx
fireEvent.click(screen.getByRole('tab', { name: '三脚猫' }));
fireEvent.change(screen.getByLabelText('三脚猫服务地址'), { target: { value: url } });
fireEvent.change(screen.getByLabelText('三脚猫 API 密钥'), { target: { value: key } });
fireEvent.click(screen.getByRole('button', { name: '获取模型' }));
expect(await screen.findByRole('option', { name: 'claude-a' })).toBeInTheDocument();
```

覆盖独立密钥、手动输入、获取失败、连接测试、保存状态和文字润色配置不受影响。

- [x] **步骤 2：运行测试确认设置入口不存在**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/sanmao-settings.test.tsx`

预期：FAIL，设置页没有三脚猫选项卡。

- [x] **步骤 3：实现 SanmaoSettings 与 AI 服务选项卡**

设置页增加 `role="tablist" aria-label="AI 服务"`，选项卡为“文字润色 / 三脚猫”。将地址、密钥、模型、获取模型和测试连接移入 `SanmaoSettings`，原聊天页不再维护这些字段。

模型控件同时支持列表选择和手动输入；模型 ID 使用同一个受控值。获取模型前不要求模型字段，获取失败保留旧模型并显示脱敏错误。

- [x] **步骤 4：重跑设置测试与类型检查**

运行：`npx vitest run tests/unit/studio.test.tsx tests/unit/sanmao-settings.test.tsx && npm run typecheck`

预期：全部 PASS。

### 任务 4：重做三脚猫顶栏与模型切换

- [x] **步骤 1：编写聊天页失败测试**

更新 `tests/unit/sanmao-form.test.tsx`：

```tsx
expect(screen.getByLabelText('当前模型')).toHaveValue('claude-a');
fireEvent.change(screen.getByLabelText('当前模型'), {
  target: { value: 'claude-b' },
});
await waitFor(() => expect(sanmao.saveProfile).toHaveBeenCalledWith(
  expect.objectContaining({ model: 'claude-b' }),
));
```

覆盖模型搜索、刷新、手动输入、回复中禁用、切换不清空对话、未配置时“前往设置”，以及切页后读取最新模型。原“连接设置”表单断言全部移除。

- [x] **步骤 2：运行测试确认新顶栏不存在**

运行：`npx vitest run tests/unit/sanmao-form.test.tsx tests/unit/studio.test.tsx`

预期：FAIL，找不到当前模型控件或前往设置按钮。

- [x] **步骤 3：实现专业顶栏和模型交互**

顶栏使用固定尺寸：助手名称/状态在左，`当前模型` 下拉框、刷新按钮和新建会话在右。移除连接设置按钮和原表单。

模型切换调用 `saveProfile({ baseUrl, model, apiKey: 空 })` 复用密钥；成功后更新本地 profile 并显示“已保存”。正在回复时禁用切换，模型变化不影响消息列表。

App 增加设置焦点状态，例如：

```ts
const [settingsService, setSettingsService] = useState<'polish' | 'sanmao'>('polish');
```

“前往设置”设置 `settingsService='sanmao'` 并切到设置页；三脚猫页在重新激活时重新读取 profile。

- [x] **步骤 4：运行 UI 测试和布局回归**

运行：`npx vitest run tests/unit/sanmao-form.test.tsx tests/unit/studio.test.tsx && npm run typecheck`

预期：全部 PASS，无重复标签、遮挡或布局跳动。

### 任务 5：完整回归、打包与验收边界

- [x] **步骤 1：运行完整验证**

```powershell
npm run typecheck
npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot
npm run build
npx playwright test tests/e2e/studio.spec.ts
```

记录实际通过数和跳过数，继续排除用户既有环境向导修改。

- [x] **步骤 2：构建并核对 Windows 包**

运行 `npm run pack` 或输出到独立目录。确认现有 SDK 与 `claude.exe` 解包仍然有效，设置和三脚猫页面进入包内，测试密钥和聊天记录不进入包。

- [x] **步骤 3：报告真实连接边界并检查工作树**

没有用户有效 Claude 授权时，不宣称真实模型获取或对话通过。运行 `git status --short` 和 `git diff --check`，不得包含环境向导、缓存、密钥或聊天记录。实现默认不提交、不推送，完成后由用户选择收尾方式。

#### 2026-11-14 发布前补充验收（0.5.0）

- SDK 隔离同时适用于模型发现、连接测试和对话请求，用户本机 Claude 配置不会被隐式复用。
- 类型检查通过；完整 Vitest 为 65 个文件、2821 通过、1 跳过、0 失败；Studio E2E 为 26/26，打包态 E2E 为 6/6。
- 包内 SDK、模型设置和三脚猫页面均通过检查，未使用真实 Claude 密钥做模型获取或对话验收。
