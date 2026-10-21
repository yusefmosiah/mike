"use client";

import { useEffect, useState } from "react";
import { getVoiceOptions, type VoiceOptions } from "@/app/lib/mikeApi";
import {
  browserSpeechSupported,
  onDeviceRecognitionStatus,
} from "@/app/lib/voice/browserSpeech";
import { browserModelsSupported } from "@/app/lib/voice/browserModels";
import {
  deviceSpeechStatus,
  deviceVoiceSupported,
  fluidSpeechMiniStatus,
  phononStatus,
  type DeviceSpeechState,
  type FluidSpeechMiniStatus,
  type PhononStatus,
} from "@/app/lib/voice/deviceSpeech";
import type { VoiceAvailability } from "@/app/lib/voice/preferences";

export type RecognitionStatus = Awaited<ReturnType<typeof onDeviceRecognitionStatus>>;

export interface VoiceAvailabilityState {
  options: VoiceOptions | null;
  availability: VoiceAvailability;
  recognitionStatus: RecognitionStatus;
  refreshRecognition: () => void;
  /** Apple's recognition on the phone, in the iPhone app. */
  deviceStatus: DeviceSpeechState;
  refreshDevice: () => void;
  /** Fluid Speech Mini can transcribe now (bundled on the iPhone, downloaded on Android). */
  fluidSpeechMini: boolean;
  /** Where Fluid Speech Mini stands: on Android it is `downloadable` until downloaded. */
  fluidStatus: FluidSpeechMiniStatus;
  refreshFluid: () => void;
  /** Phonon on the phone: downloaded or not, in the app (iOS 18 and later, Android). */
  phonon: PhononStatus;
  refreshPhonon: () => void;
  loading: boolean;
  error: boolean;
}

const PHONON_UNAVAILABLE: PhononStatus = { state: "unavailable" };
const FLUID_UNAVAILABLE: FluidSpeechMiniStatus = { state: "unavailable" };

/**
 * What this deployment offers and what this browser (or, in the app, this
 * phone) can do, for Settings → Voice.
 */
export function useVoiceAvailability(): VoiceAvailabilityState {
  const [options, setOptions] = useState<VoiceOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [recognitionStatus, setRecognitionStatus] = useState<RecognitionStatus>("unavailable");
  const [recognitionCheck, setRecognitionCheck] = useState(0);
  const [deviceStatus, setDeviceStatus] = useState<DeviceSpeechState>("unavailable");
  const [deviceCheck, setDeviceCheck] = useState(0);
  const [fluidStatus, setFluidStatus] = useState<FluidSpeechMiniStatus>(FLUID_UNAVAILABLE);
  const [fluidCheck, setFluidCheck] = useState(0);
  const [phonon, setPhonon] = useState<PhononStatus>(PHONON_UNAVAILABLE);
  const [phononCheck, setPhononCheck] = useState(0);

  useEffect(() => {
    let active = true;
    getVoiceOptions()
      .then((next) => {
        if (active) setOptions(next);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void onDeviceRecognitionStatus().then((status) => {
      if (active) setRecognitionStatus(status);
    });
    return () => {
      active = false;
    };
  }, [recognitionCheck]);

  useEffect(() => {
    let active = true;
    void deviceSpeechStatus().then((status) => {
      if (active) setDeviceStatus(status);
    });
    return () => {
      active = false;
    };
  }, [deviceCheck]);

  useEffect(() => {
    let active = true;
    void fluidSpeechMiniStatus().then((status) => {
      if (active) setFluidStatus(status);
    });
    return () => {
      active = false;
    };
  }, [fluidCheck]);

  useEffect(() => {
    let active = true;
    void phononStatus().then((status) => {
      if (active) setPhonon(status);
    });
    return () => {
      active = false;
    };
  }, [phononCheck]);

  return {
    options,
    availability: {
      // Also while Fluid Speech Mini is only downloadable, so Settings can offer the download.
      deviceRecognition: deviceStatus !== "unavailable" || fluidStatus.state !== "unavailable",
      deviceSpeech: deviceVoiceSupported(),
      operatorTranscription: !!options?.operator.transcription,
      operatorSpeech: !!options?.operator.speech,
      openRouter: !!options?.openrouter.available && !!options.openrouter.catalog,
      browserRecognition: recognitionStatus !== "unavailable",
      // In the app the web view's own voices stay silent; the phone's
      // voices come through the plugin instead ("This phone").
      browserSpeech: browserSpeechSupported() && !deviceVoiceSupported(),
      webgpu: browserModelsSupported(),
    },
    recognitionStatus,
    refreshRecognition: () => setRecognitionCheck((n) => n + 1),
    deviceStatus,
    refreshDevice: () => setDeviceCheck((n) => n + 1),
    fluidSpeechMini: fluidStatus.state === "available",
    fluidStatus,
    refreshFluid: () => setFluidCheck((n) => n + 1),
    phonon,
    refreshPhonon: () => setPhononCheck((n) => n + 1),
    loading,
    error,
  };
}
