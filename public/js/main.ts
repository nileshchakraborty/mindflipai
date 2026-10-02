import { AppController } from './controllers/app.controller.js';
import { configService } from './services/ConfigService.js';
import { LLMOrchestrator } from './services/llm/LLMOrchestrator';
import { DeviceCapabilityService } from './services/llm/DeviceCapabilityService';
import { ModelManagerUI } from './controllers/ModelManagerUI';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { inject } from '@vercel/analytics';
import { apiService } from './services/api.service.js';
import { graphqlService } from './services/graphql.service.js';
import { settingsService } from './services/settings.service.js';
import { eventBus } from './utils/event-bus.js';
import { initErrorBar } from './utils/error-bar.util.js';
// import SkeletonLoader from './components/SkeletonLoader.js';

// Basic client-side error logging
window.addEventListener('error', (event) => {
  console.error('[Client Error]', event.message, event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Client Unhandled Rejection]', event.reason);
});

document.addEventListener('DOMContentLoaded', async () => {
  // Load configuration first
  await configService.loadConfig();

  // Ensure loading overlay is non-blocking on initial load
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    (overlay as HTMLElement).style.pointerEvents = 'none';
    (overlay as HTMLElement).style.display = 'none';
  }

  // Initialize global error bar
  initErrorBar();

  // Initialize Speed Insights
  injectSpeedInsights();

  // Initialize Vercel Web Analytics
  inject();

  // Mobile header menu toggle (for settings/logout only)
  const headerToggle = document.getElementById('header-menu-toggle');
  const mobileSettingsMenu = document.getElementById('mobile-settings-menu');
  if (headerToggle && mobileSettingsMenu) {
    headerToggle.addEventListener('click', () => {
      mobileSettingsMenu.classList.toggle('hidden');
      const icon = headerToggle.querySelector('.material-icons');
      if (icon) {
        icon.textContent = mobileSettingsMenu.classList.contains('hidden') ? 'more_vert' : 'close';
      }
    });
  }

  // Wire up mobile settings button to trigger desktop settings
  const settingsBtnMobile = document.getElementById('settings-btn-mobile');
  const settingsBtnDesktop = document.getElementById('settings-btn');
  if (settingsBtnMobile && settingsBtnDesktop) {
    settingsBtnMobile.addEventListener('click', () => {
      mobileSettingsMenu?.classList.add('hidden');
      settingsBtnDesktop.click();
    });
  }

  // Wire up mobile auth button to trigger desktop auth
  const authBtnMobile = document.getElementById('auth-btn-mobile');
  const authBtnDesktop = document.getElementById('auth-btn');
  if (authBtnMobile && authBtnDesktop) {
    authBtnMobile.addEventListener('click', () => {
      mobileSettingsMenu?.classList.add('hidden');
      authBtnDesktop.click();
    });
  }

  // Mobile nav hamburger toggle
  const navToggle = document.getElementById('nav-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  if (navToggle && mobileNav) {
    navToggle.addEventListener('click', () => {
      mobileNav.classList.toggle('hidden');
      const icon = navToggle.querySelector('.material-icons');
      if (icon) {
        icon.textContent = mobileNav.classList.contains('hidden') ? 'menu' : 'close';
      }
    });
  }

  // Capture token from OAuth redirect (?token=...) before anything else
  const urlParams = new URLSearchParams(window.location.search);
  const tokenFromUrl = urlParams.get('token');
  if (tokenFromUrl) {
    localStorage.setItem('authToken', tokenFromUrl);
    graphqlService.updateHeaders();
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const landingPage = document.getElementById('landing-page');
  const appContent = document.getElementById('app-content');

  if (apiService.isAuthenticated()) {
    landingPage?.classList.add('hidden');
    appContent?.classList.remove('hidden');

    const app = new AppController();
    (window as any).app = app;

    // Initialize LLM Orchestrator
    const orchestrator = new LLMOrchestrator();
    await orchestrator.initialize();
    (window as any).llmOrchestrator = orchestrator;

    // WebLLM Warmup: Preload model if WebLLM is preferred runtime AND device supports it
    if (settingsService.getPreferredRuntime() === 'webllm') {
      try {
        // Device validation - skip WebLLM on inadequate devices
        const capabilities = await DeviceCapabilityService.detectCapabilities();
        const tier = DeviceCapabilityService.getTier(capabilities);

        console.log('[WebLLM Warmup] Device capabilities:', {
          isMobile: capabilities.isMobile,
          memoryGB: capabilities.memoryEstimate,
          hasWebGPU: capabilities.hasWebGPU,
          isOnCellular: capabilities.isOnCellular,
          tier
        });

        // Skip WebLLM warmup for unsuitable devices
        if (capabilities.isMobile) {
          console.log('[WebLLM Warmup] Skipping: Mobile device detected. Using server-side LLM.');
          // Silently fall back to server - no warmup needed
        } else if (capabilities.memoryEstimate < 8) {
          console.log(`[WebLLM Warmup] Skipping: Only ${capabilities.memoryEstimate}GB RAM detected (need 8GB+). Using server-side LLM.`);
        } else if (capabilities.isOnCellular) {
          console.log('[WebLLM Warmup] Skipping: Cellular connection detected. Using server-side LLM to save data.');
        } else if (tier === 'low') {
          console.log('[WebLLM Warmup] Skipping: Low-tier device detected. Using server-side LLM.');
        } else {
          // Device is suitable for WebLLM - proceed with warmup
          console.log('[WebLLM Warmup] Device is suitable. Checking if model is already loaded...');

          if (!orchestrator.isModelLoaded()) {
            console.log('[WebLLM Warmup] Model not loaded, starting warmup...');

            // Show warmup overlay
            const warmupOverlay = document.createElement('div');
            warmupOverlay.id = 'webllm-warmup-overlay';
            warmupOverlay.className = 'fixed inset-0 bg-gradient-to-br from-indigo-900/95 to-purple-900/95 backdrop-blur-md z-50 flex flex-col items-center justify-center';
            warmupOverlay.innerHTML = `
            <div class="text-center max-w-md px-6">
              <div class="w-20 h-20 border-4 border-white border-t-transparent rounded-full animate-spin mb-6 mx-auto"></div>
              <h2 class="text-white text-2xl font-bold mb-2">Loading AI Model</h2>
              <p id="webllm-warmup-message" class="text-white/80 text-base mb-4">Preparing browser-based AI...</p>
              <div class="w-full bg-white/20 rounded-full h-3 mb-2">
                <div id="webllm-warmup-progress" class="bg-gradient-to-r from-cyan-400 to-blue-500 h-3 rounded-full transition-all duration-300" style="width: 0%"></div>
              </div>
              <p id="webllm-warmup-percent" class="text-white/60 text-sm">0%</p>
              <p class="text-white/40 text-xs mt-4">First load downloads ~2GB model (cached for future use)</p>
            </div>
          `;
            document.body.appendChild(warmupOverlay);

            const { config } = orchestrator.getRecommendedStrategy();
            console.log('[WebLLM Warmup] Loading model:', config.id);

            await orchestrator.loadModel(config, (progress, message) => {
              const progressBar = document.getElementById('webllm-warmup-progress');
              const percentEl = document.getElementById('webllm-warmup-percent');
              const messageEl = document.getElementById('webllm-warmup-message');

              if (progressBar) progressBar.style.width = `${progress}%`;
              if (percentEl) percentEl.textContent = `${progress}%`;
              if (messageEl) messageEl.textContent = message || 'Loading...';
            });

            // Remove warmup overlay
            warmupOverlay.remove();
            console.log('[WebLLM Warmup] Model loaded and ready!');
          } else {
            console.log('[WebLLM Warmup] Model already loaded, skipping warmup');
          }
        }
      } catch (error) {
        console.warn('[WebLLM Warmup] Failed to preload model:', error);
        // Remove overlay if it exists
        document.getElementById('webllm-warmup-overlay')?.remove();
        // Don't block app startup - WebLLM will fall back to server
      }
    }

    // Model Manager is opt-in
    let modelManager: ModelManagerUI | null = null;
    let modelManagerInitialized = false;
    const ensureModelManager = () => {
      if (!modelManagerInitialized) {
        modelManager = new ModelManagerUI(orchestrator);
        modelManager.initialize();
        modelManagerInitialized = true;
      }
    };

    // Auto-enable model manager if user previously opted in
    if (settingsService.getModelManagerEnabled()) {
      ensureModelManager();
    }

    // Setup Settings Modal Logic (only needed if logged in)
    setupSettingsModal(ensureModelManager);

  } else {
    landingPage?.classList.remove('hidden');
    appContent?.classList.add('hidden');
    // Don't initialize app controllers if not logged in
  }

  // Setup login/logout button state (for both views if needed, but mainly app view)
  const authBtn = document.getElementById('auth-btn');
  const labelEl = document.getElementById('auth-btn-label');

  const renderAuthState = () => {
    if (!authBtn || !labelEl) return;
    const isAuthed = apiService.isAuthenticated();
    labelEl.textContent = isAuthed ? 'Logout' : 'Login';
    authBtn.onclick = () => {
      if (isAuthed) {
        localStorage.removeItem('authToken');
        graphqlService.updateHeaders();
        window.location.reload();
      } else {
        window.location.href = '/api/auth/google';
      }
    };
  };

  renderAuthState();

  // Expose eventBus for inline handlers (legacy refresh button)
  (window as any).eventBus = eventBus;
  (window as any).apiService = apiService;
  // Expose models for E2E testing
  import('./models/quiz.model.js').then(({ quizModel }) => {
    (window as any).quizModel = quizModel;
  });
});

