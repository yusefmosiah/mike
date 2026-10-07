"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    createBranch,
    fetchSiblings,
    getChat,
    setChatLeaf,
} from "@/app/lib/mikeApi";
import type { Message } from "../shared/types";

type HandleChatOptions = { linkOnlyToMessageId?: string };

interface Args {
    /** The chat whose tree is being navigated. Null before a chat exists. */
    chatId?: string | null;
    /** The rendered transcript; the re-answer queue watches its tail. */
    messages: Message[];
    /** Replaces the transcript after a leaf move. */
    setMessages: (messages: Message[]) => void;
    /** The page's stream entry point (useAssistantChat's handleChat). */
    handleChat: (
        message: Message,
        opts?: HandleChatOptions,
    ) => Promise<unknown>;
}

/**
 * The branch actions shared by the chat surfaces, for pages that wire the
 * full experience. ChatView owns the controls and has its own fallbacks;
 * pages pass these in so a leaf move reloads the transcript, and an edited
 * prompt or regenerated answer streams through the normal chat handler with
 * the prompt linked (`link_only_to_message_id`) instead of sending a new
 * message.
 */
export function useChatBranchActions({
    chatId,
    messages,
    setMessages,
    handleChat,
}: Args) {
    const busyRef = useRef(false);
    const [resubmit, setResubmit] = useState<{
        prompt: Message;
        linkOnlyToMessageId: string;
    } | null>(null);

    /** Reloads the ancestry the caller's (moved) leaf selects. */
    const reloadActivePath = useCallback(async () => {
        if (!chatId) return;
        const detail = await getChat(chatId);
        setMessages(detail.messages);
    }, [chatId, setMessages]);

    // The re-answer can only be sent once the reloaded path is in the
    // transcript: handleChat streams the messages state it sees, and sending
    // before the swap would post the pre-branch path and insert a duplicate
    // prompt row server side. The request waits here until the transcript's
    // tail becomes the prompt it names.
    useEffect(() => {
        if (!resubmit) return;
        const last = messages[messages.length - 1];
        if (last?.role !== "user" || last.id !== resubmit.prompt.id) return;
        setResubmit(null);
        void handleChat(resubmit.prompt, {
            linkOnlyToMessageId: resubmit.linkOnlyToMessageId,
        });
    }, [resubmit, messages, handleChat]);

    /** Saves the edited prompt as a sibling branch and re-answers it. */
    const editPrompt = useCallback(
        async (args: { message: Message; content: string }) => {
            if (!chatId || !args.message.id || busyRef.current) return;
            busyRef.current = true;
            try {
                const created = await createBranch(chatId, {
                    from_message_id: args.message.id,
                    content: args.content,
                    files: args.message.files,
                    workflow: args.message.workflow,
                });
                await reloadActivePath();
                setResubmit({
                    prompt: {
                        id: created.id,
                        role: "user",
                        content: args.content,
                        files: args.message.files,
                        workflow: args.message.workflow,
                    },
                    linkOnlyToMessageId: created.id,
                });
            } finally {
                busyRef.current = false;
            }
        },
        [chatId, reloadActivePath],
    );

    /** Re-points the leaf at the prompt and re-answers it in place. */
    const regenerate = useCallback(
        async (args: { assistant: Message; parentUser: Message | null }) => {
            if (!chatId || !args.parentUser?.id || busyRef.current) return;
            busyRef.current = true;
            try {
                await setChatLeaf(chatId, args.parentUser.id);
                await reloadActivePath();
                setResubmit({
                    prompt: args.parentUser,
                    linkOnlyToMessageId: args.parentUser.id,
                });
            } finally {
                busyRef.current = false;
            }
        },
        [chatId, reloadActivePath],
    );

    /** Moves the leaf onto a response so the next prompt continues from it. */
    const branchIntoNewThread = useCallback(
        async (message: Message) => {
            if (!chatId || !message.id || busyRef.current) return;
            busyRef.current = true;
            try {
                await setChatLeaf(chatId, message.id);
                await reloadActivePath();
            } finally {
                busyRef.current = false;
            }
        },
        [chatId, reloadActivePath],
    );

    /** Steps to the sibling branch on either side of a message. */
    const navigateSibling = useCallback(
        async (
            message: Message,
            knownIds: Array<string | number> | null,
            dir: -1 | 1,
        ) => {
            if (!chatId || !message.id || busyRef.current) return;
            busyRef.current = true;
            try {
                // The reads that carry a message's position do not carry the
                // ordered sibling ids, so this asks the branch API for them.
                let order = knownIds ? knownIds.map(String) : null;
                let current = order ? order.indexOf(message.id) : -1;
                if (!order || current < 0) {
                    const fetched = await fetchSiblings(chatId, message.id);
                    order = fetched.siblings.map((sibling) => sibling.id);
                    current =
                        fetched.index > 0
                            ? fetched.index - 1
                            : order.indexOf(message.id);
                }
                const target =
                    current < 0 ? undefined : order?.[current + dir];
                if (target === undefined) return;
                await setChatLeaf(chatId, target);
                await reloadActivePath();
            } finally {
                busyRef.current = false;
            }
        },
        [chatId, reloadActivePath],
    );

    return {
        reloadActivePath,
        editPrompt,
        regenerate,
        branchIntoNewThread,
        navigateSibling,
    };
}