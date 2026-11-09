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
    / "qwen_tts_service.py"
)
SPEC = importlib.util.spec_from_file_location("qwen_tts_service", SERVICE_PATH)
assert SPEC is not None and SPEC.loader is not None
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class FakeModel:
    def __init__(self, path):
        self.path = path

    def get_supported_speakers(self):
        return ["Vivian"]

    def get_supported_languages(self):
        return ["Auto", "Chinese"]


class FakeQwen3TTSModel:
    calls = []
    failures = []
    model_refs = []

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.failures = []
        cls.model_refs = []

    @classmethod
    def from_pretrained(cls, path, **kwargs):
        cls.calls.append((str(path), kwargs))
        if cls.failures:
            raise cls.failures.pop(0)
        model = FakeModel(str(path))
        cls.model_refs.append(weakref.ref(model))
        return model


class ModelRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.model_root = Path(self.temporary_directory.name)
        for directory in service.MODEL_DIRECTORIES.values():
            (self.model_root / directory).mkdir()

        FakeQwen3TTSModel.reset()
        self.torch = types.ModuleType("torch")
        self.torch.bfloat16 = object()
        self.torch.cuda = types.SimpleNamespace(
            is_available=mock.Mock(return_value=True),
            empty_cache=mock.Mock(),
        )
        self.qwen_tts = types.ModuleType("qwen_tts")
        self.qwen_tts.Qwen3TTSModel = FakeQwen3TTSModel
        self.module_patch = mock.patch.dict(
            sys.modules,
            {"torch": self.torch, "qwen_tts": self.qwen_tts},
        )
        self.module_patch.start()
        self.registry = service.ModelRegistry(self.model_root)

    def tearDown(self):
        self.registry.close()
        self.module_patch.stop()
        self.temporary_directory.cleanup()

    def test_custom_voice_loads_only_the_local_custom_model(self):
        capabilities = self.registry.capabilities("custom")

        self.assertEqual(
            capabilities,
            {"speakers": ["Vivian"], "languages": ["Auto", "Chinese"]},
        )
        self.assertEqual(len(FakeQwen3TTSModel.calls), 1)
        path, kwargs = FakeQwen3TTSModel.calls[0]
        self.assertEqual(
            path,
            str(self.model_root / service.MODEL_DIRECTORIES["custom"]),
        )
        self.assertEqual(kwargs["device_map"], "cuda:0")
        self.assertIs(kwargs["dtype"], self.torch.bfloat16)
        self.assertIs(kwargs["local_files_only"], True)
        self.assertEqual(self.registry.mode, "custom")

    def test_switch_to_base_releases_custom_model_and_cuda_cache(self):
        self.registry.capabilities("custom")
        custom_ref = FakeQwen3TTSModel.model_refs[0]
        self.assertIsNotNone(custom_ref())

        with mock.patch.object(service.gc, "collect", wraps=service.gc.collect) as collect:
            capabilities = self.registry.capabilities("clone")

        self.assertEqual(
            capabilities,
            {"speakers": [], "languages": ["Auto", "Chinese"]},
        )
        self.assertEqual(len(FakeQwen3TTSModel.calls), 2)
        self.assertEqual(
            FakeQwen3TTSModel.calls[1][0],
            str(self.model_root / service.MODEL_DIRECTORIES["clone"]),
        )
        self.assertIsNone(custom_ref())
        self.assertEqual(self.registry.mode, "clone")
        self.assertGreaterEqual(collect.call_count, 1)
        self.torch.cuda.empty_cache.assert_called()

    def test_load_failure_clears_previous_model_and_cleans_again(self):
        self.registry.capabilities("custom")
        custom_ref = FakeQwen3TTSModel.model_refs[0]
        FakeQwen3TTSModel.failures.append(RuntimeError("injected model load failure"))
        self.torch.cuda.empty_cache.reset_mock()

        with mock.patch.object(service.gc, "collect", wraps=service.gc.collect) as collect:
            with self.assertRaisesRegex(RuntimeError, "injected model load failure"):
                self.registry.capabilities("clone")

        self.assertIsNone(self.registry.model)
        self.assertIsNone(self.registry.mode)
        self.assertIsNone(custom_ref())
        self.assertGreaterEqual(collect.call_count, 2)
        self.assertGreaterEqual(self.torch.cuda.empty_cache.call_count, 2)


if __name__ == "__main__":
    unittest.main()
