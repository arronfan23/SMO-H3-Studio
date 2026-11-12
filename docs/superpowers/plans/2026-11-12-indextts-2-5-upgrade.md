# IndexTTS-2.5 升级实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。当前侧会话禁止使用子代理，全部内联执行。

**目标：** 将 SMO.H3 Studio 的语音组件升级为官方 IndexTTS-2.5，并为两种语音模式提供原生语速控制。

**架构：** 保留 Electron 主进程授权、单任务和作品落盘流程，仅替换 loopback Python 推理入口及模型布局。UI 传递直观的 `speechRate`，Python 将其倒数转换为官方 `duration_factor`；主模型和辅助模型继续通过固定版本清单按需下载。

**技术栈：** Electron、React、TypeScript、Zod、Python 3.11、IndexTTS-2.5、PyTorch 2.8、uv、Vitest、Playwright。

---

## 文件结构

- `resources/speech/index_tts_service.py`：加载 2.5 模型，映射语言和语速，执行本地推理。
- `resources/speech/pyproject.toml`、`resources/speech/uv.lock`：固定官方 v2.5.0 源码及依赖。
- `resources/speech/index_tts_models.json`：删除，2.5 不再使用 2.0 的 Hugging Face refs 缓存布局。
- `scripts/build-media-manifest.mjs`、`resources/environment/media-components.json`：生成 2.5 主模型与平铺辅助模型清单。
- `src/shared/ipc.ts`、`src/main/speech-process.ts`、`src/main/speech-generation.ts`：传递、校验并记录 `speechRate`。
- `src/renderer/SpeechForm.tsx`：显示五种语言和语速滑块，保留两个模式的草稿。
- `electron-builder.yml`：移除不再使用的辅助 revision 配置文件。
- `tests/python/test_indextts_service.py`、`tests/unit/speech-*.test.ts*`、`tests/unit/ipc.test.ts`、`tests/unit/studio.test.tsx`、`tests/unit/media-components.test.ts`、`tests/unit/runtime-packaging.test.ts`、`tests/e2e/package.spec.ts`：覆盖对应行为。

### 任务 1：迁移 Python 推理服务

- [ ] **步骤 1：先修改 Python 测试，使其要求 2.5 入口和参数**

将 fake 模块改为 `indextts.infer_v2_5`，模型目录断言改为 `IndexTTS-2.5`，并加入：

```python
def test_maps_language_and_speech_rate_to_official_parameters(self):
    self.registry.generate({
        "voice_mode": "clone",
        "text": "你好",
        "language": "Chinese",
        "ref_audio": str(self.reference_audio),
        "speech_rate": 1.5,
    })

    call = FakeIndexTTS2.infer_calls[0]
    self.assertEqual(call["lang"], "ZH")
    self.assertAlmostEqual(call["duration_factor"], 1 / 1.5)

def test_rejects_speech_rate_outside_the_official_duration_range(self):
    for rate in (0, 0.49, 2.01, float("nan"), float("inf")):
        with self.subTest(rate=rate), self.assertRaises(service.RequestError):
            self.registry.generate({
                "voice_mode": "clone",
                "text": "Hello",
                "language": "English",
                "ref_audio": str(self.reference_audio),
                "speech_rate": rate,
            })
```

构造断言使用 `use_bf16=True`，并增加 `use_qwen_emo=True`；fake CUDA 对象补充 `is_bf16_supported()`。删除只适用于 2.0 缓存 refs 的测试。

- [ ] **步骤 2：运行测试并确认因旧入口和缺少新参数而失败**

运行：`python tests/python/test_indextts_service.py -v`

预期：FAIL，仍加载 `indextts.infer_v2`、模型目录为 `IndexTTS-2`，且未传 `lang/duration_factor`。

- [ ] **步骤 3：实现最小 2.5 服务迁移**

核心实现：

