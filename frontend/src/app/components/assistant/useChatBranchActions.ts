"use client";

import { useCallback, useRef } from "react";
import {
    createBranch,
    fetchSiblings,
    forkChat,
    getChat,
    setChatLeaf,
} from "@/app/lib/mikeApi";
import type { Message } from "../shared/types";

type HandleChatOptions = { linkOnlyToMessageId?: string; history?: Message[] };

interface Args {
    /** The chat whose tree is being navigated. Null before a chat exists. */
    chatId?: string | null;
    /** The rendered transcript; a regenerate takes its history from here. */
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
 * The branch actions shared by the chat surfaces. A leaf move reloads the
 * transcript the server selects; an edited prompt or a regenerated answer
 * streams through the page's chat handler with the stored prompt named
 * (`link_only_to_message_id`) and that branch's history given explicitly, so
 * the request never depends on which transcript happened to be rendered.
 */
export function useChatBranchActions({
    chatId,
    messages,
    setMessages,
    handleChat,
}: Args) {
    const busyRef = useRef(false);

    /** Reloads the ancestry the caller's (moved) leaf selects. */
    const reloadActivePath = useCallback(async () => {
        if (!chatId) return;
        const detail = await getChat(chatId);
        setMessages(detail.messages);
    }, [chatId, setMessages]);

    /**
     * Answers a stored prompt again on the branch `history` leads to. Once the
     * answer is stored, the reload shows its position among the prompt's
     * answers ("‹ 2/2 ›"), which the stream cannot know.
     */
    const reanswer = useCallback(
        async (prompt: Message & { id: string }, history: Message[]) => {
            await handleChat(prompt, {
                linkOnlyToMessageId: prompt.id,
                history,
            });
            await reloadActivePath().catch(() => {});
        },
        [handleChat, reloadActivePath],
    );

    /**
     * Saves the edited prompt as a sibling version and starts its answer.
     * Resolves once the version is saved, so an editor can close then; a
     * failed save rejects and the caller keeps the draft.
     */
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
                // The full read carries branch positions, so the new version
                // shows "‹ 2/2 ›" while it is answered. The branch call's own
                // path is the fallback: the version is saved either way.
                const path = await getChat(chatId)
                    .then((detail) => detail.messages)
                    .catch(() => created.messages);
                const index = path.findIndex((m) => m.id === created.id);
                const prompt: Message & { id: string } =
                    index >= 0
                        ? { ...path[index], id: created.id }
                        : {
                              id: created.id,
                              role: "user",
                              content: args.content,
                              files: args.message.files,
                              workflow: args.message.workflow,
                          };
                const history =
                    index >= 0 ? path.slice(0, index) : path.slice(0, -1);
                void reanswer(prompt, history);
            } finally {
                busyRef.current = false;
            }
        },
        [chatId, reanswer],
    );

    /** Answers the prompt again; the new answer becomes a sibling of the old. */
    const regenerate = useCallback(
        async (args: { assistant: Message; parentUser: Message | null }) => {
            const prompt = args.parentUser;
            if (!chatId || !prompt?.id || busyRef.current) return;
            const index = messages.findIndex((m) => m.id === prompt.id);
            if (index < 0) return;
            void reanswer({ ...prompt, id: prompt.id }, messages.slice(0, index));
        },
        [chatId, messages, reanswer],
    );

    /**
     * Branches into a new thread: a new chat holding this one's history up to
     * the answer. Returns the new chat's id; the page navigates to it.
     */
    const branchIntoNewThread = useCallback(
        async (message: Message): Promise<string | null> => {
            if (!chatId || !message.id || busyRef.current) return null;
            busyRef.current = true;
            try {
                const forked = await forkChat(chatId, message.id);
                return forked.chatId;
            } finally {
                busyRef.current = false;
            }
        },
        [chatId],
    );

    /**
     * Steps to the sibling branch on either side of a message. The server
     * opens the newest message under the sibling, so a prompt version comes
     * with its answers.
     */
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
