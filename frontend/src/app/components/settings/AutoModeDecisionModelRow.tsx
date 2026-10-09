"use client";

import { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import {
  LiquidDropdownContent,
  LiquidDropdownItem,
} from "@/app/components/ui/liquid-dropdown";
import {
  getAutoModeDecisionSettings,
  setAutoModeDecisionModel,
  type AutoModeDecisionSettings,
  type DecisionModelOption,
} from "@/app/lib/mikeApi";
import { userFacingApiError } from "@/app/lib/userFacingError";
import { SettingsRow } from "./SettingsRow";
import { SettingsDescription, SettingsLabel } from "./SettingsText";
import { SETTINGS_CONTROL_CLASS } from "./SettingsTextInput";

const DEFAULT_LABEL = "Default — the chat's own model";

/** "~410 ms · $0.020 per million tokens": measured speed first, since the gate runs before every call. */
export function decisionDetailText(option: DecisionModelOption): string {
  return [`~${Math.round(option.medianLatencyMs)} ms`, decisionPriceText(option)].filter(Boolean).join(" · ");
}

/** "$0.04 per million tokens", or nothing when OpenRouter lists no price. */
export function decisionPriceText(option: DecisionModelOption): string | null {
  const price = option.inputPricePerMillion;
  if (price === null) return null;
  if (price === 0) return "free";
  return `$${price < 0.1 ? price.toFixed(3) : price.toFixed(2)} per million tokens`;
}

/**
 * Which model judges tool calls in Auto Mode. The default asks the chat's own
 * model; a decision model answers targeted yes/no questions instead. A model
 * that fails or cannot be reached always denies the call.
 */
export function AutoModeDecisionModelRow() {
  const [settings, setSettings] = useState<AutoModeDecisionSettings | null>(null);
  const [state, setState] = useState<"loading" | "idle" | "saving" | "saved" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAutoModeDecisionSettings().then(
      (loaded) => {
        if (cancelled) return;
        setSettings(loaded);
        setState("idle");
      },
      (loadError: unknown) => {
        if (cancelled) return;
        setError(userFacingApiError(loadError, "Decision models could not be loaded."));
        setState("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = async (model: string | null) => {
    setState("saving");
    setError(null);
    try {
      setSettings(await setAutoModeDecisionModel(model));
      setState("saved");
    } catch (saveError) {
      setError(userFacingApiError(saveError, "The decision model could not be saved."));
      setState("idle");
    }
  };

  const options = settings?.options ?? [];
  const groups = [
    { label: "Open weights", items: options.filter((option) => option.openWeights) },
    { label: "Hosted", items: options.filter((option) => !option.openWeights) },
  ].filter((group) => group.items.length > 0);
  const selected = options.find((option) => option.value === settings?.model);

  return (
    <SettingsRow layout="stacked">
      <div className="space-y-1">
        <SettingsLabel>Auto Mode decision model</SettingsLabel>
        <SettingsDescription>
          Judges each tool call that could change or send something while Auto
          Mode runs without you. A model that fails or cannot be reached denies
          the call.
        </SettingsDescription>
      </div>
      {state === "loading" ? (
        <div
          role="status"
          aria-label="Loading decision models"
          className={`h-9 animate-pulse bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
        />
      ) : (
        <DropdownMenu onOpenChange={setIsOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={state === "saving" || state === "failed"}
              aria-label="Auto Mode decision model"
              className={`flex min-h-9 items-center justify-between gap-2 hover:bg-gray-200/70 ${SETTINGS_CONTROL_CLASS}`}
            >
              <span className="min-w-0 break-words text-left text-gray-900">
                {selected ? selected.name : DEFAULT_LABEL}
              </span>
              {state === "saving" ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-gray-500" />
              ) : state === "saved" ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-green-600" />
              ) : (
                <ChevronDown
                  className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                />
              )}
            </button>
          </DropdownMenuTrigger>
          <LiquidDropdownContent
            className="z-50 max-h-96 overflow-y-auto"
            style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
            align="start"
          >
            <LiquidDropdownItem className="cursor-pointer" onSelect={() => void choose(null)}>
              <span className="flex-1">{DEFAULT_LABEL}</span>
              {!settings?.model && <Check className="ml-1 h-3.5 w-3.5 text-gray-600" />}
            </LiquidDropdownItem>
            {groups.map((group) => (
              <div key={group.label}>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                  {group.label}
                </DropdownMenuLabel>
                {group.items.map((option) => (
                  <LiquidDropdownItem
                    key={option.value}
                    className="cursor-pointer"
                    onSelect={() => void choose(option.value)}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="break-words">{option.name}</span>
                      <span className="text-xs text-gray-500">{decisionDetailText(option)}</span>
                    </span>
                    {option.value === settings?.model && (
                      <Check className="ml-1 h-3.5 w-3.5 shrink-0 text-gray-600" />
                    )}
                  </LiquidDropdownItem>
                ))}
              </div>
            ))}
          </LiquidDropdownContent>
        </DropdownMenu>
      )}
      {settings && options.length === 0 && (
        <p className="text-xs text-gray-500">
          No decision models are available here; the chat&apos;s own model judges.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </SettingsRow>
  );
}