```python
MODEL_DIRECTORY = "IndexTTS-2.5"
SUPPORTED_LANGUAGES = ["Chinese", "English", "Japanese", "Spanish", "Arabic"]
LANGUAGE_CODES = {
    "Chinese": "ZH",
    "English": "EN",
    "Japanese": "JA",
    "Spanish": "ES",
    "Arabic": "AR",
}

speech_rate = payload.get("speech_rate", 1.0)
if isinstance(speech_rate, bool) or not isinstance(speech_rate, (int, float)):
    raise RequestError(400, "speech_rate must be a number")
if not math.isfinite(speech_rate) or not 0.5 <= speech_rate <= 2.0:
    raise RequestError(400, "speech_rate must be between 0.5 and 2.0")

from indextts.infer_v2_5 import IndexTTS2
self.model = IndexTTS2(
    cfg_path=str(config_path),
    model_dir=str(model_path),
    use_bf16=torch.cuda.is_available() and torch.cuda.is_bf16_supported(),
    use_cuda_kernel=False,
    use_deepspeed=False,
    use_qwen_emo=True,
)
model.infer(
    spk_audio_prompt=payload["ref_audio"],
    text=payload["text"],
    lang=LANGUAGE_CODES[payload["language"]],
    output_path=output_path,
    duration_factor=1 / speech_rate,
    use_emo_text=bool(instruct.strip()),
    emo_text=instruct.strip() or None,
    use_random=False,
    verbose=False,
)
```

同时校验语言必须属于 `LANGUAGE_CODES`，将 `speech_rate` 加入允许的公共请求字段，删除 `ensure_huggingface_references()` 及其调用。

- [ ] **步骤 4：运行 Python 测试确认通过**

运行：`python tests/python/test_indextts_service.py -v`

预期：全部 PASS。

### 任务 2：贯通语速请求与作品元数据

- [ ] **步骤 1：添加 IPC、主进程和生成失败的测试**

在 `tests/unit/speech-process.test.ts` 断言自定义与克隆 payload 均包含：

```ts
expect(JSON.parse(init.body as string)).toMatchObject({ speech_rate: 1.5 });
```

在 `tests/unit/speech-generation.test.ts` 添加 `speechRate: 0.49` 和 `2.01` 的拒绝测试，并断言正常作品元数据包含：

```ts
expect(work.metadata).toMatchObject({ speechRate: 1.5 });
```

在 `tests/unit/ipc.test.ts` 验证合法 `speechRate` 被接受，非有限值和越界值被拒绝。

- [ ] **步骤 2：运行三组测试并确认新断言失败**

运行：`npx vitest run tests/unit/speech-process.test.ts tests/unit/speech-generation.test.ts tests/unit/ipc.test.ts`

预期：FAIL，当前请求和 payload 不支持 `speechRate`。

- [ ] **步骤 3：实现请求字段与校验**

在共享 schema 增加：

```ts
speechRate: z.number().finite().min(0.5).max(2).optional(),
```

在主进程请求类型中增加 `speechRate?: number`，payload 使用：

```ts
speech_rate: request.speechRate ?? 1.0,
```

`validateSpeechGenerationRequest()` 对缺省值之外的字段校验有限数值与 `[0.5, 2]` 范围，作品元数据记录 `speechRate: request.speechRate ?? 1.0`。

- [ ] **步骤 4：重跑三组测试**

运行同步骤 2，预期全部 PASS。

### 任务 3：增加两个模式的语速与多语言 UI

- [ ] **步骤 1：添加 SpeechForm 和跨页面失败测试**

在 `tests/unit/speech-form.test.tsx` 对两个模式分别执行：

```tsx
const rate = within(activeSpeechPanel).getByRole('slider', { name: '语速' });
fireEvent.change(rate, { target: { value: '1.5' } });
expect(screen.getByText('1.50x')).toBeInTheDocument();
expect(smo.jobs.start.mock.calls[0][0]).toMatchObject({ speechRate: 1.5 });
```

新增语言选项断言：中文、英语、日语、西班牙语、阿拉伯语可见，Auto 不存在。`tests/unit/studio.test.tsx` 增加切页后语速仍为 `1.5` 的断言。

- [ ] **步骤 2：运行测试并确认语速控件不存在**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx`

预期：FAIL，找不到“语速”滑块。

- [ ] **步骤 3：实现共享草稿状态和滑块**

在 `SpeechForm` 中增加：

```tsx
const [speechRate, setSpeechRate] = useState(1);
const languageLabels: Record<string, string> = {
  Chinese: '中文',
  English: '英语',
  Japanese: '日语',
  Spanish: '西班牙语',
  Arabic: '阿拉伯语',
};
```

两个 panel 使用各自唯一 ID 渲染相同状态：

```tsx
<input
  id={`${mode}-speech-rate`}
  type="range"
  min={0.5}
  max={2}
  step={0.05}
  value={speechRate}
  aria-label="语速"
  onChange={(event) => setSpeechRate(Number(event.target.value))}
