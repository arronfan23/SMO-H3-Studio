# SMO.H3 首次启动环境配置向导实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让新下载的 SMO.H3 Studio 在首次启动时自动检测硬件，选择兼容运行包和模型，下载并验证环境，最后启动 ComfyUI，而不要求用户手动配置路径。

**架构：** 以版本化 `environment.json` 和运行清单驱动安装。`EnvironmentManifest` 负责 SM89/SM120 与发布方模型元数据，`EnvironmentStore` 负责路径和状态，`DownloadService` 负责 Range 恢复、哈希和原子文件操作，`EnvironmentSetupService` 负责安装与健康检查，`EnvironmentWizard` 负责首次启动 UI。运行包和模型分开下载，不制作完整 199 GiB 离线包。

**技术栈：** Electron、React、TypeScript、Zod、Node:sqlite、Node:fs/fetch/crypto、Vitest、Playwright、electron-builder、GitHub Releases、Hugging Face 元数据 API。

---

## 文件结构与职责

- `src/shared/environment.ts`：环境配置、运行包、模型、硬件档案、安装阶段和 IPC 类型。
- `src/main/environment-manifest.ts`：清单读取、Zod 校验、架构选择、磁盘估算。
- `src/main/environment-store.ts`：`environment.json` 的读取、校验、原子写入、状态迁移和路径解析。
- `src/main/download.ts`：HTTPS、Range、`.part`、哈希、原子重命名、分块合并和中断恢复。
- `src/main/environment-setup.ts`：检测、清单、安装、校验、启动和错误恢复。
- `src/main/app-services.ts`、`src/main/ipc.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`：注册 `environment` 域和持久化路径。
- `src/renderer/EnvironmentWizard.tsx`、`useEnvironment.ts`、`App.tsx`：首次启动向导与正常应用分流。
- `scripts/build-environment-manifest.mjs`：从发布方元数据和运行包分块生成清单。
- `scripts/package-runtime.ps1`：按 1.9 GB 分块、计算哈希并输出运行包与发布元数据。
- `resources/environment/selflift-spark.json`：SM89/SM120 运行包和 10 个实际模型文件的发布方清单。
- `tests/unit/environment-*.test.ts`、`tests/e2e/environment.spec.ts`：硬件、下载、安装、首次启动与打包验证。

## 任务 1：硬件门禁与运行清单

**文件：** 创建 `src/shared/environment.ts`、`src/main/environment-manifest.ts`、`resources/environment/selflift-spark.json`、`tests/unit/environment-manifest.test.ts`

- [ ] **步骤 1：编写清单与硬件门禁失败测试**

```ts
expect(selectEnvironmentProfile(minimum30Hardware, manifest).runtime.id).toBe('sm89');
expect(selectEnvironmentProfile(minimum40Hardware, manifest).runtime.id).toBe('sm89');
expect(selectEnvironmentProfile(minimum50Hardware, manifest).runtime.id).toBe('sm120');
expect(() => selectEnvironmentProfile(vram4Hardware, manifest).runtime).toThrow(/8 GiB/);
expect(() => selectEnvironmentProfile(ram16Hardware, manifest).runtime).toThrow(/32 GiB/);
expect(() => selectEnvironmentProfile(otherGpuHardware, manifest).runtime).toThrow(/unsupported|架构/);
```

再验证：有效清单拒绝空 URL、非 HTTPS、短 SHA256、重复模型路径、目录穿越和未知字段；`requiredBytes` 同时包含运行包解压估算、模型下载和至少 5 GiB 校验临时空间。

- [ ] **步骤 2：运行测试确认失败**

运行：`npx vitest run tests/unit/environment-manifest.test.ts`

预期：模块和清单不存在，硬件选择尚未实现。

- [ ] **步骤 3：实现类型、清单校验和架构选择**

`src/shared/environment.ts` 定义：

