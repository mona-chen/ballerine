/**
 * Liveness Analysis Utilities
 *
 * Browser-based passive liveness detection using multiple signals:
 * - Depth consistency from MediaPipe FaceMesh 3D landmarks
 * - Texture analysis (Laplacian variance on face region)
 * - Moiré pattern detection for screen replay attacks
 * - RGB emission analysis for screen vs. reflected light
 * - Temporal micro-motion consistency
 * - Device motion telemetry
 */

export interface LivenessSignals {
  depthScore: number;
  textureScore: number;
  moireScore: number;
  rgbScore: number;
  reflectionScore: number;
  motionScore: number;
  overall: number;
  reasons: string[];
}

export interface MotionTelemetry {
  hasMotion: boolean;
  accelerationVariance: number;
  rotationVariance: number;
  sampleCount: number;
}

// ─────────────────────────────────────────────────────────────
// Depth Analysis
// ─────────────────────────────────────────────────────────────

export function analyzeDepth(landmarks: any[]): number {
  if (!landmarks || landmarks.length < 468) return 0;

  // Key facial landmarks for depth profiling
  const noseTip = landmarks[1];
  const noseBridge = landmarks[6];
  const leftEyeInner = landmarks[133];
  const rightEyeInner = landmarks[362];
  const leftCheek = landmarks[234];
  const rightCheek = landmarks[454];
  const chin = landmarks[152];
  const forehead = landmarks[10];

  // Real faces: nose tip is closest (most negative z in MP conventions), eye sockets recede
  const noseDepth = noseTip.z || 0;
  const bridgeDepth = noseBridge.z || 0;
  const leftEyeDepth = leftEyeInner.z || 0;
  const rightEyeDepth = rightEyeInner.z || 0;
  const chinDepth = chin.z || 0;
  const foreheadDepth = forehead.z || 0;

  // Expected hierarchy for a real face (in normalized coordinates):
  // nose_tip < nose_bridge < eye_sockets, cheeks ~ forehead, chin is often deepest
  const expectedOrder =
    noseDepth <= bridgeDepth &&
    bridgeDepth <= Math.min(leftEyeDepth, rightEyeDepth) &&
    Math.max(leftEyeDepth, rightEyeDepth) <= chinDepth + 0.05;

  // Depth variance across the face should be moderate, not flat
  const zValues = landmarks.map((lm: any) => lm.z || 0);
  const zMean = zValues.reduce((a, b) => a + b, 0) / zValues.length;
  const zVariance = zValues.reduce((sum, z) => sum + Math.pow(z - zMean, 2), 0) / zValues.length;

  // Real face: variance should be in a characteristic range (too flat = photo, too chaotic = artifact)
  const varianceScore = Math.max(0, 100 - Math.abs(zVariance - 0.003) * 15000);

  // Nose protrusion score
  const eyeAvgDepth = (leftEyeDepth + rightEyeDepth) / 2;
  const noseProtrusion = eyeAvgDepth - noseDepth;
  const protrusionScore = Math.min(Math.max(noseProtrusion * 800, 0), 100);

  // Flat masks often have uniform z or reversed order
  const orderScore = expectedOrder ? 100 : 30;

  const finalScore = varianceScore * 0.35 + protrusionScore * 0.4 + orderScore * 0.25;
  return Math.min(Math.max(finalScore, 0), 100);
}

// ─────────────────────────────────────────────────────────────
// Texture / Sharpness Analysis
// ─────────────────────────────────────────────────────────────

export function analyzeTexture(imageData: ImageData): number {
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);

  // Convert to grayscale
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = r * 0.299 + g * 0.587 + b * 0.114;
  }

  // Laplacian variance: measure of fine texture/detail
  let laplacianSum = 0;
  let laplacianSqSum = 0;
  let count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const center = gray[i];
      const laplacian =
        gray[i - 1] +
        gray[i + 1] +
        gray[i - width] +
        gray[i + width] -
        4 * center;

      laplacianSum += laplacian;
      laplacianSqSum += laplacian * laplacian;
      count++;
    }
  }

  const mean = laplacianSum / count;
  const variance = laplacianSqSum / count - mean * mean;

  // Real skin typically has texture variance in a characteristic range
  // Very low = overly smooth (photo/filter/mask)
  // Very high = noisy artifact or digital screen pattern
  const optimalVariance = 120;
  const normalized = Math.max(0, 100 - Math.abs(variance - optimalVariance) / 4);

  return Math.min(normalized, 100);
}

