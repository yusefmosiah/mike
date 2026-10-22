---
name: youtube-transcript
description: Turn a YouTube link into a transcript document in Mike, from the video's captions, with its title, channel, date and description. Use when the user shares a YouTube link and asks for a transcript, the text of a talk or hearing, or a summary that needs the full text first.
---

# YouTube transcript

Makes a Markdown transcript of a YouTube video and saves it to Mike as a
document. It needs the workstation (`run_python`).

## Steps

1. Run the script with the link. Put the result under `~/mike/out/`:

   ```bash
   python3 ~/skills/youtube-transcript/scripts/transcribe.py "<youtube-url>" --out ~/mike/out/<short-name>.md
   ```

   Add `--language fr` (or another code) when the user wants captions in a
   language other than English. The script prints the character count and,
   on its last line, the file it wrote.

2. Check the exit code:
   - **0**: read the first lines of the file to confirm the title, then save
     it with `save_to_mike` (the path the script printed; `to_library: true`,
     or the user's project). Tell the user the title, the channel and how
     the text was obtained (the `method` line).
   - **3**: YouTube refused this workstation's network address. It asks
     data-centre addresses to sign in, so captions cannot be fetched from
     here. Say so plainly, and offer what works instead: the user pastes the
     transcript (YouTube's "Show transcript" panel) or uploads the video's
     subtitle file, or runs Mike on their own computer (personal mode),
     where YouTube answers. Do not retry with other tools or sites.
   - **4**: the video has no captions. Say that transcribing the audio is
     not available in the workstation yet.
   - **2**: the link is not a YouTube video link; ask for one.

3. If the user asked for a summary or analysis, write it from the saved
   transcript and quote it, rather than from the description alone.

## What the transcript looks like

A Markdown file with frontmatter (`source`, `title`, `method`,
`transcribed`, and `note` when the captions look incomplete), then
`# <title>`, an "About the video" section (channel, date, description) and
"Transcript" in paragraphs. Captions carry no speaker names; do not add
any.

## Checks

- The title in the file matches the video the user meant.
- A `note` in the frontmatter means the captions cover only part of the
  video: tell the user.
- Never publish the transcript anywhere outside Mike.