function setupSettingsModal(ensureModelManager: () => void) {
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const settingsClose = document.getElementById('settings-close');
  const settingsCancel = document.getElementById('settings-cancel');
  const settingsSave = document.getElementById('settings-save');
  const runtimeRadios = Array.from(document.querySelectorAll('.runtime-radio')) as HTMLInputElement[];
  const modelManagerToggle = document.getElementById('model-manager-enabled') as HTMLInputElement | null;

  const openSettings = () => {
    const pref = settingsService.getPreferredRuntime();
    runtimeRadios.forEach(r => r.checked = r.value === pref);
    if (modelManagerToggle) modelManagerToggle.checked = settingsService.getModelManagerEnabled();
    settingsModal?.classList.remove('hidden');
    settingsModal?.classList.add('flex');
  };
  const closeSettings = () => {
    settingsModal?.classList.add('hidden');
    settingsModal?.classList.remove('flex');
  };

  settingsBtn?.addEventListener('click', openSettings);
  settingsClose?.addEventListener('click', closeSettings);
  settingsCancel?.addEventListener('click', closeSettings);
  settingsSave?.addEventListener('click', () => {
    const selected = runtimeRadios.find(r => r.checked);
    if (selected) settingsService.setPreferredRuntime(selected.value as any);
    if (modelManagerToggle) {
      const enabled = modelManagerToggle.checked;
      settingsService.setModelManagerEnabled(enabled);
      if (enabled) ensureModelManager();
    }
    closeSettings();
  });
}
