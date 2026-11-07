# Spark 自动加速实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** RTX 40/50 的所有文字、音频和重试任务自动使用正确的 Spark 节点，RTX 30 保留兼容路径，并通过同负载实测验证真实提速。

**架构：** 新增纯函数模块负责硬件选择与 ComfyUI API 图转换；在生成提交边界统一调用，避免修改历史工作流副本。环境就绪校验根据同一硬件指纹要求对应 Spark 节点存在。

**技术栈：** TypeScript、Electron、ComfyUI API 图、Vitest、Playwright、Spark-H3 0.1.2。

**规格：** `docs/superpowers/specs/2026-11-07-spark-acceleration-design.md`

---

## 文件职责

- 创建 `src/main/spark-acceleration.ts`：选择 `none/spark-sm89/spark-sm120`，并将 Spark 接到最终采样模型链。
- 创建 `tests/unit/spark-acceleration.test.ts`：验证架构、连接、参数、不可变性和幂等性。
- 修改 `src/main/generation.ts`：在用户参数写入后应用 Spark，并记录作品加速元数据。
- 修改 `src/main/app-services.ts`：把已验证的环境配置传入生成器。
- 修改 `src/main/environment-setup.ts`：按环境硬件指纹扩展必需节点校验。
- 修改 `tests/unit/generation.test.ts`：覆盖实际提交图和元数据。
- 修改 `tests/unit/environment-setup.test.ts`：覆盖 Spark 节点缺失和 RTX 30 回退。

### 任务 1：Spark 纯图转换

**文件：** `src/main/spark-acceleration.ts`、`tests/unit/spark-acceleration.test.ts`

- [x] **步骤 1：编写失败的转换测试**

使用现有 `resources/workflows/text-ref2va.json` 和 `audio-digital-human.json` 作为真实输入，至少覆盖：

```ts
const accelerated = applySparkAcceleration(textGraph, 'spark-sm120');
expect(accelerated.smo_spark).toMatchObject({
  class_type: 'MiniMaxH3SparkAttentionSM120',
  inputs: {
    model: ['153', 0],
    enabled: true,
    steps: 8,
    warmup_ratio: 0.25,
    topk_ratio: 0.2,
    strict: true,
    tail_granularity: 'query',
    reblock_layout: 'q_reuse_k',
  },
});
expect(accelerated['269'].inputs.low_res_model).toEqual(['smo_spark', 0]);
expect(accelerated['124'].inputs.model).toEqual(['smo_spark', 0]);
expect(textGraph.smo_spark).toBeUndefined();
```

音频断言源模型为 `['62', 0]`、`steps` 为 6；参数化断言 `{sm120,12.0}`、`{sm89,8.9}` 分别选择对应加速，`{sm89,8.6}` 返回 `none`。对输出再次调用转换，`smo_spark` 数量仍为 1。

- [x] **步骤 2：运行测试并确认因模块不存在而失败**

运行：`npx vitest run tests/unit/spark-acceleration.test.ts`

预期：FAIL，无法导入 `spark-acceleration`。

- [x] **步骤 3：实现硬件选择与图转换**

建立以下公开契约：

```ts
export type SparkAcceleration = 'none' | 'spark-sm89' | 'spark-sm120';
export interface SparkAccelerationEnvironment {
  runtimeId?: 'sm89' | 'sm120';
  hardwareFingerprint?: { cudaComputeCapability: string };
}

export function selectSparkAcceleration(
  environment?: SparkAccelerationEnvironment,
): SparkAcceleration {
  const runtimeId = environment?.runtimeId;
  const cc = environment?.hardwareFingerprint?.cudaComputeCapability;
  if (runtimeId === 'sm120' && cc === '12.0') return 'spark-sm120';
  if (runtimeId === 'sm89' && cc === '8.9') return 'spark-sm89';
  return 'none';
}
```

`applySparkAcceleration` 先 `structuredClone`，`none` 直接返回副本。受支持图必须各有一个 `SelfLiftAvatarH3Sampler` 和 `BasicScheduler`；读取采样器的 `low_res_model` 与调度器的整数 `steps`，新建：

```ts
copy.smo_spark = {
  class_type: acceleration === 'spark-sm120'
    ? 'MiniMaxH3SparkAttentionSM120'
    : 'MiniMaxH3SparkAttentionSM89',
  inputs: {
    model: originalModelLink,
    enabled: true,
    steps,
    warmup_mode: 'warmup_ratio',
    warmup_ratio: 0.25,
    warmup_steps: 1,
    topk_mode: 'topk_ratio',
    topk_ratio: 0.2,
    topk_blocks: 228,
    dense_layers: 0,
    min_tokens: 12288,
    strict: true,
    tail_granularity: 'query',
    reblock_layout: 'q_reuse_k',
  },
};
sampler.inputs.low_res_model = ['smo_spark', 0];
scheduler.inputs.model = ['smo_spark', 0];
```

已有 `smo_spark` 时直接返回结构化克隆，不重复连接。缺失节点、模型链接或非正整数步数时抛出明确错误。

- [x] **步骤 4：运行转换测试**

运行：`npx vitest run tests/unit/spark-acceleration.test.ts`

预期：全部 PASS。

- [x] **步骤 5：提交独立转换模块**

```bash
git add src/main/spark-acceleration.ts tests/unit/spark-acceleration.test.ts
git commit -m "Add Spark workflow acceleration transform"
```

### 任务 2：生成、重试与作品诊断

**文件：** `src/main/generation.ts`、`src/main/app-services.ts`、`tests/unit/generation.test.ts`

- [x] **步骤 1：编写失败的生成集成测试**

在生成 harness 中传入：

