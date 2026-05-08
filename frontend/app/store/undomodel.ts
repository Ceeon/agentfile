// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type UndoActionKind = "close-block";

type UndoAction = {
    id: string;
    kind: UndoActionKind;
    run: () => void | Promise<void>;
    expiresAt?: number;
};

const undoActions: UndoAction[] = [];

function removeExpiredUndoActions() {
    const now = Date.now();
    for (let idx = undoActions.length - 1; idx >= 0; idx--) {
        const action = undoActions[idx];
        if (action.expiresAt != null && action.expiresAt <= now) {
            undoActions.splice(idx, 1);
        }
    }
}

function pushUndoAction(action: UndoAction) {
    const existingIdx = undoActions.findIndex((item) => item.id === action.id);
    if (existingIdx >= 0) {
        undoActions.splice(existingIdx, 1);
    }
    undoActions.push(action);
}

function runUndoAction(id: string): boolean {
    removeExpiredUndoActions();
    const actionIdx = undoActions.findIndex((action) => action.id === id);
    if (actionIdx < 0) {
        return false;
    }
    const [action] = undoActions.splice(actionIdx, 1);
    void action.run();
    return true;
}

function runLastUndoAction(kind?: UndoActionKind): boolean {
    removeExpiredUndoActions();
    for (let idx = undoActions.length - 1; idx >= 0; idx--) {
        const action = undoActions[idx];
        if (kind != null && action.kind !== kind) {
            continue;
        }
        undoActions.splice(idx, 1);
        void action.run();
        return true;
    }
    return false;
}

function removeUndoAction(id: string) {
    const actionIdx = undoActions.findIndex((action) => action.id === id);
    if (actionIdx >= 0) {
        undoActions.splice(actionIdx, 1);
    }
}

export { pushUndoAction, removeUndoAction, runLastUndoAction, runUndoAction };
