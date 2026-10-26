// Audio and video documents are stored as uploaded. One check runs on the
// way in: the file's first bytes must be the container its extension names,
// so a file renamed .mp4 (or anything else wearing a media extension) is
// refused rather than published and served as video.

import { isMediaFileType } from "./documentTypes";

export class MediaRejectedError extends Error {
  readonly code = "unsupported_media";
  constructor() {
    super("The file is not the audio or video format its name says.");
    this.name = "MediaRejectedError";
  }
}

/** How many leading bytes `mediaSignatureMatches` reads. */
export const MEDIA_SIGNATURE_BYTES = 16;

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

// ISO base media files (mp4, m4a, mov) open with a box: a 4-byte size, then
// its type. Most start with "ftyp"; older QuickTime files can start with one
// of the others.
const ISO_FIRST_BOXES = new Set(["ftyp"]);
const QUICKTIME_FIRST_BOXES = new Set(["ftyp", "moov", "mdat", "wide", "free", "skip", "pnot"]);

/** True when `head` (the file's first bytes) starts the container `fileType` names. */
export function mediaSignatureMatches(fileType: string, head: Uint8Array): boolean {
  switch (fileType.toLowerCase()) {
    case "mp3":
      // An ID3 tag, or straight into an MPEG audio frame's sync bits.
      return ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case "mp4":
    case "m4a":
      return ISO_FIRST_BOXES.has(ascii(head, 4, 8));
    case "mov":
      return QUICKTIME_FIRST_BOXES.has(ascii(head, 4, 8));
    case "wav":
      return ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE";
    case "ogg":
      return ascii(head, 0, 4) === "OggS";
    case "webm":
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    default:
      return false;
  }
}

/** Throws MediaRejectedError when a media file's bytes are not its type. */
export function checkMediaFile(fileType: string, head: Uint8Array): void {
  if (isMediaFileType(fileType) && !mediaSignatureMatches(fileType, head)) {
    throw new MediaRejectedError();
  }
}
