// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import Logo from "@/app/asset/logo.svg";
import { Button } from "@/app/element/button";
import { FlexiModal } from "@/app/modals/modal";
import { OnboardingFeatures } from "@/app/onboarding/onboarding-features";
import { ClientModel } from "@/app/store/client-model";
import { atoms } from "@/app/store/global";
import { disableGlobalKeybindings, enableGlobalKeybindings, globalRefocus } from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import * as services from "@/store/services";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtom, useAtomValue, useSetAtom } from "jotai";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import { useEffect, useRef, useState } from "react";
import { debounce } from "throttle-debounce";

// Page flow:
//   init -> (telemetry enabled) -> features
//   init -> (telemetry disabled) -> notelemetrystar -> features

type PageName = "init" | "notelemetrystar" | "features";

const pageNameAtom: PrimitiveAtom<PageName> = atom<PageName>("init");

const InitPage = ({ isCompact }: { isCompact: boolean }) => {
    const settings = useAtomValue(atoms.settingsAtom);
    const clientData = useAtomValue(ClientModel.getInstance().clientAtom);
    const [telemetryEnabled, setTelemetryEnabled] = useState<boolean>(!!settings["telemetry:enabled"]);
    const setPageName = useSetAtom(pageNameAtom);

    const acceptTos = () => {
        if (!clientData.tosagreed) {
            fireAndForget(services.ClientService.AgreeTos);
        }
        if (telemetryEnabled) {
            WorkspaceLayoutModel.getInstance().setAIPanelVisible(true);
        }
        setPageName(telemetryEnabled ? "features" : "notelemetrystar");
    };

    const setTelemetry = (value: boolean) => {
        fireAndForget(() =>
            services.ClientService.TelemetryUpdate(value).then(() => {
                setTelemetryEnabled(value);
            })
        );
    };

    const label = telemetryEnabled ? "已开启" : "已关闭";

    return (
        <div className="flex flex-col h-full">
            <header
                className={`flex flex-col gap-2 border-b-0 p-0 ${isCompact ? "mt-1 mb-4" : "mb-9"} w-full unselectable flex-shrink-0`}
            >
                <div className={`${isCompact ? "" : "mb-2.5"} flex justify-center`}>
                    <Logo />
                </div>
                <div className="text-center text-[25px] font-normal text-foreground">欢迎使用 Agentfile</div>
            </header>
            <OverlayScrollbarsComponent
                className="flex-1 overflow-y-auto min-h-0"
                options={{ scrollbars: { autoHide: "never" } }}
            >
                <div className="flex flex-col items-start gap-8 w-full mb-5 unselectable">
                    <div className="flex w-full items-center gap-[18px]">
                        <div>
                            <a
                                target="_blank"
                                href="https://github.com/wavetermdev/waveterm?ref=install"
                                rel={"noopener"}
                            >
                                <i className="text-[32px] text-white/50 fa-brands fa-github"></i>
                            </a>
                        </div>
                        <div className="flex flex-col items-start gap-1 flex-1">
                            <div className="text-foreground text-base leading-[18px]">在 GitHub 上支持我们</div>
                            <div className="text-secondary leading-5">
                                我们是<i>开源项目</i>，并致力于为个人用户提供免费的工作台。欢迎通过在{" "}
                                <a
                                    target="_blank"
                                    href="https://github.com/wavetermdev/waveterm?ref=install"
                                    rel={"noopener"}
                                >
                                    GitHub&nbsp;(wavetermdev/waveterm)
                                </a>
                                上点亮 Star 来支持我们。
                            </div>
                        </div>
                    </div>
                    <div className="flex w-full items-center gap-[18px]">
                        <div>
                            <a target="_blank" href="https://discord.gg/XfvZ334gwU" rel={"noopener"}>
                                <i className="text-[25px] text-white/50 fa-solid fa-people-group"></i>
                            </a>
                        </div>
                        <div className="flex flex-col items-start gap-1 flex-1">
                            <div className="text-foreground text-base leading-[18px]">加入社区</div>
                            <div className="text-secondary leading-5">
                                获取帮助、提交功能建议、反馈 Bug，或和其他用户交流。
                                <br />
                                <a target="_blank" href="https://discord.gg/XfvZ334gwU" rel={"noopener"}>
                                    加入 Agentfile&nbsp;Discord&nbsp;频道
                                </a>
                            </div>
                        </div>
                    </div>
                    <div className="flex w-full items-center gap-[18px]">
                        <div>
                            <i className="text-[32px] text-white/50 fa-solid fa-chart-line"></i>
                        </div>
                        <div className="flex flex-col items-start gap-1 flex-1">
                            <div className="text-secondary leading-5">
                                匿名使用数据可以帮助我们持续改进你正在使用的功能。
                                <br />
                                <a
                                    className="plain-link"
                                    target="_blank"
                                    href="https://waveterm.dev/privacy"
                                    rel="noopener"
                                >
                                    隐私政策
                                </a>
                            </div>
                            <label className="flex items-center gap-2 cursor-pointer text-secondary">
                                <input
                                    type="checkbox"
                                    checked={telemetryEnabled}
                                    onChange={(e) => setTelemetry(e.target.checked)}
                                    className="cursor-pointer accent-gray-500"
                                />
                                <span>{label}</span>
                            </label>
                        </div>
                    </div>
                </div>
            </OverlayScrollbarsComponent>
            <footer className={`unselectable flex-shrink-0 ${isCompact ? "mt-2" : "mt-5"}`}>
                <div className="flex flex-row items-center justify-center [&>button]:!px-5 [&>button]:!py-2 [&>button]:text-sm [&>button:not(:first-child)]:ml-2.5">
                    <Button className="font-[600]" onClick={acceptTos}>
                        继续
                    </Button>
                </div>
            </footer>
        </div>
    );
};

