# 第三方声明

## 范围

本仓库的 MIT 许可证仅覆盖 SMO.H3 Studio 提供的打包脚本与文档，不覆盖运行包内的 ComfyUI、Python、节点、CUDA 组件、FFmpeg，也不覆盖任何模型。

运行包 ZIP 保留上游组件原有的 LICENSE、NOTICE 和其他许可文件。重新分发或使用这些组件时，仍须遵守各组件的许可证。仓库中的 `licenses/ComfyUI-LICENSE` 是 ComfyUI 许可证的原文副本，不替换运行包内的其他许可文件。

## 运行环境来源

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)：上游 ComfyUI 项目；其许可证副本保留在本仓库与运行包中。
- [Spark-H3](https://github.com/zechengtang/Spark-H3)：SelfLift Spark 相关节点的上游项目；节点及其许可证保留在运行包中。
- [MiniMax-H3](https://github.com/MiniMax-AI/MiniMax-H3)：模型与工作流相关的上游项目。此链接不表示本仓库或第三方模型获得 MiniMax 官方背书。

运行包来自本地既有的无模型 ZIP。本仓库脚本只进行顺序分块与哈希校验，不把第三方运行环境重新标注为 SMO 或 MiniMax 的官方作品。

## 模型来源

模型文件不上传到本仓库，也不包含在运行包 ZIP 中。安装器根据 `manifests/selflift-spark.json` 从下列发布方下载，并核对其 Hugging Face 元数据、字节数和 SHA256。

| 发布方仓库 | 清单中的文件 |
| --- | --- |
| [speedyrulz/mini](https://huggingface.co/speedyrulz/mini) | `minimax_h3_hybrid_fl2va_ref2va_b30-49-int8.safetensors`、`taeh3.safetensors` |
| [p3cyc/minimax](https://huggingface.co/p3cyc/minimax) | `qwen3vl_32b_minimax_h3_ultra_uncensored_heretic_int8_convrot.safetensors` |
| [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) | `minimax_h3_video_vae_int8_convrot.safetensors`、`minimax_h3_audio_vae_fp32.safetensors` |
| [DarkRomeo88/MiniMax-H3-turbo-lora-comfyui](https://huggingface.co/DarkRomeo88/MiniMax-H3-turbo-lora-comfyui) | `dmad_minimax_h3_4step_full_critic_comfy.safetensors` |
| [RunningHubAI/rh-h3-speed-slider-1.1-lora](https://huggingface.co/RunningHubAI/rh-h3-speed-slider-1.1-lora) | `H3_speed_slider_1.1.safetensors` |
| [Alissonerdx/Minimax-H3-ComfyUI](https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI) | `h3_upscaler_lms_v0.1_fp32.safetensors` |
| [LBH-123-AI/Minimax_h3_latent_Upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler) | `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` |
| [Veda-Sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview](https://huggingface.co/Veda-Sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview) | `minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors` |

除明确列出的发布方外，不对模型作者、转换者或量化者作额外归属推断。第三方发布方的文件不能称为 MiniMax 官方文件；模型是否允许使用或再分发，应以各发布方仓库中的许可证与说明为准。
