// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, isDev, pushNotification } from "@/store/global";
import { useAtomValue } from "jotai";
import { useEffect } from "react";

export const useUpdateNotifier = () => {
    const appUpdateStatus = useAtomValue(atoms.updaterStatusAtom);

    useEffect(() => {
        let notification: NotificationType | null = null;

        switch (appUpdateStatus) {
            case "ready":
                notification = {
                    id: "update-notification",
                    icon: "arrows-rotate",
                    title: "发现可用更新",
                    message: "新版本已可用，随时可以开始安装。",
                    timestamp: new Date().toLocaleString(),
                    type: "update",
                    actions: [
                        {
                            label: "立即安装",
                            actionKey: "installUpdate",
                            color: "green",
                            disabled: false,
                        },
                    ],
                };
                break;

            case "downloading":
                notification = {
                    id: "update-notification",
                    icon: "arrows-rotate",
                    title: "正在下载更新",
                    message: "更新正在下载中。",
                    timestamp: new Date().toLocaleString(),
                    type: "update",
                    actions: [
                        {
                            label: "下载中...",
                            actionKey: "",
                            color: "green",
                            disabled: true,
                        },
                    ],
                };
                break;

            case "installing":
                notification = {
                    id: "update-notification",
                    icon: "arrows-rotate",
                    title: "正在安装更新",
                    message: "更新正在安装中。",
                    timestamp: new Date().toLocaleString(),
                    type: "update",
                    actions: [
                        {
                            label: "安装中...",
                            actionKey: "",
                            color: "green",
                            disabled: true,
                        },
                    ],
                };
                break;

            case "error":
                notification = {
                    id: "update-notification",
                    icon: "circle-exclamation",
                    title: "更新失败",
                    message: "更新过程中发生错误。",
                    timestamp: new Date().toLocaleString(),
                    type: "update",
                    actions: [
                        {
                            label: "重试更新",
                            actionKey: "retryUpdate",
                            color: "green",
                            disabled: false,
                        },
                    ],
                };
                break;
        }

        if (!isDev()) return;

        if (notification) {
            pushNotification(notification);
        }
    }, [appUpdateStatus]);
};
