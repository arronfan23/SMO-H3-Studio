# SMO.H3 Studio Spark 自动加速设计

日期：2026-11-07

## 已确认事实

- 当前软件的文字和音频工作流使用 `comfy kitchen attention`，没有 Spark 或 Veda 节点。
- 本机 RTX 5080 最近 20 次 ComfyUI 历史也均未使用 Spark 或 Veda。
- 可作为对比基准的本机文字任务为 10 秒、1.2MP、8 步，成功耗时约 4.9 分钟。
- 当前 SelfLift Spark 运行包已包含 Spark-H3 0.1.2、对应 `comfy-kitchen` 后端及所需节点，无需新增模型或运行时下载。
- Spark-H3 正式支持 SM89（RTX 40 系）和 SM120（RTX 50 系）。RTX 30 系的 CUDA CC 8.6 不属于 Spark 支持范围。
- Veda 与 Spark 不在本次叠加，避免两个稀疏注意力实现互相覆盖。

## 目标与边界

- RTX 40/50 的所有软件生成任务默认使用与硬件匹配的 Spark 节点，无需用户配置。
- RTX 30 保留现有兼容工作流，不显示或伪装成 Spark 加速。
- 覆盖默认工作流、硬件档位生成的工作流及重试任务，无需迁移旧的作品或工作流副本。
- 保留现有模型、LoRA、步数、分辨率、低显存和分块策略。
- 加速失败必须明确报错，不能静默退回普通注意力后继续生成。
- 不承诺不同显卡拥有相同绝对耗时；发布前必须报告同机、同负载的真实对比结果。

## 实现结构

新增 `src/main/spark-acceleration.ts`，提供纯函数式工作流转换，输入为 ComfyUI API 图和当前环境的运行时及 CUDA CC，输出为结构化克隆，不修改原对象。

转换函数按以下规则选择节点：

- `sm120` + CUDA CC `12.0`：`MiniMaxH3SparkAttentionSM120`。
- `sm89` + CUDA CC `8.9`：`MiniMaxH3SparkAttentionSM89`。
- `sm89` + CUDA CC `8.6`：不添加 Spark。
- 其他或缺少硬件指纹：不添加 Spark。

在 `generation.ts` 提交任务前、用户输入已经写入工作流之后调用转换函数。这样默认工作流、硬件配置副本及重试都经过同一入口，旧工作流文件保持不可变。

Spark 节点接收 `SelfLiftAvatarH3Sampler.low_res_model` 原先连接的模型输出，然后将 Spark 输出同时连接到：

- `SelfLiftAvatarH3Sampler.low_res_model`。
- `BasicScheduler.model`。

该位置位于现有 ModelAttentionBackend、LoRA、MiniMaxLowVRAMAttention 和 ModelPreviewOverrideKJ 之后，确保 Spark 是采样器最终收到的模型补丁，不被前面的省显存节点覆盖。

节点使用固定 ID `smo_spark`。重复转换不得重复添加节点或改变已有连接。

## Spark 参数

- `enabled: true`
- `steps`：读取当前 `BasicScheduler.inputs.steps`，保持文字 8 步、音频 6 步。
- `warmup_mode: "warmup_ratio"`
- `warmup_ratio: 0.25`
- `warmup_steps: 1`（比例模式下不参与计算）
- `topk_mode: "topk_ratio"`
- `topk_ratio: 0.2`
- `topk_blocks: 228`（比例模式下不参与计算）
- `dense_layers: 0`
- `min_tokens: 12288`
- `strict: true`
- `tail_granularity: "query"`
- `reblock_layout: "q_reuse_k"`

这些参数来自 Spark 官方 DMAD 示例；本软件不改变现有采样器和 LoRA。

## 环境校验与诊断

环境启动校验按当前硬件指纹要求对应 Spark 节点存在：RTX 40 要求 SM89 节点，RTX 50 要求 SM120 节点；RTX 30 不增加该要求。

作品元数据记录 `acceleration: "spark-sm89" | "spark-sm120" | "none"`，便于后续确认实际提交配置。界面不增加新的技术参数或设置项。

## 测试与验收

1. 单元测试覆盖架构选择、最终模型链、调度器连接、参数、原图不变和重复转换。
2. 生成测试验证文字、音频及 RTX 30 回退的实际提交图。
3. 环境测试验证所需 Spark 节点缺失时不会错误标记为就绪。
4. 运行现有单元、类型检查、Electron 和打包态测试。
5. 使用合成测试素材，在本机 RTX 5080 上运行 10 秒、1.2MP、8 步文字任务；与已有约 4.9 分钟基准比较，记录总耗时和采样耗时。
6. 使用同一负载验证音频数字人路径，确认 6 步任务同样实际执行 Spark。
7. 检查输出可播放、非空白且画面结构正常，并确认 ComfyUI 历史包含 Spark 节点及日志出现实际 Spark 执行记录。
8. 若真实任务报错、Spark 未实际执行或速度没有改善，不发布该实现。

