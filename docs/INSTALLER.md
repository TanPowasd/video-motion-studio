# Windows 安装包（NSIS）

`release/Vmotion-Setup-<版本>-x64.exe` 是按用户安装的 Windows 10/11 x64 安装程序，不需要管理员权限。它和 [便携 ZIP](PORTABLE.md) 来自同一个封装目录 `release/Vmotion`：同一套 Electron/Node 运行时、原生核心、FFmpeg、字体、第三方许可和源码清单。便携 ZIP 不受影响。

## 构建

```powershell
npm run package:installer          # build + 便携封装 + 安装包
# 已有 release/Vmotion 时只打安装包：
npx tsx scripts/package-installer.ts
```

- 需要 NSIS 3 的 `makensis`：`choco install nsis -y`（GitHub windows-latest 通常已预装）。查找顺序：`MAKENSIS` 环境变量 → PATH → `%ProgramFiles(x86)%\NSIS\makensis.exe`。
- `scripts/package-installer.ts` 把 `release/Vmotion` 复制到临时目录，**去掉 `portable.flag`、`profile` 和 `portable-manifest.json`**，加入 `bin\vmotion.cmd`、安装版 `READ-ME.txt` 与 `install-manifest.json`，再用 `scripts/installer/vmotion.nsi` 生成安装包和 `.sha256`。`VMOTION_PACKAGE_ROOT` 与便携包含义相同；`VMOTION_NSIS_VERBOSE=1` 输出完整 makensis 日志。
- 安装包本身是 32 位 NSIS 引导程序（官方 NSIS 发行版只带 x86 stub，最稳妥），只在 64 位 Windows 10/11 上允许安装，安装的程序是 x64。
- Windows CI（`windows.yml`，手动运行并勾选 portable）在便携 ZIP 之后构建安装包，上传 artifact `vmotion-installer-<sha>`（安装包 + `.sha256`）。

为什么用手写 NSIS 而不是 electron-builder：仓库没有 electron-builder；现有封装（运行时锁定、原生二进制筛选、许可/源码清单、Vmotion.exe 重命名）都在 `scripts/package.ts`，手写 .nsi 直接复用这个封装目录，不引入新的依赖树，也不改变便携包。

## 安装

- 默认目录 `%LOCALAPPDATA%\Programs\Vmotion`，可在向导中更改；再次安装时默认使用上次的目录（`HKCU\Software\Vmotion\InstallDir`）。
- 拒绝安装到含 `portable.flag` 的便携目录；目录非空且不是 Vmotion 安装时会先确认。
- 组件：
  - **Vmotion 程序（必需）**：程序文件、开始菜单 `Vmotion`、`Vmotion Agent 工作台`、`卸载 Vmotion`，以及“应用和功能”中的卸载项（HKCU）。
  - **桌面快捷方式**（默认勾选）。
  - **关联 .vmotion 文件 + 文件夹右键“用 Vmotion 打开”**（默认勾选，HKCU\Software\Classes）。两者都执行 `Vmotion.exe --project "<路径>"`：双击工程文件夹里任意 `*.vmotion` 文件会打开所在工程；文件夹右键直接打开该文件夹为工程（不是工程时显示错误并回到首页）。
  - **把 vmotion 命令加入用户 PATH**（默认勾选）：把 `<安装目录>\bin` 加入当前用户 PATH（PowerShell 修改 HKCU\Environment，保留 REG_EXPAND_SZ 和其他条目，不受 NSIS 字符串长度限制）。新开的终端中 `vmotion --version`、`vmotion mcp --project ...` 即可使用；未勾选时用 `<安装目录>\bin\vmotion.cmd`。安装目录根下的 `vmotion.cmd` 和 `Agent\vmotion-agent.cmd` 与便携包相同。
- 安装后不是便携模式：设置、最近项目和界面缓存保存在 **`%APPDATA%\vmotion`**（Electron 按用户的默认位置）。
- 支持静默安装：`Vmotion-Setup-<版本>-x64.exe /S [/D=目标目录]`（`/D` 必须是最后一个参数）。

## 升级（覆盖安装）

- 直接运行新版本安装包。Vmotion 或外部 agent 的 CLI/MCP 会话仍在运行时，安装程序提示关闭后重试。
- 安装前删除上一版写入的顶层程序条目（`resources`、`locales`、DLL 等），避免旧文件残留；安装目录中用户自己的文件和 `%APPDATA%\vmotion` 不动，所以设置和最近项目保留。
- 上次未勾选的可选组件保持未勾选；升级时取消某个组件会撤销它（删除桌面快捷方式、关联或 PATH 项）。
- 新版本首次启动时，桌面主进程比较 `%APPDATA%\vmotion\install-state.json` 中记录的版本，只运行一次登记在 `src/desktop/version-migration.ts` 的 profile 迁移，然后记录当前版本。迁移失败不会阻止启动，下次启动重试。没有迁移时只记录版本。

## 卸载

“应用和功能”或开始菜单的 `卸载 Vmotion`：

- 删除程序文件（只删除安装器写入的顶层条目，然后在目录为空时删除安装目录）、开始菜单/桌面快捷方式、`.vmotion` 关联（仅当仍指向 Vmotion）、文件夹右键项、PATH 项和卸载注册信息。
- **保留**工程、素材、导出文件和 `%APPDATA%\vmotion`。卸载器的组件页可勾选“同时删除设置、最近项目和界面缓存”一并删除 profile。静默卸载 `/S` 保留 profile。
- 重新安装后最近项目与设置恢复，工程可直接打开。

## Windows 11 实机验收（维护者）

1. 运行 `Vmotion-Setup-<版本>-x64.exe`：不弹 UAC；默认目录 `%LOCALAPPDATA%\Programs\Vmotion`；安装目录中**没有** `portable.flag`、`profile`。
2. 开始菜单 → Vmotion 启动；新建工程、导出一段视频。确认 `%APPDATA%\vmotion\settings.json`、`recent-projects.json`、`install-state.json` 出现（`lastVersion` 为当前版本，`kind` 为 `installed`）。
3. 新开 PowerShell：`vmotion --version` 输出 package.json 版本；`vmotion mcp --project <工程>` 可被 MCP 客户端连接（或使用“连接 MCP”复制的配置）。`Get-Command vmotion` 指向 `<安装目录>\bin\vmotion.cmd`。
4. 在工程文件夹新建 `打开.vmotion`（空文件即可），双击 → 打开该工程；文件夹右键“用 Vmotion 打开”同样有效（Win11 在“显示更多选项”中）。
5. 版本号加一重新打包（或用另一版本安装包）覆盖安装：最近项目、主题设置仍在；`install-state.json` 的 `previousVersion` 为旧版本。运行中覆盖安装应提示先关闭。
6. 卸载（不勾选删除 profile）：安装目录、快捷方式、关联、PATH 项删除；工程文件和 `%APPDATA%\vmotion` 仍在。重新安装后最近项目可直接打开。
7. 再次卸载并勾选删除 profile：`%APPDATA%\vmotion` 被删除。
8. 便携 ZIP 解压运行仍使用包内 `profile`（与安装版互不影响）。