// ─────────────────────────────────────────────────────────────
// Moiré Pattern Detection (Screen Replay)
// ─────────────────────────────────────────────────────────────

export function detectMoire(imageData: ImageData): number {
  const { width, height, data } = imageData;

  // Sample BOTH horizontal AND vertical scanlines
  // Screens have pixel grids in both directions
  const hScanlines = [Math.floor(height * 0.35), Math.floor(height * 0.5), Math.floor(height * 0.65)];
  const vScanlines = [Math.floor(width * 0.35), Math.floor(width * 0.5), Math.floor(width * 0.65)];

  let hPeriodicity = 0;
  let vPeriodicity = 0;

  // Horizontal scanlines (detect vertical pixel grid)
  for (const y of hScanlines) {
    const row = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      row[x] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    hPeriodicity += computePeriodicity(row);
  }
  hPeriodicity /= hScanlines.length;

  // Vertical scanlines (detect horizontal pixel grid)
  for (const x of vScanlines) {
    const col = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      col[y] = (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    vPeriodicity += computePeriodicity(col);
  }
  vPeriodicity /= vScanlines.length;

  // Screens show periodicity in BOTH directions
  // Take the MAX - either direction showing strong periodicity is suspicious
  const avgScore = Math.max(hPeriodicity, vPeriodicity);
  const dualAxisScore = (hPeriodicity + vPeriodicity) / 2;

  // High-confidence screen: strong periodicity in at least one direction
  if (avgScore > 55) {
    return Math.max(0, 100 - (avgScore - 55) * 3.5);
  }

  // Medium periodicity: possible screen at angle or lower-res display
  if (avgScore > 30) {
    // Dual-axis periodicity strongly suggests screen even at moderate levels
    if (hPeriodicity > 25 && vPeriodicity > 25) {
      return Math.max(15, 80 - (avgScore - 30) * 2);
    }
    return Math.max(35, 90 - (avgScore - 30) * 1.5);
  }

  // Low periodicity: natural texture, but check for flat photo (both near zero)
  if (avgScore < 8 && dualAxisScore < 5) {
    // Suspiciously flat - could be a printed photo with no texture
    return 45;
  }

  return 95; // Natural skin texture
}

function computePeriodicity(signal: Float32Array): number {
  const n = signal.length;
  const maxLag = Math.min(Math.floor(n / 2), 64); // Reduced for performance

  // Multi-scale autocorrelation for different pixel pitch sizes
  const correlations: number[] = [];

  for (let lag = 2; lag <= maxLag; lag++) {
    let correlation = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < n - lag; i++) {
      correlation += signal[i] * signal[i + lag];
      normA += signal[i] * signal[i];
      normB += signal[i + lag] * signal[i + lag];
    }

    const normalized = correlation / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
    correlations.push(Math.abs(normalized));
  }

  // Find peaks - screens have sharp periodic peaks
  let peakCount = 0;
  let maxCorrelation = 0;

  for (let i = 1; i < correlations.length - 1; i++) {
    if (correlations[i] > correlations[i - 1] &&
        correlations[i] > correlations[i + 1] &&
        correlations[i] > 0.3) {
      peakCount++;
    }
    maxCorrelation = Math.max(maxCorrelation, correlations[i]);
  }

  // Screens produce multiple regular peaks (harmonics of pixel grid)
  // Boost score if multiple peaks detected
  const peakBonus = peakCount >= 2 ? 15 : 0;

  return Math.min(100, maxCorrelation * 100 + peakBonus);
}

// ─────────────────────────────────────────────────────────────
// RGB Emission Analysis (Screen Replay)
// ─────────────────────────────────────────────────────────────

