# 正式安装版与版本显示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 同时提供可选择安装路径的 NSIS 安装版与现有便携版，安装后自动创建快捷方式，并在设置页显示真实软件版本。

**架构：** 通过受限的 `app:getVersion` IPC 将 Electron 包版本传给设置页；electron-builder 同时构建 NSIS 与 portable，数据目录继续由首次环境配置页管理，与软件本体安装目录解耦。

**技术栈：** Electron、TypeScript、React、NSIS、electron-builder、Vitest、Playwright。

**规格：** `docs/superpowers/specs/2026-11-07-installer-version-design.md`

---

## 文件职责

- 修改 `src/shared/ipc.ts`：注册 `app:getVersion` 和只读 API 类型。
- 修改 `src/main/ipc.ts`：返回 Electron `app.getVersion()`。
- 修改 `src/preload/index.ts`：暴露最小化 `window.smo.app` API。
- 修改 `src/renderer/SettingsPage.tsx`：显示动态版本及失败回退。
- 修改 `src/renderer/styles.css`：添加低强调、非卡片版本页脚。
- 修改 `electron-builder.yml`：同时生成 NSIS 安装版与便携版。
- 修改 `tests/unit/ipc.test.ts`、`tests/unit/studio.test.tsx` 及相关测试 API 夹具：覆盖版本链路。
- 修改 `tests/unit/smoke.test.ts`：解析并验证安装器配置。
- 修改 `package.json`、`package-lock.json`：更新发布版本。

### 任务 1：动态版本号

- [x] **步骤 1：编写失败的 IPC 与界面测试**

IPC 测试增加：

```ts
expect(IPC_CHANNELS).toContain('app:getVersion');
await expect(harness.invoke('app:getVersion', {})).resolves.toBe('0.3.15-test');
expect(ipcRendererInvoke('app:getVersion', {})).resolves.toBe('0.3.15-test');
```

设置页测试让 `smo.app.getVersion` 返回 `0.3.15-test`，进入设置后断言页脚包含 `SMO.H3 Studio · 版本 0.3.15-test`；另以拒绝 Promise 验证显示 `版本未知` 且页面其他设置仍可操作。

- [x] **步骤 2：运行测试并确认缺少版本 API**

运行：`npx vitest run tests/unit/ipc.test.ts tests/unit/studio.test.tsx -t "version|版本"`

预期：FAIL，`smo.app` 或 IPC 通道不存在。

- [x] **步骤 3：实现受限版本链路**

在 IPC 白名单和 discriminated union 中加入：

```ts
requestSchema('app:getVersion', emptyPayload)
```

`SmoApi` 添加：

```ts
readonly app: { getVersion(): Promise<string> };
```

主进程 `registerIpc` 的 switch 返回 `electronApp.getVersion()`，预加载对象添加：

```ts
app: { getVersion: () => ipcRenderer.invoke('app:getVersion', {}) },
```

`SettingsPage` 在现有 `refresh()` 的 `Promise.allSettled` 中同时读取版本，成功时保存版本，失败时使用 `版本未知`。在设置网格之后添加：

```tsx
<footer className="settings-version">
  SMO.H3 Studio · {appVersion === null ? '版本未知' : `版本 ${appVersion}`}
</footer>
```

CSS 只设置文字颜色、字号、间距和文本换行，不添加卡片、图标或说明性营销文字。同步补齐测试中的 `smo.app` 模拟，保持现有主线程测试改动不被回退。

- [x] **步骤 4：运行版本测试和类型检查**

运行：

```bash
npx vitest run tests/unit/ipc.test.ts tests/unit/studio.test.tsx
npm run typecheck
```

预期：测试与三个 TypeScript 项目均 PASS。

- [x] **步骤 5：提交版本功能**

```bash
git add src/shared/ipc.ts src/main/ipc.ts src/preload/index.ts src/renderer/SettingsPage.tsx src/renderer/styles.css tests/unit/ipc.test.ts tests/unit/studio.test.tsx
git commit -m "Show app version in settings (installer task 1)"
```

提交时仅暂存明确涉及版本 API 的测试文件；若其他测试夹具需要补 `app` 模拟，只暂存对应文件，不使用目录级暂存。

### 任务 2：NSIS 安装版与便携版双构建

