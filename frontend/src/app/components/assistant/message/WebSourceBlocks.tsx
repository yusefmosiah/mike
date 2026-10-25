"use client";

import { useState } from "react";
import type { AssistantEvent } from "@/app/components/shared/types";
import { EventBlock } from "./EventBlocks";
import { EventDisclosureButton, EventLabel } from "./EventDisclosure";

type WebSearchEvent = Extract<AssistantEvent, { type: "web_search" }>;
type WebFetchEvent = Extract<AssistantEvent, { type: "web_fetch" }>;

/**
 * The URL, when it is a web address a link may point at. Results come from
 * search providers and pages, so anything else (javascript:, data:) is shown
 * as text, never linked.
 */
export function safeWebUrl(value: string): URL | null {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || url.protocol === "http:" ? url : null;
    } catch {
        return null;
    }
}

function hostOf(value: string): string {
    return safeWebUrl(value)?.hostname.replace(/^www\./, "") ?? value;
}

function WebLink({ url, children }: { url: string; children: React.ReactNode }) {
    const safe = safeWebUrl(url);
    if (!safe) return <span className="[overflow-wrap:anywhere]">{children}</span>;
    return (
        <a
            href={safe.href}
            target="_blank"
            rel="noreferrer noopener"
            title={safe.href}
            className="rounded-sm [overflow-wrap:anywhere] underline-offset-2 hover:text-gray-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
            {children}
        </a>
    );
}

/** A web search a step ran: the query, and the results it was shown. */
export function WebSearchBlock({
    event,
    showConnector,
}: {
    event: WebSearchEvent;
    showConnector?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const count = event.results.length;
    const label = event.error ? "Web search failed" : "Searched the web";
    const detail = (
        <>
            for <span className="[overflow-wrap:anywhere]">&ldquo;{event.query}&rdquo;</span>
            {event.error ? null : ` · ${count} ${count === 1 ? "result" : "results"}`}
        </>
    );
    return (
        <EventBlock showConnector={showConnector} dotColor={event.error ? "red" : "green"}>
            {count > 0 ? (
                <EventDisclosureButton
                    open={open}
                    onToggle={() => setOpen((value) => !value)}
                    label={label}
                    detail={detail}
                />
            ) : (
                <>
                    <EventLabel>{label}</EventLabel>
                    <span>&nbsp;{detail}</span>
                </>
            )}
            {open && count > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                    {event.results.map((result, index) => (
                        <li key={`${result.url}-${index}`}>
                            <WebLink url={result.url}>
                                {result.title || hostOf(result.url)}
                            </WebLink>
                            {result.title ? (
                                <span className="text-gray-400"> · {hostOf(result.url)}</span>
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </EventBlock>
    );
}

/** A web page a step read. */
export function WebFetchBlock({
    event,
    showConnector,
}: {
    event: WebFetchEvent;
    showConnector?: boolean;
}) {
    const host = hostOf(event.url);
    const partial =
        !event.error &&
        typeof event.chars_read === "number" &&
        typeof event.total_chars === "number" &&
        event.chars_read < event.total_chars;
    return (
        <EventBlock showConnector={showConnector} dotColor={event.error ? "red" : "green"}>
            <EventLabel>{event.error ? "Could not read" : "Read"}</EventLabel>
            <span>
                &nbsp;
                <WebLink url={event.url}>{event.title || host}</WebLink>
                {event.title ? <span className="text-gray-400"> · {host}</span> : null}
                {partial ? <span className="text-gray-400"> · part of the page</span> : null}
            </span>
        </EventBlock>
    );
}