export function analyzeRGBChannels(imageData: ImageData): number {
  const { data } = imageData;
  const totalPixels = data.length / 4;

  let rMean = 0,
    gMean = 0,
    bMean = 0;
  let rVar = 0,
    gVar = 0,
    bVar = 0;

  for (let i = 0; i < data.length; i += 4) {
    rMean += data[i];
    gMean += data[i + 1];
    bMean += data[i + 2];
  }

  rMean /= totalPixels;
  gMean /= totalPixels;
  bMean /= totalPixels;

  for (let i = 0; i < data.length; i += 4) {
    rVar += Math.pow(data[i] - rMean, 2);
    gVar += Math.pow(data[i + 1] - gMean, 2);
    bVar += Math.pow(data[i + 2] - bMean, 2);
  }

  rVar /= totalPixels;
  gVar /= totalPixels;
  bVar /= totalPixels;

  // Reflected light (real face) typically has more balanced RGB variance
  // Screens often have channel-specific artifacts and dominant blues
  const varianceBalance =
    100 - Math.abs(rVar - gVar) / 100 - Math.abs(gVar - bVar) / 100 - Math.abs(rVar - bVar) / 100;

  // Prevent negative
  const balanceScore = Math.max(0, varianceBalance);

  // Blue dominance is common in LCD screens
  const blueDominance = bMean / (rMean + gMean + bMean + 1);
  const blueScore = blueDominance > 0.38 ? Math.max(0, 100 - (blueDominance - 0.38) * 300) : 100;

  return balanceScore * 0.6 + blueScore * 0.4;
}

// ─────────────────────────────────────────────────────────────
// Reflection Asymmetry (Photo / Screen Check)
// ─────────────────────────────────────────────────────────────

export function analyzeReflection(imageData: ImageData): number {
  const { width, height, data } = imageData;

  // Compare left and right halves of the face region for specular symmetry
  // Real faces have somewhat symmetric but not perfectly identical reflections
  // Photos/prints often have flat, uniform lighting

  const midX = Math.floor(width / 2);
  let diffSum = 0;
  let intensitySum = 0;
  let count = 0;

  // Also track variance within each half for flatness detection
  let leftVariance = 0;
  let rightVariance = 0;
  const leftIntensities: number[] = [];
  const rightIntensities: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < midX; x++) {
      const leftIdx = (y * width + x) * 4;
      const rightIdx = (y * width + (width - 1 - x)) * 4;

      const leftIntensity = (data[leftIdx] + data[leftIdx + 1] + data[leftIdx + 2]) / 3;
      const rightIntensity = (data[rightIdx] + data[rightIdx + 1] + data[rightIdx + 2]) / 3;

      diffSum += Math.abs(leftIntensity - rightIntensity);
      intensitySum += leftIntensity + rightIntensity;
      leftIntensities.push(leftIntensity);
      rightIntensities.push(rightIntensity);
      count++;
    }
  }

  const avgDiff = diffSum / count;
  const avgIntensity = intensitySum / (count * 2);

  // Calculate variance within each half
  const leftMean = leftIntensities.reduce((a, b) => a + b, 0) / leftIntensities.length;
  const rightMean = rightIntensities.reduce((a, b) => a + b, 0) / rightIntensities.length;
  leftVariance = leftIntensities.reduce((sum, v) => sum + Math.pow(v - leftMean, 2), 0) / leftIntensities.length;
  rightVariance = rightIntensities.reduce((sum, v) => sum + Math.pow(v - rightMean, 2), 0) / rightIntensities.length;
  const avgVariance = (leftVariance + rightVariance) / 2;

  // Real face: moderate asymmetry due to natural lighting
  // Perfect symmetry = suspiciously flat/printed
  // Extreme asymmetry = possible screen glare from one side
  const symmetryRatio = avgDiff / (avgIntensity + 1);

  // Printed photos have characteristically LOW variance (flat matte surface)
  // Real skin has higher variance due to pores, texture, specular highlights
  const varianceScore = Math.min(100, avgVariance / 10);

  let score = 60;

  // Penalize suspicious flatness (printed photo indicator)
  if (symmetryRatio < 0.015) {
    score -= 45; // very suspicious - perfectly flat like a print
  } else if (symmetryRatio < 0.03) {
    score -= 25; // moderately suspicious
  } else if (symmetryRatio > 0.5) {
    score -= 20; // extreme one-sided glare, possible screen
  } else {
    // Bonus for natural-looking asymmetry
    score += Math.min(30, (symmetryRatio - 0.03) * 100);
  }

  // Variance bonus - real faces have texture
  if (varianceScore > 40) {
    score += 20;
  } else if (varianceScore < 15) {
    score -= 15; // flat like paper
  }

  return Math.min(100, Math.max(5, score));
}

