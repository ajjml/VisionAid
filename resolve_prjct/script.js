// Vision Assistant bootstrap
(function () {
  "use strict";

  async function setupCamera() {
    const video = document.getElementById("cameraView");
    if (!(video instanceof HTMLVideoElement)) {
      alert("Camera preview element not found.");
      throw new Error("Element with id 'cameraView' not found or not a video element.");
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("Camera access is not supported on this device/browser.");
      throw new Error("mediaDevices.getUserMedia not available");
    }

    const tryGetStream = async (constraints) => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        throw err;
      }
    };

    let stream;
    try {
      // Prefer exact environment camera when available
      stream = await tryGetStream({ video: { facingMode: { exact: "environment" } }, audio: false });
    } catch (err) {
      // Fallback to best-effort environment or default camera
      try {
        stream = await tryGetStream({ video: { facingMode: "environment" }, audio: false });
      } catch (fallbackErr) {
        // Map common errors to user-friendly alerts
        const e = fallbackErr;
        const name = e && e.name ? e.name : "Error";
        const messageByName = {
          NotAllowedError: "Permission to use the camera was denied.",
          SecurityError: "Camera access is blocked by the browser's security settings.",
          NotFoundError: "No suitable camera was found on this device.",
          OverconstrainedError: "The requested camera constraints could not be satisfied.",
          NotReadableError: "The camera is already in use by another application.",
          TypeError: "Camera constraints were invalid.",
        };
        const userMessage = messageByName[name] || "Unable to access the camera.";
        alert(userMessage);
        throw fallbackErr;
      }
    }

    const statusParagraph = document.getElementById("statusText");
    if (statusParagraph) statusParagraph.textContent = "Camera stream acquired.";

    const videoEl = video;
    videoEl.srcObject = stream;
    videoEl.playsInline = true;
    videoEl.muted = true;
    videoEl.autoplay = true;

    return new Promise((resolve, reject) => {
      const onReady = async () => {
        try {
          await videoEl.play();
          videoEl.removeAttribute("hidden");
          videoEl.style.display = "block"; // in case CSS uses display:none
          if (statusParagraph) statusParagraph.textContent = "Camera ready.";
          resolve(videoEl);
        } catch (playErr) {
          alert("Failed to start the camera preview.");
          if (statusParagraph) statusParagraph.textContent = "Failed to start camera.";
          reject(playErr);
        } finally {
          cleanup();
        }
      };
      const onError = (ev) => {
        cleanup();
        if (statusParagraph) statusParagraph.textContent = "Camera error.";
        reject(ev instanceof Error ? ev : new Error("Video error"));
      };
      const cleanup = () => {
        videoEl.removeEventListener("loadedmetadata", onReady);
        videoEl.removeEventListener("error", onError);
        videoEl.removeEventListener("canplay", onReady);
      };

      videoEl.addEventListener("loadedmetadata", onReady, { once: true });
      videoEl.addEventListener("canplay", onReady, { once: true });
      videoEl.addEventListener("error", onError, { once: true });
    });
  }

  function speak(text) {
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1;
      utter.pitch = 1;
      window.speechSynthesis.speak(utter);
    } catch (_) {
      // no-op if speech synthesis not available
    }
  }

  async function startListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      const msg = "Speech recognition is not supported in this browser.";
      alert(msg);
      speak(msg);
      throw new Error("SpeechRecognition not available");
    }

    const statusParagraph = document.getElementById("statusText");
    const button = document.getElementById("listenBtn");
    const video = document.getElementById("cameraView");

    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;

    return new Promise((resolve) => {
      recognition.onresult = async (event) => {
        const transcript = (event.results?.[0]?.[0]?.transcript || "").toLowerCase();
        const triggers = [
          "what's in front of me",
          "whats in front of me",
          "what is in front of me",
          "detect objects",
          "detect object",
          "what do you see",
        ];
        if (triggers.some((t) => transcript.includes(t))) {
          try {
            if (button instanceof HTMLElement) button.style.display = "none";
            if (video instanceof HTMLVideoElement) { video.hidden = false; video.style.display = "block"; }
            if (statusParagraph) statusParagraph.textContent = "Processing...";
            await setupCamera();
            if (typeof window.analyzeImage === "function") { await window.analyzeImage(); }
            if (statusParagraph) statusParagraph.textContent = "Analysis complete.";
          } catch (err) {
            const msg = "Unable to process camera for analysis.";
            alert(msg);
            speak(msg);
            if (statusParagraph) statusParagraph.textContent = msg;
          }
        } else {
          speak("Say 'what's in front of me' or 'detect objects'.");
        }
        resolve({ transcript });
      };

      recognition.onerror = (event) => {
        const msg = (event?.error === "not-allowed") ? "Microphone permission denied." : "Speech recognition error.";
        alert(msg);
        speak(msg);
        if (statusParagraph) statusParagraph.textContent = msg;
        resolve(undefined);
      };

      try {
        if (statusParagraph) statusParagraph.textContent = "Listening...";
        recognition.start();
      } catch (_) {
        const msg = "Unable to start listening.";
        alert(msg);
        speak(msg);
        if (statusParagraph) statusParagraph.textContent = msg;
        resolve(undefined);
      }
    });
  }

  let cachedObjectDetectionModel = null;
  async function analyzeImage() {
    const statusParagraph = document.getElementById("statusText");
    const video = document.getElementById("cameraView");
    if (!(video instanceof HTMLVideoElement)) {
      throw new Error("cameraView video element not available");
    }

    if (typeof cocoSsd === "undefined" || typeof tf === "undefined") {
      const msg = "Model libraries not loaded.";
      alert(msg);
      speak(msg);
      throw new Error(msg);
    }

    try {
      if (!cachedObjectDetectionModel) {
        if (statusParagraph) statusParagraph.textContent = "Loading object detection model...";
        cachedObjectDetectionModel = await cocoSsd.load();
      }

      // Capture current frame to a canvas
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not get canvas context");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      if (statusParagraph) statusParagraph.textContent = "Detecting objects...";
      const predictions = await cachedObjectDetectionModel.detect(canvas);
      const confident = predictions.filter(p => (typeof p.score === "number") && p.score > 0.7);

      if (typeof window.speakResults === "function") {
        window.speakResults(confident);
      }
      return confident;
    } catch (err) {
      const msg = "Analysis failed.";
      if (statusParagraph) statusParagraph.textContent = msg;
      speak(msg);
      throw err;
    }
  }

  async function speakResults(detections) {
    const resultDiv = document.getElementById("resultDiv");
    const button = document.getElementById("listenBtn");
    const video = document.getElementById("cameraView");

    const say = (text) => {
      try {
        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1;
        utter.pitch = 1;
        window.speechSynthesis.speak(utter);
      } catch (_) {}
    };

    let text;
    if (!Array.isArray(detections) || detections.length === 0) {
      text = "I don't see any common objects clearly.";
    } else {
      const toArticle = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
      const parts = detections.map(d => {
        const name = String(d.class || "object");
        const pct = Math.round((Number(d.score) || 0) * 100);
        return `${toArticle(name)} ${name} with ${pct}% confidence`;
      });
      if (parts.length === 1) {
        text = `I detect ${parts[0]}.`;
      } else if (parts.length === 2) {
        text = `I detect ${parts[0]} and ${parts[1]}.`;
      } else {
        text = `I detect ${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}.`;
      }
    }

    if (resultDiv) resultDiv.textContent = text;
    say(text);

    await new Promise(r => setTimeout(r, 5000));

    if (video instanceof HTMLVideoElement) {
      const stream = video.srcObject;
      if (stream && typeof stream.getTracks === "function") {
        stream.getTracks().forEach(t => {
          try { t.stop(); } catch (_) {}
        });
      }
      video.srcObject = null;
      video.hidden = true;
      video.style.display = "none";
    }

    if (button instanceof HTMLElement) {
      button.style.display = "";
    }

    const statusParagraph = document.getElementById("statusText");
    if (statusParagraph) statusParagraph.textContent = "Ready.";
  }

  // Expose on window for usage elsewhere
  window.setupCamera = setupCamera;
  window.startListening = startListening;
  window.analyzeImage = analyzeImage;
  window.speakResults = speakResults;

  document.addEventListener("DOMContentLoaded", async () => {
    const statusParagraph = document.querySelector("main p");
    if (!statusParagraph) return;

    try {
      statusParagraph.textContent = "Loading TensorFlow.js and COCO-SSD…";
      // tf and cocoSsd are expected to be available via CDN scripts
      if (typeof tf === "undefined" || typeof cocoSsd === "undefined") {
        statusParagraph.textContent = "Failed to load required libraries.";
        return;
      }
      statusParagraph.textContent = "Ready.";
    } catch (err) {
      statusParagraph.textContent = "Initialization error.";
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });
})();

// Initialization on full window load
window.addEventListener("load", () => {
  const button = document.getElementById("listenBtn");
  const video = document.getElementById("cameraView");
  const status = document.getElementById("statusText");

  const hasRecognition = ("SpeechRecognition" in window) || ("webkitSpeechRecognition" in window);
  const hasSynthesis = ("speechSynthesis" in window) && ("SpeechSynthesisUtterance" in window);
  if (!hasRecognition || !hasSynthesis) {
    alert("This browser may not fully support speech recognition and synthesis.");
  }

  if (status) {
    status.textContent = "Press the button and say 'What is in front of me?'";
  }

  if (button && !button.dataset.wired) {
    button.addEventListener("click", async () => {
      try { await window.startListening(); } catch (_) {}
    });
    button.dataset.wired = "true";
  }
});