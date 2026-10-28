# Paste a YouTube link, play it on a DLNA renderer

This is the whole setup behind the card: paste a YouTube link in Home Assistant and a wall
panel plays that one video in its native player. There's no YouTube app, no browsing and no
autoplay chain. It was built for a Xiaomi Mi Smart Clock (1 GB RAM) running
[Kiosk Satellite](https://github.com/jxlarrea/kiosk-satellite), whose built-in DLNA renderer
shows up in HA through the **DLNA Digital Media Renderer** integration. A web view player was
ruled out, because on 1 GB it runs the panel out of memory.

Last verified 2026-10-29 with Home Assistant 2026.10.4, MeTube 2026.10.25 (yt-dlp nightly
2026.10.26), Kiosk Satellite 2026.10.42.

This is a record of my personal setup for intentional computing, not a maintained project.
Every link in the chain can break without warning: YouTube, yt-dlp, the MeTube wrapper,
HA's DLNA integration and the renderer. When one does, I may fix it for myself, or I may not.

## How it works

```
paste link ──► input_text.youtube_url ──► automation
                                            │ 1. clear the box, show "Loading video…" on the panel
                                            │ 2. oEmbed: title + channel ──► input_text.youtube_now_playing
                                            │ 3. MeTube: delete the previous download
                                            │ 4. MeTube: download <id>.mp4 (360p H.264/AAC, from t= if given)
                                            │ 5. poll MeTube every 3 s until finished or failed
                                            ▼
             media-source://media_source/local/youtube/<id>.mp4 ──► DLNA renderer plays it
```

The panel only ever fetches a file from Home Assistant's media folder. It never talks to YouTube.

## Why not the obvious routes

**`media_extractor` → DLNA renderer.** HA's built-in route extracts a stream URL with yt-dlp
and hands it to the player. The renderer gets **HTTP 403** from `googlevideo.com`. HA's
bundled yt-dlp (2026.07.04 at the time) has no JavaScript runtime, so it falls back to the
`ANDROID_VR` client. That client's stream URLs only work for a fetcher that presents itself
like yt-dlp. Even HA's own Downloader integration got 403, from the same IP, seconds after
extraction, and so did a plain yt-dlp download inside the HA container. A current yt-dlp
without a JS runtime returned no usable formats at all.

**Fixing yt-dlp inside HA.** Hand-installing a newer yt-dlp and deno in the core container
would be undone by every HA update.

**MeTube.** It ships yt-dlp with deno (`yt-dlp[default,curl-cffi,deno]`), updates yt-dlp
nightly and has an HTTP API. It runs as an HA app (add-on) and writes to `/media`, so HA can
serve the finished file to the renderer like any other local media.

## Setup

1. **MeTube app.** Add the repository `https://github.com/mauro-midolo/MeTube-Home-Assistant`
   (Settings > Apps > App store > ⋮ > Repositories), install **MeTube** and set the options from
   [`examples/metube-options.yaml`](../examples/metube-options.yaml). The important ones are
   `video_dir: /media/youtube`, `output_template: "%(id)s.%(ext)s"` (the card finds the
   thumbnail by video id), `max_concurrent_downloads: 1` and a `nightly_update_time`. The
   wrapper is a small `run.py` on top of the official `ghcr.io/alexta69/metube` image. Read it
   before you trust it, as I did. Port 8081 can stay closed: HA reaches MeTube on the internal
   app network as `http://2c1db717-metube:8081`, where the prefix is a hash of the repository
   URL, so it's the same on every install.
2. **DLNA renderer.** Enable it in Kiosk Satellite (Settings > DLNA Renderer) and add the
   **DLNA Digital Media Renderer** integration in HA. It's usually discovered automatically.
3. **Config.** Add the `input_text` and four `rest_command`s from
   [`examples/configuration.yaml`](../examples/configuration.yaml), create the text helper
   **YouTube now playing** in the UI, and restart HA.
4. **Automation.** Import [`examples/automation.yaml`](../examples/automation.yaml) and change
   the renderer entity and the Kiosk Satellite notification action at the top.
5. **Card.** Install this repository's card and add it to a dashboard (see the
   [README](../README.md)).

## Behaviour

- **Link formats:** `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/` and `/live/` links work,
  including share links with `?si=…`. Anything else shows a warning card and stops.
- **Quality:** 360p, merged by MeTube into H.264 + AAC MP4, which old panels decode in hardware.
- **Timestamps:** `t=90`, `t=90s` and `t=1m30s` all work. MeTube downloads from that point
  (`clip_start`), so the file itself starts there.
- **Storage:** only one video is kept. Each new paste deletes the previous file through MeTube.
- **Wait time:** a 19 s clip took about 8 s to download. A 10.5 min video was playing
  about 26 s after the paste.
- **Errors:** when a download fails (removed, age-restricted, region-locked…), MeTube's
  message appears as a red card on the panel. The automation gives up after 10 minutes.

## Renderer quirks (and how the card deals with them)

| Quirk | Effect | Workaround |
| --- | --- | --- |
| The renderer never advertises **Seek** to HA (supported features 135693 playing, 152076 paused, 152077 idle). | `media_player.media_seek` is refused, so the progress bar can't seek. | `t=` is handled at download time with MeTube's `clip_start`. |
| It advertises **Pause** only while playing and **Play** only while paused. | `media_player.media_play_pause` fails on a paused video ("does not support action"). | The card calls `media_play` or `media_pause` explicitly. |
| **Artwork and artist don't make it to HA.** `python-didl-lite` defines `upnp:albumArtURI` and `upnp:artist` only for music classes, so for a `videoItem` `async_upnp_client` drops them silently. Sending the video as a music track doesn't help either, because the renderer reports its own track metadata (class video, title only). | The stock media card shows the title and nothing else. | The card reads the video id from the playing file's name and loads `i.ytimg.com/vi/<id>/mqdefault.jpg` itself. The channel comes from oEmbed via `input_text.youtube_now_playing`. |
| The decoder sometimes refuses the first video surface. | Brief black start. | Kiosk Satellite retries on a platform view by itself. |

On the panel itself the video covers the screen while it plays, and tapping it stops playback,
so the card mostly matters on a phone or another dashboard.

## Troubleshooting

- **Loading never finishes.** Check the MeTube panel in the HA sidebar. The automation trace
  shows how many times it polled.
- **Downloads start failing after months of working.** YouTube changed something. MeTube
  updates yt-dlp every night at `nightly_update_time`. Restarting the app updates it at once.
- **"Entity … does not support action media_seek / media_play_pause".** That's expected with
  this renderer; see the table above.
- **The card shows no thumbnail.** The file has to be named `<11-char id>.mp4` under
  `/youtube/`, so check MeTube's `output_template`.
