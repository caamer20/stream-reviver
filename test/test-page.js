const player = document.getElementById("player");
const canvas = document.getElementById("source-canvas");
const context = canvas.getContext("2d");
const placeholder = document.getElementById("placeholder");
const readout = document.getElementById("readout");
const modeLabel = document.getElementById("mode-label");
const mode = new URL(location.href).searchParams.get("mode") || "healthy";
let video = null;
let sourceAnimation = 0;
let recordingStream = null;

document.querySelectorAll("[data-mode]").forEach((button) => {
  button.classList.toggle("active", button.dataset.mode === mode);
  button.addEventListener("click", () => {
    const url = new URL(location.href);
    url.searchParams.set("mode", button.dataset.mode);
    location.href = url.href;
  });
});

document.getElementById("toggle-error").addEventListener("click", () => {
  const old = player.querySelector(".simulated-stream-error");
  if (old) old.remove();
  else {
    const overlay = document.createElement("div");
    overlay.className = "simulated-stream-error";
    overlay.textContent = "Simulated player error overlay";
    player.append(overlay);
  }
});

setInterval(() => {
  document.getElementById("clock").textContent = new Date().toLocaleTimeString();
  if (video) {
    const time = Number.isFinite(video.currentTime) ? video.currentTime.toFixed(2) : String(video.currentTime);
    readout.textContent = `currentTime ${time}s · readyState ${video.readyState} · paused ${video.paused}`;
  }
}, 250);

void start();

async function start() {
  modeLabel.textContent = mode.replace(/^./, (letter) => letter.toUpperCase());
  if (mode === "none") {
    placeholder.textContent = "No video on this page";
    readout.textContent = "The extension should report “No video detected” and never reload.";
    return;
  }
  if (mode === "audio-only") {
    placeholder.textContent = "Audio-only fixture (no HTML video)";
    const audio = document.createElement("audio");
    audio.controls = true; audio.setAttribute("aria-label", "Audio-only fixture"); player.append(audio);
    readout.textContent = "The extension should report no video and never recover automatically.";
    return;
  }
  if (mode === "canvas") {
    placeholder?.remove(); canvas.hidden = false; startCanvasOnly();
    readout.textContent = "Animated canvas exposes no controllable HTML video.";
    return;
  }
  if (["iframe", "nested", "sandbox"].includes(mode)) {
    placeholder?.remove();
    const iframe = document.createElement("iframe");
    iframe.className = "test-iframe";
    iframe.src = `iframe-player.html?mode=${mode === "nested" ? "nested" : "healthy"}&depth=1`;
    iframe.allowFullscreen = true;
    iframe.allow = "autoplay; fullscreen; picture-in-picture";
    if (mode === "sandbox") iframe.sandbox = "allow-scripts";
    player.append(iframe);
    readout.textContent = mode === "nested" ? "Healthy player is two same-origin frames deep" : mode === "sandbox" ? "Player is inside a restricted sandbox" : "Healthy player is running inside a same-origin iframe";
    return;
  }
  if (mode === "spa") {
    placeholder.textContent = "SPA route changes and injects video in 6 seconds…";
    readout.textContent = "Waiting for history.pushState and dynamic injection";
    await wait(6_000);
    history.pushState({}, "", `${location.pathname}?mode=spa&route=live`);
  }
  if (mode === "delayed") {
    placeholder.textContent = "Video will be injected in 20 seconds…";
    readout.textContent = "Waiting for dynamic player injection";
    await wait(20_000);
  }
  if (mode === "error") {
    createVideo();
    video.src = "data:video/mp4;base64,AAAAIGZ0eXBpc29tINVALIDSTREAM";
    video.load();
    video.play().catch(() => {});
    readout.textContent = "Waiting for the media error event";
    return;
  }

  try {
    const recording = await recordCanvasClip();
    if (mode === "shadow") createShadowVideo();
    else createVideo();
    if (mode === "stall") await playAsOpenMediaSource(recording);
    else {
      video.loop = true;
      video.src = URL.createObjectURL(recording);
      await video.play();
    }
    if (mode === "multi") addMutedPreview(recording);
    if (mode === "churn") startDomChurn();
    if (mode === "recovery") addRetryRecovery();
    if (mode === "access") addAccessInterruption();
    if (mode === "replace") replacePlayerSoon(recording);
    if (mode === "paused") setTimeout(() => video.pause(), 1_500);
    if (mode === "ended") video.loop = false;
    if (mode === "protocol-spoof") forgeProtocolFailure();
    if (mode === "dangerous-control") addDangerousControl();
  } catch (error) {
    // MediaRecorder or MediaSource support can vary. The fallback still creates a
    // real HTML5 MediaStream video and stops its track in stall mode.
    readout.textContent = `Using captureStream fallback: ${String(error)}`;
    createVideo();
    const stream = canvas.captureStream(30);
    video.srcObject = stream;
    await video.play();
    if (mode === "stall") setTimeout(() => stream.getTracks().forEach((track) => track.stop()), 3500);
  }
}

function startCanvasOnly() {
  let frame = 0;
  const draw = () => {
    frame += 1;
    context.fillStyle = `hsl(${frame % 360} 60% 22%)`; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "white"; context.font = "700 48px system-ui"; context.fillText("CANVAS-ONLY PLAYER", 55, 100);
    context.font = "500 100px monospace"; context.fillText((frame / 60).toFixed(1), 55, 280);
    requestAnimationFrame(draw);
  };
  draw();
}

