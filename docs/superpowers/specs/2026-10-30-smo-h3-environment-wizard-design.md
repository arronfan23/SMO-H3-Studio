# SMO.H3 首次启动环境配置向导设计规格

日期：2026-10-30

## 背景与目标

用户希望下载软件后，首次打开即自动检测电脑硬件，选择兼容模型和运行环境，并完成 ComfyUI 配置。当前 SMO.H3 Studio 已具备硬件检测和 `conservative`、`balanced-16gb`、`high-memory-candidate` 参数策略，但缺少首次启动安装、路径初始化、下载恢复和环境验证。

已确认的分发方式：

- 新建公开 GitHub 仓库 `arronfan23/SMO-H3-Runtime`，存放运行环境清单、文档、安装脚本和验证后的运行包。
- 模型文件不重新上传到该仓库或用户服务器，按各自发布方页面直接下载。
- MiniMax/Comfy-Org 官方文件与 SelfLift 专用第三方文件分开标注，不把第三方模型冒充成 MiniMax 官方模型。
- 运行包不包含用户素材、API Key、生成历史、缓存或模型文件；保留上游 LICENSE/NOTICE。

## 当前事实与约束

- 当前 SelfLift Spark 运行环境约 24.23 GiB，模型目录约 175.04 GiB，不应整包发布。
- 现有工作流只引用 11 个模型/LoRA 文件，可按清单下载，避免无关 BF16、GGUF 和备用模型。
- 当前 Spark 包只适配 SM120（RTX 50 系）。README 明确 30 系不支持当前两份 Spark 包，其他架构需要单独验证的构建，不能自动套用。
- 当前 `recommendHardware` 已提供低显存 `conservative`（INT8、0.4MP、lowvram、tiling=4）、`balanced-16gb` 和 `high-memory-candidate`，应复用而非重写。
- 默认模型目录、ComfyUI 根目录和输出目录目前硬编码为 G 盘路径，必须改为安装后持久化配置。
- 已验证本机环境仅为 RTX 5080、INT8、16GB。8GB 配置只能先标为兼容候选，实际速度与稳定性由用户朋友电脑测试确认。

## 范围

### 包含

- 首次启动硬件检测、架构与最低配置门禁、安装目录选择、环境清单选择。
- 运行包下载、官方/发布方模型下载、断点续传、SHA256 校验、原子安装、失败恢复。
- 安装后 `environment.json`、路径验证、H3 节点健康检查和自动启动。
- 单元测试、下载 mock、首次启动 E2E、打包态验证，以及后续真实 8GB 硬件验收。

### 不包含

- 不实现登录、注册、会员或服务器账号系统。
- 不上传模型文件到新建仓库，不制作近 200 GiB 的完整离线包。
- 不为不支持的 GPU 架构静默安装或切换模型，不承诺 8GB 与 16GB 有相同表现。
- 不修改 `G:\H3Selflift整合包` 中的模型、冻结工作流或启动脚本。

## 1. 硬件检测与最低配置

- 使用现有 `nvidia-smi` 获取 GPU 名称、显存、驱动和 CUDA Compute Capability；读取 RAM、Windows 版本和安装盘剩余空间。
- 最低安装门槛：
  - NVIDIA GPU 且 Compute Capability 属于已有验证运行包的架构；当前仅为 `sm120`。
  - 显存不少于 8 GiB。
  - 物理内存不少于 32 GiB。
  - 磁盘剩余空间不少于“当前运行包、所选模型、临时下载和校验所需空间”的计算值，不固定写死一个数字。
- 非 N 卡、低于显存/内存门槛、架构不支持或磁盘不足时显示具体原因并停止安装，不开始大文件下载。
- 将硬件型号、显存、内存、CUDA、安装目录和预计所需空间展示给用户，避免黑盒选择。

## 2. 配置档案选择

- `conservative`：用于最低兼容候选，INT8、0.4MP、lowvram、tiling=4；不宣称 8GB 已验证。
- `balanced-16gb`：用于 12–19 GiB 显存，INT8、0.7MP、lowvram、自动 tiling。
- `high-memory-candidate`：用于 20 GiB 及以上显存，BF16-if-present、1.0MP、自动 tiling，仍标为未实测，默认不选。
- 当前运行包架构与档案分离：档案只控制模型和工作流参数，不能绕过 SM120 启动兼容性。

## 3. 首次启动向导与持久化

