# SMO.H3 Studio 安装版与版本显示设计

日期：2026-11-07

## 目标

- 提供可选择安装路径的 Windows 正式安装版。
- 安装后自动创建桌面和开始菜单快捷方式。
- 设置页始终显示当前软件版本，不需要手动维护显示文字。
- 保留现有便携版，安装版和便携版使用相同的应用功能与环境配置逻辑。
- 升级或卸载软件本体时不错误删除 ComfyUI、模型、素材或作品。

## 发布形态

Windows 构建同时生成：

- `SMO.H3-Studio-Setup-<version>.exe`：NSIS 安装版，作为推荐下载。
- `SMO.H3-Studio-<version>.exe`：现有便携版，继续保留。

安装版与便携版共享同一个 `appId`，使正式安装版能够识别后续版本。安装版使用 assisted installer，而不是一键安装。

## 安装路径与快捷方式

NSIS 配置采用以下行为：

- `oneClick: false`：显示安装向导。
- `allowToChangeInstallationDirectory: true`：允许用户选择软件本体安装路径。
- `perMachine: false`：默认当前用户安装，不要求管理员权限。
- `createDesktopShortcut: true`：自动创建桌面快捷方式。
- `createStartMenuShortcut: true`：自动创建开始菜单快捷方式。
- `runAfterFinish: true`：安装完成后可以启动软件。
- `deleteAppDataOnUninstall: false`：卸载不主动删除用户数据。

快捷方式指向最终安装目录中的 `SMO.H3 Studio.exe`，不会指向便携版的临时解压目录。

## 数据目录

安装器只负责软件本体路径。首次启动仍进入现有“首次环境配置”页面，由用户在“安装目录”中输入数据目录。

该数据目录继续包含运行时、模型、数字模特、上传文件、作品和配置。硬件检测、空闲磁盘检测、运行时下载及校验均以用户选择的数据目录为准。

升级软件本体后复用既有 `environment.json`，不重复下载已校验的运行时和模型。卸载默认只移除软件本体，不清理数据目录。

## 设置页版本号

新增只读 `app:getVersion` IPC：

- 主进程返回 Electron `app.getVersion()`。
- 预加载层只暴露 `window.smo.app.getVersion()`，不开放 Node 或任意文件访问。
- IPC 使用现有空载荷 schema 和通道白名单。

设置页加载时获取版本，在页面底部使用非卡片、低强调页脚显示 `SMO.H3 Studio · 版本 <version>`。读取失败时显示 `版本未知`，不影响其他设置功能。

## 测试与验收

1. 单元测试覆盖版本 IPC 白名单、主进程返回值和设置页版本展示。
2. 保留并通过现有便携版单元、Electron 和打包态测试。
3. 构建测试同时验证安装版和便携版产物存在，NSIS 配置包含自定义安装目录、桌面快捷方式及保留数据规则。
4. 使用安装版实际安装到一个非默认测试路径，确认应用文件位于所选目录，桌面快捷方式指向该位置且可以启动。
5. 在已安装客户端的设置页确认版本号与 `package.json` 一致。
6. 确认既有数据目录和环境配置继续复用，安装过程不触发模型下载。
7. GitHub Release 同时上传安装版和便携版，分别核对本地与远端 SHA256。