const NoTelemetryStarPage = ({ isCompact }: { isCompact: boolean }) => {
    const setPageName = useSetAtom(pageNameAtom);

    const handleStarClick = async () => {
        const clientId = ClientModel.getInstance().clientId;
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", clientId),
            meta: { "onboarding:githubstar": true },
        });
        window.open("https://github.com/wavetermdev/waveterm?ref=not", "_blank");
        setPageName("features");
    };

    const handleMaybeLater = async () => {
        const clientId = ClientModel.getInstance().clientId;
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", clientId),
            meta: { "onboarding:githubstar": false },
        });
        setPageName("features");
    };

    return (
        <div className="flex flex-col h-full">
            <header className={`flex flex-col gap-2 border-b-0 p-0 mt-1 mb-4 w-full unselectable flex-shrink-0`}>
                <div className={`flex justify-center`}>
                    <Logo />
                </div>
                <div className="text-center text-[25px] font-normal text-foreground">遥测已关闭 ✓</div>
            </header>
            <OverlayScrollbarsComponent
                className="flex-1 overflow-y-auto min-h-0"
                options={{ scrollbars: { autoHide: "never" } }}
            >
                <div className="flex flex-col items-center gap-6 w-full mb-2 unselectable">
                    <div className="text-center text-secondary leading-relaxed max-w-md">
                        <p className="mb-4">没问题，我们尊重你的隐私。</p>
                        <p className="mb-4">
                            但如果没有使用数据，我们就很难判断产品是否真的有帮助。一个 GitHub Star 能让我们知道
                            Agentfile 值得继续投入和维护。
                        </p>
                    </div>
                </div>
            </OverlayScrollbarsComponent>
            <footer className={`unselectable flex-shrink-0 mt-2`}>
                <div className="flex flex-row items-center justify-center gap-2.5 [&>button]:!px-5 [&>button]:!py-2 [&>button]:text-sm [&>button]:!h-[37px]">
                    <Button className="outlined green font-[600]" onClick={handleStarClick}>
                        ⭐ 去 GitHub 点亮 Star
                    </Button>
                    <Button className="outlined grey font-[600]" onClick={handleMaybeLater}>
                        稍后再说
                    </Button>
                </div>
            </footer>
        </div>
    );
};

const FeaturesPage = () => {
    const [newInstallOnboardingOpen, setNewInstallOnboardingOpen] = useAtom(modalsModel.newInstallOnboardingOpen);

    const handleComplete = () => {
        setNewInstallOnboardingOpen(false);
        setTimeout(() => {
            globalRefocus();
        }, 10);
    };

    return <OnboardingFeatures onComplete={handleComplete} />;
};

const NewInstallOnboardingModal = () => {
    const modalRef = useRef<HTMLDivElement | null>(null);
    const [pageName, setPageName] = useAtom(pageNameAtom);
    const clientData = useAtomValue(ClientModel.getInstance().clientAtom);
    const [isCompact, setIsCompact] = useState<boolean>(window.innerHeight < 800);

    const updateModalHeight = () => {
        const windowHeight = window.innerHeight;
        setIsCompact(windowHeight < 800);
        if (modalRef.current) {
            const modalHeight = modalRef.current.offsetHeight;
            const maxHeight = windowHeight * 0.9;
            if (maxHeight < modalHeight) {
                modalRef.current.style.height = `${maxHeight}px`;
            } else {
                modalRef.current.style.height = "auto";
            }
        }
    };

    useEffect(() => {
        if (clientData.tosagreed) {
            setPageName("features");
        }
        return () => {
            setPageName("init");
        };
    }, []);

    useEffect(() => {
        updateModalHeight();
        const debouncedUpdateModalHeight = debounce(150, updateModalHeight);
        window.addEventListener("resize", debouncedUpdateModalHeight);
        return () => {
            window.removeEventListener("resize", debouncedUpdateModalHeight);
        };
    }, []);

    useEffect(() => {
        disableGlobalKeybindings();
        return () => {
            enableGlobalKeybindings();
        };
    }, []);

    let pageComp: React.JSX.Element = null;
    switch (pageName) {
        case "init":
            pageComp = <InitPage isCompact={isCompact} />;
            break;
        case "notelemetrystar":
            pageComp = <NoTelemetryStarPage isCompact={isCompact} />;
            break;
        case "features":
            pageComp = <FeaturesPage />;
            break;
    }
    if (pageComp == null) {
        return null;
    }

    const paddingClass = isCompact ? "!py-3 !px-[30px]" : "!p-[30px]";
    const widthClass = pageName === "features" ? "w-[800px]" : "w-[560px]";

    return (
        <FlexiModal className={`${widthClass} rounded-[10px] ${paddingClass} relative overflow-hidden`} ref={modalRef}>
            <div className="absolute inset-0 bg-gradient-to-br from-accent/[0.25] via-transparent to-accent/[0.05] pointer-events-none rounded-[10px]" />
            <div className="flex flex-col w-full h-full relative z-10">{pageComp}</div>
        </FlexiModal>
    );
};

NewInstallOnboardingModal.displayName = "NewInstallOnboardingModal";

export { NewInstallOnboardingModal };