// ─────────────────────────────────────────────────────────────
// Photo-of-Photo Detection (Print Border & Flat Surface)
// ─────────────────────────────────────────────────────────────

export interface PrintSpoofSignals {
  hasBorder: boolean;
  borderStrength: number;
  surfaceFlatness: number;
  colorUniformity: number;
}

export function detectPhotoOfPhoto(imageData: ImageData): PrintSpoofSignals {
  const { width, height, data } = imageData;

  // Check for sharp edges/borders around the face region
  // Printed photos often have visible paper edges or white borders

  // Sample edge regions
  const edgeSize = Math.min(20, Math.floor(Math.min(width, height) * 0.08));

  let borderScore = 0;
  let edgeSharpness = 0;

  // Check top edge
  for (let x = edgeSize; x < width - edgeSize; x++) {
    const edgeY = Math.min(edgeSize, Math.floor(height * 0.1));
    for (let y = 0; y < edgeY; y++) {
      const idx = (y * width + x) * 4;
      const belowIdx = ((y + 5) * width + x) * 4;

      const edgePixel = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const belowPixel = (data[belowIdx] + data[belowIdx + 1] + data[belowIdx + 2]) / 3;

      // Sharp transition suggests a paper edge
      if (Math.abs(edgePixel - belowPixel) > 40) {
        edgeSharpness++;
      }

      // White borders are common in prints
      if (edgePixel > 200 && belowPixel < 150) {
        borderScore++;
      }
    }
  }

  // Check left/right edges for vertical borders
  for (let y = edgeSize; y < height - edgeSize; y++) {
    for (let x = 0; x < Math.min(edgeSize, Math.floor(width * 0.1)); x++) {
      const idx = (y * width + x) * 4;
      const rightIdx = (y * width + (x + 5)) * 4;

      const edgePixel = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const rightPixel = (data[rightIdx] + data[rightIdx + 1] + data[rightIdx + 2]) / 3;

      if (Math.abs(edgePixel - rightPixel) > 40) {
        edgeSharpness++;
      }
      if (edgePixel > 200 && rightPixel < 150) {
        borderScore++;
      }
    }
  }

  // Calculate surface flatness - printed photos have uniform lighting
  const centerStartX = Math.floor(width * 0.2);
  const centerEndX = Math.floor(width * 0.8);
  const centerStartY = Math.floor(height * 0.2);
  const centerEndY = Math.floor(height * 0.8);

  let localVariances: number[] = [];
  const blockSize = 16;

  for (let y = centerStartY; y < centerEndY; y += blockSize) {
    for (let x = centerStartX; x < centerEndX; x += blockSize) {
      let blockSum = 0;
      let blockSumSq = 0;
      let blockCount = 0;

      for (let by = y; by < Math.min(y + blockSize, centerEndY); by++) {
        for (let bx = x; bx < Math.min(x + blockSize, centerEndX); bx++) {
          const idx = (by * width + bx) * 4;
          const intensity = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
          blockSum += intensity;
          blockSumSq += intensity * intensity;
          blockCount++;
        }
      }

      const mean = blockSum / blockCount;
      const variance = blockSumSq / blockCount - mean * mean;
      localVariances.push(variance);
    }
  }

  // Real faces have varied local variances; prints are unnaturally uniform
  const varianceOfVariances = Math.sqrt(
    localVariances.reduce((sum, v) => {
      const meanVar = localVariances.reduce((a, b) => a + b, 0) / localVariances.length;
      return sum + Math.pow(v - meanVar, 2);
    }, 0) / localVariances.length
  );

  // Flat prints have very uniform variance across blocks
  const surfaceFlatness = Math.max(0, 100 - varianceOfVariances / 5);

  // Color uniformity - printed photos often have limited color gamut
  let colorSpread = 0;
  const samples: number[] = [];
  for (let i = 0; i < data.length; i += 16) { // Sample every 4th pixel
    samples.push(data[i], data[i + 1], data[i + 2]);
  }

  const rValues = samples.filter((_, i) => i % 3 === 0);
  const gValues = samples.filter((_, i) => i % 3 === 1);
  const bValues = samples.filter((_, i) => i % 3 === 2);

  const rRange = Math.max(...rValues) - Math.min(...rValues);
  const gRange = Math.max(...gValues) - Math.min(...gValues);
  const bRange = Math.max(...bValues) - Math.min(...bValues);

  colorSpread = (rRange + gRange + bRange) / 3;
  const colorUniformity = Math.max(0, 100 - colorSpread / 2);

  const totalPixels = width * height;
  const hasBorder = borderScore > totalPixels * 0.001 || edgeSharpness > totalPixels * 0.002;

  return {
    hasBorder,
    borderStrength: Math.min(100, (borderScore / totalPixels) * 1000),
    surfaceFlatness,
    colorUniformity,
  };
}

