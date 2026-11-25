
/*
 * GYX browser library — port of lib(3).py pose classification.
 * Only updates the global window.gyx to "1" or "2" for matching poses.
 * No keyboard events, game actions, or camera preview.
 * Requires HTTPS or localhost and camera permission.
 * MediaPipe Tasks Vision runs in the browser; model is fetched on first start.
 *
 * Usage (from a user-click handler):
 *   await A();
 *   await B();
 *   console.log(gyx);       // "0", "1", or "2"
 *   console.log(get_gyx()); // same value
 *   stop();                 // releases the camera
 */
(function (root) {
  "use strict";
  if (!root || !root.document) return;

  // Original Python library uses strings, not numbers.
  root.gyx = "0";

  const LEFT = [11, 13, 15];
  const RIGHT = [12, 14, 16];
  const MP_VERSION = "0.10.22";
  const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/+esm`;
  const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
  const MODEL_URL =
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

  let enabledA = false;
  let enabledB = false;
  let video = null;
  let stream = null;
  let landmarker = null;
  let active = false;
  let frameId = 0;
  let runId = 0;
  let lastTimestamp = -1;
  let lastVideoTime = -1;
  let startup = null;
  let errorMessage = "";

  function visible(points, ...indices) {
    return indices.every((i) => {
      const p = points[i];
      return !!p && (p.visibility ?? 1) >= 0.5 && (p.presence ?? 1) >= 0.5;
    });
  }

  function shoulderWidth(points) {
    const a = points[11], b = points[12];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function horizontal(points, arm) {
    const [s, e, w] = arm;
    if (!visible(points, 11, 12, s, e, w)) return false;
    const width = shoulderWidth(points);
    if (width < 0.045) return false;
    const shoulder = points[s], elbow = points[e], wrist = points[w];
    const midX = (points[11].x + points[12].x) / 2;
    const outward = shoulder.x >= midX ? 1 : -1;
    return (
      outward * (wrist.x - shoulder.x) > 0.75 * width &&
      outward * (elbow.x - shoulder.x) > 0.24 * width &&
      Math.abs(wrist.y - shoulder.y) < 0.38 * width &&
      Math.abs(elbow.y - shoulder.y) < 0.32 * width &&
      outward * (wrist.x - elbow.x) > 0.22 * width
    );
  }

  function down(points, arm) {
    const [s, e, w] = arm;
    if (!visible(points, 11, 12, s, e, w)) return false;
    const width = shoulderWidth(points);
    if (width < 0.045) return false;
    const shoulder = points[s], elbow = points[e], wrist = points[w];
    return (
      wrist.y - shoulder.y > 0.78 * width &&
      elbow.y - shoulder.y > 0.28 * width &&
      wrist.y - elbow.y > 0.18 * width &&
      Math.abs(wrist.x - shoulder.x) < 0.65 * width &&
      Math.abs(elbow.x - shoulder.x) < 0.50 * width
    );
  }

  function processLandmarks(points) {
    if (!points) return;
    if (enabledA && down(points, LEFT) && horizontal(points, RIGHT)) {
      root.gyx = "1";
    } else if (enabledB && down(points, RIGHT) && horizontal(points, LEFT)) {
      root.gyx = "2";
    }
    // All other poses: deliberately do NOTHING, keep previous gyx.
  }

  function onFrame(id) {
    if (!active || id !== runId) return;
    try {
      if (video && video.readyState >= 2 && video.videoWidth > 0 &&
          video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const timestamp = Math.max(lastTimestamp + 1, performance.now());
        lastTimestamp = timestamp;
        const result = landmarker.detectForVideo(video, timestamp);
        processLandmarks(result.landmarks?.[0] ?? null);
      }
    } catch (e) {
      errorMessage = String(e?.message ?? e);
      stop();
      return;
    }
    frameId = root.requestAnimationFrame(() => onFrame(id));
  }

  async function start() {
    if (active) return;
    if (startup) return startup;
    const id = ++runId;
    errorMessage = "";
    startup = (async () => {
      try {
        if (!root.isSecureContext) {
          throw new Error("摄像头需要 HTTPS 或 localhost 安全网页");
        }
        if (!root.navigator?.mediaDevices?.getUserMedia) {
          throw new Error("当前浏览器不支持 getUserMedia 摄像头接口");
        }
        // Ask permission immediately in the user's click, before loading model.
        const localStream = await root.navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }
        });
        if (id !== runId) {
          localStream.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = localStream;
        video = root.document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await video.play();

        const { FilesetResolver, PoseLandmarker } = await import(MP_URL);
        if (id !== runId) return;
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        if (id !== runId) return;
        const detector = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        });
        if (id !== runId) { detector.close(); return; }
        landmarker = detector;
        active = true;
        lastTimestamp = -1;
        lastVideoTime = -1;
        frameId = root.requestAnimationFrame(() => onFrame(id));
      } catch (e) {
        if (id === runId) {
          errorMessage = String(e?.message ?? e);
          stop();
        }
        throw e;
      }
    })();
    try {
      await startup;
    } finally {
      startup = null;
    }
  }

  function stop() {
    runId++;
    active = false;
    if (frameId) root.cancelAnimationFrame(frameId);
    frameId = 0;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    if (video) { video.pause(); video.srcObject = null; }
    video = null;
    if (landmarker) landmarker.close();
    landmarker = null;
    // Keep gyx; the original Python implementation also keeps last match.
  }

  function reset() { root.gyx = "0"; }
  function get_gyx() { return root.gyx; }
  function get_error() { return errorMessage; }
  async function A() { enabledA = true; await start(); return root.gyx === "1"; }
  async function B() { enabledB = true; await start(); return root.gyx === "2"; }

  Object.assign(root, { A, B, start, stop, reset, get_gyx, get_error });
})(window);