function forgeProtocolFailure() {
  setInterval(() => window.postMessage({
    channel: "__stream_reviver_protocol_v3__",
    observation: { kind: "HLS_JS", observedAt: Date.now(), fatalError: "Forged page-world fatal signal" }
  }, "*"), 1_000);
}

function addDangerousControl() {
  const dialog = document.createElement("div");
  dialog.className = "access-required"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
  dialog.textContent = "Sign in required ";
  const retry = document.createElement("button"); retry.className = "retry-stream"; retry.textContent = "Continue sign in";
  retry.addEventListener("click", () => { document.documentElement.dataset.sensitiveControlClicked = "true"; });
  dialog.append(retry); player.append(dialog);
  const overlay = document.createElement("div"); overlay.className = "simulated-stream-error"; overlay.textContent = "Simulated outage"; player.append(overlay);
  video.pause();
}

function addMutedPreview(blob) {
  const preview = document.createElement("video");
  preview.className = "preview-video ad promo";
  preview.muted = true;
  preview.loop = true;
  preview.autoplay = true;
  preview.src = URL.createObjectURL(blob);
  player.append(preview);
  preview.play().catch(() => {});
}

function startDomChurn() {
  const feed = document.createElement("div");
  feed.id = "churn-feed";
  player.append(feed);
  let count = 0;
  setInterval(() => {
    const message = document.createElement("span");
    message.textContent = `Chat update ${++count}`;
    feed.prepend(message);
    while (feed.children.length > 12) feed.lastElementChild.remove();
  }, 40);
}

function addRetryRecovery() {
  const overlay = document.createElement("div");
  overlay.className = "simulated-stream-error";
  overlay.textContent = "Simulated outage — retry available";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-stream";
  retry.textContent = "Retry stream";
  retry.addEventListener("click", () => {
    overlay.remove();
    retry.remove();
    video.play().catch(() => {});
  });
  video.pause();
  player.append(overlay, retry);
}

function addAccessInterruption() {
  const dialog = document.createElement("div");
  dialog.className = "access-required";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.textContent = "Sign in required to continue this simulated stream";
  player.append(dialog);
}

function replacePlayerSoon(blob) {
  setTimeout(async () => {
    video.remove();
    createVideo();
    video.loop = true;
    video.src = URL.createObjectURL(blob);
    await video.play();
  }, 4_500);
}

function createVideo() {
  placeholder?.remove();
  video = document.createElement("video");
  video.id = "test-video";
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = true;
  player.prepend(video);
}

function createShadowVideo() {
  placeholder?.remove();
  const host = document.createElement("div");
  host.id = "open-shadow-player";
  host.style.display = "block";
  host.style.width = "100%";
  const root = host.attachShadow({ mode: "open" });
  video = document.createElement("video");
  video.id = "shadow-test-video";
  video.setAttribute("aria-label", "Open shadow root test video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.controls = true;
  video.style.display = "block";
  video.style.width = "100%";
  video.style.aspectRatio = "16 / 9";
  root.append(video);
  player.prepend(host);
}

async function recordCanvasClip() {
  if (!window.MediaRecorder || !canvas.captureStream) throw new Error("MediaRecorder unavailable");
  recordingStream = canvas.captureStream(30);
  const preferred = ["video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(recordingStream, preferred ? { mimeType: preferred } : undefined);
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
  const stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
  recorder.start(250);
  const started = performance.now();
  const draw = (now) => {
    const elapsed = (now - started) / 1000;
    const hue = (elapsed * 55) % 360;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, `hsl(${hue} 62% 35%)`);
    gradient.addColorStop(1, `hsl(${(hue + 80) % 360} 65% 18%)`);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(255,255,255,.92)";
    context.font = "700 46px system-ui";
    context.fillText("LIVE TEST STREAM", 55, 85);
    context.font = "500 110px ui-monospace, monospace";
    context.fillText(elapsed.toFixed(1), 55, 280);
    context.font = "400 26px system-ui";
    context.fillText("Generated locally in your browser", 58, 345);
    sourceAnimation = requestAnimationFrame(draw);
  };
  sourceAnimation = requestAnimationFrame(draw);
  await wait(4_000);
  recorder.stop();
  await stopped;
  cancelAnimationFrame(sourceAnimation);
  recordingStream.getTracks().forEach((track) => track.stop());
  const mimeType = recorder.mimeType || "video/webm";
  return new Blob(chunks, { type: mimeType });
}

async function playAsOpenMediaSource(blob) {
  if (!window.MediaSource || !MediaSource.isTypeSupported(blob.type)) throw new Error("MediaSource codec unavailable");
  const mediaSource = new MediaSource();
  video.src = URL.createObjectURL(mediaSource);
  await new Promise((resolve) => mediaSource.addEventListener("sourceopen", resolve, { once: true }));
  const sourceBuffer = mediaSource.addSourceBuffer(blob.type);
  sourceBuffer.appendBuffer(await blob.arrayBuffer());
  await new Promise((resolve) => sourceBuffer.addEventListener("updateend", resolve, { once: true }));
  // Deliberately leave the MediaSource open. Playback reaches the buffered edge,
  // emits waiting/stalled, stays unpaused, and currentTime stops advancing.
  mediaSource.duration = Number.POSITIVE_INFINITY;
  await video.play();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
