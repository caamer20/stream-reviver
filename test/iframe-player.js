const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
const video = document.querySelector("video");
const parameters = new URL(location.href).searchParams;
const depth = Number(parameters.get("depth") || "0");
if (parameters.get("mode") === "nested" && depth < 2) {
  document.body.replaceChildren();
  const iframe = document.createElement("iframe");
  iframe.src = `iframe-player.html?mode=nested&depth=${depth + 1}`;
  iframe.allow = "autoplay; fullscreen; picture-in-picture"; iframe.allowFullscreen = true;
  iframe.style.cssText = "width:100%;height:100%;border:0";
  document.body.append(iframe);
} else {
let frame = 0;
function draw() {
  frame += 1;
  context.fillStyle = `hsl(${frame % 360} 55% 22%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "white";
  context.font = "700 45px system-ui";
  context.fillText("IFRAME LIVE STREAM", 55, 90);
  context.font = "500 90px monospace";
  context.fillText((frame / 30).toFixed(1), 55, 260);
  requestAnimationFrame(draw);
}
draw();
video.srcObject = canvas.captureStream(30);
video.play().catch(() => {});
}