```ts
export interface EnvironmentRuntime {
  id: 'sm89' | 'sm120';
  displayName: string;
  archiveParts: Array<{ url: string; path: string; size: number; sha256: string }>;
  archiveSize: number;
  archiveSha256: string;
  estimatedExtractedBytes: number;
  pythonPath: string;
  launchScript: string;
}

export interface EnvironmentProfileSelection {
  runtime: EnvironmentRuntime;
  profile: 'conservative' | 'balanced-16gb' | 'high-memory-candidate';
  modelFiles: Array<{ url: string; path: string; size: number; sha256: string; source: string }>;
  requiredBytes: number;
}
```

`selectEnvironmentProfile` 按 `cudaComputeCapability >= 12 ? 'sm120' : 'sm89'` 选择运行包，强制 `vramGiB >= 8`、`ramGiB >= 32` 和 `freeDiskGiB * GiB >= requiredBytes`。`high-memory-candidate` 仅在 `vramGiB >= 20` 时可选，其他按现有 `recommendHardware` 复用参数。

`resources/environment/selflift-spark.json` 记录两个运行包和 10 个实际模型文件的 `url/path/size/sha256/source`，不把第三方发布方标为官方。

- [ ] **步骤 4：运行清单测试并提交**

运行：`npx vitest run tests/unit/environment-manifest.test.ts`

提交：`git add src/shared/environment.ts src/main/environment-manifest.ts resources/environment/selflift-spark.json tests/unit/environment-manifest.test.ts && git commit -m "Add hardware aware environment manifest"`

## 任务 2：持久化环境配置与路径解析

**文件：** 创建 `src/main/environment-store.ts`、`tests/unit/environment-store.test.ts`，修改 `src/shared/environment.ts`

- [ ] **步骤 1：编写配置读写失败测试**

覆盖：缺失配置返回 null、合法配置 roundtrip、无效 schema 版本、绝对路径逃逸、损坏 JSON、原子临时文件清理、旧默认路径回退和 `ready` 状态不可伪造。

```ts
const config = await store.load();
expect(config).toBeNull();
await store.save(validConfig);
await expect(store.load()).resolves.toEqual(validConfig);
await expect(store.markReady()).resolves.toMatchObject({ status: 'ready' });
```

- [ ] **步骤 2：实现 `EnvironmentStore`**

`EnvironmentConfig` 至少包含：

```ts
{
  schemaVersion: 1,
  runtimeId: 'sm89' | 'sm120',
  runtimeRoot: string,
  modelDirectory: string,
  outputDirectory: string,
  profile: 'conservative' | 'balanced-16gb' | 'high-memory-candidate',
  hardwareFingerprint: { gpu: string; vramGiB: number; ramGiB: number; cudaComputeCapability: number },
  manifestVersion: string,
  status: 'installing' | 'ready' | 'failed',
  createdAt: string,
  updatedAt: string,
}
```

`load()` 做 Zod 校验；`save()` 使用临时文件 + rename；`markReady()` 只能由安装服务在健康检查通过后调用。新增 `resolveEnvironmentPaths(config, fallback)`，配置缺失时保留当前用户已有路径，配置存在时优先使用配置路径。

- [ ] **步骤 3：运行配置测试并提交**

运行：`npx vitest run tests/unit/environment-store.test.ts`

提交：`git add src/main/environment-store.ts src/shared/environment.ts tests/unit/environment-store.test.ts && git commit -m "Persist environment configuration"`

## 任务 3：可恢复下载与原子文件操作

**文件：** 创建 `src/main/download.ts`、`tests/unit/download.test.ts`

- [ ] **步骤 1：编写本地 HTTP 下载失败测试**

使用本地 HTTP server 覆盖：完整 200、已有部分文件 206 续传、服务器不支持 Range 时从头下载、重定向、哈希不匹配、大小不匹配、取消、目录穿越和分块合并顺序错误。

```ts
const receipt = await downloadFile({
  url: server.url('/model.safetensors',
  destination: join(tempDir, 'models', 'model.safetensors'),
  expectedSize: 12,
  expectedSha256: expectedHash,
});
expect(receipt.resumed).toBe(true);
expect(receipt.bytes).toBe(12);
expect(receipt.sha256).toBe(expectedHash);
```

