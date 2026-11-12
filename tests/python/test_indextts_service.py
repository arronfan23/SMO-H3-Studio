import importlib.util
import sys
import tempfile
import types
import unittest
import weakref
from pathlib import Path
from unittest import mock


SERVICE_PATH = (
    Path(__file__).resolve().parents[2]
    / "resources"
    / "speech"
    / "index_tts_service.py"
)
SPEC = importlib.util.spec_from_file_location("index_tts_service", SERVICE_PATH)
assert SPEC is not None and SPEC.loader is not None
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class FakeIndexTTS2:
    calls = []
    infer_calls = []
    failures = []
    model_refs = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        type(self).calls.append(kwargs)
        type(self).model_refs.append(weakref.ref(self))

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.infer_calls = []
        cls.failures = []
        cls.model_refs = []

    def infer(self, **kwargs):
        type(self).infer_calls.append(kwargs)
        Path(kwargs["output_path"]).write_bytes(b"RIFF-index-tts")
        return kwargs["output_path"]


class ModelRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.model_root = Path(self.temporary_directory.name)
        model_directory = self.model_root / "IndexTTS-2"
        model_directory.mkdir()
        (model_directory / "config.yaml").write_text("model: test", encoding="utf-8")
        self.reference_audio = self.model_root / "reference.wav"
        self.reference_audio.write_bytes(b"reference")

        FakeIndexTTS2.reset()
        self.torch = types.ModuleType("torch")
        self.torch.cuda = types.SimpleNamespace(
            is_available=mock.Mock(return_value=True),
            empty_cache=mock.Mock(),
        )
        infer_v2 = types.ModuleType("indextts.infer_v2")
        infer_v2.IndexTTS2 = FakeIndexTTS2
        indextts = types.ModuleType("indextts")
        indextts.infer_v2 = infer_v2
        self.module_patch = mock.patch.dict(
            sys.modules,
            {
                "torch": self.torch,
                "indextts": indextts,
                "indextts.infer_v2": infer_v2,
            },
        )
        self.module_patch.start()
        self.registry = service.ModelRegistry(self.model_root)

    def tearDown(self):
        self.registry.close()
        self.module_patch.stop()
        self.temporary_directory.cleanup()

    def test_capabilities_load_only_the_pinned_local_model(self):
        capabilities = self.registry.capabilities("custom")

        self.assertEqual(
            capabilities,
            {"speakers": [], "languages": ["Auto", "Chinese", "English"]},
        )
        self.assertEqual(len(FakeIndexTTS2.calls), 1)
        self.assertEqual(
            FakeIndexTTS2.calls[0]["model_dir"],
            str(self.model_root / "IndexTTS-2"),
        )
        self.assertEqual(
            FakeIndexTTS2.calls[0]["cfg_path"],
            str(self.model_root / "IndexTTS-2" / "config.yaml"),
        )
        self.assertIs(FakeIndexTTS2.calls[0]["use_fp16"], True)
        self.assertIs(FakeIndexTTS2.calls[0]["use_cuda_kernel"], False)
        self.assertIs(FakeIndexTTS2.calls[0]["use_deepspeed"], False)

    def test_custom_uses_reference_audio_and_emotion_description(self):
        audio = self.registry.generate({
            "voice_mode": "custom",
            "text": "Hello",
            "language": "English",
            "ref_audio": str(self.reference_audio),
            "instruct": "calm and warm",
        })

        self.assertEqual(audio, b"RIFF-index-tts")
        self.assertEqual(len(FakeIndexTTS2.infer_calls), 1)
        self.assertEqual(
            FakeIndexTTS2.infer_calls[0]["spk_audio_prompt"],
            str(self.reference_audio),
        )
        self.assertEqual(FakeIndexTTS2.infer_calls[0]["text"], "Hello")
        self.assertEqual(FakeIndexTTS2.infer_calls[0]["emo_text"], "calm and warm")
        self.assertIs(FakeIndexTTS2.infer_calls[0]["use_emo_text"], True)
        self.assertEqual(self.registry.mode, "custom")

    def test_clone_uses_reference_audio_without_qwen_only_fields(self):
        audio = self.registry.generate({
            "voice_mode": "clone",
            "text": "你好",
            "language": "Chinese",
            "ref_audio": str(self.reference_audio),
        })

        self.assertEqual(audio, b"RIFF-index-tts")
        self.assertEqual(len(FakeIndexTTS2.infer_calls), 1)
        self.assertNotIn("ref_text", FakeIndexTTS2.infer_calls[0])
        self.assertNotIn("x_vector_only_mode", FakeIndexTTS2.infer_calls[0])
        self.assertEqual(self.registry.mode, "clone")

    def test_switching_modes_reuses_one_model_instance(self):
        self.registry.capabilities("custom")
        model_ref = FakeIndexTTS2.model_refs[0]
        self.registry.capabilities("clone")

        self.assertEqual(len(FakeIndexTTS2.calls), 1)
        self.assertIsNotNone(model_ref())
        self.assertEqual(self.registry.mode, "clone")

    def test_writes_pinned_offline_references_inside_the_model_directory(self):
        self.registry.capabilities("custom")

        reference = (
            self.model_root
            / "checkpoints"
            / "hf_cache"
            / "models--facebook--w2v-bert-2.0"
            / "refs"
            / "main"
        )
        self.assertEqual(
            reference.read_text(encoding="ascii").strip(),
            "da985ba0987f70aaeb84a80f2851cfac8c697a7b",
        )

    def test_load_failure_clears_model_and_cuda_cache(self):
        self.registry.capabilities("custom")
        model_ref = FakeIndexTTS2.model_refs[0]
        self.registry.model = None
        self.registry.mode = None
        self.registry.model_root = self.model_root / "missing"
        self.torch.cuda.empty_cache.reset_mock()

        with self.assertRaises(FileNotFoundError):
            self.registry.capabilities("clone")

        self.assertIsNone(self.registry.model)
        self.assertIsNone(self.registry.mode)
        self.assertIsNone(model_ref())
        self.torch.cuda.empty_cache.assert_called()

    def test_reference_audio_is_required_for_both_modes(self):
        for mode in ("custom", "clone"):
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(service.RequestError, "ref_audio"):
                    payload = {
                        "voice_mode": mode,
                        "text": "Hello",
                        "language": "English",
                    }
                    if mode == "custom":
                        payload["instruct"] = ""
                    self.registry.generate(payload)


if __name__ == "__main__":
    unittest.main()
