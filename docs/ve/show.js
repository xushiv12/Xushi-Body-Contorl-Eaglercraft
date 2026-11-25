
/*
 * GYX Body Control Library
 *
 * Browser version of the original Python lib.py
 *
 * Action A:
 * Left arm down, right arm horizontal
 * window.gyx = "1"
 *
 * Action B:
 * Right arm down, left arm horizontal
 * window.gyx = "2"
 *
 * Other poses:
 * Do not change window.gyx
 *
 * No game control or keyboard simulation.
 *
 * Public functions:
 * A(), B(), start(), stop(),
 * reset(), get_gyx(), get_error()
 */

(function (root) {
  "use strict";

  // ====================================
  // Global variable
  // ====================================

  root.gyx = "0";

  // ====================================
  // MediaPipe configuration
  // ====================================

  const VERSION = "0.10.32";

  const MODULE_URL =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" +
    VERSION + "/vision_bundle.mjs";

  const WASM_URL =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@" +
    VERSION + "/wasm";

  const MODEL_URL =
    "https://storage.googleapis.com/" +
    "mediapipe-models/pose_landmarker/" +
    "pose_landmarker_lite/float16/1/" +
    "pose_landmarker_lite.task";

  // ====================================
  // Body landmarks
  // ====================================

  const LEFT = [11, 13, 15];
  const RIGHT = [12, 14, 16];

  // ====================================
  // Internal state
  // ====================================

  let enabledA = false;
  let enabledB = false;

  let video = null;
  let stream = null;
  let detector = null;

  let active = false;
  let startupPromise = null;

  let frameId = null;
  let sessionId = 0;

  let lastVideoTime = -1;
  let lastTimestamp = -1;

  let errorMessage = "";

  // ====================================
  // Landmark visibility
  // ====================================

  function visible(points, ...indices) {
    return indices.every(i => {
      const p = points[i];

      return (
        p !== undefined &&
        p !== null &&
        (p.visibility ?? 1) >= 0.5 &&
        (p.presence ?? 1) >= 0.5
      );
    });
  }

  // ====================================
  // Shoulder width
  // ====================================

  function shoulderWidth(points) {
    const a = points[11];
    const b = points[12];

    return Math.hypot(
      a.x - b.x,
      a.y - b.y
    );
  }

  // ====================================
  // Horizontal arm detection
  // ====================================

  function horizontal(points, arm) {
    const [s, e, w] = arm;

    if (!visible(points, 11, 12, s, e, w)) {
      return false;
    }

    const width = shoulderWidth(points);

    if (width < 0.045) {
      return false;
    }

    const shoulder = points[s];
    const elbow = points[e];
    const wrist = points[w];

    const midX =
      (points[11].x + points[12].x) / 2;

    const outward =
      shoulder.x >= midX ? 1 : -1;

    return (
      outward *
        (wrist.x - shoulder.x) >
          0.75 * width &&

      outward *
        (elbow.x - shoulder.x) >
          0.24 * width &&

      Math.abs(
        wrist.y - shoulder.y
      ) < 0.38 * width &&

      Math.abs(
        elbow.y - shoulder.y
      ) < 0.32 * width &&

      outward *
        (wrist.x - elbow.x) >
          0.22 * width
    );
  }

  // ====================================
  // Downward arm detection
  // ====================================

  function down(points, arm) {
    const [s, e, w] = arm;

    if (!visible(points, 11, 12, s, e, w)) {
      return false;
    }

    const width = shoulderWidth(points);

    if (width < 0.045) {
      return false;
    }

    const shoulder = points[s];
    const elbow = points[e];
    const wrist = points[w];

    return (
      wrist.y - shoulder.y >
        0.78 * width &&

      elbow.y - shoulder.y >
        0.28 * width &&

      wrist.y - elbow.y >
        0.18 * width &&

      Math.abs(
        wrist.x - shoulder.x
      ) < 0.65 * width &&

      Math.abs(
        elbow.x - shoulder.x
      ) < 0.50 * width
    );
  }

  // ====================================
  // Process detected pose
  // ====================================

  function processLandmarks(points) {
    if (!points || points.length < 17) {
      return;
    }

    // Action A
    if (
      enabledA &&
      down(points, LEFT) &&
      horizontal(points, RIGHT)
    ) {
      root.gyx = "1";
    }

    // Action B
    else if (
      enabledB &&
      down(points, RIGHT) &&
      horizontal(points, LEFT)
    ) {
      root.gyx = "2";
    }

    // Other poses:
    // Keep the previous value.
  }

  // ====================================
  // Camera recognition loop
  // ====================================

  function recognizeFrame(id) {
    if (!active || id !== sessionId) {
      return;
    }

    try {
      if (
        video &&
        detector &&
        video.readyState >= 2 &&
        video.videoWidth > 0 &&
        video.currentTime !== lastVideoTime
      ) {
        lastVideoTime = video.currentTime;

        const timestamp = Math.max(
          performance.now(),
          lastTimestamp + 1
        );

        lastTimestamp = timestamp;

        const result = detector.detectForVideo(
          video,
          timestamp
        );

        const points =
          result.landmarks &&
          result.landmarks.length > 0
            ? result.landmarks[0]
            : null;

        processLandmarks(points);
      }

    } catch (error) {
      errorMessage =
        error.message || String(error);

      console.error(
        "GYX recognition error:",
        errorMessage
      );

      stop();
      return;
    }

    frameId = root.requestAnimationFrame(
      () => recognizeFrame(id)
    );
  }

  // ====================================
  // Start camera and MediaPipe
  // ====================================

  async function start() {
    if (active) {
      return;
    }

    if (startupPromise) {
      return startupPromise;
    }

    errorMessage = "";

    const id = ++sessionId;

    startupPromise = (async function () {
      try {
        if (!root.isSecureContext) {
          throw new Error(
            "Camera requires HTTPS or localhost"
          );
        }

        if (
          !navigator.mediaDevices ||
          !navigator.mediaDevices.getUserMedia
        ) {
          throw new Error(
            "Browser does not support camera access"
          );
        }

        // Request camera permission first.
        const localStream =
          await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              width: { ideal: 640 },
              height: { ideal: 480 },
              facingMode: "user"
            }
          });

        if (id !== sessionId) {
          localStream.getTracks().forEach(
            track => track.stop()
          );
          return;
        }

        stream = localStream;

        video = document.createElement("video");

        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;

        await video.play();

        if (id !== sessionId) {
          return;
        }

        // Load the actual MediaPipe ESM bundle.
        const imported = await import(MODULE_URL);

        if (id !== sessionId) {
          return;
        }

        // Handle both named and default exports.
        const vision =
          imported.FilesetResolver
            ? imported
            : imported.default;

        if (
          !vision ||
          !vision.FilesetResolver ||
          !vision.PoseLandmarker
        ) {
          throw new Error(
            "MediaPipe module exports are unavailable"
          );
        }

        const {
          FilesetResolver,
          PoseLandmarker
        } = vision;

        // Load WASM runtime.
        const fileset =
          await FilesetResolver.forVisionTasks(
            WASM_URL
          );

        if (id !== sessionId) {
          return;
        }

        // Initialize pose detector.
        const newDetector =
          await PoseLandmarker.createFromOptions(
            fileset,
            {
              baseOptions: {
                modelAssetPath: MODEL_URL,
                delegate: "CPU"
              },

              runningMode: "VIDEO",
              numPoses: 1,

              minPoseDetectionConfidence: 0.5,
              minPosePresenceConfidence: 0.5,
              minTrackingConfidence: 0.5
            }
          );

        if (id !== sessionId) {
          newDetector.close();
          return;
        }

        detector = newDetector;

        lastVideoTime = -1;
        lastTimestamp = -1;

        active = true;

        console.log(
          "GYX: Camera and pose recognition ready"
        );

        frameId = root.requestAnimationFrame(
          () => recognizeFrame(id)
        );

      } catch (error) {
        if (id === sessionId) {
          errorMessage =
            error.message || String(error);

          console.error(
            "GYX startup error:",
            errorMessage
          );

          stop();
        }

        throw error;
      }
    })();

    try {
      await startupPromise;
    } finally {
      startupPromise = null;
    }
  }

  // ====================================
  // Stop recognition
  // ====================================

  function stop() {
    sessionId++;

    active = false;

    if (frameId !== null) {
      root.cancelAnimationFrame(frameId);
      frameId = null;
    }

    if (stream) {
      stream.getTracks().forEach(
        track => track.stop()
      );

      stream = null;
    }

    if (video) {
      video.pause();
      video.srcObject = null;
      video = null;
    }

    if (detector) {
      detector.close();
      detector = null;
    }

    // Do not reset gyx automatically.
  }

  // ====================================
  // Public functions
  // ====================================

  function reset() {
    root.gyx = "0";
  }

  function get_gyx() {
    return root.gyx;
  }

  function get_error() {
    return errorMessage;
  }

  async function A() {
    enabledA = true;

    await start();

    return root.gyx === "1";
  }

  async function B() {
    enabledB = true;

    await start();

    return root.gyx === "2";
  }

  // ====================================
  // Export to global window
  // ====================================

  root.A = A;
  root.B = B;

  root.start = start;
  root.stop = stop;

  root.reset = reset;
  root.get_gyx = get_gyx;
  root.get_error = get_error;

})(window);
