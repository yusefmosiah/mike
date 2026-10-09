"use client";

import { useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  LiquidDropdownContent,
  LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import { SETTINGS_CONTROL_CLASS } from "@/app/components/settings/SettingsTextInput";

export interface VoiceChoice {
  id: string;
  label: string;
  /** A second line: price, language, or what the choice means. */
  detail?: string;
}

/** One choice from a list (a model, a voice), in the settings control style. */
export function VoiceChoiceDropdown({
  label,
  value,
  choices,
  placeholder,
  onChange,
}: {
  /** Accessible name of the control. */
  label: string;
  value: string | undefined;
  choices: VoiceChoice[];
  placeholder: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = choices.find((choice) => choice.id === value);
  return (
    <DropdownMenu onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={`flex min-h-9 items-center justify-between gap-2 py-1.5 text-left hover:bg-gray-200/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ${SETTINGS_CONTROL_CLASS}`}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <span className="block text-gray-900">{selected?.label ?? placeholder}</span>
            {selected?.detail && (
              <span className="block text-xs text-gray-500">{selected.detail}</span>
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
      </DropdownMenuTrigger>
      <LiquidDropdownContent
        className="z-50 max-h-80 overflow-y-auto"
        style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
        align="start"
      >
        {choices.map((choice) => (
          <LiquidDropdownItem
            key={choice.id}
            selected={choice.id === value}
            onSelect={() => onChange(choice.id)}
          >
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="block">{choice.label}</span>
              {choice.detail && (
                <span className="block text-[11px] text-gray-400">{choice.detail}</span>
              )}
            </span>
            {choice.id === value && (
              <Check aria-hidden="true" className="ml-1 h-3.5 w-3.5 text-gray-600" />
            )}
          </LiquidDropdownItem>
        ))}
      </LiquidDropdownContent>
    </DropdownMenu>
  );
}
