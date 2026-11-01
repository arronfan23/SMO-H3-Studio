# 已有 ComfyUI 环境导入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 SMO.H3 Studio 首次配置页增加严格校验、免下载的已有 ComfyUI 环境导入流程。

**架构：** 渲染进程只负责目录选择与状态展示，主进程通过两条新 IPC 通道完成目录选择和导入。`EnvironmentSetupService` 复用现有硬件选择、文件哈希、后端候选事务、互斥和取消机制，全部校验通过后才提交 ready 配置。

**技术栈：** Electron、React、TypeScript、Zod、YAML、Vitest、Playwright。

---

## 文件结构

- `src/shared/environment.ts`：新增 `EnvironmentImportInput`。
- `src/shared/ipc.ts`：注册导入 IPC、负载 schema 和 API 类型。
- `src/preload/index.ts`：桥接目录选择与导入调用。
- `src/main/ipc.ts`：扩展服务接口并转发导入请求。
- `src/main/app-services.ts`：实现原生目录选择器并暴露导入服务。
- `src/main/environment-manifest.ts`：拆分不检查下载空间的硬件与环境推荐函数。
- `src/main/environment-setup.ts`：解析模型路径、执行导入、报告校验进度并回滚失败提交。
- `src/renderer/useEnvironment.ts`：增加目录选择和导入控制器操作。
- `src/renderer/EnvironmentWizard.tsx`：增加“使用已有环境”按钮与通用准备提示。
- `tests/unit/ipc.test.ts`：IPC 负载和转发回归。
- `tests/unit/environment-manifest.test.ts`：无下载空间检查的推荐函数回归。
- `tests/unit/environment-setup.test.ts`：导入成功、失败、取消、互斥和回滚测试。
- `tests/unit/app-services-env.test.ts`：目录选择器测试。
- `tests/unit/environment-wizard.test.tsx`：导入按钮与控制器测试。
- `tests/e2e/environment.spec.ts`：隔离环境中的完整导入交互。
- `package.json`、`package-lock.json`：增加直接运行时依赖 `yaml`。

### 任务 1：共享 IPC 与目录选择

- [ ] **步骤 1：编写失败的 IPC 测试**

在 `tests/unit/ipc.test.ts` 增加两条通道的注册、严格负载和转发断言：

```ts
test('imports an existing environment with a strict payload', async () => {
  const input = { runtimeRoot: 'D:\\H3\\Runtime', profileId: 'conservative' as const };
  services.environment.importExisting.mockResolvedValue(environmentState);
  await handlers.get('environment:import')?.(input);
  expect(services.environment.importExisting).toHaveBeenCalledWith(input);
  await expect(handlers.get('environment:import')?.({ ...input, extra: true }))
    .rejects.toThrow();
});

test('returns a cancelled existing-root directory selection', async () => {
  services.environment.selectExistingRoot.mockResolvedValue(null);
  await expect(handlers.get('environment:selectExistingRoot')?.({})).resolves.toBeNull();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/ipc.test.ts`

预期：FAIL，`environment:import` 和 `environment:selectExistingRoot` 尚未注册。

- [ ] **步骤 3：实现共享类型、IPC、preload 与目录选择**

新增类型：

```ts
export interface EnvironmentImportInput {
  runtimeRoot: string;
  profileId: EnvironmentProfile;
}
```

注册 `environment:selectExistingRoot` 的空负载和 `environment:import` 的严格 schema：

```ts
const environmentImportSchema = z.object({
  runtimeRoot: nonEmptyString,
  profileId: z.enum(['conservative', 'balanced-16gb', 'high-memory-candidate']),
}).strict();
```

在 `app-services.ts` 复用注入的 `FileDialog`：

```ts
selectExistingRoot: async () => {
  const result = await fileDialog.showOpenDialog({
    title: '选择已有 ComfyUI 运行目录',
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
},
```

同时补充 `IpcServices`、dispatch、preload 和 `SmoApi` 类型。

