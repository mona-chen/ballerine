<script lang="ts">
  import { onMount } from 'svelte';
  import { NextStepButton, Paragraph, Title, VideoContainer } from '../atoms';
  import { configuration } from '../contexts/configuration';
  import { Elements } from '../contexts/configuration/types';
  import { T } from '../contexts/translation';
  import { getLayoutStyles, getStepConfiguration } from '../ui-packs';
  import { getFlowConfig } from '../contexts/flows/hooks';
  import { bvnValue } from '../contexts/app-state/stores';
  import { submitLivenessResult } from '../services/http';

  export let stepId;

  const step = getStepConfiguration($configuration, stepId);
  const flow = getFlowConfig($configuration);
  const style = getLayoutStyles($configuration, step);

  const stepNamespace = step.namespace || 'liveness-check';

  let videoElement: HTMLVideoElement;
  let canvasElement: HTMLCanvasElement;
  let isInitialized = false;
  let isChecking = false;
  let livenessScore = 0;
  let statusMessage = 'Initializing camera...';
  let isSubmitting = false;

  // Enhanced liveness configuration - realistic durations
  const AVAILABLE_CHALLENGES = [
    { id: 'smile', name: 'smile', duration: 5, difficulty: 'easy' }, // Quick but clear
    { id: 'blink', name: 'blink', duration: 3, difficulty: 'easy' }, // Natural blink duration
    { id: 'turn_left', name: 'turn left', duration: 10, difficulty: 'medium' }, // Requires deliberate turn
    { id: 'turn_right', name: 'turn right', duration: 10, difficulty: 'medium' }, // Requires deliberate turn
    { id: 'nod', name: 'nod', duration: 8, difficulty: 'medium' }, // Natural head movement
    { id: 'look_up', name: 'look up', duration: 6, difficulty: 'hard' }, // Clear upward movement
  ];

  // Randomized challenge sequence
  let challenges: typeof AVAILABLE_CHALLENGES = [];
  let currentStepIndex = 0;
  let stepCompleted: boolean[] = [];
  let snapshots: string[] = [];
  let stepTimers: number[] = [];
  let qualityScores: number[] = [];
  let padScores: number[] = []; // Presentation Attack Detection scores
  let actionConsistency: number[] = []; // Tracks how many consecutive frames action is detected
  let previousNoseY: number | null = null; // Track previous nose position for nod detection
  let centerNoseX: number = 0.5; // Baseline nose position when facing forward

  // Retry mechanism
  let retryCount = 0;
  const MAX_RETRIES = 3;
  let failedAttempts: number[] = [];

  // Session management
  let sessionId: string;
  let challengeStartTime: number;

  // Initialize randomized challenges
  function initializeChallenges() {
    const shuffled = [...AVAILABLE_CHALLENGES].sort(() => Math.random() - 0.5);
    const selectedCount = Math.min(3 + Math.floor(Math.random() * 2), shuffled.length); // 3-4 challenges
    challenges = shuffled.slice(0, selectedCount);

    stepCompleted = new Array(challenges.length).fill(false);
    stepTimers = new Array(challenges.length).fill(0);
    qualityScores = new Array(challenges.length).fill(0);
    padScores = new Array(challenges.length).fill(0);
    actionConsistency = new Array(challenges.length).fill(0);
    currentStepIndex = 0;

    // Generate secure session ID with current BVN
    const currentBvn = $bvnValue || '';
    sessionId = generateSessionId(currentBvn);
    challengeStartTime = Date.now();

    console.log(
      'Initialized challenges:',
      challenges.map(c => c.id),
    );
  }

  // Security and quality utilities
  function generateSessionId(bvn?: string): string {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).substring(2, 15);
    const bvnHash = bvn ? btoa(bvn).substring(0, 8) : 'unknown';
    return `session_${timestamp}_${randomPart}_${bvnHash}`;
  }

  // MediaPipe Face Mesh
  let faceMesh: any = null;

  // Position tracking for face in oval
  let positionScore = 0;

  // Previous landmarks for motion analysis
  let previousLandmarks: any = null;
  let motionHistory: number[] = [];

  // Image quality assessment
  function assessImageQuality(landmarks: any, imageData?: ImageData): number {
    let qualityScore = 0;
    const weights = {
      position: 0.3,
      size: 0.2,
      sharpness: 0.2,
      lighting: 0.3,
    };

    // Position score (already calculated)
    const posScore = calculatePositionScore(landmarks);
    qualityScore += posScore * weights.position;

    // Size score - face should occupy good portion of frame
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    landmarks.forEach((lm: any) => {
      minX = Math.min(minX, lm.x);
      maxX = Math.max(maxX, lm.x);
      minY = Math.min(minY, lm.y);
      maxY = Math.max(maxY, lm.y);
    });

    const faceWidth = maxX - minX;
    const faceHeight = maxY - minY;
    const faceArea = faceWidth * faceHeight;
    const idealSize = 0.15; // Ideal face area as fraction of frame
    const sizeScore = Math.max(0, 100 - Math.abs(faceArea - idealSize) * 500);
    qualityScore += Math.min(sizeScore, 100) * weights.size;

    // Lighting estimation (simplified - based on face landmark visibility)
    const visibleLandmarks = landmarks.filter((lm: any) => lm.visibility > 0.8).length;
    const lightingScore = (visibleLandmarks / landmarks.length) * 100;
    qualityScore += lightingScore * weights.lighting;

    // Sharpness estimation (simplified - would need actual image analysis)
    // For now, use landmark consistency
    let sharpnessScore = 100;
    if (previousLandmarks) {
      const movement = calculateMovement(previousLandmarks, landmarks);
      sharpnessScore = Math.max(0, 100 - movement * 1000); // Less stable = potentially blurry
    }
    qualityScore += Math.max(sharpnessScore, 50) * weights.sharpness;

    previousLandmarks = JSON.parse(JSON.stringify(landmarks));
    return Math.min(qualityScore, 100);
  }

  // Basic Presentation Attack Detection
  function detectPresentationAttack(landmarks: any, currentChallenge: string): number {
    let padScore = 100; // Start with assuming real
    const suspiciousPatterns = [];

    // Check for unnatural movement patterns (much less sensitive)
    if (motionHistory.length > 20) {
      // Increased from 10
      const avgMotion = motionHistory.reduce((a, b) => a + b, 0) / motionHistory.length;
      const motionVariance =
        motionHistory.reduce((sum, motion) => sum + Math.pow(motion - avgMotion, 2), 0) /
        motionHistory.length;

      // Much more lenient thresholds - only flag extremely suspicious behavior
      if (avgMotion < 0.0001) {
        // Reduced from 0.001
        suspiciousPatterns.push('minimal_movement');
        padScore -= 5; // Reduced from 20
      }
      if (motionVariance > 0.05) {
        // Increased from 0.01
        suspiciousPatterns.push('erratic_movement');
        padScore -= 5; // Reduced from 15
      }
    }

    // Challenge-specific PAD checks
    switch (currentChallenge) {
      case 'smile':
        // Check if smile appears too suddenly or mechanically
        const smileScore = detectSmile(landmarks);
        if (smileScore > 0.9 && motionHistory.length < 5) {
          suspiciousPatterns.push('instant_smile');
          padScore -= 25;
        }
        break;

      case 'blink':
        // Natural blinks should be quick but not instant
        const blinkScore = detectBlink(landmarks);
        if (blinkScore && motionHistory[motionHistory.length - 1] < 0.002) {
          suspiciousPatterns.push('unnatural_blink');
          padScore -= 20;
        }
        break;
    }

    // Face 3D depth consistency check (simplified)
    const depthScore = checkFaceDepthConsistency(landmarks);
    padScore -= (100 - depthScore) * 0.3;

    // Only log if there are significant issues (reduced console spam)
    if (suspiciousPatterns.length > 0 && padScore < 80) {
      console.warn('Suspicious patterns detected:', suspiciousPatterns);
    }

    return Math.max(padScore, 0);
  }

  function calculateMovement(landmarks1: any, landmarks2: any): number {
    if (!landmarks1 || !landmarks2) return 0;

    let totalMovement = 0;
    for (let i = 0; i < Math.min(landmarks1.length, landmarks2.length); i++) {
      const dx = landmarks2[i].x - landmarks1[i].x;
      const dy = landmarks2[i].y - landmarks1[i].y;
      totalMovement += Math.sqrt(dx * dx + dy * dy);
    }
    return totalMovement / landmarks1.length;
  }

  function checkFaceDepthConsistency(landmarks: any): number {
    // Simplified depth check using z-coordinates from MediaPipe
    const zValues = landmarks.map((lm: any) => lm.z || 0);
    const zVariance =
      zValues.reduce(
        (sum: number, z: number) =>
          sum + Math.pow(z - zValues.reduce((a, b) => a + b, 0) / zValues.length, 2),
        0,
      ) / zValues.length;

    // Natural faces should have some depth variation
    if (zVariance < 0.0001) return 50; // Too flat - possible photo
    if (zVariance > 0.1) return 30; // Too much variance - possible digital manipulation

    return Math.max(0, 100 - zVariance * 500);
  }

  // Enhanced oval ring progress based on completion
  $: overallProgress =
    challenges.length > 0 ? stepCompleted.filter(Boolean).length / challenges.length : 0;
  $: progress = Math.max(positionScore / 100, overallProgress * 0.7); // Mix position and completion
  $: strokeColor = progress > 0.7 ? '#00ff00' : progress > 0.3 ? '#ffff00' : '#ff0000';
  $: dashOffset = 1138 * (1 - progress);
  const perimeter = 1138; // Approximate for rx=192 ry=144

  // Initialize challenges and set up logging
  onMount(async () => {
    initializeChallenges();
    console.log('Liveness check initialized with', challenges.length, 'challenges');

    try {
      // Load MediaPipe Face Mesh
      const { FaceMesh } = await import('@mediapipe/face_mesh');
      const { Camera } = await import('@mediapipe/camera_utils');

      faceMesh = new FaceMesh({
        locateFile: file => {
          return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        },
      });

      faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.6, // Increased for better quality
        minTrackingConfidence: 0.6,
      });

      faceMesh.onResults(onResults);

      // Initialize camera
      const camera = new Camera(videoElement, {
        onFrame: async () => {
          await faceMesh.send({ image: videoElement });
        },
        width: 640,
        height: 480,
      });

      camera.start();
      isInitialized = true;
      statusMessage = `Get ready! We'll ask you to perform ${challenges.length} actions.`;
    } catch (error) {
      console.error('Failed to initialize liveness check:', error);
      statusMessage = 'Failed to initialize camera. Please try again.';
      // Retry logic would go here
    }
  });

  function calculatePositionScore(landmarks: any) {
    // Calculate face bounding box from landmarks
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
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

    // Distance from center (normalized coordinates 0-1)
    const distX = Math.abs(centerX - 0.5);
    const distY = Math.abs(centerY - 0.5);
    const dist = Math.sqrt(distX * distX + distY * distY);

    // Size score: face should be appropriate size
    const size = width * height;
    const sizeScore = Math.min(size * 1000, 100); // Adjust multiplier

    // Position score: more forgiving for nodding movements
    // Allow more vertical movement since nodding requires up/down motion
    const verticalTolerance = 0.25; // Increased from default
    const horizontalTolerance = 0.15; // Keep horizontal strict

    const verticalScore = Math.max(0, 100 - distY * 300); // More forgiving vertically
    const horizontalScore = Math.max(0, 100 - distX * 500); // Keep horizontal strict

    const posScore = Math.min(verticalScore, horizontalScore); // Use the more restrictive score

    return Math.min(sizeScore, posScore);
  }

  function detectSmile(landmarks: any): boolean {
    // Much more sensitive smile detection
    const leftMouthCorner = landmarks[61];
    const rightMouthCorner = landmarks[291];
    const upperLip = landmarks[13];
    const lowerLip = landmarks[14];
    const noseTip = landmarks[1];

    // Calculate mouth width and position relative to nose
    const mouthWidth = Math.abs(rightMouthCorner.x - leftMouthCorner.x);
    const mouthCenterY = (leftMouthCorner.y + rightMouthCorner.y) / 2;
    const mouthOpenness = Math.abs(upperLip.y - lowerLip.y);

    // Very relaxed smile detection - any upward mouth movement
    const cornersRaised =
      leftMouthCorner.y < noseTip.y + 0.08 && rightMouthCorner.y < noseTip.y + 0.08; // More lenient
    const someOpenness = mouthOpenness > 0.01 && mouthOpenness < 0.25; // Wider range
    const visibleWidth = mouthWidth > 0.06; // More lenient

    return cornersRaised && (someOpenness || visibleWidth); // OR condition makes it easier
  }

  function detectBlink(landmarks: any): boolean {
    // Enhanced blink detection with better thresholds
    // Left eye: points 33, 160, 158, 133, 153, 144
    const leftEye = [
      landmarks[33],
      landmarks[160],
      landmarks[158],
      landmarks[133],
      landmarks[153],
      landmarks[144],
    ];
    const earLeft =
      (Math.abs(leftEye[1].y - leftEye[5].y) + Math.abs(leftEye[2].y - leftEye[4].y)) /
      (2 * Math.abs(leftEye[0].x - leftEye[3].x));

    // Right eye: points 362, 385, 387, 263, 373, 380
    const rightEye = [
      landmarks[362],
      landmarks[385],
      landmarks[387],
      landmarks[263],
      landmarks[373],
      landmarks[380],
    ];
    const earRight =
      (Math.abs(rightEye[1].y - rightEye[5].y) + Math.abs(rightEye[2].y - rightEye[4].y)) /
      (2 * Math.abs(rightEye[0].x - rightEye[3].x));

    // Much more forgiving blink detection - any partial closure counts
    return earLeft < 0.35 && earRight < 0.35; // Increased threshold, removed minimum
  }

  function detectTurnLeft(landmarks: any): boolean {
    const noseTip = landmarks[1];
    const noseX = noseTip.x;

    // Calibrate center position on first frames if not set
    if (centerNoseX === 0.5 && Math.abs(noseX - 0.5) < 0.1) {
      centerNoseX = noseX;
      console.log(`[CALIBRATION] Set center nose X to: ${centerNoseX.toFixed(3)}`);
    }

    // Calculate deviation from calibrated center
    const deviation = centerNoseX - noseX;
    const threshold = 0.08; // Very forgiving - just need slight left movement

    // Debug logging
    console.log(
      `[TURN_LEFT] Nose X: ${noseX.toFixed(3)}, Center: ${centerNoseX.toFixed(
        3,
      )}, Deviation: ${deviation.toFixed(3)}, Threshold: ${threshold}`,
    );

    // Detect turn left if nose is significantly left of calibrated center
    return deviation > threshold;
  }

  function detectTurnRight(landmarks: any): boolean {
    const noseTip = landmarks[1];
    const noseX = noseTip.x;

    // Calibrate center position on first frames if not set
    if (centerNoseX === 0.5 && Math.abs(noseX - 0.5) < 0.1) {
      centerNoseX = noseX;
      console.log(`[CALIBRATION] Set center nose X to: ${centerNoseX.toFixed(3)}`);
    }

    // Calculate deviation from calibrated center
    const deviation = noseX - centerNoseX;
    const threshold = 0.08; // Very forgiving - just need slight right movement

    // Debug logging
    console.log(
      `[TURN_RIGHT] Nose X: ${noseX.toFixed(3)}, Center: ${centerNoseX.toFixed(
        3,
      )}, Deviation: ${deviation.toFixed(3)}, Threshold: ${threshold}`,
    );

    // Detect turn right if nose is significantly right of calibrated center
    return deviation > threshold;
  }

  function detectNod(landmarks: any): boolean {
    const noseTip = landmarks[1];
    const forehead = landmarks[10]; // Top of head/forehead

    // Track vertical head position - nodding causes significant vertical movement
    const currentNoseY = noseTip.y;
    const headSize = Math.abs(forehead.y - noseTip.y);

    // Initialize previous nose position if not set
    if (!previousNoseY) {
      previousNoseY = currentNoseY;
      return false;
    }

    // Detect nodding: nose moves down significantly compared to head size
    const verticalMovement = Math.abs(currentNoseY - previousNoseY);
    const nodThreshold = headSize * 0.1; // 10% of head size as threshold

    // Detect both directions of nodding (down and up motion)
    const isNodding = verticalMovement > nodThreshold;

    // Update previous position for next frame
    previousNoseY = currentNoseY;

    return isNodding;
  }

  function detectLookUp(landmarks: any): boolean {
    // Use eye landmarks to detect looking up
    const leftEyeCenter = landmarks[33];
    const rightEyeCenter = landmarks[362];
    const noseTip = landmarks[1];

    // When looking up, eyes appear higher relative to nose
    const eyeNoseDistance = (leftEyeCenter.y + rightEyeCenter.y) / 2 - noseTip.y;
    return eyeNoseDistance < -0.08; // Eyes significantly above nose position
  }

  function captureSnapshot() {
    const canvas = document.createElement('canvas');
    canvas.width = videoElement.videoWidth;
    canvas.height = videoElement.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0);
    return canvas.toDataURL('image/jpeg');
  }

  function onResults(results: any) {
    if (!canvasElement || !results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      statusMessage = 'No face detected. Please position your face in the frame.';
      positionScore = 0;
      return;
    }

    const landmarks = results.multiFaceLandmarks[0];
    positionScore = calculatePositionScore(landmarks);

    // Enhanced quality assessment
    const qualityScore = assessImageQuality(landmarks);

    // Track motion for PAD analysis
    if (previousLandmarks) {
      const currentMotion = calculateMovement(previousLandmarks, landmarks);
      motionHistory.push(currentMotion);
      if (motionHistory.length > 30) motionHistory.shift(); // Keep last 30 frames
    }

    // Relaxed quality threshold - more user-friendly
    const MIN_QUALITY_THRESHOLD = 40; // Reduced from 60
    if (qualityScore < MIN_QUALITY_THRESHOLD) {
      statusMessage = `Position your face better and ensure good lighting.`;
      isChecking = false;
      return;
    }

    // More forgiving position check for nodding challenges
    const currentChallenge = challenges[currentStepIndex];
    const isNodChallenge = currentChallenge?.id === 'nod';
    const positionThreshold = isNodChallenge ? 50 : 70; // Lower threshold for nodding

    if (positionScore < positionThreshold) {
      statusMessage = isNodChallenge
        ? 'Keep your face in view while nodding.'
        : 'Position your face within the oval guide.';
      isChecking = false;
      return;
    }

    // Face is positioned, start action checks
    if (!isChecking && challenges.length > 0 && currentStepIndex < challenges.length) {
      isChecking = true;
      statusMessage = `Step ${currentStepIndex + 1}/${
        challenges.length
      }: ${currentChallenge.name.toUpperCase()}`;
    }

    if (currentStepIndex >= challenges.length) return; // All challenges completed

    if (!currentChallenge) return; // Safety check

    let actionDetected = false;

    // Dynamic action detection based on randomized challenges
    switch (currentChallenge.id) {
      case 'smile':
        actionDetected = detectSmile(landmarks);
        break;
      case 'blink':
        actionDetected = detectBlink(landmarks);
        break;
      case 'turn_left':
        actionDetected = detectTurnLeft(landmarks);
        break;
      case 'turn_right':
        actionDetected = detectTurnRight(landmarks);
        break;
      case 'nod':
        actionDetected = detectNod(landmarks);
        break;
      case 'look_up':
        actionDetected = detectLookUp(landmarks);
        break;
    }

    // Enhanced PAD and quality tracking
    const padScore = detectPresentationAttack(landmarks, currentChallenge.id);
    qualityScores[currentStepIndex] = Math.round(qualityScore);
    padScores[currentStepIndex] = Math.round(padScore);

    // Track action consistency - require stable detection for reliability
    if (actionDetected) {
      actionConsistency[currentStepIndex]++;
    } else {
      actionConsistency[currentStepIndex] = 0;
    }

    // Require consistent detection for multiple frames before counting
    const MIN_CONSISTENT_FRAMES = 2; // Must detect action for 2 consecutive frames
    if (actionConsistency[currentStepIndex] >= MIN_CONSISTENT_FRAMES && padScore > 70) {
      stepTimers[currentStepIndex]++;
      actionConsistency[currentStepIndex] = 0; // Reset after counting a frame
    }

    if (stepTimers[currentStepIndex] >= currentChallenge.duration) {
      stepCompleted[currentStepIndex] = true;
      snapshots.push(captureSnapshot());
      currentStepIndex++;

      if (currentStepIndex >= challenges.length) {
        // Calculate final liveness score based on quality and PAD scores
        const avgQuality = qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length;
        const avgPad = padScores.reduce((a, b) => a + b, 0) / padScores.length;
        livenessScore = Math.round((avgQuality + avgPad) / 2);

        statusMessage = 'All steps completed! Submitting results...';
        isChecking = false;
        isSubmitting = true;

        // Enhanced liveness result submission
        submitEnhancedLivenessResult();
      } else {
        const nextChallenge = challenges[currentStepIndex];
        statusMessage = `Step ${currentStepIndex + 1}/${challenges.length}: Please ${
          nextChallenge.name
        }`;
        stepTimers[currentStepIndex] = 0;
        // Reset nose calibration for new challenge
        centerNoseX = 0.5;
        console.log(`[RESET] Nose calibration reset for new challenge: ${nextChallenge.name}`);
      }
    } else if (padScore <= 70) {
      statusMessage = 'Try again naturally.'; // Only show if really suspicious
      stepTimers[currentStepIndex] = Math.max(0, stepTimers[currentStepIndex] - 1); // Gentle reset
    } else {
      const progress = Math.round((stepTimers[currentStepIndex] / currentChallenge.duration) * 100);
      statusMessage = `${currentChallenge.name.toUpperCase()} - Progress: ${progress}%`;
    }

    // Canvas clear
    const ctx = canvasElement.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    }
  }

  async function submitEnhancedLivenessResult() {
    const currentBvn = $bvnValue || '';
    const verificationData = {
      sessionId,
      bvn: currentBvn,
      livenessScore,
      challenges: challenges.map((c, i) => ({
        challengeId: c.id,
        completed: stepCompleted[i],
        quality: qualityScores[i],
        padScore: padScores[i],
        duration: stepTimers[i],
        snapshot: snapshots[i],
      })),
      metadata: {
        userAgent: navigator.userAgent,
        timestamp: Date.now(),
        challengeDuration: Date.now() - challengeStartTime,
        retryCount,
      },
      verificationId: localStorage.getItem('verificationId') || undefined,
    };

    try {
      const result = await submitLivenessResult(verificationData);

      if (result.success) {
        statusMessage = 'Liveness verification completed successfully!';
        console.log('Enhanced liveness result submitted:', result);

        // Clear sensitive data
        localStorage.removeItem('verificationId');
      } else {
        handleSubmissionFailure(result.message);
      }
    } catch (error) {
      console.error('Failed to submit enhanced liveness results:', error);
      handleSubmissionFailure('Network error during submission');
    } finally {
      isSubmitting = false;
    }
  }

  function handleSubmissionFailure(message?: string) {
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      statusMessage = `Submission failed. Retrying... (${retryCount}/${MAX_RETRIES})`;

      setTimeout(async () => {
        await submitEnhancedLivenessResult();
      }, 2000);
    } else {
      statusMessage = 'Unable to submit verification. Please contact support.';
      // Log detailed failure for debugging
      console.error('Liveness submission failed after retries:', {
        sessionId,
        attempts: retryCount,
        finalError: message,
      });
    }
  }