- [x] **步骤 1：编写失败的构建配置测试**

使用项目已有 `yaml` 解析器读取 `electron-builder.yml`，断言：

```ts
expect(config.win.target).toEqual(['nsis', 'portable']);
expect(config.nsis).toMatchObject({
  oneClick: false,
  perMachine: false,
  allowToChangeInstallationDirectory: true,
  createDesktopShortcut: true,
  createStartMenuShortcut: true,
  runAfterFinish: true,
  deleteAppDataOnUninstall: false,
});
expect(config.nsis.artifactName).toBe('SMO.H3-Studio-Setup-${version}.${ext}');
```

保留现有 portable 配置断言，确保原下载形式没有回归。

- [x] **步骤 2：运行配置测试并确认缺少 NSIS 配置**

运行：`npx vitest run tests/unit/smoke.test.ts -t "NSIS|installer|安装"`

预期：FAIL，当前只有 portable target。

- [x] **步骤 3：实现双目标配置**

将 Windows target 改为：

```yaml
win:
  target:
    - nsis
    - portable
  icon: resources/brand/icon.ico
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  runAfterFinish: true
  deleteAppDataOnUninstall: false
  artifactName: SMO.H3-Studio-Setup-${version}.${ext}
portable:
  artifactName: SMO.H3-Studio-${version}.${ext}
```

不修改 `appId`、环境清单、数据目录解析、工作流或模型配置。

- [x] **步骤 4：运行配置与现有打包资源测试**

运行：`npx vitest run tests/unit/smoke.test.ts tests/unit/runtime-packaging.test.ts`

预期：全部 PASS。

- [x] **步骤 5：提交安装器配置**

```bash
git add electron-builder.yml tests/unit/smoke.test.ts
git commit -m "Add customizable NSIS installer (installer task 2)"
```

### 任务 3：真实安装验收与发布

- [x] **步骤 1：运行自动回归并构建两个产物**

将版本更新为下一补丁版本，运行：

```bash
npm test
npm run typecheck
npm run pack -- --config.electronDist=node_modules/electron/dist
npm run test:e2e:package
```

预期：除主线程已有的 5 个未完成“使用已有环境”测试外，其他单元测试通过；类型检查、构建和 6 项便携打包测试通过。`release` 同时存在 Setup 与便携 exe。

- [x] **步骤 2：验证自定义安装路径与快捷方式**

将 Setup 安装到明确选择的非默认测试路径 `G:\SMO-H3-Studio-Installed`。使用安装向导选择该目录；自动验收可用 `/S /D=G:\SMO-H3-Studio-Installed` 验证 NSIS 的自定义目录行为。

确认：

- `G:\SMO-H3-Studio-Installed\SMO.H3 Studio.exe` 存在。
- 桌面 `SMO.H3 Studio.lnk` 的 TargetPath 指向该 exe，不是临时目录或旧便携版。
- 开始菜单快捷方式存在。
- 启动已安装客户端后，设置页版本与 `package.json` 一致。
- 既有 `G:\SMO-H3-Data` 配置和环境继续复用，没有触发运行时或模型下载。

## 实际安装验收记录

- Setup 和便携版均成功构建，便携版 6 项打包测试通过。
- 使用 `/S /D=G:\SMO-H3-Studio-Installed` 完成自定义目录安装。
- 已安装 exe、桌面快捷方式和开始菜单快捷方式均指向 `G:\SMO-H3-Studio-Installed\SMO.H3 Studio.exe`。
- `G:\SMO-H3-Data\environment.json` 保持原文件与最后修改时间，没有重新配置或下载模型。
- 通过 Playwright 启动已安装客户端，设置页实际显示 `SMO.H3 Studio · 版本 0.3.15`。
- 完整回归中仅保留主线程已有的 5 个未完成“使用已有环境”失败；版本功能引入的其他测试失败已修复。

- [x] **步骤 3：提交并发布双产物**

只暂存本功能文件，保留主线程未完成的测试改动。推送分支后创建 GitHub Release，同时上传 Setup 和便携 exe；安装版标记为推荐下载。使用 `gh release view --json assets` 核对两个远端资产的 SHA256 均与本地一致，并更新本机桌面快捷方式到已验证的正式安装客户端。

