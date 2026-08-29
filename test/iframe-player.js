const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
const video = document.querySelector("video");
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
