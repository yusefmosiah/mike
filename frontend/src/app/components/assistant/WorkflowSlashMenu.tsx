"use client";

import { useEffect, useRef } from "react";
import type { Workflow } from "../shared/types";
import { workflowSlashCommand } from "./workflowSlashCommands";
import { LIQUID_GLASS_TRANSLUCENT_CLASS } from "@/app/components/ui/liquid-surface";

export const WORKFLOW_SLASH_MENU_ID = "workflow-slash-menu";

/** A built-in command listed before the workflows, such as `/nr`. */
export type SlashCommandOption = { command: string; description: string };

interface Props {
    workflows: Workflow[];
    activeIndex: number;
    onSelect: (workflow: Workflow) => void;
    /** Built-in commands; they take the first option indices. */
    commands?: SlashCommandOption[];
    onSelectCommand?: (command: SlashCommandOption) => void;
}

export function WorkflowSlashMenu({
    workflows,
    activeIndex,
    onSelect,
    commands = [],
    onSelectCommand,
}: Props) {
    const activeOptionRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
    }, [activeIndex]);

    if (workflows.length === 0 && commands.length === 0) return null;
    const optionClass = (active: boolean) =>
        `theme-dropdown-item flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${
            active ? "theme-dropdown-selected text-gray-900" : "text-gray-700"
        }`;

    return (
        <div
            id={WORKFLOW_SLASH_MENU_ID}
            role="listbox"
            aria-label="Commands"
            className={`absolute bottom-full left-0 mb-1.5 grid max-h-64 w-full gap-1 overflow-y-auto rounded-[18px] p-1 overscroll-contain md:rounded-[22px] ${LIQUID_GLASS_TRANSLUCENT_CLASS}`}
        >
            {commands.map((option, index) => {
                const active = index === activeIndex;
                return (
                    <button
                        ref={active ? activeOptionRef : undefined}
                        key={option.command}
                        id={`${WORKFLOW_SLASH_MENU_ID}-${index}`}
                        type="button"
                        role="option"
                        aria-label={`${option.command} ${option.description}`}
                        aria-selected={active}
                        onClick={() => onSelectCommand?.(option)}
                        className={optionClass(active)}
                    >
                        <span className="font-medium text-gray-900">
                            {option.command}
                        </span>
                        <span className="text-gray-500">
                            {option.description}
                        </span>
                    </button>
                );
            })}
            {workflows.map((workflow, workflowIndex) => {
                const trigger = workflowSlashCommand(workflow);
                if (!trigger) return null;
                const index = commands.length + workflowIndex;
                const active = index === activeIndex;
                return (
                    <button
                        ref={active ? activeOptionRef : undefined}
                        key={workflow.id}
                        id={`${WORKFLOW_SLASH_MENU_ID}-${index}`}
                        type="button"
                        role="option"
                        aria-label={`${trigger} ${workflow.metadata.title}`}
                        aria-selected={active}
                        onClick={() => onSelect(workflow)}
                        className={optionClass(active)}
                    >
                        <span className="font-medium text-gray-900">
                            {trigger}
                        </span>
                        <span className="truncate text-gray-500">
                            {workflow.metadata.title}
                        </span>
                    </button>
                );
            })}
        </div>
    );
}
