// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CopyButton } from "@/app/element/copybutton";
import { createContentBlockPlugin } from "@/app/element/markdown-contentblock-plugin";
import {
    DefaultAppleStyleSettings,
    formatMarkdownFrontmatterValue,
    MarkdownContentBlockType,
    parseMarkdownFrontmatter,
    getMarkdownRenderProfile,
    type MarkdownRenderProfile,
    preprocessMarkdown,
    resolveRemoteFile,
    resolveRemoteFileInfo,
    resolveSrcSet,
    transformBlocks,
} from "@/app/element/markdown-util";
import remarkMermaidToTag from "@/app/element/remark-mermaid-to-tag";
import { boundNumber, useAtomValueSafe, cn } from "@/util/util";
import clsx from "clsx";
import { Atom } from "jotai";
import { OverlayScrollbarsComponent, OverlayScrollbarsComponentRef } from "overlayscrollbars-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import RemarkFlexibleToc, { TocItem } from "remark-flexible-toc";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import React from "react";
import { createBlockAtRightmost, openLink } from "../store/global";
import { IconButton } from "./iconbutton";
import "./markdown.scss";

let mermaidInitialized = false;
let mermaidInstance: any = null;

const initializeMermaid = async () => {
    if (!mermaidInitialized) {
        const mermaid = await import("mermaid");
        mermaidInstance = mermaid.default;
        mermaidInstance.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
        mermaidInitialized = true;
    }
};

const Link = ({
    setFocusedHeading,
    resolveOpts,
    props,
}: {
    props: React.AnchorHTMLAttributes<HTMLAnchorElement>;
    setFocusedHeading: (href: string) => void;
    resolveOpts?: MarkdownResolveOpts;
}) => {
    const onClick = async (e: React.MouseEvent) => {
        const href = props.href ?? "";
        if (!href) {
            return;
        }
        e.preventDefault();
        if (href.startsWith("#")) {
            setFocusedHeading(href);
            return;
        }
        if (isBlockedMarkdownHref(href)) {
            return;
        }
        if (isExternalMarkdownHref(href) || resolveOpts == null) {
            openLink(href);
            return;
        }

        const fileRef = parseMarkdownFileHref(href);
        if (fileRef.connName != null) {
            await openMarkdownFileInCurrentTab(fileRef.path, fileRef.connName);
            return;
        }

        const fileInfo = await resolveRemoteFileInfo(fileRef.path, resolveOpts);
        if (fileInfo?.path && !fileInfo.notfound) {
            await openMarkdownFileInCurrentTab(fileInfo.path, resolveOpts.connName);
            return;
        }

        openLink(href);
    };
    return (
        <a href={props.href} onClick={onClick}>
            {props.children}
        </a>
    );
};

async function openMarkdownFileInCurrentTab(filePath: string, connName?: string | null) {
    const blockDef: BlockDef = {
        meta: {
            view: "preview",
            file: filePath,
            connection: connName,
        },
    };
    await createBlockAtRightmost(blockDef);
}

function isExternalMarkdownHref(href: string): boolean {
    const trimmed = href.trim();
    if (/^\/\//.test(trimmed)) {
        return true;
    }
    const scheme = getMarkdownHrefScheme(trimmed);
    return scheme != null && scheme !== "file" && scheme !== "wsh";
}

function isBlockedMarkdownHref(href: string): boolean {
    return /^(javascript|vbscript|data):/i.test(href.trim());
}

function getMarkdownHrefScheme(href: string): string | null {
    const match = href.match(/^([a-zA-Z][a-zA-Z\d+.-]*):/);
    return match?.[1]?.toLowerCase() ?? null;
}

