<script lang="ts">
  import { T } from '../contexts/translation';
  import { configuration } from '../contexts/configuration';
  import { goToNextStep, goToPrevStep } from '../contexts/navigation/hooks';
  import { Elements, Steps } from '../contexts/configuration/types';
  import { preloadNextStepByCurrent } from '../services/preload-service';
  import { appState, currentStepId } from '../contexts/app-state/stores';
  import { ActionNames, sendButtonClickEvent, VerificationStatuses } from '../utils/event-service';
  import { getLayoutStyles, getStepConfiguration } from '../ui-packs';

  export let stepId;

  const step = getStepConfiguration($configuration, stepId);
  const style = getLayoutStyles($configuration, step);

  const stepNamespace = step.namespace || 'liveness-start';

  preloadNextStepByCurrent($configuration, configuration, $currentStepId);

  function handleStart() {
    console.log('[LivenessStart] Starting verification, current step:', $currentStepId);
    goToNextStep(currentStepId, $configuration, $currentStepId);
  }
</script>

<div class="container" {style}>
  <!-- Fixed top navigation -->
  <div class="nav-bar">
    <button class="nav-btn" on:click={() => goToPrevStep(currentStepId, $configuration, $currentStepId)} aria-label="back">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 12H5M12 19l-7-7 7-7"/>
      </svg>
    </button>
    <button class="nav-btn" on:click={() => {
      sendButtonClickEvent(
        ActionNames.CLOSE,
        { status: VerificationStatuses.DATA_COLLECTION },
        $appState,
        true,
      );
    }} aria-label="close">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
  </div>

  <!-- Main content -->
  <div class="content">
    <!-- Illustration -->
    <div class="illustration">
      <svg viewBox="0 0 200 240" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Phone frame -->
        <rect x="40" y="20" width="120" height="200" rx="16" fill="#f0fdfa" stroke="#14b8a6" stroke-width="3"/>
        <!-- Screen -->
        <rect x="50" y="40" width="100" height="160" rx="8" fill="#ffffff"/>
        <!-- Face outline -->
        <circle cx="100" cy="100" r="28" fill="#ccfbf1"/>
        <circle cx="100" cy="100" r="20" fill="#14b8a6"/>
        <!-- Smile -->
        <path d="M92 102q8 8 16 0" stroke="white" stroke-width="2.5" stroke-linecap="round" fill="none"/>
        <!-- Eyes -->
        <circle cx="94" cy="96" r="2.5" fill="white"/>
        <circle cx="106" cy="96" r="2.5" fill="white"/>
        <!-- Body/shoulders -->
        <ellipse cx="100" cy="155" rx="35" ry="25" fill="#ccfbf1"/>
        <!-- Glow effect -->
        <circle cx="100" cy="120" r="60" fill="url(#glow)" opacity="0.5"/>
        <defs>
          <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stop-color="#14b8a6" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#14b8a6" stop-opacity="0"/>
          </radialGradient>
        </defs>
      </svg>
    </div>

    <!-- Title -->
    <h1 class="title">
      <T key="title" namespace={stepNamespace} />
    </h1>

    <!-- Description -->
    <p class="description">
      <T key="description" namespace={stepNamespace} />
    </p>

    <!-- Feature list -->
    <ul class="feature-list">
      <li class="feature-item">
        <span class="feature-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </span>
        <span class="feature-text">
          <T key="feature1" namespace={stepNamespace} />
        </span>
      </li>
      <li class="feature-item">
        <span class="feature-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </span>
        <span class="feature-text">
          <T key="feature2" namespace={stepNamespace} />
        </span>
      </li>
      <li class="feature-item">
        <span class="feature-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
        </span>
        <span class="feature-text">
          <T key="feature3" namespace={stepNamespace} />
        </span>
      </li>
    </ul>
  </div>

  <!-- Bottom action area -->
  <div class="bottom-area">
    {#each step.elements as element}
      {#if element.type === Elements.Button}
        <button class="start-button" on:click={handleStart}>
          <T key="button" namespace={stepNamespace} />
        </button>
      {/if}
    {/each}
    <p class="privacy-note">
      <T key="privacy" namespace={stepNamespace} />
    </p>
  </div>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    padding: 0;
    position: relative;
    height: 100%;
    background: #ffffff;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  }

  .nav-bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem;
    z-index: 10;
  }

  .nav-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: none;
    background: #f1f5f9;
    color: #334155;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .nav-btn:hover {
    background: #e2e8f0;
  }

  .nav-btn svg {
    width: 20px;
    height: 20px;
  }

  .content {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4rem 1.5rem 1rem;
    overflow-y: auto;
  }

  .illustration {
    width: 160px;
    height: 192px;
    margin-bottom: 1.5rem;
  }

  .illustration svg {
    width: 100%;
    height: 100%;
  }

  .title {
    font-size: 1.5rem;
    font-weight: 600;
    line-height: 1.2;
    color: #0f172a;
    margin: 0 0 0.75rem;
    text-align: center;
    letter-spacing: -0.02em;
  }

  .description {
    font-size: 0.9375rem;
    line-height: 1.5;
    color: #64748b;
    margin: 0 0 1.5rem;
    text-align: center;
    max-width: 320px;
    letter-spacing: -0.01em;
  }

  .feature-list {
    list-style: none;
    padding: 0;
    margin: 0;
    width: 100%;
    max-width: 320px;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .feature-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    font-size: 0.875rem;
    line-height: 1.4;
    color: #334155;
  }

  .feature-icon {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    color: #14b8a6;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .feature-icon svg {
    width: 18px;
    height: 18px;
  }

  .feature-text {
    flex: 1;
    font-weight: 400;
    letter-spacing: -0.01em;
  }

  .bottom-area {
    flex: 0 0 auto;
    padding: 1rem 1.5rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }

  .privacy-note {
    font-size: 0.75rem;
    line-height: 1.4;
    color: #64748b;
    margin: 0;
    text-align: center;
    letter-spacing: -0.01em;
  }

  .start-button {
    width: 100%;
    border: none;
    padding: 16px 24px;
    border-radius: 12px;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.25;
    letter-spacing: -0.01em;
    cursor: pointer;
    transition: transform 0.1s ease, opacity 0.2s ease, box-shadow 0.2s ease;
    background: linear-gradient(135deg, #14b8a6 0%, #0d9488 100%);
    color: white;
    box-shadow: 0 4px 12px rgba(20, 184, 166, 0.25);
  }

  .start-button:hover {
    box-shadow: 0 6px 16px rgba(20, 184, 166, 0.35);
  }

  .start-button:active {
    transform: scale(0.98);
  }
</style>
