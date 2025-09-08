(function () {
  "use strict";

  // DOM references
  let listenBtn;
  let cameraView;
  let statusText;
  let resultDiv;
  let statusSpinner;

  // Speech recognition instance
  let recognition = null;

  // Cached detection model
  let objectDetectionModel = null;

  // Throttle flag
  let isBusy = false;

  // Auto-listen flag after certain actions (e.g., opening camera)
  let shouldAutoListen = true; // enable continuous listening by default

  const HELP_MESSAGE = "You can say: open camera, what's in front, detect objects, or help.";

  // Utility: speak a message
  function speak(message) {
    try {
      const utter = new SpeechSynthesisUtterance(message);
      window.speechSynthesis.speak(utter);
    } catch (_) {}
  }

  function setProcessing(isProcessing) {
    if (statusText) statusText.setAttribute("aria-busy", isProcessing ? "true" : "false");
    if (statusSpinner) statusSpinner.setAttribute("aria-hidden", isProcessing ? "false" : "true");
  }

  // 1) Initialization
  window.addEventListener("load", () => {
    listenBtn = document.getElementById("listenBtn");
    cameraView = document.getElementById("cameraView");
    statusText = document.getElementById("statusText");
    resultDiv = document.getElementById("resultDiv");
    statusSpinner = document.getElementById("statusSpinner");

    if (statusText) {
      statusText.textContent = "Say 'Open camera' or 'What is in front of me?'";
    }

    initSpeechRecognition();

    // Auto-start listening for voice commands
    try {
      if (recognition) {
        if (statusText) statusText.textContent = "Listening...";
        recognition.start();
      }
    } catch (_) {}
  });

  // 2) Speech Recognition Setup
  function initSpeechRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      recognition = null;
      alert("This browser does not support speech recognition.");
      return;
    }

    recognition = new SR();
    recognition.lang = "en-US";
    recognition.continuous = false; // single-shot (we will auto-restart)
    recognition.interimResults = false;

    // 3) Voice Command Handling (with help mode)
    recognition.addEventListener("result", async (event) => {
      try {
        const transcript = (event.results?.[0]?.[0]?.transcript || "").toLowerCase();
        const detectTriggers = [
          "what's in front",
          "whats in front",
          "what is in front",
          "detect object",
          "detect objects"
        ];
        const helpTriggers = ["help", "what can i say", "what can you do"];
        const openCameraTriggers = ["open camera", "start camera", "turn on camera"];
        const closeCameraTriggers = ["close camera", "stop camera", "turn off camera"];

        if (helpTriggers.some(t => transcript.includes(t))) {
          speak(HELP_MESSAGE);
          if (statusText) statusText.textContent = HELP_MESSAGE;
          return;
        }

        if (openCameraTriggers.some(t => transcript.includes(t))) {
          await startCamera({ analyze: false });
          speak("Camera is on. How can I help you?");
          if (statusText) statusText.textContent = "Camera is on. Listening...";
          shouldAutoListen = true;
          return;
        }

        if (closeCameraTriggers.some(t => transcript.includes(t))) {
          resetApp();
          speak("Camera is off.");
          if (statusText) statusText.textContent = "Camera is off. Listening...";
          shouldAutoListen = true;
          return;
        }

        if (detectTriggers.some(t => transcript.includes(t))) {
          await startCamera({ analyze: true });
        } else {
          // Not recognized: keep listening silently, maybe give brief hint
          if (statusText) statusText.textContent = "Listening...";
        }
      } catch (err) {
        console.error(err);
        speak("I encountered an error processing your request.");
        if (statusText) statusText.textContent = "An error occurred.";
      }
    });

    recognition.addEventListener("end", () => {
      if (shouldAutoListen && !isBusy) {
        try {
          if (statusText) statusText.textContent = "Listening...";
          recognition.start();
        } catch (_) {}
      }
    });

    recognition.addEventListener("error", (event) => {
      console.error("Speech recognition error:", event);
      if (statusText) statusText.textContent = "Speech recognition error. Retrying...";
      // Try to resume listening after a short delay
      setTimeout(() => {
        if (shouldAutoListen && !isBusy) {
          try { recognition.start(); } catch (_) {}
        }
      }, 800);
    });
  }

  // 4) Camera Access
  async function startCamera(options = { analyze: true }) {
    const analyze = options && typeof options.analyze === "boolean" ? options.analyze : true;

    if (!cameraView || !(cameraView instanceof HTMLVideoElement)) {
      speak("Camera is not available.");
      throw new Error("cameraView element missing");
    }

    try {
      isBusy = true;
      setProcessing(true);
      if (statusText) statusText.textContent = "Opening camera...";
      const constraints = {
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      cameraView.srcObject = stream;
      cameraView.playsInline = true;
      cameraView.muted = true;
      cameraView.autoplay = true;

      await new Promise((resolve, reject) => {
        const onCanPlay = () => { cleanup(); resolve(); };
        const onError = (e) => { cleanup(); reject(e); };
        const cleanup = () => {
          cameraView.removeEventListener("loadedmetadata", onCanPlay);
          cameraView.removeEventListener("canplay", onCanPlay);
          cameraView.removeEventListener("error", onError);
        };
        cameraView.addEventListener("loadedmetadata", onCanPlay, { once: true });
        cameraView.addEventListener("canplay", onCanPlay, { once: true });
        cameraView.addEventListener("error", onError, { once: true });
      });

      cameraView.removeAttribute("hidden");
      cameraView.style.display = "block";
      if (statusText) statusText.textContent = analyze ? "Camera ready." : "Camera on.";

      if (analyze) {
        await analyzeImage();
      }
    } catch (err) {
      console.error(err);
      const msg = (err && err.message) ? err.message : "Unable to access the camera.";
      speak(msg);
      if (statusText) statusText.textContent = msg;
    } finally {
      setProcessing(false);
      isBusy = false;
    }
  }

  // 5) Object Detection (warm-up and detect on video)
  async function analyzeImage() {
    if (!cameraView) return;
    setProcessing(true);
    if (statusText) statusText.textContent = "Processing...";

    if (!objectDetectionModel) {
      objectDetectionModel = await cocoSsd.load();
    }

    // Warm-up: run multiple frames and keep the best detections
    let bestDetections = [];
    for (let i = 0; i < 3; i++) {
      const predictions = await objectDetectionModel.detect(cameraView);
      const detections = predictions.filter(p => typeof p.score === "number" && p.score > 0.5);
      if (detections.length > bestDetections.length) bestDetections = detections;
      if (i < 2) await new Promise(r => setTimeout(r, 200));
    }

    setProcessing(false);
    speakResults(bestDetections);
  }

  // Helper to join list naturally
  function joinNatural(items, conj = "and") {
    if (items.length <= 1) return items.join("");
    if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
    return `${items.slice(0, -1).join(", ")} ${conj} ${items[items.length - 1]}`;
  }

  // 6) Text-to-Speech Response with improved grammar
  function speakResults(detections) {
    let message = "";

    if (!Array.isArray(detections) || detections.length === 0) {
      message = "I cannot clearly identify any objects.";
    } else {
      const toArticle = (word) => (/^[aeiou]/i.test(word) ? "an" : "a");
      const parts = detections.slice(0, 5).map(d => {
        const name = String(d.class || "object");
        const pct = Math.round((Number(d.score) || 0) * 100);
        return `${toArticle(name)} ${name} with ${pct}% confidence`;
      });
      const joined = joinNatural(parts, "and");
      message = `I detect ${joined}.`;
    }

    if (resultDiv) resultDiv.textContent = message;
    speak(message);

    setTimeout(resetApp, 8000);
  }

  // 7) App Reset
  function resetApp() {
    // Stop camera
    if (cameraView && cameraView.srcObject && typeof cameraView.srcObject.getTracks === "function") {
      try { cameraView.srcObject.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    if (cameraView) {
      cameraView.srcObject = null;
      cameraView.hidden = true;
      cameraView.style.display = "none";
    }

    if (statusText) statusText.textContent = "Say 'Open camera' or 'What is in front of me?'";
    setProcessing(false);
    isBusy = false;
  }
})(); 