```ts
acceleration: {
  runtimeId: 'sm120',
  hardwareFingerprint: { cudaComputeCapability: '12.0' },
},
```

运行文字和音频生成后，对 `comfy.submissions` 中真实提交图断言 `smo_spark` 存在且采样器连接正确；读取 `store.works` 断言 `metadata.acceleration === 'spark-sm120'`。另以 RTX 30 的 `{sm89,8.6}` 运行一次，断言提交图没有 `smo_spark` 且元数据为 `none`。

- [x] **步骤 2：运行集成测试并确认缺少加速**

运行：`npx vitest run tests/unit/generation.test.ts -t "Spark"`

预期：FAIL，提交图没有 `smo_spark`。

- [x] **步骤 3：接入统一生成边界**

在 `GenerationHandlerOptions` 添加 `acceleration?: SparkAccelerationEnvironment`，在请求入队时计算一次：

```ts
const acceleration = selectSparkAcceleration(options.acceleration);
const baseMetadata: WorkMetadata = {
  request,
  workflowVersion,
  acceleration,
  ...(originalRetryOf ? { retryOf: originalRetryOf } : {}),
};
```

将提交前逻辑改为：

```ts
const patched = patchWorkflow(frozen, changes);
const workflow = applySparkAcceleration(patched, acceleration);
const submitted = await comfy.submit(workflow);
```

在 `app-services.ts` 创建生成器时传入 `acceleration: environmentConfig ?? undefined`，使所有重试也使用同一环境指纹。

- [x] **步骤 4：运行生成测试**

运行：`npx vitest run tests/unit/generation.test.ts`

预期：全部 PASS。

- [x] **步骤 5：提交生成集成**

```bash
git add src/main/generation.ts src/main/app-services.ts tests/unit/generation.test.ts
git commit -m "Enable Spark for supported generation hardware"
```

### 任务 3：环境就绪校验

**文件：** `src/main/environment-setup.ts`、`tests/unit/environment-setup.test.ts`

- [ ] **步骤 1：编写失败的校验测试**

在 SM120 安装 harness 的后端 `objectInfo` 中删除 `MiniMaxH3SparkAttentionSM120`，断言安装失败且错误包含该节点；以 SM89、CUDA CC 8.6 的硬件运行一次，断言没有 Spark 节点仍可完成基础校验。

- [ ] **步骤 2：运行校验测试并确认旧逻辑漏检**

运行：`npx vitest run tests/unit/environment-setup.test.ts -t "Spark"`

预期：SM120 缺失 Spark 的用例错误地通过安装，因此测试 FAIL。

- [ ] **步骤 3：按配置计算必需节点**

新增内部辅助函数并替换三个 `REQUIRED_COMFY_NODES.filter` 调用点：

```ts
function requiredNodesFor(config: EnvironmentConfig): string[] {
  const acceleration = selectSparkAcceleration(config);
  const sparkNode = acceleration === 'spark-sm120'
    ? 'MiniMaxH3SparkAttentionSM120'
    : acceleration === 'spark-sm89'
      ? 'MiniMaxH3SparkAttentionSM89'
      : undefined;
  return [...REQUIRED_COMFY_NODES, ...(sparkNode ? [sparkNode] : [])];
}
```

安装、已有环境导入及重新验证均使用当前 `EnvironmentConfig`。测试中的正常 SM120 后端夹具加入 `MiniMaxH3SparkAttentionSM120`，与真实运行包一致。

- [ ] **步骤 4：运行环境测试**

运行：`npx vitest run tests/unit/environment-setup.test.ts tests/unit/app-services-env.test.ts`

预期：全部 PASS。

- [ ] **步骤 5：提交校验改动**

```bash
git add src/main/environment-setup.ts tests/unit/environment-setup.test.ts
git commit -m "Validate Spark runtime nodes for supported GPUs"
```

### 任务 4：真实验收与发布

**文件：** `package.json`、`package-lock.json`、真实验收记录；不修改模型或运行包清单。

- [ ] **步骤 1：运行完整自动验证**

运行：

```bash
npm run typecheck
npm test
npx playwright test --grep-invert "imports an existing environment"
```

预期：本次相关测试全部 PASS；主线程已有的 5 个“使用已有环境”未完成测试不纳入本次提交，其他失败必须修复。

- [ ] **步骤 2：执行同负载真实文字基准**

运行 `npm run dev`，使用合成模特、10 秒、1.2MP、8 步和固定测试提示词完成一次文字生成。对比本机已有约 4.9 分钟基准，记录总耗时；通过 `/history` 确认 `smo_spark` 和 `MiniMaxH3SparkAttentionSM120` 已提交，并确认日志存在实际 Spark 执行记录。输出必须可播放且画面非空白。

- [ ] **步骤 3：执行真实音频路径验收**

使用合成音频和同一合成模特运行 10 秒、1.2MP、6 步音频数字人。确认输出可播放、音画时长正确、历史包含 Spark，记录实际耗时。若 Spark 报错、未执行或两条路径未体现提速，停止发布并回到对应实现任务。

- [ ] **步骤 4：构建并验证便携包**

将版本升为下一补丁版本后运行：

```bash
npm run pack -- --config.electronDist=node_modules/electron/dist
npm run test:e2e:package
```

预期：构建退出码 0，6 项打包态测试 PASS。

- [ ] **步骤 5：提交并发布**

只暂存本计划涉及的文件，保留主线程未完成的 `tests/e2e/environment.spec.ts` 和 `tests/unit/environment-wizard.test.tsx` 改动。推送 `codex/runtime-in-app-repo`，用 `gh release create` 上传新便携包，再核对 Release 资产的 SHA256 与本地文件一致。