- [ ] **步骤 4：运行测试和类型检查**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/app-services-env.test.ts && npm run typecheck`

预期：PASS，目录选择器断言 `openDirectory`，取消返回 `null`。

- [ ] **步骤 5：Commit**

```bash
git add src/shared/environment.ts src/shared/ipc.ts src/preload/index.ts src/main/ipc.ts src/main/app-services.ts tests/unit/ipc.test.ts tests/unit/app-services-env.test.ts
git commit -m "Add existing environment import IPC"
```

### 任务 2：硬件推荐与现有模型路径

- [ ] **步骤 1：编写失败测试**

在 `tests/unit/environment-manifest.test.ts` 验证新函数在低磁盘空间时仍返回推荐，但显存或内存不足仍拒绝：

```ts
const selection = selectEnvironmentRecommendation(
  { ...hardware, freeDiskGiB: 1 },
  manifest,
);
expect(selection.runtime.id).toBe('sm120');
expect(() => selectEnvironmentRecommendation(
  { ...hardware, ramGiB: 16 },
  manifest,
)).toThrow(/32 GiB RAM/);
```

在 `tests/unit/environment-setup.test.ts` 直接测试 `resolveExistingModelRoot`，分别覆盖 `extra_model_paths.yaml` 的外置模型根目录与缺省 `ComfyUI/models`：

```ts
await expect(resolveExistingModelRoot(runtimeRoot)).resolves.toBe(externalModelRoot);
```

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/environment-manifest.test.ts tests/unit/environment-setup.test.ts`

预期：FAIL，推荐函数和导入方法尚不存在。

- [ ] **步骤 3：实现推荐函数与 YAML 模型根解析**

运行：`npm install yaml@^2.8.2 --save`

将现有 `selectEnvironmentProfile` 拆为：

```ts
export function selectEnvironmentRecommendation(
  hardware: HardwareInfo,
  manifestInput: unknown,
): EnvironmentProfileSelection {
  // 保留现有 GPU、CUDA、VRAM、RAM 校验并返回推荐，不检查 freeDiskGiB。
}

export function selectEnvironmentProfile(
  hardware: HardwareInfo,
  manifestInput: unknown,
): EnvironmentProfileSelection {
  const selection = selectEnvironmentRecommendation(hardware, manifestInput);
  // 保留现有 requiredBytes 和 freeDiskGiB 校验。
  return selection;
}
```

在 `environment-setup.ts` 导出 `resolveExistingModelRoot` 并使用 `parseYaml`，仅接受记录中的 `h3_selflift_models.base_path`；缺文件或缺该节时返回 `win32.join(runtimeRoot, 'ComfyUI', 'models')`。所有返回路径经过现有 `validateInstallRoot`。

- [ ] **步骤 4：运行测试确认通过**

运行：`npx vitest run tests/unit/environment-manifest.test.ts tests/unit/environment-setup.test.ts`

预期：PASS，原安装空间校验测试保持通过。

- [ ] **步骤 5：Commit**

```bash
git add package.json package-lock.json src/main/environment-manifest.ts src/main/environment-setup.ts tests/unit/environment-manifest.test.ts tests/unit/environment-setup.test.ts
git commit -m "Resolve models for existing environments"
```

### 任务 3：导入事务与真实校验进度

- [ ] **步骤 1：编写成功导入的失败测试**

使用小型测试运行包和模型调用：

```ts
const state = await harness.service.importExisting({
  runtimeRoot: harness.runtimeRoot,
  profileId: 'high-memory-candidate',
});

expect(state).toMatchObject({
  stage: 'ready',
  active: false,
  healthy: true,
  config: {
    runtimeRoot: harness.runtimeRoot,
    modelDirectory: join(harness.installRoot, 'models', 'diffusion_models'),
    status: 'ready',
  },
});
expect(harness.downloads.parts).not.toHaveBeenCalled();
expect(harness.downloads.file).not.toHaveBeenCalled();
expect(harness.backend).toHaveBeenCalledTimes(1);
```

- [ ] **步骤 2：补充失败、取消与回滚测试**

覆盖：模型缺失、哈希错误、非法 `runtimeRoot`、低配置档位、取消读取、后端缺节点、与安装互斥，以及 `transaction.activate()` 失败后不残留未验证 ready 配置。进度测试断言当前文件和累计字节数单调增加。

- [ ] **步骤 3：运行测试确认失败**

运行：`npx vitest run tests/unit/environment-setup.test.ts`

预期：FAIL，`importExisting` 尚不存在。

- [ ] **步骤 4：实现导入事务**

实现公共入口并复用 `trackOperation` 互斥：