function parseMarkdownFileHref(href: string): { path: string; connName?: string } {
    let normalized = href.trim();
    const hashIdx = normalized.indexOf("#");
    if (hashIdx > 0) {
        normalized = normalized.slice(0, hashIdx);
    }
    if (/^file:\/\//i.test(normalized)) {
        try {
            return { path: decodeURIComponent(new URL(normalized).pathname) };
        } catch {
            return { path: normalized.replace(/^file:\/\//i, "") };
        }
    }
    if (/^wsh:\/\//i.test(normalized)) {
        try {
            const url = new URL(normalized);
            return {
                path: normalizeWshUrlPath(url.pathname),
                connName: decodeURIComponent(url.hostname || "local"),
            };
        } catch {
            return { path: normalized.replace(/^wsh:\/\/[^/]+\//i, "") };
        }
    }
    return { path: normalized };
}

function normalizeWshUrlPath(pathname: string): string {
    const decodedPathname = decodeURIComponent(pathname);
    if (decodedPathname.startsWith("//")) {
        return decodedPathname.slice(1);
    }
    if (decodedPathname === "/~" || decodedPathname.startsWith("/~/")) {
        return decodedPathname.slice(1);
    }
    return decodedPathname;
}

const Heading = ({ props, hnum }: { props: React.HTMLAttributes<HTMLHeadingElement>; hnum: number }) => {
    return (
        <div id={props.id} className={clsx("heading", `is-${hnum}`)}>
            {props.children}
        </div>
    );
};

const Mermaid = ({ chart }: { chart: string }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const renderMermaid = async () => {
            try {
                setIsLoading(true);
                setError(null);

                await initializeMermaid();
                if (!ref.current || !mermaidInstance) {
                    return;
                }

                // Normalize the chart text
                let normalizedChart = chart
                    .replace(/<br\s*\/?>/gi, "\n") // Convert <br/> and <br> to newlines
                    .replace(/\r\n?/g, "\n") // Normalize \r \r\n to \n
                    .replace(/\n+$/, ""); // Remove final newline

                ref.current.removeAttribute("data-processed");
                ref.current.textContent = normalizedChart;
                // console.log("mermaid", normalizedChart);
                await mermaidInstance.run({ nodes: [ref.current] });
                setIsLoading(false);
            } catch (err) {
                console.error("Error rendering mermaid diagram:", err);
                setError(`渲染图表失败：${err.message || err}`);
                setIsLoading(false);
            }
        };

        renderMermaid();
    }, [chart]);

    useEffect(() => {
        if (!ref.current) return;

        if (error) {
            ref.current.textContent = `错误：${error}`;
            ref.current.className = "mermaid error";
        } else if (isLoading) {
            ref.current.textContent = "图表加载中...";
            ref.current.className = "mermaid";
        } else {
            ref.current.className = "mermaid";
        }
    }, [isLoading, error]);

    return <div className="mermaid" ref={ref} />;
};

const Code = ({ className = "", children }: { className?: string; children: React.ReactNode }) => {
    if (/\blanguage-mermaid\b/.test(className)) {
        const text = Array.isArray(children) ? children.join("") : String(children ?? "");
        return <Mermaid chart={text} />;
    }
    return <code className={className}>{children}</code>;
};

type CodeBlockProps = {
    children: React.ReactNode;
    onClickExecute?: (cmd: string) => void;
};

const CodeBlock = ({ children, onClickExecute }: CodeBlockProps) => {
    const getTextContent = (children: any): string => {
        if (typeof children === "string") {
            return children;
        } else if (Array.isArray(children)) {
            return children.map(getTextContent).join("");
        } else if (children.props && children.props.children) {
            return getTextContent(children.props.children);
        }
        return "";
    };

    const handleCopy = async (e: React.MouseEvent) => {
        let textToCopy = getTextContent(children);
        textToCopy = textToCopy.replace(/\n$/, ""); // remove trailing newline
        await navigator.clipboard.writeText(textToCopy);
    };

    const handleExecute = (e: React.MouseEvent) => {
        let textToCopy = getTextContent(children);
        textToCopy = textToCopy.replace(/\n$/, ""); // remove trailing newline
        if (onClickExecute) {
            onClickExecute(textToCopy);
            return;
        }
    };

    return (
        <pre className="codeblock">
            {children}
            <div className="codeblock-actions">
                <CopyButton onClick={handleCopy} title="复制" />
                {onClickExecute && (
                    <IconButton
                        decl={{
                            elemtype: "iconbutton",
                            icon: "regular@square-terminal",
                            click: handleExecute,
                        }}
                    />
                )}
            </div>
        </pre>
    );
};

const Table = ({ props }: { props: React.TableHTMLAttributes<HTMLTableElement> }) => {
    return (
        <div className="table-wrapper">
            <table {...props} />
        </div>
    );
};

function isImageOnlyParagraph(node: any): boolean {
    if (!node || !Array.isArray(node.children) || node.children.length !== 1) {
        return false;
    }
    const child = node.children[0];
    return child?.type === "element" && (child.tagName === "img" || child.tagName === "picture");
}

const Paragraph = ({
    props,
    appleStyle,
}: {
    props: React.HTMLAttributes<HTMLParagraphElement> & { node?: any };
    appleStyle: boolean;
}) => {
    if (appleStyle && isImageOnlyParagraph((props as any).node)) {
        return <div className="paragraph apple-style-media-paragraph">{props.children}</div>;
    }
    return <div className="paragraph" {...props} />;
};

const MarkdownSource = ({
    props,
    resolveOpts,
}: {
    props: React.HTMLAttributes<HTMLSourceElement> & {
        srcSet?: string;
        media?: string;
    };
    resolveOpts: MarkdownResolveOpts;
}) => {
    const [resolvedSrcSet, setResolvedSrcSet] = useState<string>(props.srcSet);
    const [resolving, setResolving] = useState<boolean>(true);

    useEffect(() => {
        const resolvePath = async () => {
            const resolved = await resolveSrcSet(props.srcSet, resolveOpts);
            setResolvedSrcSet(resolved);
            setResolving(false);
        };

        resolvePath();
    }, [props.srcSet]);

    if (resolving) {
        return null;
    }

    return <source srcSet={resolvedSrcSet} media={props.media} />;
};

interface WaveBlockProps {
    blockkey: string;
    blockmap: Map<string, MarkdownContentBlockType>;
}

function WaveBlock(props: WaveBlockProps) {
    const { blockkey, blockmap } = props;
    const block = blockmap.get(blockkey);
    if (block == null) {
        return null;
    }
    const sizeInKB = Math.round((block.content.length / 1024) * 10) / 10;
    const displayName = block.id.replace(/^"|"$/g, "");
    return (
        <div className="waveblock">
            <div className="wave-block-content">
                <div className="wave-block-icon">
                    <i className="fas fa-file-code"></i>
                </div>
                <div className="wave-block-info">
                    <span className="wave-block-filename">{displayName}</span>
                    <span className="wave-block-size">{sizeInKB} KB</span>
                </div>
            </div>
        </div>
    );
}

const MarkdownImg = ({
    props,
    resolveOpts,
    appleStyle,
}: {
    props: React.ImgHTMLAttributes<HTMLImageElement>;
    resolveOpts: MarkdownResolveOpts;
    appleStyle: boolean;
}) => {
    const [resolvedSrc, setResolvedSrc] = useState<string>(props.src);
    const [resolvedSrcSet, setResolvedSrcSet] = useState<string>(props.srcSet);
    const [resolvedStr, setResolvedStr] = useState<string>(null);
    const [resolving, setResolving] = useState<boolean>(true);

    useEffect(() => {
        if (props.src.startsWith("data:image/")) {
            setResolving(false);
            setResolvedSrc(props.src);
            setResolvedStr(null);
            return;
        }
        if (resolveOpts == null) {
            setResolving(false);
            setResolvedSrc(null);
            setResolvedStr(`[img:${props.src}]`);
            return;
        }

        const resolveFn = async () => {
            const [resolvedSrc, resolvedSrcSet] = await Promise.all([
                resolveRemoteFile(props.src, resolveOpts),
                resolveSrcSet(props.srcSet, resolveOpts),
            ]);

            setResolvedSrc(resolvedSrc);
            setResolvedSrcSet(resolvedSrcSet);
            setResolvedStr(null);
            setResolving(false);
        };
        resolveFn();
    }, [props.src, props.srcSet]);

    if (resolving) {
        return null;
    }
    if (resolvedStr != null) {
        return <span>{resolvedStr}</span>;
    }
    if (resolvedSrc != null) {
        const imageElem = <img {...props} src={resolvedSrc} srcSet={resolvedSrcSet} className={clsx(props.className)} />;
        if (appleStyle) {
            return <figure className="apple-style-figure">{imageElem}</figure>;
        }
        return imageElem;
    }
    return <span>[img]</span>;
};

type MarkdownProps = {
    text?: string;
    textAtom?: Atom<string> | Atom<Promise<string>>;
    showTocAtom?: Atom<boolean>;
    style?: React.CSSProperties;
    className?: string;
    contentClassName?: string;
    onClickExecute?: (cmd: string) => void;
    resolveOpts?: MarkdownResolveOpts;
    scrollable?: boolean;
    rehype?: boolean;
    fontSizeOverride?: number;
    fixedFontSizeOverride?: number;
    frontmatterMode?: "inline" | "card" | "hidden";
    scrollStateKey?: string;
    initialScrollTop?: number;
    onScrollTopChange?: (scrollTop: number) => void;
};

const FrontmatterCard = ({
    frontmatter,
    appleStyle,
}: {
    frontmatter: Record<string, unknown>;
    appleStyle: boolean;
}) => {
    const entries = Object.entries(frontmatter).filter(([, value]) => value != null && formatMarkdownFrontmatterValue(value).trim());
    if (entries.length === 0) {
        return null;
    }
    return (
        <section className={clsx("frontmatter-card", appleStyle && "frontmatter-card-apple-style")}>
            <div className="frontmatter-card-header">文档信息</div>
            <div className="frontmatter-card-body">
                {entries.map(([key, value]) => (
                    <div key={key} className="frontmatter-row">
                        <div className="frontmatter-key">{key}</div>
                        <div className="frontmatter-value">{formatMarkdownFrontmatterValue(value)}</div>
                    </div>
                ))}
            </div>
        </section>
    );
};

const Markdown = ({
    text,
    textAtom,
    showTocAtom,
    style,
    className,
    contentClassName,
    resolveOpts,
    fontSizeOverride,
    fixedFontSizeOverride,
    scrollable = true,
    rehype = true,
    onClickExecute,
    frontmatterMode = "inline",
    scrollStateKey,
    initialScrollTop,
    onScrollTopChange,
}: MarkdownProps) => {
    const textAtomValue = useAtomValueSafe<string>(textAtom);
    const tocRef = useRef<TocItem[]>([]);
    const showToc = useAtomValueSafe(showTocAtom) ?? false;
    const contentsOsRef = useRef<OverlayScrollbarsComponentRef>(null);
    const [focusedHeading, setFocusedHeading] = useState<string>(null);
    const [renderProfile, setRenderProfile] = useState({
        appleStyle: resolveOpts != null,
        appleStyleSettings: DefaultAppleStyleSettings,
    } as MarkdownRenderProfile);

    // Ensure uniqueness of ids between MD preview instances.
    const [idPrefix] = useState<string>(crypto.randomUUID());

    text = textAtomValue ?? text ?? "";
    const frontmatterResult = useMemo(() => parseMarkdownFrontmatter(text), [text]);
    const markdownSource = frontmatterMode === "inline" ? text : frontmatterResult.body;
    const processedText = preprocessMarkdown(markdownSource, renderProfile);
    const transformedOutput = transformBlocks(processedText);
    const transformedText = transformedOutput.content;
    const contentBlocksMap = transformedOutput.blocks;
    const appleStyle = renderProfile.appleStyle;
    const renderedFrontmatter =
        frontmatterMode === "card" && frontmatterResult.data != null ? (
            <FrontmatterCard frontmatter={frontmatterResult.data} appleStyle={appleStyle} />
        ) : null;

    useEffect(() => {
        let disposed = false;
        if (resolveOpts == null) {
            setRenderProfile({ appleStyle: false, appleStyleSettings: DefaultAppleStyleSettings });
            return;
        }
        getMarkdownRenderProfile(resolveOpts)
            .then((profile) => {
                if (!disposed) {
                    setRenderProfile(profile);
                }
            })
            .catch(() => {
                if (!disposed) {
                    setRenderProfile({ appleStyle: false, appleStyleSettings: DefaultAppleStyleSettings });
                }
            });
        return () => {
            disposed = true;
        };
    }, [resolveOpts?.baseDir, resolveOpts?.connName]);

    useEffect(() => {
        if (focusedHeading && contentsOsRef.current && contentsOsRef.current.osInstance()) {
            const { viewport } = contentsOsRef.current.osInstance().elements();
            const heading = document.getElementById(idPrefix + focusedHeading.slice(1));
            if (heading) {
                const headingBoundingRect = heading.getBoundingClientRect();
                const viewportBoundingRect = viewport.getBoundingClientRect();
                const headingTop = headingBoundingRect.top - viewportBoundingRect.top;
                viewport.scrollBy({ top: headingTop });
            }
        }
    }, [focusedHeading]);

    useEffect(() => {
        if (!scrollable || contentsOsRef.current == null) {
            return;
        }
        const osInstance = contentsOsRef.current.osInstance();
        if (osInstance == null) {
            return;
        }
        const { viewport } = osInstance.elements();
        const handleScroll = () => {
            onScrollTopChange?.(viewport.scrollTop);
        };
        viewport.addEventListener("scroll", handleScroll);
        handleScroll();
        return () => {
            viewport.removeEventListener("scroll", handleScroll);
        };
    }, [onScrollTopChange, scrollStateKey, scrollable]);

    useEffect(() => {
        if (!scrollable || contentsOsRef.current == null) {
            return;
        }
        const targetScrollTop = Math.max(0, initialScrollTop ?? 0);
        const rafId = window.requestAnimationFrame(() => {
            const osInstance = contentsOsRef.current?.osInstance();
            const viewport = osInstance?.elements().viewport;
            if (viewport != null) {
                viewport.scrollTop = targetScrollTop;
            }
        });
        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [initialScrollTop, scrollStateKey, scrollable]);

    const markdownComponents: Partial<Components> & Record<string, any> = {
        a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
            <Link props={props} setFocusedHeading={setFocusedHeading} resolveOpts={resolveOpts} />
        ),
        p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <Paragraph props={props as any} appleStyle={appleStyle} />,
        h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => <Heading props={props} hnum={1} />,
        h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => <Heading props={props} hnum={2} />,
        h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => <Heading props={props} hnum={3} />,
        h4: (props: React.HTMLAttributes<HTMLHeadingElement>) => <Heading props={props} hnum={4} />,
        h5: (props: React.HTMLAttributes<HTMLHeadingElement>) => <Heading props={props} hnum={5} />,
        h6: (props: React.HTMLAttributes<HTMLHeadingElement>) => <Heading props={props} hnum={6} />,
        img: (props: React.HTMLAttributes<HTMLImageElement>) => (
            <MarkdownImg props={props} resolveOpts={resolveOpts} appleStyle={appleStyle} />
        ),
        source: (props: React.HTMLAttributes<HTMLSourceElement>) => (
            <MarkdownSource props={props} resolveOpts={resolveOpts} />
        ),
        table: (props: React.HTMLAttributes<HTMLTableElement>) => <Table props={props} />,
        code: Code,
        pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
            <CodeBlock children={props.children} onClickExecute={onClickExecute} />
        ),
    };
    markdownComponents["applespacer"] = () => <div className="apple-style-spacer" aria-hidden="true" />;
    markdownComponents["waveblock"] = (props: any) => <WaveBlock {...props} blockmap={contentBlocksMap} />;
    markdownComponents["mermaidblock"] = (props: any) => {
        const getTextContent = (children: any): string => {
            if (typeof children === "string") {
                return children;
            } else if (Array.isArray(children)) {
                return children.map(getTextContent).join("");
            } else if (children && typeof children === "object" && children.props && children.props.children) {
                return getTextContent(children.props.children);
            }
            return String(children || "");
        };

        const chartText = getTextContent(props.children);
        return <Mermaid chart={chartText} />;
    };

    const toc = useMemo(() => {
        if (showToc) {
            if (tocRef.current.length > 0) {
                return tocRef.current.map((item) => {
                    return (
                        <a
                            key={item.href}
                            className="toc-item"
                            style={{ "--indent-factor": item.depth } as React.CSSProperties}
                            onClick={() => setFocusedHeading(item.href)}
                        >
                            {item.value}
                        </a>
                    );
                });
            } else {
                return (
                    <div
                        className="toc-item toc-empty text-secondary"
                        style={{ "--indent-factor": 2 } as React.CSSProperties}
                    >
                        No sub-headings found
                    </div>
                );
            }
        }
    }, [showToc, tocRef]);

    let rehypePlugins = null;
    if (rehype) {
        rehypePlugins = [
            rehypeRaw,
            rehypeHighlight,
            () =>
                rehypeSanitize({
                    ...defaultSchema,
                    attributes: {
                        ...defaultSchema.attributes,
                        span: [
                            ...(defaultSchema.attributes?.span || []),
                            // Allow all class names starting with `hljs-`.
                            ["className", /^hljs-./],
                            ["srcset"],
                            ["media"],
                            ["type"],
                            // Alternatively, to allow only certain class names:
                            // ['className', 'hljs-number', 'hljs-title', 'hljs-variable']
                        ],
                        waveblock: [["blockkey"]],
                    },
                    tagNames: [
                        ...(defaultSchema.tagNames || []),
                        "span",
                        "waveblock",
                        "picture",
                        "source",
                        "mermaidblock",
                        "applespacer",
                    ],
                }),
            () => rehypeSlug({ prefix: idPrefix }),
        ];
    }
    const remarkPlugins: any = [
        remarkMermaidToTag,
        remarkGfm,
        remarkBreaks,
        [RemarkFlexibleToc, { tocRef: tocRef.current }],
        [createContentBlockPlugin, { blocks: contentBlocksMap }],
    ];

    const renderedMarkdown = (
        <>
            {renderedFrontmatter}
            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
                {transformedText}
            </ReactMarkdown>
        </>
    );

    const ScrollableMarkdown = () => {
        return (
            <OverlayScrollbarsComponent
                ref={contentsOsRef}
                className="content"
                options={{ scrollbars: { autoHide: "leave" } }}
            >
                <div className={cn("markdown-document", contentClassName)}>{renderedMarkdown}</div>
            </OverlayScrollbarsComponent>
        );
    };

    const NonScrollableMarkdown = () => {
        return (
            <div className="content non-scrollable">
                <div className={cn("markdown-document", contentClassName)}>{renderedMarkdown}</div>
            </div>
        );
    };

    const mergedStyle = { ...style };
    if (fontSizeOverride != null) {
        mergedStyle["--markdown-font-size"] = `${boundNumber(fontSizeOverride, 6, 64)}px`;
    }
    if (fixedFontSizeOverride != null) {
        mergedStyle["--markdown-fixed-font-size"] = `${boundNumber(fixedFontSizeOverride, 6, 64)}px`;
    }
    return (
        <div className={clsx("markdown", appleStyle && "markdown-apple-style", className)} style={mergedStyle}>
            {scrollable ? <ScrollableMarkdown /> : <NonScrollableMarkdown />}
            {toc && (
                <OverlayScrollbarsComponent className="toc mt-1" options={{ scrollbars: { autoHide: "leave" } }}>
                    <div className="toc-inner">
                        <h4 className="font-bold">Table of Contents</h4>
                        {toc}
                    </div>
                </OverlayScrollbarsComponent>
            )}
        </div>
    );
};

export { Markdown };
