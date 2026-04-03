<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { NextStepButton, Paragraph, Title, VideoContainer } from '../atoms';
  import { configuration, IAppConfiguration } from '../contexts/configuration';
  import { Elements } from '../contexts/configuration/types';
  import { T } from '../contexts/translation';
  import { getLayoutStyles, getStepConfiguration } from '../ui-packs';
  import { getFlowConfig } from '../contexts/flows/hooks';
  import { livenessResult, currentStepId } from '../contexts/app-state/stores';
  import { submitLivenessResult } from '../services/http';
  import { goToNextStep } from '../contexts/navigation';
  import {
    analyzeDepth,
    analyzeTexture,
    detectMoire,
    analyzeRGBChannels,
    analyzeReflection,
    analyzeTemporalMotion,
    analyzeCameraMotion,
    startMotionTracking,
    computePassiveScore,
    cropFaceFromCanvas,
    captureVideoFrame,
    type LivenessSignals,
    type MotionTelemetry,
  } from '../utils/liveness-analysis';

  export let stepId: string;

  const step = getStepConfiguration($configuration, stepId);
  const flow = getFlowConfig($configuration);
  const style = getLayoutStyles($configuration, step);

  const stepNamespace = step.namespace || 'liveness-check';

  // ─────────────────────────────────────────────────────────────
  // State Machine
  // ─────────────────────────────────────────────────────────────
  type Phase = 'camera_setup' | 'selfie_capture' | 'analyzing' | 'challenge' | 'submitting' | 'completed' | 'failed';
  let phase: Phase = 'camera_setup';

  let videoElement: HTMLVideoElement;
  let analysisCanvas: HTMLCanvasElement;
  let faceMesh: any = null;

  let livenessScore = 0;
  let isSubmitting = false;
  let sessionId: string;

  // MediaPipe results
  let latestLandmarks: any[] | null = null;
  let landmarkHistory: any[][][] = [];
  let positionScore = 0;

  // Motion telemetry
  let motionTelemetry: MotionTelemetry = {
    hasMotion: false,
    accelerationVariance: 0,
    rotationVariance: 0,
    sampleCount: 0,
  };
  let stopMotionTracking: (() => void) | null = null;

  // Passive analysis results
  let passiveSignals: LivenessSignals | null = null;

  // Challenge state
  const CHALLENGES = [
    { id: 'turn_left', name: 'Turn your head slightly left', durationFrames: 20 },
    { id: 'turn_right', name: 'Turn your head slightly right', durationFrames: 20 },
    { id: 'blink', name: 'Blink naturally', durationFrames: 12 },
  ];
  let currentChallenge: typeof CHALLENGES[0] | null = null;
  let challengeProgress = 0;
  let challengeDetectedFrames = 0;
  let challengeCalibrated = false;
  let centerNoseX = 0.5;
  let eyeOpenBaseline = 0;

  // Verification snapshot captured during selfie phase
  let snapshotBase64: string | null = null;

  // Auto-capture countdown
  let autoCaptureFrames = 0;
  const AUTO_CAPTURE_REQUIRED_FRAMES = 20; // ~1 second at 30fps

  // ─────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────
  function generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 15);
    return `liveness_${timestamp}_${randomPart}`;
  }

  // ─────────────────────────────────────────────────────────────
  // Camera + MediaPipe Setup
  // ─────────────────────────────────────────────────────────────
  onMount(async () => {
    // Priority: URL param sessionId > endUserInfo.id > generated
    sessionId = $configuration.endUserInfo?.sessionId ||
                $configuration.endUserInfo?.id ||
                generateSessionId();

    console.log('[LivenessCheck] Session ID:', sessionId);
    console.log('[LivenessCheck] Redirect URL:', $configuration.endUserInfo?.redirectUrl);

    stopMotionTracking = startMotionTracking((telemetry) => {
      motionTelemetry = telemetry;
    });

    try {
      const { FaceMesh } = await import('@mediapipe/face_mesh');
      const { Camera } = await import('@mediapipe/camera_utils');

      faceMesh = new FaceMesh({
        locateFile: (file) => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        },
      });

      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      faceMesh.onResults((results) => {
        if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
          latestLandmarks = results.multiFaceLandmarks[0];
          landmarkHistory.push(results.multiFaceLandmarks);
          if (landmarkHistory.length > 45) landmarkHistory.shift();
          positionScore = calculatePositionScore(latestLandmarks);

          if (phase === 'selfie_capture') {
            if (positionScore >= 0.72) {
              autoCaptureFrames++;
              if (autoCaptureFrames >= AUTO_CAPTURE_REQUIRED_FRAMES) {
                autoCaptureFrames = 0;
                captureAndAnalyze();
              }
            } else {
              autoCaptureFrames = Math.max(0, autoCaptureFrames - 2);
            }
          }

          if (phase === 'challenge' && currentChallenge) {
            processChallengeFrame(latestLandmarks);
          }
        } else {
          latestLandmarks = null;
          positionScore = 0;
          autoCaptureFrames = 0;
        }
      });

      const camera = new Camera(videoElement, {
        onFrame: async () => {
          await faceMesh.send({ image: videoElement });
        },
        width: 640,
        height: 480,
      });

      await camera.start();
      phase = 'selfie_capture';
    } catch (error) {
      console.error('Camera init failed:', error);
      phase = 'failed';
    }
  });

  onDestroy(() => {
    if (stopMotionTracking) stopMotionTracking();
  });

  // ─────────────────────────────────────────────────────────────
  // Selfie Capture + Passive Analysis
  // ─────────────────────────────────────────────────────────────
  async function captureAndAnalyze() {
    if (!latestLandmarks || !videoElement) return;

    phase = 'analyzing';

    let canvas: HTMLCanvasElement;
    try {
      canvas = captureVideoFrame(videoElement);
      snapshotBase64 = canvas.toDataURL('image/jpeg', 0.92);
    } catch (err) {
      console.error('Video capture failed:', err);
      phase = 'selfie_capture';
      return;
    }

    const faceImageData = cropFaceFromCanvas(canvas, latestLandmarks, 0.12);

    const depthScore = analyzeDepth(latestLandmarks);
    const textureScore = faceImageData ? analyzeTexture(faceImageData) : 50;
    const moireScore = faceImageData ? detectMoire(faceImageData) : 50;
    const rgbScore = faceImageData ? analyzeRGBChannels(faceImageData) : 50;
    const reflectionScore = faceImageData ? analyzeReflection(faceImageData) : 50;
    const temporal = analyzeTemporalMotion(landmarkHistory);

    let motionScore: number;
    if (motionTelemetry.hasMotion) {
      motionScore = 85;
    } else if (motionTelemetry.sampleCount > 0) {
      motionScore = 30;
    } else {
      const cameraMotion = analyzeCameraMotion(landmarkHistory);
      motionScore = cameraMotion.score;
    }

    passiveSignals = computePassiveScore(
      depthScore,
      textureScore,
      moireScore,
      rgbScore,
      reflectionScore,
      motionScore,
    );

    const adjustedOverall = Math.min(100, passiveSignals.overall * 0.85 + temporal.score * 0.15);

    if (adjustedOverall >= 85) {
      livenessScore = Math.round(adjustedOverall);
      await submitResult();
    } else if (adjustedOverall >= 55) {
      livenessScore = Math.round(adjustedOverall);
      startChallenge();
    } else {
      livenessScore = Math.round(adjustedOverall);
      phase = 'failed';
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Challenge Phase
  // ─────────────────────────────────────────────────────────────
  function startChallenge() {
    currentChallenge = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
    challengeProgress = 0;
    challengeDetectedFrames = 0;
    challengeCalibrated = false;
    centerNoseX = 0.5;
    eyeOpenBaseline = 0;
    phase = 'challenge';
  }

  function processChallengeFrame(landmarks: any[]) {
    if (!currentChallenge) return;

    let detected = false;

    switch (currentChallenge.id) {
      case 'turn_left':
        detected = detectTurnLeft(landmarks);
        break;
      case 'turn_right':
        detected = detectTurnRight(landmarks);
        break;
      case 'blink':
        detected = detectBlink(landmarks);
        break;
    }

    if (detected) {
      challengeDetectedFrames++;
    } else {
      challengeDetectedFrames = Math.max(0, challengeDetectedFrames - 1);
    }

    challengeProgress = Math.min(
      100,
      (challengeDetectedFrames / currentChallenge.durationFrames) * 100,
    );

    if (challengeDetectedFrames >= currentChallenge.durationFrames) {
      livenessScore = Math.min(100, Math.round(livenessScore * 0.7 + 95 * 0.3));
      phase = 'submitting';
      submitResult();
    }
  }

  function detectTurnLeft(landmarks: any[]): boolean {
    const noseTip = landmarks[1];
    if (!challengeCalibrated && Math.abs(noseTip.x - 0.5) < 0.1) {
      centerNoseX = noseTip.x;
      challengeCalibrated = true;
    }
    const deviation = centerNoseX - noseTip.x;
    return deviation > 0.06;
  }

  function detectTurnRight(landmarks: any[]): boolean {
    const noseTip = landmarks[1];
    if (!challengeCalibrated && Math.abs(noseTip.x - 0.5) < 0.1) {
      centerNoseX = noseTip.x;
      challengeCalibrated = true;
    }
    const deviation = noseTip.x - centerNoseX;
    return deviation > 0.06;
  }

  function detectBlink(landmarks: any[]): boolean {
    const leftEAR = computeEAR(landmarks, [33, 160, 158, 133, 153, 144]);
    const rightEAR = computeEAR(landmarks, [362, 385, 387, 263, 373, 380]);
    const avgEAR = (leftEAR + rightEAR) / 2;

    if (!challengeCalibrated) {
      eyeOpenBaseline = avgEAR;
      challengeCalibrated = true;
      return false;
    }

    return avgEAR < eyeOpenBaseline * 0.55 && avgEAR < 0.3;
  }

  function computeEAR(landmarks: any[], indices: number[]): number {
    const pts = indices.map((i) => landmarks[i]);
    const vertical1 = distance(pts[1], pts[5]);
    const vertical2 = distance(pts[2], pts[4]);
    const horizontal = distance(pts[0], pts[3]);
    return (vertical1 + vertical2) / (2 * horizontal + 1e-8);
  }

  function distance(a: any, b: any): number {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
  }

  // ─────────────────────────────────────────────────────────────
  // Result Submission
  // ─────────────────────────────────────────────────────────────
  async function submitResult() {
    isSubmitting = true;
    phase = 'submitting';

    const payload: Record<string, unknown> = {
      session_id: sessionId,
      score: livenessScore,
      provider: 'ballerine_hybrid_v1',
      snapshot: snapshotBase64,
      metadata: {
        userAgent: navigator.userAgent,
        timestamp: Date.now(),
        motionTelemetry,
        challengeId: currentChallenge?.id || null,
        challengePassed: currentChallenge ? challengeProgress >= 100 : null,
        passiveSignals: passiveSignals
          ? {
              overall: passiveSignals.overall,
              depth: passiveSignals.depthScore,
              texture: passiveSignals.textureScore,
              moire: passiveSignals.moireScore,
              rgb: passiveSignals.rgbScore,
              reflection: passiveSignals.reflectionScore,
              motion: passiveSignals.motionScore,
              reasons: passiveSignals.reasons,
            }
          : null,
      },
    };

    try {
      const result = await submitLivenessResult(payload as any);
      if (result.success) {
        phase = 'completed';
        livenessResult.set(payload as Record<string, unknown>);

        // Check for redirect URL
        const redirectUrl = $configuration.endUserInfo?.redirectUrl;
        if (redirectUrl) {
          // Redirect on success
          setTimeout(() => {
            window.location.href = redirectUrl;
          }, 1500);
        } else {
          // Auto-advance to Final step after successful submission
          setTimeout(() => {
            goToNextStep(currentStepId, $configuration, stepId);
          }, 800);
        }
      } else {
        phase = 'failed';
      }
    } catch (err) {
      console.error('Submission error:', err);
      phase = 'failed';
    } finally {
      isSubmitting = false;
    }
  }

  function retry() {
    phase = 'selfie_capture';
    landmarkHistory = [];
    passiveSignals = null;
    currentChallenge = null;
    snapshotBase64 = null;
    autoCaptureFrames = 0;
    livenessResult.set(undefined);
  }

  // ─────────────────────────────────────────────────────────────
  // Oval Progress Ring
  // ─────────────────────────────────────────────────────────────
  const perimeter = 1138;
  $: ovalProgress = phase === 'challenge'
    ? challengeProgress / 100
    : phase === 'selfie_capture'
      ? Math.min(positionScore / 100, 1)
      : 0;
  $: dashOffset = perimeter * (1 - ovalProgress);

  function calculatePositionScore(landmarks: any[]): number {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    landmarks.forEach((lm: any) => {
      minX = Math.min(minX, lm.x);
      maxX = Math.max(maxX, lm.x);
      minY = Math.min(minY, lm.y);
      maxY = Math.max(maxY, lm.y);
    });

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const width = maxX - minX;
    const height = maxY - minY;

    const distX = Math.abs(centerX - 0.5);
    const distY = Math.abs(centerY - 0.5);
    const dist = Math.sqrt(distX * distX + distY * distY);

    const size = width * height;
    const sizeScore = Math.min(size * 1200, 100);
    const centerScore = Math.max(0, 100 - dist * 300);

    return Math.min(100, centerScore * 0.6 + sizeScore * 0.4);
  }

  // ─────────────────────────────────────────────────────────────
  // UI Copy helpers
  // ─────────────────────────────────────────────────────────────
  $: mainInstruction = (() => {
    switch (phase) {
      case 'camera_setup':
        return 'Initializing camera...';
      case 'selfie_capture':
        return latestLandmarks ? 'Position your face in the frame' : 'Looking for your face...';
      case 'analyzing':
        return 'Analyzing...';
      case 'challenge':
        return currentChallenge?.name || 'Follow the instruction';
      case 'submitting':
        return 'Verifying...';
      case 'completed':
        return 'Liveness verified successfully!';
      case 'failed':
        return 'Unable to verify. Please try again.';
      default:
        return '';
    }
  })();

  // Sub-instruction removed - now shown only in bottom hint pill
</script>

<div class="page" {style}>
  <!-- Top bar: back + close -->
  <div class="top-bar">
    {#each step.elements as element}
      {#if element.type === Elements.IconButton}
        <button class="icon-btn" on:click={() => history.back()} aria-label="back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
      {/if}
      {#if element.type === Elements.IconCloseButton}
        <button class="icon-btn" on:click={() => window.dispatchEvent(new CustomEvent('close-flow'))} aria-label="close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      {/if}
    {/each}
  </div>

  <!-- Camera Stage -->
  <div class="stage">
    <video bind:this={videoElement} autoplay muted playsinline class="video-feed" />
    <canvas bind:this={analysisCanvas} class="detection-overlay" width="640" height="480" />

    <!-- Vignette + oval -->
    {#if phase === 'selfie_capture' || phase === 'challenge'}
      <div class="vignette-mask" aria-hidden="true"></div>

      <div class="face-oval">
        <svg class="oval-svg" viewBox="0 0 300 400" preserveAspectRatio="xMidYMid meet">
          <ellipse
            cx="150"
            cy="200"
            rx="120"
            ry="160"
            fill="none"
            stroke="rgba(45,212,191,0.6)"
            stroke-width="3"
            stroke-dasharray="8,6"
          />
          {#if ovalProgress > 0}
            <ellipse
              cx="150"
              cy="200"
              rx="120"
              ry="160"
              fill="none"
              stroke={phase === 'challenge' ? '#14b8a6' : '#2dd4bf'}
              stroke-width="5"
              stroke-linecap="round"
              stroke-dasharray={perimeter}
              stroke-dashoffset={dashOffset}
              transform="rotate(-180 150 200)"
            />
          {/if}
        </svg>
      </div>
    {/if}

    <!-- Overlay text -->
    <div class="overlay" class:faded={phase === 'analyzing' || phase === 'submitting'}>
      <div class="pill" class:success={phase === 'completed'} class:error={phase === 'failed'}>
        {mainInstruction}
      </div>
      {#if phase === 'analyzing' || phase === 'submitting'}
        <div class="spinner"></div>
      {/if}
    </div>
  </div>

  <!-- Bottom action bar -->
  <div class="bottom-bar">
    {#each step.elements as element}
      {#if element.type === Elements.Button}
        {#if phase === 'camera_setup'}
          <NextStepButton configuration={element.props} isDisabled={true} skipType={undefined}>
            Initializing camera...
          </NextStepButton>
        {:else if phase === 'selfie_capture'}
          <!-- Auto-captures when face is centered; no manual button needed -->
          <div class="hint-pill">
            <span class="dot"></span>
            {#if latestLandmarks && positionScore >= 0.72}
              Hold still
            {:else}
              Auto-capture when centered
            {/if}
          </div>
        {:else if phase === 'challenge'}
          <div class="hint-pill">
            <span class="dot"></span>
            Hold the pose
          </div>
        {:else if phase === 'failed'}
          <button class="action-button" on:click={retry}>Try Again</button>
        {:else if phase === 'completed'}
          <NextStepButton configuration={element.props} isDisabled={false} skipType={undefined}>
            Continue
          </NextStepButton>
        {:else if phase === 'submitting'}
          <NextStepButton configuration={element.props} isDisabled={true} skipType={undefined}>
            Verifying...
          </NextStepButton>
        {/if}
      {/if}
    {/each}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    height: 100%;
    background: #0b0b0c;
    color: #ffffff;
    overflow: hidden;
    position: relative;
  }

  .top-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    pointer-events: none;
  }

  .top-bar > * {
    pointer-events: auto;
  }

  .icon-btn {
    background: rgba(0,0,0,0.35);
    border: none;
    color: #fff;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    backdrop-filter: blur(4px);
    padding: 0;
  }

  .icon-btn svg {
    width: 20px;
    height: 20px;
  }

  .stage {
    flex: 1 1 auto;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #000;
    min-height: 0;
  }

  .video-feed {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  .detection-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .vignette-mask {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(
      ellipse 52% 62% at 50% 45%,
      rgba(0,0,0,0) 0%,
      rgba(0,0,0,0) 52%,
      rgba(0,0,0,0.55) 72%,
      rgba(0,0,0,0.82) 100%
    );
  }

  .face-oval {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .oval-svg {
    width: min(92vw, 360px);
    height: auto;
    max-height: 72vh;
  }

  .oval-svg ellipse {
    transition: stroke-dashoffset 0.25s ease, stroke 0.25s ease;
  }

  .overlay {
    position: absolute;
    top: 50px;
    left: 0;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    pointer-events: none;
    transition: opacity 0.3s ease;
    padding: 0 1rem;
  }

  .overlay.faded {
    opacity: 0.55;
  }

  .pill {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.25;
    color: #ffffff;
    text-align: center;
    text-shadow: 0 1px 3px rgba(0,0,0,0.6);
    padding: 0.5rem 0.875rem;
    background: rgba(0,0,0,0.5);
    border-radius: 999px;
    backdrop-filter: blur(8px);
    max-width: 85%;
    letter-spacing: -0.01em;
  }

  .pill.success {
    background: rgba(20, 184, 166, 0.9);
  }

  .pill.error {
    background: rgba(239, 68, 68, 0.9);
  }

  .sub {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.8125rem;
    font-weight: 400;
    line-height: 1.3;
    color: rgba(255,255,255,0.85);
    text-align: center;
    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    max-width: 80%;
    letter-spacing: -0.01em;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 3px solid rgba(255,255,255,0.25);
    border-top-color: #ffffff;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .bottom-bar {
    flex: 0 0 auto;
    width: 100%;
    max-width: 420px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 1rem 1.25rem 1.5rem;
    background: #0b0b0c;
    gap: 0.5rem;
  }

  .hint-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.8125rem;
    font-weight: 500;
    line-height: 1.25;
    color: #f0fdfa;
    background: rgba(15, 23, 42, 0.7);
    border: 1px solid rgba(45, 212, 191, 0.25);
    padding: 0.5rem 0.875rem;
    border-radius: 999px;
    letter-spacing: -0.01em;
  }

  .hint-pill .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #2dd4bf;
    animation: pulse 1.4s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .action-button {
    width: 100%;
    border: none;
    padding: 14px 24px;
    border-radius: 12px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: transform 0.1s ease, opacity 0.2s ease;
    background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
    color: white;
  }

  .action-button:active {
    transform: scale(0.98);
  }
</style>