```ts
importExisting(input: EnvironmentImportInput): Promise<EnvironmentState> {
  if (this.detectFlight) {
    return Promise.reject(new Error('Cannot import while detection is active'));
  }
  const key = `import\0${installRootKey(input.runtimeRoot)}\0${input.profileId}`;
  return this.trackOperation(key, () => this.executeImport(input));
}
```

`executeImport` 依次执行：硬件检测、无磁盘空间要求的推荐、所选档位校验、运行文件校验、模型哈希进度、后端验证、ready 提交和事务激活。失败时回滚候选事务和 ready 提交，下载函数不参与。

为 `verifyFileHash` 与 `verifyModelFiles` 增加可选字节回调；原安装调用不传回调，行为不变。

- [ ] **步骤 5：运行测试确认通过**

运行：`npx vitest run tests/unit/environment-setup.test.ts tests/unit/app-services-env.test.ts && npm run typecheck`

预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add src/main/environment-setup.ts tests/unit/environment-setup.test.ts tests/unit/app-services-env.test.ts
git commit -m "Import verified existing ComfyUI environments"
```

### 任务 4：首次配置页导入交互

- [ ] **步骤 1：编写失败的渲染测试**

```ts
smo.environment.selectExistingRoot.mockResolvedValue('D:\\H3\\Runtime');
smo.environment.importExisting.mockResolvedValue(readyState(true));
await renderDetectedWizard();
fireEvent.click(screen.getByRole('button', { name: '使用已有环境' }));
await expectStudio();
expect(smo.environment.importExisting).toHaveBeenCalledWith({
  runtimeRoot: 'D:\\H3\\Runtime',
  profileId: 'balanced-16gb',
});
expect(smo.environment.start).not.toHaveBeenCalled();
```

另测目录选择返回 `null` 时不调用导入、不显示错误；导入拒绝时显示错误；忙碌时按钮禁用。

在 `tests/e2e/environment.spec.ts` 用模拟目录选择和导入 IPC 验证：点击导入后进入制作台，`environment:start` 与 `environment:retry` 均未调用。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/environment-wizard.test.tsx && npm run build && npx playwright test tests/e2e/environment.spec.ts`

预期：FAIL，按钮、控制器方法和 E2E 导入动作尚不存在。

- [ ] **步骤 3：实现控制器和按钮**

`useEnvironment` 新增 `importExisting` 操作。目录选择取消抛出名为 `AbortError` 的错误，由现有取消过滤逻辑处理。`EnvironmentWizard` 使用 `FolderOpen` 图标和“使用已有环境”文字，按钮复用 `canStart` 的硬件与忙碌条件。活动但尚无总量时的提示改为通用的“正在准备环境配置…”。

- [ ] **步骤 4：运行渲染测试**

运行：`npx vitest run tests/unit/environment-wizard.test.tsx && npm run typecheck && npm run build && npx playwright test tests/e2e/environment.spec.ts`

预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add src/renderer/useEnvironment.ts src/renderer/EnvironmentWizard.tsx tests/unit/environment-wizard.test.tsx tests/e2e/environment.spec.ts
git commit -m "Add existing environment import action"
```

### 任务 5：E2E、完整验证与发布

- [ ] **步骤 1：完整回归**

运行：`npm test && npm run typecheck && npm run test:e2e`

预期：全部通过；记录实际测试数量。

- [ ] **步骤 2：真实只读环境验收**

对 `G:\H3Selflift整合包\ComfyUI_SelfLift_Spark_SM120_CUDA130` 执行导入，确认 10 个模型哈希、运行文件和必需节点全部通过，`environment.json` 指向现有目录，下载目录未创建，不生成视频、不停止健康后端。

- [ ] **步骤 3：更新版本并 Commit**

运行：`npm version 0.3.3 --no-git-tag-version`

```bash
git add package.json package-lock.json
git commit -m "Release SMO.H3 Studio 0.3.3"
```

- [ ] **步骤 4：打包验证并发布 0.3.3**

运行：`npm run pack && npm run test:e2e:package`

若 Electron 下载网络不可用，使用已校验 SHA256 的本机 `electron-v45.0.0-win32-x64.zip` 通过 `--config.electronDist` 打包。上传 GitHub Release、核对远程 SHA256，并更新桌面快捷方式。
