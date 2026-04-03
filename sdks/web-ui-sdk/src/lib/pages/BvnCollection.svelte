<script lang="ts">
  import { Input, NextStepButton, Paragraph, Title } from '../atoms';
  import { configuration } from '../contexts/configuration';
  import { Elements } from '../contexts/configuration/types';
  import { T } from '../contexts/translation';
  import { appState } from '../contexts/app-state';
  import { bvnValue } from '../contexts/app-state/stores';
  import { getLayoutStyles, getStepConfiguration } from '../ui-packs';
  import { getFlowConfig } from '../contexts/flows/hooks';
  import { validateBvn } from '../services/http';

  export let stepId;

  const step = getStepConfiguration($configuration, stepId);
  const flow = getFlowConfig($configuration);
  const style = getLayoutStyles($configuration, step);

  const stepNamespace = step.namespace || 'bvn-collection';

  let bvnInputValue = '';
  let isValid = false;
  let isFocused = false;
  let isValidating = false;
  let validationError = '';
  let bvnValidated = false;

  $: isValid = bvnInputValue.replace(/\D/g, '').length === 11;
  $: inputStyle = isValid
    ? { border: '2px solid #28a745' }
    : bvnInputValue.length > 0 && !isValid
    ? { border: '2px solid #dc3545' }
    : {};

  function validateBVN(value: string) {
    const cleanValue = value.replace(/\D/g, '');
    return cleanValue.length === 11;
  }

  function formatBVN(value: string) {
    // Format as XXX-XXXX-XXXX for better UX
    const cleaned = value.replace(/\D/g, '');
    const match = cleaned.match(/^(\d{0,3})(\d{0,4})(\d{0,4})$/);
    if (match) {
      return [match[1], match[2], match[3]].filter(Boolean).join('-');
    }
    return cleaned;
  }

  async function handleBvnValidation() {
    if (!isValid) return;

    isValidating = true;
    validationError = '';

    try {
      const cleanBvn = bvnInputValue.replace(/-/g, '');
      const response = await validateBvn(cleanBvn);
      if (response.isValid) {
        bvnValidated = true;
        bvnValue.set(cleanBvn); // Store the validated BVN in the store
        validationError = '';
      } else {
        validationError = response.message || 'Invalid BVN number';
        bvnValidated = false;
      }
    } catch (error) {
      console.error('BVN validation error:', error);
      validationError = 'Failed to validate BVN. Please try again.';
      bvnValidated = false;
    } finally {
      isValidating = false;
    }
  }

  $: formattedBVN = formatBVN(bvnInputValue);
</script>

<div class="container" {style}>
  {#each step.elements as element}
    {#if element.type === Elements.Title}
      <div class="title-section">
        <div class="icon-wrapper">
          <svg class="bvn-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
        <Title configuration={element.props}>
          <T key="title" namespace={stepNamespace} />
        </Title>
      </div>
    {/if}
    {#if element.type === Elements.Paragraph}
      <Paragraph configuration={element.props}>
        <T key={element.props.context || 'description'} namespace={stepNamespace} />
      </Paragraph>
    {/if}
    {#if element.type === Elements.Input}
      <div class="input-section">
        <div
          class="input-wrapper"
          class:focused={isFocused}
          class:valid={isValid}
          class:invalid={bvnInputValue.length > 0 && !isValid}
        >
          <Input
            configuration={{
              ...element.props,
              style: inputStyle,
              attributes: {
                ...element.props.attributes,
                placeholder: 'placeholder',
                type: 'text',
                maxlength: 15, // Allow for dashes
                validate: () => validateBVN(bvnInputValue),
              },
            }}
            translationContext={stepNamespace}
            bind:value={bvnInputValue}
            on:focus={() => (isFocused = true)}
            on:blur={() => (isFocused = false)}
          />
          {#if isValid}
            <div class="validation-icon valid">
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clip-rule="evenodd"
                />
              </svg>
            </div>
          {:else if bvnInputValue.length > 0}
            <div class="validation-icon invalid">
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clip-rule="evenodd"
                />
              </svg>
            </div>
          {/if}
        </div>
        {#if bvnInputValue.length > 0 && !isValid}
          <div class="error-message">Please enter a valid 11-digit BVN number</div>
        {/if}
      </div>
    {/if}
    {#if element.type === Elements.Button}
      <div class="button-section">
        {#if !bvnValidated}
          <NextStepButton
            configuration={element.props}
            isDisabled={!isValid || isValidating}
            skipType={undefined}
            advanceOnClick={false}
            on:click={handleBvnValidation}
          >
            {#if isValidating}
              Validating...
            {:else}
              <T key="button" namespace={stepNamespace} />
            {/if}
          </NextStepButton>
        {:else}
          <NextStepButton configuration={element.props} isDisabled={false} skipType={undefined}>
            Continue to Liveness Check
          </NextStepButton>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 2rem 1rem;
    position: var(--position);
    background: var(--background);
    line-height: var(--line-height);
    text-align: center;
    gap: 2rem;
    align-items: center;
    justify-content: flex-start;
    max-width: 500px;
    margin: 0 auto;
  }

  .title-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
    margin-bottom: 1rem;
  }

  .icon-wrapper {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 20px rgba(102, 126, 234, 0.3);
  }

  .bvn-icon {
    width: 32px;
    height: 32px;
    color: white;
  }

  .input-section {
    width: 100%;
    max-width: 400px;
    margin: 1rem 0;
  }

  .input-wrapper {
    position: relative;
    transition: all 0.3s ease;
  }

  .input-wrapper.focused {
    transform: scale(1.02);
  }

  .validation-icon {
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .validation-icon.valid {
    color: #28a745;
  }

  .validation-icon.invalid {
    color: #dc3545;
  }

  .error-message {
    color: #dc3545;
    font-size: 0.875rem;
    margin-top: 0.5rem;
    text-align: center;
    animation: fadeIn 0.3s ease;
  }

  .button-section {
    width: 100%;
    max-width: 400px;
    margin-top: 1rem;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
