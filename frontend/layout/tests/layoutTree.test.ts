// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { assert, test } from "vitest";
import { newLayoutNode } from "../lib/layoutNode";
import { computeMoveNode, moveNode } from "../lib/layoutTree";
import {
    DropDirection,
    LayoutTreeActionType,
    LayoutTreeComputeMoveNodeAction,
    LayoutTreeMoveNodeAction,
} from "../lib/types";
import { newLayoutTreeState } from "./model";

test("layoutTreeStateReducer - compute move", () => {
    const targetNode = newLayoutNode(undefined, undefined, undefined, { blockId: "root" });
    let node1 = newLayoutNode(undefined, undefined, undefined, { blockId: "node1" });
    let treeState = newLayoutTreeState(newLayoutNode(undefined, undefined, [node1, targetNode]));
    assert(treeState.rootNode.children!.length === 2, "root should start with two children");

    let pendingAction = computeMoveNode(treeState, {
        type: LayoutTreeActionType.ComputeMove,
        nodeId: targetNode.id,
        nodeToMoveId: node1.id,
        direction: DropDirection.Bottom,
    });
    assert(pendingAction != null, "moving an existing node should produce a pending action");

    const insertOperation = pendingAction as LayoutTreeMoveNodeAction;
    assert(insertOperation.node === node1, "insert operation node should equal node1");
    assert(insertOperation.parentId === treeState.rootNode.id, "insert operation parent should be the root node");
    assert(insertOperation.index === 2, "insert operation index should move node1 after the target");
    assert(!insertOperation.insertAtRoot, "insert operation insertAtRoot should be false");
    moveNode(treeState, insertOperation);
    assert(
        treeState.rootNode.data === undefined && treeState.rootNode.children!.length === 2,
        "root node should now have no data and should have two children"
    );
    assert(treeState.rootNode.children![1].data!.blockId === "node1", "root's second child should be node1");
});

test("computeMove - noop action", () => {
    let nodeToMove = newLayoutNode(undefined, undefined, undefined, { blockId: "nodeToMove" });
    let treeState = newLayoutTreeState(
        newLayoutNode(undefined, undefined, [
            nodeToMove,
            newLayoutNode(undefined, undefined, undefined, { blockId: "otherNode" }),
        ])
    );
    let moveAction: LayoutTreeComputeMoveNodeAction = {
        type: LayoutTreeActionType.ComputeMove,
        nodeId: treeState.rootNode.id,
        nodeToMoveId: nodeToMove.id,
        direction: DropDirection.Left,
    };
    let pendingAction = computeMoveNode(treeState, moveAction);

    assert(pendingAction === undefined, "inserting a node to the left of itself should not produce a pendingAction");

    moveAction = {
        type: LayoutTreeActionType.ComputeMove,
        nodeId: treeState.rootNode.id,
        nodeToMoveId: nodeToMove.id,
        direction: DropDirection.Right,
    };

    pendingAction = computeMoveNode(treeState, moveAction);
    assert(pendingAction === undefined, "inserting a node to the right of itself should not produce a pendingAction");
});