// Compute photo-of-photo liveness score (0-100)
export function computePrintSpoofScore(signals: PrintSpoofSignals): number {
  let score = 50;

  // Strong border indicator
  if (signals.hasBorder && signals.borderStrength > 20) {
    score -= 30;
  }

  // Surface flatness - prints are unnaturally flat
  if (signals.surfaceFlatness > 70) {
    score -= 25;
  } else if (signals.surfaceFlatness < 40) {
    score += 20; // Natural texture is good
  }

  // Limited color gamut suggests print
  if (signals.colorUniformity > 75) {
    score -= 20;
  }

  return Math.min(100, Math.max(0, score));
}

// ─────────────────────────────────────────────────────────────
// Temporal Motion Analysis
// ─────────────────────────────────────────────────────────────

export function analyzeTemporalMotion(
  landmarkHistory: any[][][],
): { score: number; isNatural: boolean } {
  if (landmarkHistory.length < 10) {
    return { score: 50, isNatural: false };
  }

  const frameDeltas: number[] = [];

  for (let i = 1; i < landmarkHistory.length; i++) {
    const prev = landmarkHistory[i - 1][0];
    const curr = landmarkHistory[i][0];

    let totalDelta = 0;
    // Sample sparse landmarks for efficiency (20 key points)
    const indices = [1, 33, 133, 362, 61, 291, 13, 14, 152, 10, 234, 454, 0, 17, 199, 22, 273, 39, 269, 93];

    for (const idx of indices) {
      const dx = curr[idx].x - prev[idx].x;
      const dy = curr[idx].y - prev[idx].y;
      totalDelta += Math.sqrt(dx * dx + dy * dy);
    }

    frameDeltas.push(totalDelta / indices.length);
  }

  const meanDelta = frameDeltas.reduce((a, b) => a + b, 0) / frameDeltas.length;
  const variance =
    frameDeltas.reduce((sum, d) => sum + Math.pow(d - meanDelta, 2), 0) / frameDeltas.length;

  // Natural human motion has characteristic "brownian" properties:
  // - small constant tremor (mean > 0.0003)
  // - moderate variance (not zero, not extreme)
  // - occasional larger movements

  const hasTremor = meanDelta > 0.0003;
  const varianceInRange = variance > 1e-8 && variance < 0.001;

  // Score based on how natural the motion pattern is
  let score = 0;
  if (hasTremor) score += 40;
  if (varianceInRange) score += 40;

  // Bonus for non-uniformity (real humans don't move at perfectly constant speed)
  const maxDelta = Math.max(...frameDeltas);
  const minDelta = Math.min(...frameDeltas);
  if (maxDelta / (minDelta + 1e-8) > 3) score += 20;

  return { score, isNatural: hasTremor && varianceInRange };
}

