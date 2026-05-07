// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { contextBridge, ipcRenderer, Rectangle } from "electron";

// update type in custom.d.ts (ElectronApi type)
contextBridge.exposeInMainWorld("api", {
    getAuthKey: () => ipcRenderer.sendSync("get-auth-key"),
    getIsDev: () => ipcRenderer.sendSync("get-is-dev"),
    getPlatform: () => ipcRenderer.sendSync("get-platform"),
    getCursorPoint: () => ipcRenderer.sendSync("get-cursor-point"),
    getUserName: () => ipcRenderer.sendSync("get-user-name"),
    getHostName: () => ipcRenderer.sendSync("get-host-name"),
    getDataDir: () => ipcRenderer.sendSync("get-data-dir"),
    getConfigDir: () => ipcRenderer.sendSync("get-config-dir"),
    getHomeDir: () => ipcRenderer.sendSync("get-home-dir"),
    getAboutModalDetails: () => ipcRenderer.sendSync("get-about-modal-details"),
    getZoomFactor: () => ipcRenderer.sendSync("get-zoom-factor"),
    openNewWindow: () => ipcRenderer.send("open-new-window"),
    openFileInNewTab: (filePath: string, connection?: string) =>
        ipcRenderer.send("open-file-in-new-tab", { filePath, connection }),
    registerGlobalWebviewKeys: (_keys: string[]) => {},
    showWorkspaceAppMenu: (workspaceId) => ipcRenderer.send("workspace-appmenu-show", workspaceId),
    showContextMenu: (workspaceId, menu) => ipcRenderer.send("contextmenu-show", workspaceId, menu),
    onContextMenuClick: (callback) => ipcRenderer.on("contextmenu-click", (_event, id) => callback(id)),
    downloadFile: (filePath) => ipcRenderer.send("download", { filePath }),
    openExternal: (url) => {
        if (url && typeof url === "string") {
            ipcRenderer.send("open-external", url);
        } else {
            console.error("Invalid URL passed to openExternal:", url);
        }
    },
    getEnv: (varName) => ipcRenderer.sendSync("get-env", varName),
    onFullScreenChange: (callback) =>
        ipcRenderer.on("fullscreen-change", (_event, isFullScreen) => callback(isFullScreen)),
    onZoomFactorChange: (callback) =>
        ipcRenderer.on("zoom-factor-change", (_event, zoomFactor) => callback(zoomFactor)),
    onUpdaterStatusChange: (callback) => ipcRenderer.on("app-update-status", (_event, status) => callback(status)),
    getUpdaterStatus: () => ipcRenderer.sendSync("get-app-update-status"),
    getUpdaterChannel: () => ipcRenderer.sendSync("get-updater-channel"),
    installAppUpdate: () => ipcRenderer.send("install-app-update"),
    onMenuItemAbout: (callback) => ipcRenderer.on("menu-item-about", callback),
    onMenuItemSettings: (callback) => ipcRenderer.on("menu-item-settings", callback),
    onMenuItemNewFolderWindow: (callback) => ipcRenderer.on("menu-item-new-folder-window", callback),
    updateWindowControlsOverlay: (rect) => ipcRenderer.send("update-window-controls-overlay", rect),
    onReinjectKey: (callback) => ipcRenderer.on("reinject-key", (_event, waveEvent) => callback(waveEvent)),
    onControlShiftStateUpdate: (callback) =>
        ipcRenderer.on("control-shift-state-update", (_event, state) => callback(state)),
    createWorkspace: () => ipcRenderer.send("create-workspace"),
    switchWorkspace: (workspaceId) => ipcRenderer.send("switch-workspace", workspaceId),
    deleteWorkspace: (workspaceId) => ipcRenderer.send("delete-workspace", workspaceId),
    setActiveTab: (tabId) => ipcRenderer.send("set-active-tab", tabId),
    createTab: () => ipcRenderer.send("create-tab"),
    closeTab: (workspaceId, tabId) => ipcRenderer.send("close-tab", workspaceId, tabId),
    setWindowInitStatus: (status) => ipcRenderer.send("set-window-init-status", status),
    onWaveInit: (callback) => {
        const listener = (_event, initOpts) => callback(initOpts);
        ipcRenderer.on("wave-init", listener);
        return () => ipcRenderer.removeListener("wave-init", listener);
    },
    onOpenFileInCurrentWindow: (callback) => {
        const listener = (_event, request) => callback(request);
        ipcRenderer.on("open-file-in-current-window", listener);
        return () => ipcRenderer.removeListener("open-file-in-current-window", listener);
    },
    sendLog: (log) => ipcRenderer.send("fe-log", log),
    onQuicklook: (filePath: string) => ipcRenderer.send("quicklook", filePath),
    openNativePath: (filePath: string) => ipcRenderer.send("open-native-path", filePath),
    openExternalTerminal: (cwd: string, connection?: string) => ipcRenderer.send("open-external-terminal", { cwd, connection }),
    openDirectoryTarget: (target: DirectoryOpenTarget, cwd: string, connection?: string) =>
        ipcRenderer.send("open-directory-target", { target, cwd, connection }),
    listDirectoryOpenTargets: (connection?: string) => ipcRenderer.invoke("list-directory-open-targets", connection),
    listExternalTerminalApps: () => ipcRenderer.invoke("list-external-terminal-apps"),
    openFileInBrowser: (filePath: string) => ipcRenderer.send("open-file-in-browser", filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.send("show-item-in-folder", filePath),
    writeClipboardText: (text: string) => ipcRenderer.invoke("write-clipboard-text", text),
    writeClipboardHtml: (html: string, text?: string) => ipcRenderer.invoke("write-clipboard-html", { html, text }),
    captureScreenshot: (rect: Rectangle) => ipcRenderer.invoke("capture-screenshot", rect),
    setKeyboardChordMode: () => ipcRenderer.send("set-keyboard-chord-mode"),
    incrementTermCommands: () => ipcRenderer.send("increment-term-commands"),
    nativePaste: () => ipcRenderer.send("native-paste"),
    doRefresh: () => ipcRenderer.send("do-refresh"),
    readClipboardFiles: () => ipcRenderer.invoke("read-clipboard-files"),
    readClipboardImage: () => ipcRenderer.invoke("read-clipboard-image"),
});
