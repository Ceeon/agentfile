// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import { ImperativePanelGroupHandle, ImperativePanelHandle } from "react-resizable-panels";

class WorkspaceLayoutModel {
    private static instance: WorkspaceLayoutModel | null = null;

    aiPanelRef: ImperativePanelHandle | null = null;
    panelGroupRef: ImperativePanelGroupHandle | null = null;
    panelContainerRef: HTMLDivElement | null = null;
    aiPanelWrapperRef: HTMLDivElement | null = null;
    inResize = false;
    panelVisibleAtom = jotai.atom(false);

    static getInstance(): WorkspaceLayoutModel {
        if (WorkspaceLayoutModel.instance == null) {
            WorkspaceLayoutModel.instance = new WorkspaceLayoutModel();
        }
        return WorkspaceLayoutModel.instance;
    }

    registerRefs(
        aiPanelRef: ImperativePanelHandle,
        panelGroupRef: ImperativePanelGroupHandle,
        panelContainerRef: HTMLDivElement,
        aiPanelWrapperRef: HTMLDivElement
    ): void {
        this.aiPanelRef = aiPanelRef;
        this.panelGroupRef = panelGroupRef;
        this.panelContainerRef = panelContainerRef;
        this.aiPanelWrapperRef = aiPanelWrapperRef;
    }

    updateWrapperWidth(): void {}

    enableTransitions(_duration: number): void {}

    handleWindowResize(): void {}

    handlePanelLayout(_sizes: number[]): void {}

    syncAIPanelRef(): void {}

    getMaxAIPanelWidth(windowWidth: number): number {
        return windowWidth;
    }

    getClampedAIPanelWidth(width: number): number {
        return width;
    }

    getAIPanelVisible(): boolean {
        return false;
    }

    setAIPanelVisible(_visible: boolean, _opts?: { nofocus?: boolean }): void {}

    getAIPanelWidth(): number {
        return 0;
    }

    setAIPanelWidth(_width: number): void {}

    getAIPanelPercentage(_windowWidth: number): number {
        return 0;
    }

    getMainContentPercentage(_windowWidth: number): number {
        return 100;
    }

    handleAIPanelResize(_width: number, _windowWidth: number): void {}
}

export { WorkspaceLayoutModel };