// ─────────────────────────────────────────────────────────────
// Device Motion Telemetry
// ─────────────────────────────────────────────────────────────

export function startMotionTracking(
  onUpdate: (telemetry: MotionTelemetry) => void,
): () => void {
  const samples: { acc: number[]; rot: number[] }[] = [];

  const handler = (event: DeviceMotionEvent) => {
    const acc = event.accelerationIncludingGravity;
    const rot = event.rotationRate;

    samples.push({
      acc: acc ? [acc.x || 0, acc.y || 0, acc.z || 0] : [0, 0, 0],
      rot: rot ? [rot.alpha || 0, rot.beta || 0, rot.gamma || 0] : [0, 0, 0],
    });

    if (samples.length > 60) samples.shift();

    if (samples.length >= 20) {
      const telemetry = computeTelemetry(samples);
      onUpdate(telemetry);
    }
  };

  window.addEventListener('devicemotion', handler as EventListener);

  return () => {
    window.removeEventListener('devicemotion', handler as EventListener);
  };
}

function computeTelemetry(samples: { acc: number[]; rot: number[] }[]): MotionTelemetry {
  // Compute variance in acceleration and rotation
  const accMeans = [0, 0, 0];
  const rotMeans = [0, 0, 0];

  for (const s of samples) {
    for (let i = 0; i < 3; i++) {
      accMeans[i] += s.acc[i];
      rotMeans[i] += s.rot[i];
    }
  }

  for (let i = 0; i < 3; i++) {
    accMeans[i] /= samples.length;
    rotMeans[i] /= samples.length;
  }

  let accVar = 0;
  let rotVar = 0;

  for (const s of samples) {
    for (let i = 0; i < 3; i++) {
      accVar += Math.pow(s.acc[i] - accMeans[i], 2);
      rotVar += Math.pow(s.rot[i] - rotMeans[i], 2);
    }
  }

  accVar /= samples.length * 3;
  rotVar /= samples.length * 3;

  // Natural hand-holding produces some variance
  // Tripods / static setups produce near-zero variance
  const hasMotion = accVar > 0.01 || rotVar > 0.1;

  return {
    hasMotion,
    accelerationVariance: accVar,
    rotationVariance: rotVar,
    sampleCount: samples.length,
  };
}

// ─────────────────────────────────────────────────────────────
// Desktop Motion Fallback (Camera-based hand tremor detection)
// ─────────────────────────────────────────────────────────────

export function analyzeCameraMotion(
  landmarkHistory: any[][][],
): { score: number; hasMotion: boolean } {
  if (landmarkHistory.length < 15) {
    return { score: 45, hasMotion: false };
  }

  // Use nose tip motion across recent frames
  const positions = landmarkHistory.map(frame => frame[0][1]);
  let totalDelta = 0;

  for (let i = 1; i < positions.length; i++) {
    const dx = positions[i].x - positions[i - 1].x;
    const dy = positions[i].y - positions[i - 1].y;
    totalDelta += Math.sqrt(dx * dx + dy * dy);
  }

  const avgDelta = totalDelta / (positions.length - 1);

  // Natural hand-holding produces small continuous drift / tremor
  const hasMotion = avgDelta > 0.00015;
  const score = Math.min(95, Math.max(35, avgDelta * 100000 + 35));

  return { score, hasMotion };
}

// ─────────────────────────────────────────────────────────────
// Overall Passive Scoring
// ─────────────────────────────────────────────────────────────

export interface LivenessSignals {
  depthScore: number;
  textureScore: number;
  moireScore: number;
  rgbScore: number;
  reflectionScore: number;
  motionScore: number;
  printSpoofScore: number;
  overall: number;
  reasons: string[];
}