</script>

<div class="container" {style}>
  {#each step.elements as element}
    {#if element.type === Elements.Title}
      <Title configuration={element.props}>
        <T key="title" namespace={stepNamespace} />
      </Title>
    {/if}
    {#if element.type === Elements.Paragraph}
      <Paragraph configuration={element.props}>
        <T key={element.props.context || 'description'} namespace={stepNamespace} />
      </Paragraph>
    {/if}
    {#if element.type === Elements.VideoContainer}
      <div class="video-container">
        <div class="video-wrapper">
          <video bind:this={videoElement} autoplay muted playsinline class="video-feed" />
          <canvas bind:this={canvasElement} class="detection-overlay" width="640" height="480" />
          <!-- Oval face detection window with progress -->
          <div class="face-oval">
            <svg class="oval-svg" viewBox="0 0 300 400" xmlns="http://www.w3.org/2000/svg">
              <!-- Background oval guide -->
              <ellipse
                cx="150"
                cy="200"
                rx="120"
                ry="160"
                fill="none"
                stroke="rgba(255,255,255,0.8)"
                stroke-width="3"
                stroke-dasharray="5,5"
              />
              <!-- Progress oval ring -->
              <ellipse
                cx="150"
                cy="200"
                rx="120"
                ry="160"
                fill="none"
                stroke={strokeColor}
                stroke-width="3"
                stroke-dasharray={perimeter}
                stroke-dashoffset={dashOffset}
                transform="rotate(-180 150 200)"
              />
            </svg>
          </div>
        </div>
      </div>

      <!-- Enhanced status section with progress bar -->
      <div class="status-section">
        <div
          class="status-message"
          class:warning={statusMessage.includes('Suspicious') || statusMessage.includes('failed')}
          class:error={statusMessage.includes('Unable') || statusMessage.includes('error')}
          class:success={statusMessage.includes('completed successfully')}
        >
          {statusMessage}
        </div>

        {#if isChecking && currentStepIndex < challenges.length && challenges[currentStepIndex]}
          <div class="progress-container">
            <div class="progress-bar">
              <div
                class="progress-fill"
                style="width: {(stepTimers[currentStepIndex] /
                  challenges[currentStepIndex].duration) *
                  100}%"
              />
            </div>
            <div class="progress-text">
              {stepTimers[currentStepIndex]}/{challenges[currentStepIndex].duration} frames
            </div>
          </div>
        {/if}
      </div>
    {/if}
    {#if element.type === Elements.Button}
      {#if currentStepIndex >= challenges.length}
        <NextStepButton
          configuration={element.props}
          isDisabled={isSubmitting}
          skipType={undefined}
        >
          {#if isSubmitting}
            Submitting Results...
          {:else}
            <T key="button" namespace={stepNamespace} />
          {/if}
        </NextStepButton>
      {:else if retryCount >= MAX_RETRIES}
        <!-- Retry option after max retries exceeded -->
        <div class="retry-section">
          <p>Having trouble? Let's try again.</p>
          <button class="retry-button" on:click={initializeChallenges} disabled={isSubmitting}>
            Restart Verification
          </button>
        </div>
      {/if}
    {/if}
  {/each}
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--padding);
    position: var(--position);
    background: var(--background);
    line-height: var(--line-height);
    text-align: center;
    gap: 1rem;
    align-items: center;
  }

  .video-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
  }

  .video-wrapper {
    position: relative;
    width: 100%;
    max-width: 400px;
    aspect-ratio: 4/3;
    margin: 0 auto;
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
  }

  .video-feed {
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #000;
  }

  .detection-overlay {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .face-oval {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
  }

  .oval-svg {
    width: 100%;
    height: 100%;
  }

  .oval-svg ellipse {
    transition: stroke 0.3s ease, stroke-dashoffset 0.3s ease;
  }

  .status-message {
    font-size: 1.1rem;
    font-weight: 500;
    color: #333;
    min-height: 3rem;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 0 1rem;
    transition: color 0.3s ease;
  }

  .status-message.warning {
    color: #ff6b35;
  }

  .status-message.error {
    color: #dc3545;
  }

  .status-message.success {
    color: #28a745;
  }

  .retry-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    margin-top: 1rem;
  }

  .retry-section p {
    color: #666;
    font-size: 0.9rem;
    text-align: center;
  }

  .retry-button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
  }

  .retry-button:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
  }

  .retry-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
  }

  .status-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    min-height: 4rem;
  }

  .progress-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    max-width: 300px;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background-color: #e0e0e0;
    border-radius: 4px;
    overflow: hidden;
    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4caf50, #66bb6a);
    border-radius: 4px;
    transition: width 0.2s ease;
    box-shadow: 0 2px 4px rgba(76, 175, 80, 0.3);
  }

  .progress-text {
    font-size: 0.875rem;
    color: #666;
    font-weight: 500;
  }
</style>
