// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { memo } from "react";

interface WaveAIVisualContentProps {
    model: WaveConfigViewModel;
}

export const WaveAIVisualContent = memo(({ model }: WaveAIVisualContentProps) => {
    return (
        <div className="flex flex-col gap-4 p-6 h-full">
            <div className="text-lg font-semibold">AI 模式 - 可视化编辑器</div>
            <div className="text-muted-foreground">可视化编辑器即将推出...</div>
        </div>
    );
});

WaveAIVisualContent.displayName = "WaveAIVisualContent";
