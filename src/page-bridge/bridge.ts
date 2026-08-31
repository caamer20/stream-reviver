// This script intentionally runs in the page's MAIN world. Everything it emits
// is treated as untrusted supplemental evidence by the isolated content script.
(() => {
  const marker = "__streamReviverProtocolBridgeV3";
  const scope = window as any;
  if (scope[marker]) return;
  scope[marker] = true;
  const channel = "__stream_reviver_protocol_v3__";
  let lastMseAppendAt = 0;
  let mseError = "";
  const observedSourceBuffers = new WeakSet<SourceBuffer>();
  const peerConnections = new Set<RTCPeerConnection>();
  const previousStats = new WeakMap<RTCPeerConnection, Record<string, number>>();
  const maxTrackedPeerConnections = 32;
  let webRtcSampleInFlight = false;

  const emit = (observation: Record<string, unknown>) => {
    window.postMessage({ channel, observation: { ...observation, observedAt: Date.now() } }, "*");
  };

  try {
    const originalAppend = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function(buffer: BufferSource): void {
      lastMseAppendAt = Date.now();
      if (!observedSourceBuffers.has(this)) {
        observedSourceBuffers.add(this);
        // One listener per SourceBuffer avoids accumulating one dormant
        // listener for every append during a long-running live stream.
        this.addEventListener("error", () => { mseError = "Media Source buffer emitted an error"; });
      }
      return originalAppend.call(this, buffer);
    };
  } catch { /* MSE unavailable or protected */ }

  try {
    const NativePeerConnection = window.RTCPeerConnection;
    if (NativePeerConnection) {
      const Wrapped = function(this: unknown, configuration?: RTCConfiguration) {
        const connection = new NativePeerConnection(configuration);
        if (peerConnections.size < maxTrackedPeerConnections) peerConnections.add(connection);
        connection.addEventListener("connectionstatechange", () => {
          if (["failed", "closed"].includes(connection.connectionState)) {
            emit({ kind: "WEBRTC", fatalError: `WebRTC connection ${connection.connectionState}` });
          }
          if (connection.connectionState === "closed") peerConnections.delete(connection);
        });
        return connection;
      } as unknown as typeof RTCPeerConnection;
      Wrapped.prototype = NativePeerConnection.prototype;
      Object.setPrototypeOf(Wrapped, NativePeerConnection);
      (window as any).RTCPeerConnection = Wrapped;
    }
  } catch { /* page prevented wrapping */ }

  const patchPlayerLibraries = () => {
    try {
      const Hls = scope.Hls;
      if (Hls?.prototype && !Hls.prototype.__streamReviverPatched && typeof Hls.prototype.trigger === "function") {
        const trigger = Hls.prototype.trigger;
        Hls.prototype.trigger = function(event: unknown, data: any) {
          if (String(event).toLowerCase().includes("error") && data?.fatal) {
            emit({ kind: "HLS_JS", fatalError: cleanError(data?.details ?? data?.type ?? "Fatal HLS error") });
          }
          return trigger.apply(this, arguments as any);
        };
        Hls.prototype.__streamReviverPatched = true;
        emit({ kind: "HLS_JS", readyState: "detected" });
      }
      if (scope.dashjs?.MediaPlayer) emit({ kind: "DASH_JS", readyState: "detected" });
    } catch { /* library shape differs */ }
  };

  const sampleWebRtc = async () => {
    if (webRtcSampleInFlight) return;
    webRtcSampleInFlight = true;
    try {
      for (const connection of [...peerConnections]) {
        if (["closed", "failed"].includes(connection.connectionState)) { peerConnections.delete(connection); continue; }
        try {
          const report = await connection.getStats();
          let packetsReceived = 0, packetsLost = 0, framesDecoded = 0, framesRendered = 0, freezeCount = 0, jitter = 0;
          report.forEach((stat: any) => {
            if (stat.type !== "inbound-rtp") return;
            packetsReceived += finite(stat.packetsReceived); packetsLost += finite(stat.packetsLost);
            framesDecoded += finite(stat.framesDecoded); framesRendered += finite(stat.framesRendered);
            freezeCount += finite(stat.freezeCount); jitter = Math.max(jitter, finite(stat.jitter));
          });
          const previous = previousStats.get(connection) ?? {};
          emit({
            kind: "WEBRTC", readyState: connection.connectionState,
            packetsReceivedDelta: packetsReceived - finite(previous.packetsReceived), packetsLostDelta: packetsLost - finite(previous.packetsLost),
            framesDecodedDelta: framesDecoded - finite(previous.framesDecoded), framesRenderedDelta: framesRendered - finite(previous.framesRendered),
            freezeCountDelta: freezeCount - finite(previous.freezeCount), jitterSeconds: jitter
          });
          previousStats.set(connection, { packetsReceived, packetsLost, framesDecoded, framesRendered, freezeCount });
        } catch { /* stats inaccessible */ }
      }
    } finally {
      webRtcSampleInFlight = false;
    }
  };

  window.setInterval(() => {
    patchPlayerLibraries();
    if (lastMseAppendAt || mseError) emit({ kind: "MSE", readyState: "observed", appendAgeMs: lastMseAppendAt ? Date.now() - lastMseAppendAt : undefined, fatalError: mseError || undefined });
    void sampleWebRtc();
  }, 3000);
  patchPlayerLibraries();

  function cleanError(value: unknown): string { return String(value).replace(/[\r\n]+/g, " ").slice(0, 160); }
  function finite(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? number : 0; }
})();
