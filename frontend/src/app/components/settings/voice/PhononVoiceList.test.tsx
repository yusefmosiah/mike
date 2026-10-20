import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import { BrowserModelError, PHONON_VOICES } from "@/app/lib/voice/browserModels";
import { DeviceSpeechError } from "@/app/lib/voice/deviceSpeech";
import {
  PhononVoiceList,
  VOICE_SAMPLE_FAILED_MESSAGE,
  VOICE_SAMPLE_TEXT,
  clearVoiceSampleCache,
} from "./PhononVoiceList";

class FakeAudio {
  static instances: FakeAudio[] = [];
  static playError: unknown = null;
  listeners: Record<string, () => void> = {};
  paused = false;
  constructor(public src: string) {
    FakeAudio.instances.push(this);
  }
  addEventListener(name: string, fn: () => void) {
    this.listeners[name] = fn;
  }
  async play() {
    if (FakeAudio.playError) throw FakeAudio.playError;
  }
  pause() {
    this.paused = true;
  }
}

const blob = () => new Blob(["x"], { type: "audio/wav" });
let synthesize: Mock<(text: string, voice: string) => Promise<Blob>>;
let revoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearVoiceSampleCache();
  FakeAudio.instances = [];
  FakeAudio.playError = null;
  synthesize = vi.fn(async () => blob());
  revoke = vi.fn();
  vi.stubGlobal("Audio", FakeAudio);
  URL.createObjectURL = vi.fn(() => "blob:sample");
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
});
afterEach(() => vi.unstubAllGlobals());

const renderList = (props: Partial<React.ComponentProps<typeof PhononVoiceList>> = {}) => {
  const onSelect = vi.fn();
  const view = render(
    <PhononVoiceList voices={PHONON_VOICES} value="Harper" engine="device" synthesize={synthesize} onSelect={onSelect} {...props} />,
  );
  return { onSelect, ...view };
};

describe("PhononVoiceList", () => {
  it("is a radio group with each voice's description and the current one checked", () => {
    renderList({ value: "Miles" });
    expect(screen.getByRole("radiogroup", { name: "Read-aloud voice" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(PHONON_VOICES.length);
    expect(screen.getByRole("radio", { name: /Miles/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Harper/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Harper/ })).toHaveAccessibleName(/American · female · modern, confident/);
  });

  it("saves a voice when its row is chosen", async () => {
    const { onSelect } = renderList();
    await userEvent.click(screen.getByRole("radio", { name: /Edwin/ }));
    expect(onSelect).toHaveBeenCalledWith("Edwin");
  });

  it("plays a live sample, then stops it", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(synthesize).toHaveBeenCalledWith(VOICE_SAMPLE_TEXT, "Hugh");
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(FakeAudio.instances[0].paused).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:sample");
    expect(screen.getByRole("button", { name: "Play a sample of Hugh" })).toBeInTheDocument();
  });

  it("plays one sample at a time", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await screen.findByRole("button", { name: "Stop" });
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Miles" }));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(FakeAudio.instances[0].paused).toBe(true);
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Play a sample of Hugh" })).toBeInTheDocument();
  });

  it("drops a sample that finishes after another was chosen, but keeps it for later", async () => {
    let finish: (b: Blob) => void = () => {};
    synthesize.mockImplementationOnce(() => new Promise<Blob>((resolve) => (finish = resolve)));
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Miles" }));
    await act(async () => finish(blob()));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it("replays from the cache without synthesizing again", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(2));
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(FakeAudio.instances).toHaveLength(2);
  });

  it("returns to play when the sample ends", async () => {
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await screen.findByRole("button", { name: "Stop" });
    act(() => FakeAudio.instances[0].listeners.ended());
    expect(screen.getByRole("button", { name: "Play a sample of Hugh" })).toBeInTheDocument();
  });

  it("shows a per-row loading state and can cancel it; says Preparing Phonon the first time", async () => {
    synthesize.mockImplementation(() => new Promise<Blob>(() => {}));
    renderList({ preparing: true });
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(screen.getByRole("status")).toHaveTextContent("Preparing Phonon…");
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("uses plain wording once a sample has been made, or when no preparation is due", async () => {
    renderList({ preparing: true });
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Stop" }));
    synthesize.mockImplementation(() => new Promise<Blob>(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Miles" }));
    expect(screen.getByRole("status")).toHaveTextContent("Preparing the sample…");
  });

  it("keeps each engine's samples apart", async () => {
    const first = renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await screen.findByRole("button", { name: "Stop" });
    first.unmount();
    renderList({ engine: "webgpu" });
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it("disables play before Phonon is installed, with a line saying what to do, but still selects", async () => {
    const { onSelect } = renderList({ playDisabledReason: "Download Phonon above to hear samples." });
    expect(screen.getByText("Download Phonon above to hear samples.")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Maeve/ }));
    expect(onSelect).toHaveBeenCalledWith("Maeve");
  });

  it("shows the message of a known failure in the row", async () => {
    synthesize.mockRejectedValueOnce(new DeviceSpeechError("Could not read this aloud on this iPhone. Please try again."));
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not read this aloud on this iPhone.");
    synthesize.mockRejectedValueOnce(new BrowserModelError("The model restarted."));
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The model restarted.");
  });

  it("never shows a raw error", async () => {
    synthesize.mockRejectedValueOnce(new Error("pg: connection refused at 10.0.0.1"));
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(VOICE_SAMPLE_FAILED_MESSAGE);
    synthesize.mockRejectedValueOnce(new MikeApiError({ message: "stack trace", status: 500 }));
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(VOICE_SAMPLE_FAILED_MESSAGE);
  });

  it("ignores a failure after the sample was cancelled", async () => {
    let fail: (e: unknown) => void = () => {};
    synthesize.mockImplementationOnce(() => new Promise<Blob>((_, reject) => (fail = reject)));
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => fail(new Error("late")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a sample the browser will not play", async () => {
    FakeAudio.playError = new Error("NotAllowedError");
    renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(VOICE_SAMPLE_FAILED_MESSAGE);
    expect(screen.getByRole("button", { name: "Play a sample of Hugh" })).toBeInTheDocument();
  });

  it("stops a playing sample on unmount", async () => {
    const { unmount } = renderList();
    await userEvent.click(screen.getByRole("button", { name: "Play a sample of Hugh" }));
    await waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    unmount();
    expect(FakeAudio.instances[0].paused).toBe(true);
  });
});
