// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import Logo from "@/app/asset/logo.svg";
import { modalsModel } from "@/app/store/modalmodel";
import { Modal } from "./modal";

import { useState } from "react";
import { getApi } from "../store/global";

interface AboutModalProps {}

const AboutModal = ({}: AboutModalProps) => {
    const currentDate = new Date();
    const [details] = useState(() => getApi().getAboutModalDetails());
    const [updaterChannel] = useState(() => getApi().getUpdaterChannel());

    return (
        <Modal className="pt-[34px] pb-[34px]" onClose={() => modalsModel.popModal()}>
            <div className="flex flex-col gap-[26px] w-full">
                <div className="flex flex-col items-center justify-center gap-4 self-stretch w-full text-center">
                    <Logo />
                    <div className="text-[25px]">Agentfile</div>
                    <div className="leading-5">
                        开源的 AI 文件工作台
                        <br />
                        为连续工作流而设计
                    </div>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    客户端版本 {details.version} ({details.buildTime})
                    <br />
                    更新通道：{updaterChannel}
                </div>
                <div className="flex flex-col items-center gap-3 self-stretch w-full text-center">
                    <div className="text-sm leading-5 text-secondary">
                        Maintained by Chengfeng / Ceeon
                        <br />
                        小红书：AI产品自由 / 1051267243
                    </div>
                    <img
                        src="/contact/wechat-search-contact.png"
                        alt="微信搜一搜 AI产品自由"
                        className="w-[260px] max-w-full rounded border border-border bg-white"
                    />
                </div>
                <div className="flex items-start justify-center gap-[10px] self-stretch w-full text-center flex-wrap">
                    <a
                        href="https://github.com/Ceeon/agentfile?ref=about"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-brands fa-github mr-2"></i>GitHub
                    </a>
                    <a
                        href="https://x.com/chengfeng240928"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-brands fa-x-twitter mr-2"></i>X
                    </a>
                    <a
                        href="https://github.com/Ceeon/agentfile/blob/main/ACKNOWLEDGEMENTS.md"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-heart mr-2"></i>致谢
                    </a>
                    <a
                        href="https://github.com/Ceeon/agentfile/blob/main/LICENSE"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-scale-balanced mr-2"></i>Apache-2.0
                    </a>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    &copy; {currentDate.getFullYear()} Ceeon and Agentfile contributors.
                    <br />
                    Based on Wave Terminal by Command Line Inc.
                </div>
            </div>
        </Modal>
    );
};

AboutModal.displayName = "AboutModal";

export { AboutModal };
