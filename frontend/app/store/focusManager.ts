import { atoms, getBlockComponentModel } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { focusedBlockId } from "@/util/focusutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { Atom, atom, type PrimitiveAtom } from "jotai";

export type FocusStrType = "node" | "waveai";

export class FocusManager {
    private static instance: FocusManager | null = null;

    focusType: PrimitiveAtom<FocusStrType> = atom("node");
    blockFocusAtom: Atom<string | null>;

    private constructor() {
        this.blockFocusAtom = atom((get) => {
            if (get(this.focusType) == "waveai") {
                return null;
            }
            const layoutModel = getLayoutModelForStaticTab();
            const lnode = get(layoutModel.focusedNode);
            return lnode?.data?.blockId;
        });
    }

    static getInstance(): FocusManager {
        if (!FocusManager.instance) {
            FocusManager.instance = new FocusManager();
        }
        return FocusManager.instance;
    }

    setWaveAIFocused(force: boolean = false) {
        this.setBlockFocus(force);
    }

    setBlockFocus(force: boolean = false) {
        const ftype = globalStore.get(this.focusType);
        if (!force && ftype == "node") {
            return;
        }
        globalStore.set(this.focusType, "node");
        this.refocusNode();
    }

    waveAIFocusWithin(): boolean {
        return false;
    }

    nodeFocusWithin(): boolean {
        return focusedBlockId() != null;
    }

    requestNodeFocus(): void {
        globalStore.set(this.focusType, "node");
    }

    requestWaveAIFocus(): void {
        globalStore.set(this.focusType, "node");
    }

    getFocusType(): FocusStrType {
        const ftype = globalStore.get(this.focusType);
        return ftype === "waveai" ? "node" : ftype;
    }

    refocusNode() {
        const layoutModel = getLayoutModelForStaticTab();
        const lnode = globalStore.get(layoutModel.focusedNode);
        if (lnode == null || lnode.data?.blockId == null) {
            return;
        }
        layoutModel.focusNode(lnode.id);
        const blockId = lnode.data.blockId;
        const bcm = getBlockComponentModel(blockId);
        const ok = bcm?.viewModel?.giveFocus?.();
        if (!ok) {
            const inputElem = document.getElementById(`${blockId}-dummy-focus`);
            inputElem?.focus();
        }
    }
}
