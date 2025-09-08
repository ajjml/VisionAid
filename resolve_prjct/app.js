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

  const HELP_MESSAGE = "You can say: what's in front, detect objects, or help.";

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
      statusText.textContent = "Press the button and say 'What is in front of me?'";
    }

    initSpeechRecognition();

    // 8) Button Click Handler with haptics and throttle
    if (listenBtn) {
      let lastClick = 0;
      listenBtn.addEventListener("click", () => {
        const now = Date.now();
        if (now - lastClick < 800 || isBusy) return; // throttle
        lastClick = now;
        if (navigator.vibrate) { try { navigator.vibrate(200); } catch (_) {} }
        if (!recognition) {
          alert("Speech recognition not supported in this browser.");
          return;
        }
        listenBtn.disabled = true;
        if (statusText) statusText.textContent = "Listening...";
        try { recognition.start(); }
        catch (e) {
          console.error(e);
          speak("Unable to start listening.");
          listenBtn.disabled = false;
          if (statusText) statusText.textContent = "Press the button and say 'What is in front of me?'";
        }
      });
    }
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
    recognition.continuous = false; // single-shot
    recognition.interimResults = false;

    // 3) Voice Command Handling (with help mode)
    recognition.addEventListener("result", async (event) => {
      try {
        const transcript = (event.results?.[0]?.[0]?.transcript || "").toLowerCase();
        const triggers = [
          "what's in front",
          "whats in front",
          "what is in front",
          "detect object",
          "detect objects"
        ];
        const helpTriggers = ["help", "what can i say", "what can you do"];

        if (helpTriggers.some(t => transcript.includes(t))) {
          speak(HELP_MESSAGE);
          if (statusText) statusText.textContent = HELP_MESSAGE;
          return;
        }

        const matched = triggers.some(t => transcript.includes(t));
        if (matched) {
          await startCamera();
        } else {
          speak("Please say 'what's in front' or 'detect objects'.");
          if (statusText) statusText.textContent = "Press the button and say 'What is in front of me?'";
        }
      } catch (err) {
        console.error(err);
        speak("I encountered an error processing your request.");
        if (statusText) statusText.textContent = "An error occurred.";
      }
    });

    recognition.addEventListener("end", () => {
      if (listenBtn) listenBtn.disabled = false;
    });

    recognition.addEventListener("error", (event) => {
      console.error("Speech recognition error:", event);
      speak("There was an error with speech recognition.");
      if (statusText) statusText.textContent = "Speech recognition error.";
      if (listenBtn) listenBtn.disabled = false;
    });
  }

  // 4) Camera Access
  async function startCamera() {
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
      if (listenBtn) listenBtn.style.display = "none";
      if (statusText) statusText.textContent = "Camera ready.";

      await analyzeImage();
    } catch (err) {
      console.error(err);
      const msg = (err && err.message) ? err.message : "Unable to access the camera.";
      speak(msg);
      if (statusText) statusText.textContent = msg;
      if (listenBtn) listenBtn.style.display = "";
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

    if (listenBtn) {
      listenBtn.disabled = false;
      listenBtn.style.display = "";
    }
    if (statusText) statusText.textContent = "Press the button and say 'What is in front of me?'";
    setProcessing(false);
    isBusy = false;
  }
})(); 