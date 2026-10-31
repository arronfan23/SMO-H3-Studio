import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsPage } from "../../src/renderer/SettingsPage";
import type { SmoApi } from "../../src/shared/ipc";
import type { HardwareInfo, HardwareProfile } from "../../src/shared/types";

const hardwareInfo: HardwareInfo = {
  gpu: "NVIDIA GeForce RTX 5080",
  vramGiB: 16,
  ramGiB: 64,
  driverVersion: "576.88",
  cudaComputeCapability: "12.0",
  windowsVersion: "Windows 11 Pro 10.0.22631",
  freeDiskGiB: 512,
};

const hardwareProfile: HardwareProfile = {
  preset: "balanced-16gb",
  modelPolicy: "int8",
  megapixels: 0.7,
  lowvram: true,
  tiling: "auto",
  requiresConfirmation: true,
};

const smo = {
  comfy: { health: vi.fn(), open: vi.fn() },
  llm: { getProfile: vi.fn() },
  hardware: {
    detect: vi.fn(),
    recommend: vi.fn(),
    apply: vi.fn(),
    reset: vi.fn(),
  },
};

async function renderSettings(): Promise<void> {
  render(<SettingsPage />);
  await screen.findByRole("button", { name: "检测硬件" });
}

async function renderRecommendation(): Promise<void> {
  await renderSettings();
  fireEvent.click(screen.getByRole("button", { name: "检测硬件" }));
  await screen.findByText(hardwareInfo.gpu);
  fireEvent.click(screen.getByRole("button", { name: "获取推荐" }));
  await screen.findByText(hardwareProfile.preset);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.smo = smo as unknown as SmoApi;
  vi.stubGlobal("confirm", vi.fn(() => true));
  smo.comfy.health.mockResolvedValue({ system: {}, devices: [] });
  smo.llm.getProfile.mockResolvedValue(null);
  smo.hardware.detect.mockResolvedValue(hardwareInfo);
  smo.hardware.recommend.mockResolvedValue(hardwareProfile);
  smo.hardware.apply.mockResolvedValue({
    path: "G:\\SMO-H3-Data\\workflow-profiles\\balanced-16gb-audio.json",
    profile: hardwareProfile,
  });
  smo.hardware.reset.mockResolvedValue("G:\\resources\\workflows\\text-ref2va.json");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SettingsPage hardware controls", () => {
  test("detects and displays GPU, memory, driver, CUDA, Windows, and free disk", async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "检测硬件" }));

    expect(await screen.findByText(hardwareInfo.gpu)).toBeInTheDocument();
    expect(screen.getByText("576.88")).toBeInTheDocument();
    expect(screen.getByText("12.0")).toBeInTheDocument();
    expect(screen.getByText(hardwareInfo.windowsVersion)).toBeInTheDocument();
    expect(screen.getByText(/16(?:\.0)? GiB/)).toBeInTheDocument();
    expect(screen.getByText(/64(?:\.0)? GiB/)).toBeInTheDocument();
    expect(screen.getByText(/512(?:\.0)? GiB/)).toBeInTheDocument();
    expect(smo.hardware.detect).toHaveBeenCalledTimes(1);
  });

  test("shows the real detection error", async () => {
    smo.hardware.detect.mockRejectedValue(new Error("nvidia-smi is unavailable"));
    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "检测硬件" }));

    expect(await screen.findByText("nvidia-smi is unavailable")).toBeInTheDocument();
  });

  test("recommends from detected hardware and marks the high preset as unverified", async () => {
    const highProfile: HardwareProfile = {
      preset: "high-memory-candidate",
      modelPolicy: "bf16-if-present",
      megapixels: 1,
      lowvram: false,
      tiling: "auto",
      requiresConfirmation: true,
    };
    smo.hardware.recommend.mockResolvedValue(highProfile);
    await renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "检测硬件" }));
    await screen.findByText(hardwareInfo.gpu);

    fireEvent.click(screen.getByRole("button", { name: "获取推荐" }));

    expect(await screen.findByText(highProfile.preset)).toBeInTheDocument();
    expect(screen.getByText(highProfile.modelPolicy)).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("关闭")).toBeInTheDocument();
    expect(screen.getByText("auto")).toBeInTheDocument();
    expect(screen.getByText("需要确认")).toBeInTheDocument();
    expect(screen.getByText(/候选.*未实测/)).toBeInTheDocument();
    expect(smo.hardware.recommend).toHaveBeenCalledWith({
      gpu: hardwareInfo.gpu,
      vramGiB: hardwareInfo.vramGiB,
      ramGiB: hardwareInfo.ramGiB,
    });
  });

  test("applies a confirmed audio profile with the default model directory", async () => {
    await renderRecommendation();
    fireEvent.change(screen.getByLabelText("应用模式"), { target: { value: "audio" } });
    fireEvent.click(screen.getByRole("button", { name: "获取推荐" }));
    await screen.findByText(hardwareProfile.preset);

    fireEvent.click(screen.getByRole("button", { name: "应用推荐" }));

    await waitFor(() => {
      expect(smo.hardware.apply).toHaveBeenCalledWith({
        mode: "audio",
        profile: hardwareProfile,
        confirmed: true,
        modelDirectory: "G:\\H3Selflift整合包\\模型部分\\diffusion_models",
      });
    });
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/balanced-16gb-audio\.json/),
    ).toBeInTheDocument();
  });

  test("does not apply when confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderRecommendation();

    fireEvent.click(screen.getByRole("button", { name: "应用推荐" }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(smo.hardware.apply).not.toHaveBeenCalled();
  });

  test("shows a missing-model error without reporting an applied path", async () => {
    smo.hardware.apply.mockRejectedValue(
      new Error("Required UNET model files are missing. Automatic download is disabled."),
    );
    await renderRecommendation();

    fireEvent.click(screen.getByRole("button", { name: "应用推荐" }));

    expect(await screen.findByText(/Required UNET model files are missing/)).toBeInTheDocument();
    expect(screen.queryByText(/已应用/)).not.toBeInTheDocument();
  });

  test("clears the old recommendation and applied path when the mode changes", async () => {
    await renderRecommendation();
    fireEvent.click(screen.getByRole("button", { name: "应用推荐" }));
    expect(await screen.findByText(/已应用工作流副本/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("应用模式"), { target: { value: "audio" } });

    expect(screen.queryByText(hardwareProfile.preset)).not.toBeInTheDocument();
    expect(screen.queryByText(/已应用工作流副本/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("应用模式")).toHaveValue("audio");
    expect(screen.queryByRole("button", { name: "应用推荐" })).not.toBeInTheDocument();
  });

  test("does not reset when confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(smo.hardware.reset).not.toHaveBeenCalled();
  });

  test("resets the selected mode and displays the restored frozen path", async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));

    await waitFor(() => expect(smo.hardware.reset).toHaveBeenCalledWith("text"));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/text-ref2va\.json/)).toBeInTheDocument();
  });
});
