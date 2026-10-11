"use client";

import { useEffect, useState } from "react";
import { getVoiceOptions, type VoiceOptions } from "@/app/lib/mikeApi";
import {
  browserSpeechSupported,
  onDeviceRecognitionStatus,
} from "@/app/lib/voice/browserSpeech";
import { browserModelsSupported } from "@/app/lib/voice/browserModels";
import { deviceSpeechStatus, type DeviceSpeechState } from "@/app/lib/voice/deviceSpeech";
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
  loading: boolean;
  error: boolean;
}

/**
 * What this deployment offers and what this browser (or, in the iPhone app,
 * this phone) can do, for Settings → Voice.
 */
export function useVoiceAvailability(): VoiceAvailabilityState {
  const [options, setOptions] = useState<VoiceOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [recognitionStatus, setRecognitionStatus] = useState<RecognitionStatus>("unavailable");
  const [recognitionCheck, setRecognitionCheck] = useState(0);
  const [deviceStatus, setDeviceStatus] = useState<DeviceSpeechState>("unavailable");
  const [deviceCheck, setDeviceCheck] = useState(0);

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

  return {
    options,
    availability: {
      deviceRecognition: deviceStatus !== "unavailable",
      operatorTranscription: !!options?.operator.transcription,
      operatorSpeech: !!options?.operator.speech,
      openRouter: !!options?.openrouter.available && !!options.openrouter.catalog,
      browserRecognition: recognitionStatus !== "unavailable",
      browserSpeech: browserSpeechSupported(),
      webgpu: browserModelsSupported(),
    },
    recognitionStatus,
    refreshRecognition: () => setRecognitionCheck((n) => n + 1),
    deviceStatus,
    refreshDevice: () => setDeviceCheck((n) => n + 1),
    loading,
    error,
  };
}
