// server-websocket.js
// server-websocket.js (RAW WebSocket, not socket.io)
const http = require("http");
const WebSocket = require("ws");
const ffmpeg = require("fluent-ffmpeg");

const PORT = 4000;
const RTSP_URL =
  process.env.DAHUA_RTSP_URL ||
  "rtsp://admin:12a34s56d@192.168.111.227:554/cam/realmonitor?channel=1&subtype=0";

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("WebSocket client connected");
  const ffmpegStream = ffmpeg(RTSP_URL)
    .addOptions([
      "-vf",
      "fps=20", // 20 frames per second
      "-q:v",
      "8", // Lower JPEG qualitya
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
    ])
    .format("mjpeg")
    .on("error", (err) => {
      console.error("FFmpeg error:", err.message);
      ws.send(JSON.stringify({ error: err.message }));
    })
    .pipe();

  ffmpegStream.on("data", (chunk) => {
    // Send base64 JPEG as plain message
    ws.send("data:image/jpeg;base64," + chunk.toString("base64"));
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    ffmpegStream.destroy();
  });
});

server.listen(PORT, () => {
  console.log(`Raw WebSocket camera server running on port ${PORT}`);
});