- [ ] **步骤 2：实现 `downloadFile` 与 `downloadParts`**

要求：
- 只允许 HTTPS；已有 `.part` 且大于 0 时发送 `Range: bytes=<current>-`。
- 206 才追加；200 必须从头写，不能追加成损坏文件。
- 流式写入、计算 SHA256、校验大小和哈希后原子重命名；失败保留 `.part` 供下次恢复。
- `downloadParts` 按 `part1/part2/...` 顺序合并，合并后再次验证完整包 SHA256。
- 不在日志中写入 URL 密钥、完整提示词或用户素材。

- [ ] **步骤 3：运行下载测试并提交**

运行：`npx vitest run tests/unit/download.test.ts`

提交：`git add src/main/download.ts tests/unit/download.test.ts && git commit -m "Add resumable verified downloads"`

## 任务 4：安装、校验和 ComfyUI 启动

**文件：** 创建 `src/main/environment-setup.ts`、`tests/unit/environment-setup.test.ts`，修改 `src/main/app-services.ts`、`src/main/ipc.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`

- [ ] **步骤 1：编写安装流程失败测试**

模拟硬件、清单、下载和 ComfyUI 健康检查，覆盖：完整安装、已有有效安装跳过、磁盘不足、下载失败重试、模型缺失、健康检查失败不得写 ready、安装目录穿越、取消和重启后状态恢复。

- [ ] **步骤 2：实现 `EnvironmentSetupService`**

服务阶段固定为：`detect -> select -> download-runtime -> extract -> download-models -> verify -> start -> ready`。

`start()` 必须：
1. 调用现有 `detectHardware` 和 `selectEnvironmentProfile`。
2. 下载分块并合并/校验运行包，解压到 staging 目录。
3. 校验 Python、launch.py、ffprobe 和模型文件，使用上游 `docs/file-manifest.sha256`。
4. 使用 `EnvironmentStore` 写入路径和状态。
5. 使用新的 runtimeRoot/modelDirectory/outputDirectory 创建/复用 `ComfyProcessManager`，确认 `system_stats` 和 5 个 H3 节点。
6. 只有健康检查通过才写 `ready`，随后启动 ComfyUI。

失败时保留可恢复状态和已有有效配置；`retry()` 从失败阶段继续，不重复下载已验证文件。`cancel()` 中止下载且不把状态写成 ready。

- [ ] **步骤 3：接入 environment IPC**

新增 `environment:getState`、`environment:detect`、`environment:start`、`environment:retry`、`environment:cancel`。返回硬件、配置、当前阶段、进度和错误，严格校验 start/retry 的 `{profileId, installRoot}` payload。不得让用户通过 IPC 任意指定外部目录或模型 URL。

- [ ] **步骤 4：运行安装与 IPC 测试并提交**

运行：`npx vitest run tests/unit/environment-setup.test.ts tests/unit/ipc.test.ts`

提交：`git add src/main/environment-setup.ts src/main/app-services.ts src/main/ipc.ts src/shared/ipc.ts src/preload/index.ts tests/unit/environment-setup.test.ts tests/unit/ipc.test.ts && git commit -m "Install and validate H3 environment"`

## 任务 5：首次启动环境向导

**文件：** 创建 `src/renderer/EnvironmentWizard.tsx`、`src/renderer/useEnvironment.ts`、`tests/unit/environment-wizard.test.tsx`、`tests/e2e/environment.spec.ts`，修改 `src/renderer/App.tsx`、`src/renderer/styles.css`、`tests/e2e/startup.spec.ts`

- [ ] **步骤 1：编写首次启动 UI 失败测试**

覆盖：无配置时显示向导、硬件摘要、SM89/SM120 选择说明、安装目录输入、开始/重试/取消、分阶段进度、失败原因、完成后进入制作台、重启后不再显示向导。

