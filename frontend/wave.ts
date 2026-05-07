// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { App } from "@/app/app";
import { loadMonaco } from "@/app/monaco/monaco-env";
import { GlobalModel } from "@/app/store/global-model";
import {
    globalRefocus,
    registerControlShiftStateUpdateHandler,
    registerElectronReinjectKeyHandler,
    registerGlobalKeys,
} from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { makeTabRouteId } from "@/app/store/wshrouter";
import { initWshrpc, TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import {
    atoms,
    countersClear,
    countersPrint,
    createBlock,
    getApi,
    getFocusedBlockId,
    globalStore,
    initGlobal,
    initGlobalWaveEventSubs,
    loadConnStatus,
    loadTabIndicators,
    pushFlashError,
    pushNotification,
    replaceBlock,
    removeNotificationById,
    subscribeToConnEvents,
} from "@/store/global";
import { activeTabIdAtom } from "@/store/tab-model";
import * as WOS from "@/store/wos";
import { loadFonts } from "@/util/fontutil";
import { setKeyUtilPlatform } from "@/util/keyutil";
import { fireAndForget } from "@/util/util";
import { createElement } from "react";
import { createRoot } from "react-dom/client";

const platform = getApi().getPlatform();
document.title = `Agentfile`;
let savedInitOpts: WaveInitOpts = null;
let waveRuntimeReady = false;
const pendingFileWindowRequests: FileWindowOpenRequest[] = [];

function showStartupError(message: string) {
    document.body.style.visibility = null;
    document.body.style.opacity = null;
    document.body.classList.remove("is-transparent");
    document.body.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e5e7eb;font-family:ui-sans-serif,system-ui,sans-serif;padding:32px;">
            <div style="max-width:720px;width:100%;background:#111827;border:1px solid #374151;border-radius:16px;padding:24px 28px;box-shadow:0 20px 60px rgba(0,0,0,0.35);">
                <div style="font-size:28px;font-weight:700;margin-bottom:8px;">Agentfile 启动失败</div>
                <div style="font-size:15px;line-height:1.7;color:#cbd5e1;">${message}</div>
                <div style="margin-top:18px;font-size:13px;color:#94a3b8;">建议先重启开发窗口；如果仍然出现，再继续看 preload / main 侧日志。</div>
            </div>
        </div>
    `;
}

(window as any).WOS = WOS;
(window as any).globalStore = globalStore;
(window as any).globalAtoms = atoms;
(window as any).RpcApi = RpcApi;
(window as any).isFullScreen = false;
(window as any).countersPrint = countersPrint;
(window as any).countersClear = countersClear;
(window as any).getLayoutModelForStaticTab = getLayoutModelForStaticTab;
(window as any).pushFlashError = pushFlashError;
(window as any).pushNotification = pushNotification;
(window as any).removeNotificationById = removeNotificationById;
(window as any).modalsModel = modalsModel;

function updateZoomFactor(zoomFactor: number) {
    console.log("update zoomfactor", zoomFactor);
    document.documentElement.style.setProperty("--zoomfactor", String(zoomFactor));
    document.documentElement.style.setProperty("--zoomfactor-inv", String(1 / zoomFactor));
}

function makeFileBlockDef(request: FileWindowOpenRequest): BlockDef {
    return {
        meta: {
            view: "preview",
            file: request.filePath,
            connection: request.connection,
        },
    };
}

function getReplacementBlockId(): string {
    const focusedBlockId = getFocusedBlockId();
    if (focusedBlockId) {
        return focusedBlockId;
    }
    if (!savedInitOpts?.tabId) {
        return null;
    }
    const tab = WOS.getObjectValue<Tab>(WOS.makeORef("tab", savedInitOpts.tabId));
    return tab?.blockids?.[0] ?? null;
}

async function openFileInCurrentWindow(request: FileWindowOpenRequest) {
    const blockDef = makeFileBlockDef(request);
    const targetBlockId = getReplacementBlockId();
    if (targetBlockId) {
        await replaceBlock(targetBlockId, blockDef, true);
        return;
    }
    await createBlock(blockDef);
}

function flushPendingFileWindowRequests() {
    if (!waveRuntimeReady || pendingFileWindowRequests.length === 0) {
        return;
    }
    const requests = pendingFileWindowRequests.splice(0, pendingFileWindowRequests.length);
    for (const request of requests) {
        fireAndForget(async () => {
            await openFileInCurrentWindow(request);
        });
    }
}

async function initBare() {
    const nativeApi = (window as any).api;
    if (!nativeApi?.onWaveInit) {
        showStartupError("桌面桥接没有加载，界面已进入降级错误页，避免继续白屏。");
        return;
    }
    getApi().sendLog("Init Bare");
    document.body.style.visibility = "hidden";
    document.body.style.opacity = "0";
    document.body.classList.add("is-transparent");
    getApi().onWaveInit(initWaveWrap);
    setKeyUtilPlatform(platform);
    loadFonts();
    updateZoomFactor(getApi().getZoomFactor());
    getApi().onZoomFactorChange((zoomFactor) => {
        updateZoomFactor(zoomFactor);
    });
    getApi().onOpenFileInCurrentWindow((request) => {
        if (!request?.filePath) {
            return;
        }
        if (!waveRuntimeReady) {
            pendingFileWindowRequests.push(request);
            return;
        }
        fireAndForget(async () => {
            await openFileInCurrentWindow(request);
        });
    });
    document.fonts.ready.then(() => {
        console.log("Init Bare Done");
        getApi().setWindowInitStatus("ready");
    });
}

document.addEventListener("DOMContentLoaded", initBare);

async function initWaveWrap(initOpts: WaveInitOpts) {
    try {
        if (savedInitOpts) {
            await reinitWave();
            return;
        }
        savedInitOpts = initOpts;
        await initWave(initOpts);
    } catch (e) {
        getApi().sendLog("Error in initWave " + e.message + "\n" + e.stack);
        console.error("Error in initWave", e);
    } finally {
        document.body.style.visibility = null;
        document.body.style.opacity = null;
        document.body.classList.remove("is-transparent");
    }
}

async function reinitWave() {
    console.log("Reinit Wave");
    getApi().sendLog("Reinit Wave");

    // We use this hack to prevent a flicker of the previously-hovered tab when this view was last active.
    document.body.classList.add("nohover");
    requestAnimationFrame(() =>
        setTimeout(() => {
            document.body.classList.remove("nohover");
        }, 100)
    );

    await WOS.reloadWaveObject<Client>(WOS.makeORef("client", savedInitOpts.clientId));
    const waveWindow = await WOS.reloadWaveObject<WaveWindow>(WOS.makeORef("window", savedInitOpts.windowId));
    const ws = await WOS.reloadWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid));
    const initialTab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", savedInitOpts.tabId));
    await WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", initialTab.layoutstate));
    reloadAllWorkspaceTabs(ws);
    document.title = `Agentfile - ${initialTab.name}`; // TODO update with tab name change
    getApi().setWindowInitStatus("wave-ready");
    waveRuntimeReady = true;
    flushPendingFileWindowRequests();
    globalStore.set(atoms.reinitVersion, globalStore.get(atoms.reinitVersion) + 1);
    globalStore.set(atoms.updaterStatusAtom, getApi().getUpdaterStatus());
    setTimeout(() => {
        globalRefocus();
    }, 50);
}

function reloadAllWorkspaceTabs(ws: Workspace) {
    if (ws == null || !ws.tabids?.length) {
        return;
    }
    ws.tabids?.forEach((tabid) => {
        WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabid));
    });
}

function loadAllWorkspaceTabs(ws: Workspace) {
    if (ws == null || !ws.tabids?.length) {
        return;
    }
    ws.tabids?.forEach((tabid) => {
        WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabid));
    });
}

async function initWave(initOpts: WaveInitOpts) {
    getApi().sendLog("Init Wave " + JSON.stringify(initOpts));
    const globalInitOpts: GlobalInitOptions = {
        tabId: initOpts.tabId,
        clientId: initOpts.clientId,
        windowId: initOpts.windowId,
        platform,
        environment: "renderer",
        primaryTabStartup: initOpts.primaryTabStartup,
    };
    console.log("Wave Init", globalInitOpts);
    globalStore.set(activeTabIdAtom, initOpts.tabId);
    await GlobalModel.getInstance().initialize(globalInitOpts);
    initGlobal(globalInitOpts);
    (window as any).globalAtoms = atoms;

    // Init WPS event handlers
    const globalWS = initWshrpc(makeTabRouteId(initOpts.tabId));
    (window as any).globalWS = globalWS;
    (window as any).TabRpcClient = TabRpcClient;
    await loadConnStatus();
    await loadTabIndicators();
    initGlobalWaveEventSubs(initOpts);
    subscribeToConnEvents();

    // ensures client/window/workspace are loaded into the cache before rendering
    try {
        const [client, waveWindow, initialTab] = await Promise.all([
            WOS.loadAndPinWaveObject<Client>(WOS.makeORef("client", initOpts.clientId)),
            WOS.loadAndPinWaveObject<WaveWindow>(WOS.makeORef("window", initOpts.windowId)),
            WOS.loadAndPinWaveObject<Tab>(WOS.makeORef("tab", initOpts.tabId)),
        ]);
        const [ws, layoutState] = await Promise.all([
            WOS.loadAndPinWaveObject<Workspace>(WOS.makeORef("workspace", waveWindow.workspaceid)),
            WOS.reloadWaveObject<LayoutState>(WOS.makeORef("layout", initialTab.layoutstate)),
        ]);
        loadAllWorkspaceTabs(ws);
        WOS.wpsSubscribeToObject(WOS.makeORef("workspace", waveWindow.workspaceid));
        document.title = `Agentfile - ${initialTab.name}`; // TODO update with tab name change
    } catch (e) {
        console.error("Failed initialization error", e);
        getApi().sendLog("Error in initialization (wave.ts, loading required objects) " + e.message + "\n" + e.stack);
    }
    registerGlobalKeys();
    registerElectronReinjectKeyHandler();
    registerControlShiftStateUpdateHandler();
    await loadMonaco();
    const fullConfig = await RpcApi.GetFullConfigCommand(TabRpcClient);
    console.log("fullconfig", fullConfig);
    globalStore.set(atoms.fullConfigAtom, fullConfig);
    console.log("Wave First Render");
    let firstRenderResolveFn: () => void = null;
    let firstRenderPromise = new Promise<void>((resolve) => {
        firstRenderResolveFn = resolve;
    });
    const reactElem = createElement(App, { onFirstRender: firstRenderResolveFn }, null);
    const elem = document.getElementById("main");
    const root = createRoot(elem);
    root.render(reactElem);
    await firstRenderPromise;
    console.log("Wave First Render Done");
    getApi().setWindowInitStatus("wave-ready");
    waveRuntimeReady = true;
    flushPendingFileWindowRequests();
}