/>
<output>{speechRate.toFixed(2)}x</output>
```

两种请求都加入 `speechRate`，语言 option 的 `value` 保持服务值，显示文字使用 `languageLabels`。

- [ ] **步骤 4：运行 UI 与类型测试**

运行：`npx vitest run tests/unit/speech-form.test.tsx tests/unit/studio.test.tsx && npm run typecheck`

预期：测试 PASS，TypeScript 无错误。

### 任务 4：更新模型清单、依赖锁与打包

- [ ] **步骤 1：更新清单测试为 2.5 文件集和平铺路径**

在 `tests/unit/media-components.test.ts` 将主仓库改为 `IndexTeam/IndexTTS-2.5`，要求 `codec.pth` 和多语言 tiktoken 文件，并要求：

```ts
expect(files.map((file) => file.path)).toEqual(expect.arrayContaining([
  'IndexTTS-2.5/codec.pth',
  'IndexTTS-2.5/multilingual_zh_ja_yue_char_del.tiktoken',
  'IndexTTS-2.5/hf_cache/w2v-bert-2.0/model.safetensors',
  'IndexTTS-2.5/hf_cache/campplus_cn_common.bin',
  'IndexTTS-2.5/hf_cache/bigvgan/bigvgan_generator.pt',
]));
```

生成器夹具补充 w2v 的 `model.safetensors`，删除 MaskGCT 辅助项。打包测试要求不再包含 `index_tts_models.json`。

- [ ] **步骤 2：运行测试确认旧清单和打包规则失败**

运行：`npx vitest run tests/unit/media-components.test.ts tests/unit/runtime-packaging.test.ts`

预期：FAIL，仍指向 2.0 主模型和旧缓存路径。

- [ ] **步骤 3：修改生成器与依赖**

主模型固定为 `IndexTeam/IndexTTS-2.5`，核心文件集合采用规格中的 2.5 文件。辅助文件输出到：

```js
const paths = {
  'facebook/w2v-bert-2.0': `IndexTTS-2.5/hf_cache/w2v-bert-2.0/${path}`,
  'funasr/campplus': 'IndexTTS-2.5/hf_cache/campplus_cn_common.bin',
  'nvidia/bigvgan_v2_22khz_80band_256x': `IndexTTS-2.5/hf_cache/bigvgan/${path}`,
};
```

将 `resources/speech/pyproject.toml` 的源码 URL 改为：

```toml
"indextts @ https://github.com/index-tts/index-tts/archive/39207d91c30899cad1e7c1b9eb678c241f678e55.zip",
```

删除 `index_tts_models.json` 及其打包项，然后执行：

```powershell
& 'G:\SMO-H3-Data\components\speech\runtime\tools\uv-0.11.13\uv.exe' lock --project resources/speech
```

- [ ] **步骤 4：生成真实清单并验证**

运行：

```powershell
$env:SMO_MANIFEST_PROGRESS='1'
$env:SMO_MANIFEST_CURL_FALLBACK='1'
node scripts/build-media-manifest.mjs --component speech
```

随后运行媒体与打包测试，并用 `parseMediaComponentManifest` 验证总字节数等于文件大小之和、无 Qwen 语音来源、无旧缓存路径。

### 任务 5：回归、真实模型验收与构建

- [ ] **步骤 1：运行自动化回归**

```powershell
python tests/python/test_indextts_service.py -v
npm run typecheck
npx vitest run --exclude tests/unit/environment-wizard.test.tsx --reporter=dot
npm run build
npx playwright test tests/e2e/studio.spec.ts
```

预期：除明确排除的既有环境向导修改外均通过；记录实际通过数和跳过数。

- [ ] **步骤 2：安装 2.5 并执行真实生成**

退出正在运行的 Studio 实例，使用新构建安装语音组件。用已授权参考音生成中文 `1.00x` 与 `1.50x` 样例，保存作品并比较实际音频时长；再生成一个带情绪说明的中文样例和一个英文样例。若下载或模型验收失败，保留日志并明确报告，不宣称真实生成通过。

- [ ] **步骤 3：构建 Windows 包并核对内容**

运行 `npm run pack`，或在不关闭正在使用旧包的情况下输出到独立目录。确认包内包含 `index_tts_service.py`、`pyproject.toml`、`uv.lock`，不包含 Qwen 服务、2.0 refs 配置或模型正文；对源文件和包内文件计算 SHA256 并确认一致。

- [ ] **步骤 4：检查最终工作树**

运行 `git status --short` 和 `git diff --check`。不得纳入 `tests/e2e/environment.spec.ts`、`tests/unit/environment-wizard.test.tsx` 或 `__pycache__` 的既有改动。除非用户另行要求，不提交或推送实现代码。