export function computePassiveScore(
  depthScore: number,
  textureScore: number,
  moireScore: number,
  rgbScore: number,
  reflectionScore: number,
  motionScore: number,
  printSpoofScore?: number,
): LivenessSignals {
  const weights = {
    depth: 0.22,
    texture: 0.18,
    moire: 0.18, // Increased - critical for screen detection
    rgb: 0.1,
    reflection: 0.12, // Slightly increased for print detection
    motion: 0.15,
    printSpoof: 0.05,
  };

  const pScore = printSpoofScore ?? 50;

  let overall =
    depthScore * weights.depth +
    textureScore * weights.texture +
    moireScore * weights.moire +
    rgbScore * weights.rgb +
    reflectionScore * weights.reflection +
    motionScore * weights.motion +
    pScore * weights.printSpoof;

  // TIGHTENED: Screen/spoof detection takes priority over robustness
  // If moiré strongly suggests a screen, cap the overall score
  if (moireScore < 25) {
    overall = Math.min(overall, 55); // Force challenge or fail
  }

  // Photo-of-photo detection: flat prints with low variance
  if (reflectionScore < 20 && textureScore < 50) {
    overall = Math.min(overall, 50); // Likely a printed photo
  }

  // Dual-indicator spoof: low moiré + low reflection = very suspicious
  if (moireScore < 40 && reflectionScore < 30) {
    overall = Math.min(overall, 45);
  }

  // Robustness rule: RELAXED - now requires 5 strong signals, not 4
  // This prevents borderline cases from passing due to one strong signal
  const scores = [depthScore, textureScore, moireScore, rgbScore, reflectionScore, motionScore];
  const strongSignals = scores.filter((s) => s >= 60).length; // Increased threshold
  const veryWeakSignals = scores.filter((s) => s < 25).length;
  const criticalWeakSignals = scores.filter((s) => s < 15).length;

  // Auto-fail if 2+ critical weak signals (definitely a spoof)
  if (criticalWeakSignals >= 2) {
    overall = Math.min(overall, 35);
  }
  // Only boost if truly strong across the board
  else if (strongSignals >= 5 && veryWeakSignals <= 1) {
    overall = Math.max(overall, 68); // Higher minimum for challenge range
  }

  const reasons: string[] = [];
  if (depthScore < 50) reasons.push('face_depth_inconsistent');
  if (textureScore < 40) reasons.push('texture_unnatural');
  if (moireScore < 25) reasons.push('possible_screen_replay');
  if (moireScore < 40 && moireScore >= 25) reasons.push('suspicious_screen_pattern');
  if (rgbScore < 40) reasons.push('lighting_unnatural');
  if (reflectionScore < 20) reasons.push('reflections_unnatural');
  if (reflectionScore < 35 && textureScore < 45) reasons.push('possible_printed_photo');
  if (motionScore < 30) reasons.push('device_motion_missing');
  if (pScore < 30) reasons.push('print_spoof_detected');

  return {
    depthScore,
    textureScore,
    moireScore,
    rgbScore,
    reflectionScore,
    motionScore,
    printSpoofScore: pScore,
    overall,
    reasons,
  };
}

// ─────────────────────────────────────────────────────────────
// Canvas Helpers
// ─────────────────────────────────────────────────────────────

export function cropFaceFromCanvas(
  canvas: HTMLCanvasElement,
  landmarks: any[],
  padding: number = 0.15,
): ImageData | null {
  if (!landmarks || landmarks.length === 0) return null;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;

  for (const lm of landmarks) {
    minX = Math.min(minX, lm.x * canvas.width);
    maxX = Math.max(maxX, lm.x * canvas.width);
    minY = Math.min(minY, lm.y * canvas.height);
    maxY = Math.max(maxY, lm.y * canvas.height);
  }

  const w = maxX - minX;
  const h = maxY - minY;
  const padX = w * padding;
  const padY = h * padding;

  const sx = Math.max(0, Math.floor(minX - padX));
  const sy = Math.max(0, Math.floor(minY - padY));
  const sw = Math.min(canvas.width - sx, Math.ceil(w + padX * 2));
  const sh = Math.min(canvas.height - sy, Math.ceil(h + padY * 2));

  if (sw <= 0 || sh <= 0) return null;

  return ctx.getImageData(sx, sy, sw, sh);
}

export function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error('Video dimensions not available');
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Could not get canvas context');
  }
  ctx.drawImage(video, 0, 0);
  return canvas;
}
