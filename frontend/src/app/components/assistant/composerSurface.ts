import { LIQUID_GLASS_TRANSLUCENT_CLASS } from "@/app/components/ui/liquid-surface";

/**
 * The chat composer's surface: its radius and translucent glass. The voice
 * mode panel stands in for the composer and wears the same surface, and
 * globals.css gives both the same edge-to-edge shape in the iPhone app.
 */
export const CHAT_COMPOSER_SURFACE_CLASS = `rounded-[21px] ${LIQUID_GLASS_TRANSLUCENT_CLASS}`;