- [ ] **步骤 2：实现向导与状态 Hook**

`useEnvironment` 只通过 `window.smo.environment` 读取状态，不直接访问 Node。`EnvironmentWizard` 使用实际 setup 工作流，包含：
- 硬件信息和最低配置说明；
- 默认档案选择（低显存不可选 high-memory-candidate）；
- 可写安装目录选择；
- 分阶段进度、当前下载文件、已下载/总字节；
- 开始、重试、取消和完成后的自动进入制作台。

`App.tsx` 仅在 `status === 'ready'` 且健康检查通过时显示原应用；否则显示向导，不显示营销首页。

- [ ] **步骤 3：运行 UI 与 E2E 测试并提交**

运行：`npx vitest run tests/unit/environment-wizard.test.tsx tests/unit/studio.test.tsx`

运行：`npm run test:e2e -- --grep "environment|startup"`

提交：`git add src/renderer/EnvironmentWizard.tsx src/renderer/useEnvironment.ts src/renderer/App.tsx src/renderer/styles.css tests/unit/environment-wizard.test.tsx tests/e2e/environment.spec.ts tests/e2e/startup.spec.ts && git commit -m "Add first launch environment wizard"`

## 任务 6：运行包分块、GitHub Release 与最终验收

**文件：** 创建 `scripts/package-runtime.ps1`、`scripts/build-environment-manifest.mjs`、`SMO-H3-Runtime/README.md`、`SMO-H3-Runtime/manifests/selflift-spark.json`（通过新仓库提交）

- [ ] **步骤 1：实现分块与清单生成脚本**

`package-runtime.ps1` 读取本地两份 NoModels zip，按 1,900,000,000 字节切块，计算每块 SHA256、总大小和完整包 SHA256，并输出 `runtime-packs/sm89` 与 `runtime-packs/sm120` 目录。不得改变 zip 内容、模型文件或上游许可证。

`build-environment-manifest.mjs` 读取分块元数据和发布方 API，生成与 `EnvironmentManifest` 同构的 `selflift-spark.json`，包含 10 个模型文件和运行包分块。

- [ ] **步骤 2：创建公开仓库并上传**

创建 `arronfan23/SMO-H3-Runtime`（public），提交 README、清单、LICENSE/NOTICE 和分块运行包。创建 `runtime-v1` Release 并上传全部分块与清单，核对资产大小和 SHA256；不得把模型文件上传到该仓库。

- [ ] **步骤 3：完整自动验证**

```bash
npm test
npm run typecheck
npm run test:e2e
npm run test:e2e:package
```

再运行真实 `SMO_REAL_H3=1 npm run test:e2e:real` 和打包版 `SMO_REAL_LLM=1 npm run test:e2e:real`。运行 `git diff --check`，完成规格与代码质量审查，修复全部 Critical/Important。

- [ ] **步骤 4：构建 0.2.0 并交付**

执行 `npm version 0.2.0 --no-git-tag-version`、`npm run assets`、`npm run pack`，复制 portable 到正式 release、核对 SHA256、更新桌面快捷方式和 PR #1。保留 worktree。

- [ ] **步骤 5：朋友电脑验收清单**

记录 GPU/显存/内存/CUDA、实际下载目录、各阶段耗时、失败恢复、H3 节点健康和一次小规模生成结果。30 系只有完成实测后才能把候选改为已验证；若不达标，保留清晰错误和硬件建议，不伪造成功。

## 计划自检

- 任务 1 覆盖 SM89/SM120、8GB/32GB、磁盘与清单；任务 2 覆盖持久化路径；任务 3 覆盖断点续传与校验；任务 4 覆盖安装和健康检查；任务 5 覆盖首次启动体验；任务 6 覆盖分发和真实验收。
- 模型只从发布方下载，不上传到新仓库；运行包只来自现有 NoModels zip，不包含用户素材或 API Key。
- 不改变已有 H3 工作流、模型或启动脚本，不把 8GB 写成已验证，不实现登录/会员。