- 首次启动检查 `environment.json`。只有存在且版本、路径、哈希和 H3 节点健康检查都有效时才跳过向导。
- 向导依次显示：硬件检测、配置选择、安装目录、下载进度、安装验证、准备完成。错误必须显示具体阶段和可重试操作。
- 默认安装到应用数据目录下的 `runtime`、`models`、`output` 子目录；允许用户选择其他可写目录。
- `environment.json` 至少保存：schema 版本、runtimeId、runtimeRoot、modelDirectory、outputDirectory、profile、hardwareFingerprint、manifestVersion、status、createdAt、updatedAt。
- 应用启动时优先读取该文件，再兼容 `SMO_DATA_DIRECTORY`、`SMO_OUTPUT_DIRECTORY`、`SMO_COMFYUI_ROOT` 环境变量和旧默认路径。不得再要求用户手动编辑 G 盘路径。

## 4. 运行包与模型清单

### 运行包

- 新建公开仓库 `SMO-H3-Runtime`，保存 `README.md`、运行清单、安装脚本、LICENSE/NOTICE 和经过验证的 SelfLift Spark 运行包。
- 运行包按 GitHub Release 分块提供，每块不超过 2 GB。清单记录每块 URL、大小、SHA256、合并后的总大小和完整包 SHA256。
- 下载完成后按顺序合并、校验、解压，并使用上游 `docs/file-manifest.sha256` 做关键文件验证。
- 运行包排除模型、输入/输出素材、历史、缓存、临时文件和 API Key；包含上游许可证、启动器、Python、ComfyUI、节点和 ffprobe。

### 模型文件

- 清单只包含当前文字/音频工作流实际引用的 10 个文件，并按发布方链接下载：
  - `minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors`
  - `qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors`
  - `minimax_h3_video_vae_int8_convrot.safetensors`
  - `minimax_h3_audio_vae_fp32.safetensors`
  - `dmad_minimax_h3_4step_full_critic_comfy.safetensors`
  - `H3_speed_slider_1.1.safetensors`
  - `h3_upscaler_lms_v0.1_fp32.safetensors`
  - `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors`
  - `taeh3.safetensors`
  - `minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors`
- 发布方包括 Comfy-Org/MiniMax、speedyrulz/mini、p3cyc/minimax、DarkRomeo88、Alissonerdx、LBH-123-AI、Veda-Sparse 和 RunningHubAI；清单必须记录来源类型，不把第三方发布方标成 MiniMax 官方。
- 每项记录 `url`、`path`、`size`、`sha256` 和 `source`，并验证发布方元数据。禁止把未知镜像或搜索到的同名文件直接当作官方源。

## 5. 下载与安装可靠性

- 仅允许 HTTPS，支持 Range 断点续传、`.part` 临时文件、大小与 SHA256 校验、原子重命名和失败清理。
- 安装按阶段执行：下载运行包 → 合并/解压 → 下载模型 → 校验文件 → 写入配置 → 健康检查。失败时保留已验证部分供下次恢复，不删除用户已有目录。
- 安装前计算所需空间；磁盘不足时提前停止，避免下到一半才发现无法解压。
- 清单和文件路径做目录穿越校验，禁止绝对路径、`..`、符号链接逃逸和覆盖目录外文件。
- 已存在且哈希匹配的文件跳过；不匹配时重新下载，不静默混用不同版本。
- 下载服务不得记录 API Key、完整提示词或用户素材内容。

## 6. 启动与验收

- 验证 Python、launch.py、ffprobe、所需模型文件和 H3 节点后，才写入 `environment.json` 的 `ready` 状态并自动启动 ComfyUI。
- 启动复用 `ComfyProcessManager`，从持久化配置读取 runtimeRoot、模型目录和输出目录；健康检查通过后进入制作台。
- 安装后显示 `conservative`/`balanced` 的实际配置、路径和“兼容候选/已验证”状态，不把未实测配置写成已验证。
- 真实验收分两层：本机 RTX 5080 回归，以及朋友电脑的硬件检测、下载、启动、一次小规模生成。后者完成前，只能称为候选配置。

## 7. 测试与交付

- 单元测试：硬件门禁、档案选择、清单解析、路径穿越、磁盘计算、Range 恢复、哈希失败、回滚和 existing install。
- E2E：本地模拟运行包与模型服务器，验证首次启动、下载失败恢复、重新启动跳过向导和打包后启动。
- 新建 `SMO-H3-Runtime` 仓库时同时上传 README、清单、许可证和分块运行包，并核对 Release 资产大小与 SHA256。
- 交付 0.2.0 版本，更新正式 release、桌面快捷方式和 PR。登录、会员和服务器 API 继续独立推进。

