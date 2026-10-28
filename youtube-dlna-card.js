// SPDX-License-Identifier: GPL-3.0-or-later
// YouTube DLNA card: one Lovelace card for a DLNA renderer (e.g. Kiosk Satellite's) and the
// link field that feeds the paste-to-play automation (MeTube downloads, the renderer plays).
// See docs/PIPELINE.md for the whole setup.
//
// The renderer drops DLNA artwork and artist, so the card finds the video id in the playing
// file's name (/media/youtube/<id>.mp4) and loads YouTube's thumbnail itself. The channel comes
// from an input_text the automation fills with "<video id>|<channel>".
//
// type: custom:youtube-dlna-card
// entity: media_player.kitchen_tablet_dlna             (the DLNA renderer)
// url_entity: input_text.youtube_url                   (the automation's trigger)
// now_playing_entity: input_text.youtube_now_playing   (optional, shows the channel)
// automation: automation.youtube_to_dlna               (optional, shows "Loading video…")

const VIDEO_ID = /\/youtube\/([A-Za-z0-9_-]{11})\.mp4/;

// MediaPlayerEntityFeature bits. The renderer only advertises PAUSE while playing and PLAY
// while paused, so media_play_pause (which needs PAUSE) fails on a paused video.
const PAUSE = 1;
const STOP = 4096;
const PLAY = 16384;

const fmt = (s) => {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};

class YoutubeDlnaCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity || !config.url_entity) {
      throw new Error("entity and url_entity are required");
    }
    this._config = config;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._root) this._build();
    this._update();
  }

  getCardSize() {
    return 5;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6, rows: "auto" };
  }

  connectedCallback() {
    this._timer = setInterval(() => this._updateProgress(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this._timer);
  }

  _call(domain, service, data) {
    this._hass.callService(domain, service, { entity_id: this._config.entity, ...data });
  }

  _build() {
    this._root = this.attachShadow({ mode: "open" });
    this._root.innerHTML = `
      <style>
        ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .top { display: flex; gap: 12px; align-items: center; min-width: 0; }
        .thumb { flex: none; width: 128px; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden;
                 background: var(--secondary-background-color); display: grid; place-items: center; }
        .thumb img { width: 100%; height: 100%; object-fit: cover; }
        .thumb ha-icon { --mdc-icon-size: 40px; color: var(--secondary-text-color); }
        .meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
        .title { font-size: 1.05em; font-weight: 500; color: var(--primary-text-color);
                 display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .sub { color: var(--secondary-text-color); font-size: 0.9em;
               white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bar { height: 4px; border-radius: 2px; background: var(--divider-color); overflow: hidden; }
        .fill { height: 100%; width: 0; background: var(--primary-color); }
        .times { display: flex; justify-content: space-between; margin-top: -8px;
                 color: var(--secondary-text-color); font-size: 0.8em; font-variant-numeric: tabular-nums; }
        .controls { display: flex; align-items: center; gap: 4px; }
        button { border: none; background: none; color: var(--primary-text-color); cursor: pointer;
                 width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; padding: 0; }
        button:hover { background: var(--secondary-background-color); }
        button:disabled { color: var(--disabled-text-color); cursor: default; background: none; }
        button.main { width: 48px; height: 48px; background: var(--primary-color); color: var(--text-primary-color); }
        button.main:disabled { background: var(--disabled-color, var(--divider-color)); }
        button.main ha-icon { --mdc-icon-size: 28px; }
        input[type="range"] { flex: 1; min-width: 60px; accent-color: var(--primary-color); }
        form { display: flex; gap: 8px; align-items: center; }
        form input { flex: 1; min-width: 0; height: 40px; padding: 0 12px; border-radius: 20px; font: inherit;
                     border: 1px solid var(--divider-color); background: var(--secondary-background-color);
                     color: var(--primary-text-color); }
        form input:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
        .status { color: var(--secondary-text-color); font-size: 0.85em; margin-top: -4px; }
        .status:empty { display: none; }
      </style>
      <ha-card>
        <div class="top">
          <div class="thumb"><img alt="" hidden><ha-icon icon="mdi:youtube"></ha-icon></div>
          <div class="meta"><div class="title"></div><div class="sub"></div></div>
        </div>
        <div class="bar"><div class="fill"></div></div>
        <div class="times"><span class="pos"></span><span class="dur"></span></div>
        <div class="controls">
          <button class="main play" title="Play/pause"><ha-icon icon="mdi:play"></ha-icon></button>
          <button class="stop" title="Stop"><ha-icon icon="mdi:stop"></ha-icon></button>
          <button class="mute" title="Mute"><ha-icon icon="mdi:volume-high"></ha-icon></button>
          <input class="vol" type="range" min="0" max="100" step="1" aria-label="Volume">
        </div>
        <form>
          <input type="url" placeholder="Paste a YouTube link" enterkeyhint="go" autocomplete="off">
          <button type="submit" title="Play link"><ha-icon icon="mdi:send"></ha-icon></button>
        </form>
        <div class="status"></div>
      </ha-card>`;

    const $ = (s) => this._root.querySelector(s);
    this._el = {
      img: $(".thumb img"), placeholder: $(".thumb ha-icon"), title: $(".title"), sub: $(".sub"),
      fill: $(".fill"), pos: $(".pos"), dur: $(".dur"), play: $(".play"), playIcon: $(".play ha-icon"),
      stop: $(".stop"), mute: $(".mute"), muteIcon: $(".mute ha-icon"), vol: $(".vol"),
      form: $("form"), link: $("form input"), status: $(".status"),
    };
    this._el.img.addEventListener("load", () => {
      this._el.img.hidden = false;
      this._el.placeholder.hidden = true;
    });
    this._el.img.addEventListener("error", () => {
      this._el.img.hidden = true;
      this._el.placeholder.hidden = false;
    });
    this._el.play.addEventListener("click", () => {
      const playing = this._stateObj?.state === "playing";
      this._call("media_player", playing ? "media_pause" : "media_play");
    });
    this._el.stop.addEventListener("click", () => this._call("media_player", "media_stop"));
    this._el.mute.addEventListener("click", () => {
      const muted = this._stateObj?.attributes.is_volume_muted;
      this._call("media_player", "volume_mute", { is_volume_muted: !muted });
    });
    this._el.vol.addEventListener("change", (ev) => {
      this._call("media_player", "volume_set", { volume_level: Number(ev.target.value) / 100 });
    });
    this._el.form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const url = this._el.link.value.trim();
      if (!url) return;
      this._hass.callService("input_text", "set_value", { entity_id: this._config.url_entity, value: url });
      this._el.link.value = "";
      this._el.link.blur();
      // Covers the moment before the automation reports itself running.
      this._pending = true;
      clearTimeout(this._pendingTimer);
      this._pendingTimer = setTimeout(() => {
        this._pending = false;
        this._update();
      }, 4000);
      this._update();
    });
  }

  get _stateObj() {
    return this._hass?.states[this._config.entity];
  }

  _update() {
    const st = this._stateObj;
    const el = this._el;
    if (!st) {
      el.title.textContent = `Entity not found: ${this._config.entity}`;
      return;
    }
    const a = st.attributes;
    const active = st.state === "playing" || st.state === "paused" || st.state === "buffering";

    const id = active ? (VIDEO_ID.exec(a.media_content_id || "") || [])[1] : undefined;
    const src = id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "";
    if (src !== this._src) {
      this._src = src;
      if (src) el.img.src = src;
      else {
        el.img.removeAttribute("src");
        el.img.hidden = true;
        el.placeholder.hidden = false;
      }
    }

    el.title.textContent = active ? a.media_title || "Playing" : st.state === "unavailable" ? "Panel unavailable" : "Nothing playing";
    let channel = "";
    const np = this._config.now_playing_entity && this._hass.states[this._config.now_playing_entity];
    if (id && np) {
      const [npId, ...rest] = np.state.split("|");
      if (npId === id) channel = rest.join("|");
    }
    el.sub.textContent = channel || (active ? "YouTube" : "");

    el.playIcon.setAttribute("icon", st.state === "playing" ? "mdi:pause" : "mdi:play");
    const features = a.supported_features || 0;
    el.play.disabled = !active || !(features & (st.state === "playing" ? PAUSE : PLAY));
    el.stop.disabled = !active || !(features & STOP);
    el.muteIcon.setAttribute("icon", a.is_volume_muted ? "mdi:volume-off" : "mdi:volume-high");
    el.mute.disabled = st.state === "unavailable";
    el.vol.disabled = st.state === "unavailable";
    if (this._root.activeElement !== el.vol && a.volume_level !== undefined) {
      el.vol.value = Math.round(a.volume_level * 100);
    }

    const auto = this._config.automation && this._hass.states[this._config.automation];
    const loading = auto ? (auto.attributes.current || 0) > 0 : false;
    if (loading) this._pending = false;
    el.status.textContent = loading || this._pending ? "Loading video…" : "";

    this._updateProgress();
  }

  _updateProgress() {
    const st = this._stateObj;
    if (!st || !this._el) return;
    const a = st.attributes;
    const active = st.state === "playing" || st.state === "paused";
    const dur = active ? Number(a.media_duration) || 0 : 0;
    let pos = active ? Number(a.media_position) || 0 : 0;
    if (st.state === "playing" && a.media_position_updated_at) {
      pos += (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
    }
    if (dur) pos = Math.min(pos, dur);
    this._el.fill.style.width = dur ? `${(pos / dur) * 100}%` : "0";
    this._el.pos.textContent = active ? fmt(pos) : "";
    this._el.dur.textContent = active && dur ? fmt(dur) : "";
  }
}

customElements.define("youtube-dlna-card", YoutubeDlnaCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "youtube-dlna-card",
  name: "YouTube DLNA card",
  description: "Paste a YouTube link and control its playback on a DLNA renderer.",
});
