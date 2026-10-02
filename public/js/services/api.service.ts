import { graphqlService } from './graphql.service';
import { cacheService } from './cache.service';
import { configService } from './ConfigService';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
type RequestOptions = {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
};

type DeckPayload = {
  topic: string;
  cards: Array<{ front: string; back: string; id?: string; topic?: string }>;
};

type DeckResponse = {
  id: string;
  topic: string;
  cards: Array<{ id: string; front: string; back: string; topic: string }>;
  timestamp: string | number;
};

type QuizSummary = {
  id: string;
  topic: string;
  questionCount: number;
  source: string;
  createdAt: string | number;
};

type QuizDetail = {
  id: string;
  topic: string;
  questions: Array<{ id: string; question: string; options: string[]; correctAnswer: string; explanation?: string | null }>;
  mode: string;
  createdAt: string | number;
};

type QuizHistoryEntry = { quizId: string; score: number; total: number; timestamp: string | number };

type JobStatus = {
  id: string;
  status: string;
  progress?: number;
  result?: unknown;
  error?: string | null;
};

type CreateQuizParams = {
  topic?: string;
  count?: number;
  flashcardIds?: string[];
  flashcards?: Array<{ id: string; front: string; back: string; topic?: string }>;
  preferredRuntime?: string;
};

export class ApiService {
  private baseUrl: string;
  private useGraphQL: boolean;

  constructor(baseUrl = '/api') {
    this.baseUrl = baseUrl;

    this.useGraphQL = true;

    console.log(`[API] Using ${this.useGraphQL ? 'GraphQL' : 'REST'} API`);
  }

  /**
   * Toggle between REST and GraphQL
   */
  setUseGraphQL(use: boolean) {
    this.useGraphQL = use;
    localStorage.setItem('USE_GRAPHQL', use.toString());
    console.log(`[API] Switched to ${use ? 'GraphQL' : 'REST'} API`);
  }

  /**
   * Check if using GraphQL
   */
  isUsingGraphQL(): boolean {
    return this.useGraphQL;
  }

  async request(endpoint: string, options: RequestOptions = {}) {
    // Check for token in URL (from OAuth redirect)
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    if (tokenFromUrl) {
      localStorage.setItem('authToken', tokenFromUrl);
      // Update GraphQL headers too
      graphqlService.updateHeaders();
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const token = localStorage.getItem('authToken');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Inject test auth header if flag is set (for E2E tests)
    const isTestAuth = localStorage.getItem('TEST_AUTH') === 'true';
    if (isTestAuth) {
      headers['x-test-auth'] = 'true';
    }

    // Simple incremental retry to reduce transient "Failed to fetch" errors
    const maxAttempts = 4;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      try {
        const response = await fetch(`${this.baseUrl}${endpoint}`, {
          headers,
          ...options,
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Unauthorized: Session expired, please log in again');
          }
          throw new Error(`API Error: ${response.statusText}`);
        }

        return await response.json();
      } catch (error: unknown) {
        lastError = error;
        attempt += 1;

        // Exponential backoff with jitter (0.5s, 1s, 2s, 4s-ish)
        const delay = Math.min(4000, 500 * 2 ** (attempt - 1)) + Math.random() * 200;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
    }

    console.error('API Request Failed after retries:', lastError);
    throw lastError || new Error('API request failed');
  }

  async get(endpoint: string) {
    return this.request(endpoint, { method: 'GET' });
  }

  isAuthenticated() {
    return !!localStorage.getItem('authToken');
  }

  async post(endpoint: string, data: unknown) {
    return this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  /**
   * Upload configuration file or document
   */
  async uploadFile(file: File, topic: string) {
    const MAX_DIRECT = 5 * 1024 * 1024; // 5MB
    if (file.size <= MAX_DIRECT) {
      return this.uploadSingle(file, topic);
    }
    return this.uploadChunked(file, topic);
  }

  private async uploadSingle(file: File, topic: string) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('topic', topic);

    const response = await fetch(`${this.baseUrl}/upload`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: formData
    });
    return this.handleJsonResponse(response);
  }

  private async uploadChunked(file: File, topic: string) {
    const chunkSize = 5 * 1024 * 1024; // 5MB chunks for smoother uploads
    const total = Math.ceil(file.size / chunkSize);
    const uploadId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    for (let index = 0; index < total; index++) {
      const start = index * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const blob = file.slice(start, end);

      const formData = new FormData();
      formData.append('chunk', blob, file.name);
      formData.append('uploadId', uploadId);
      formData.append('index', index.toString());
      formData.append('total', total.toString());
      formData.append('filename', file.name);
      formData.append('mimeType', file.type || 'application/octet-stream');
      formData.append('topic', topic);

      const response = await fetch(`${this.baseUrl}/upload/chunk`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: formData
      });

      const payload = await this.handleJsonResponse(response);
      if (payload.status === 'partial') {
        continue;
      }
      // Final response carries cards
      return payload;
    }
    throw new Error('Chunked upload did not return a final response.');
  }

  private authHeaders(): Record<string, string> {
    const token = localStorage.getItem('authToken');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
  }

  private async handleJsonResponse(response: Response) {
    if (!response.ok) {
      let errorMsg = `Upload failed (HTTP ${response.status})`;
      try {
        const err = await response.json();
        errorMsg = err.error || err.message || errorMsg;
      } catch { /* ignore */ }
      throw new Error(errorMsg);
    }
    const payload = await response.json();
    return payload?.data ?? payload;
  }

  /**
   * Generate from raw content (text or URLs)
   */
  async generateFromContent(payload: { type: 'text' | 'url', content: string | string[], topic: string }) {
    // Map to GraphQL input
    const input = {
      topic: payload.topic,
      inputType: payload.type,
      content: payload.content
    };

    try {
      const result = await graphqlService.generateFlashcards(input);
      return {
        success: true,
        cards: result.cards
      };
    } catch (error) {
      console.error('[API] generateFromContent failed via GraphQL', error);
      throw error;
    }
  }

  async saveDeck(deck: any) {
    return this.post('/decks', deck);
  }

  // Hybrid methods with GraphQL support

  /**
   * Get all decks - supports both REST and GraphQL
   */
  async getDecks(): Promise<DeckResponse[]> {
    const cacheKey = 'decks-list';
    const cached = await cacheService.get<DeckResponse[]>(cacheKey);
    if (cached) return cached;

    let result: any;
    try {
      result = await graphqlService.getDecks();
    } catch (error) {
      console.error('[API] GraphQL getDecks failed', error);
      throw error;
    }

    if (result && result.history) {
      result = result.history;
    }

    await cacheService.set(cacheKey, result);
    return result as DeckResponse[];
  }

  /**
   * Create a deck - supports both REST and GraphQL
   */
  async createDeck(deck: DeckPayload): Promise<DeckResponse> {
    const result = await graphqlService.createDeck(deck as any);
    await cacheService.invalidatePattern('decks-list');
    return result;
  }

  /**
   * Get quiz history - supports both REST and GraphQL
   */
  async getQuizHistory(): Promise<QuizHistoryEntry[]> {
    const cacheKey = 'quiz-history';
    const cached = await cacheService.get<QuizHistoryEntry[]>(cacheKey);
    if (cached) return cached;

    const result = await graphqlService.getQuizHistory();
    await cacheService.set(cacheKey, result);
    return result;
  }

  /**
   * Get all quizzes - supports both REST and GraphQL
   */
  async getAllQuizzes(): Promise<{ success: boolean; quizzes: QuizSummary[] }> {
    const cacheKey = 'quizzes-list';
    const cached = await cacheService.get<{ success: boolean; quizzes: QuizSummary[] }>(cacheKey);
    if (cached) return cached;

    const quizzes = await graphqlService.getAllQuizzes();
    const result = { success: true, quizzes };

    await cacheService.set(cacheKey, result);
    return result;
  }

  /**
   * Get quiz by ID - supports both REST and GraphQL
   */
  async getQuiz(id: string): Promise<{ success: boolean; quiz: QuizDetail | null }> {
    const cacheKey = `quiz-${id}`;
    const cached = await cacheService.get<{ success: boolean; quiz: QuizDetail | null }>(cacheKey);
    if (cached) return cached;

    const quiz = await graphqlService.getQuiz(id);
    const result = { success: true, quiz };

    await cacheService.set(cacheKey, result);
    return result;
  }

  /**
   * Create quiz - supports both REST and GraphQL
   * Unified method for topic or flashcards
   */
  async createQuiz(params: CreateQuizParams): Promise<{ success?: boolean; quiz?: QuizSummary; quizId?: string }> {
    const result = await this._createQuizInternal(params);
    await cacheService.invalidatePattern('quizzes-list');
    return result;
  }

  private async _createQuizInternal(params: CreateQuizParams): Promise<{ success?: boolean; quiz?: QuizSummary; quizId?: string }> {
    try {
      // Map params including cardIds
      const quiz = await graphqlService.createQuiz({
        topic: params.topic,
        count: params.count,
        cards: params.flashcards,
        cardIds: params.flashcardIds
      });
      return { success: true, quiz };
    } catch (error) {
      console.error('[API] GraphQL createQuiz failed', error);
      throw error;
    }
  }

  /**
   * Submit quiz - supports both REST and GraphQL
   * Handles the difference between server-side scoring (GraphQL) and client-side (REST legacy)
   */
  async submitQuiz(quizId: string, data: { answers?: Record<string, string> | Array<{ questionId: string; answer: string }>; results?: Array<{ cardId?: string; id?: string; userAnswer: string }> }) {
    const result = await this._submitQuizInternal(quizId, data);
    await cacheService.invalidatePattern('quiz-history');
    return result;
  }

  private async _submitQuizInternal(quizId: string, data: { answers?: Record<string, string> | Array<{ questionId: string; answer: string }>; results?: Array<{ cardId?: string; id?: string; userAnswer: string }> }) {
    try {
      // GraphQL expects answers array: { questionId, answer }
      let answers: Array<{ questionId: string; answer: string }> = [];
      if (data.answers && !Array.isArray(data.answers)) {
        answers = Object.entries(data.answers).map(([qId, ans]) => ({
          questionId: qId,
          answer: ans
        }));
      } else if (Array.isArray(data.answers)) {
        answers = data.answers as Array<{ questionId: string; answer: string }>;
      } else if (data.results && Array.isArray(data.results)) {
        // Extract from QuizModel results
        answers = data.results
          .filter(r => r.cardId || r.id)
          .map(r => ({
            questionId: (r.cardId || r.id) as string,
            answer: r.userAnswer
          }));
      }

      if (answers.length > 0) {
        const result = await graphqlService.submitQuizAnswers(quizId, answers);
        return { success: true, ...result };
      }

      throw new Error('No answers to submit or client-side grading not supported via GraphQL yet');
    } catch (error) {
      console.error('[API] GraphQL submitQuiz failed', error);
      throw error;
    }
  }

  /**
   * Generate flashcards - supports both REST and GraphQL
   */
  async generateFlashcards(params: {
    topic: string;
    count: number;
    mode?: string;
    knowledgeSource?: string;
    parentTopic?: string;
    preferredRuntime?: string;
    llmConfig?: any;
  }) {
    try {
      const input = {
        topic: params.topic,
        count: params.count,
        mode: params.mode,
        knowledgeSource: params.knowledgeSource,
        parentTopic: params.parentTopic
        // Note: llmConfig/preferredRuntime not fully passed to GraphQL yet unless we expand schema further.
        // Assuming defaults or handled by backend flags/context.
      };

      const result: any = await graphqlService.generateFlashcards(input);

      // GraphQL returns { cards, jobId, recommendedTopics }
      // Convert to REST-compatible format
      return {
        cards: result.cards,
        jobId: result.jobId,
        recommendedTopics: result.recommendedTopics,
        success: true
      };
    } catch (error) {
      console.error('[API] GraphQL generateFlashcards failed', error);
      throw error;
    }
  }

  async generateFlashcardsFromText(
    text: string,
    topic: string,
    count: number,
    preferredRuntime?: string,
    llmConfig?: any
  ) {
    return this.post('/generate/from-content', {
      type: 'text',
      content: text,
      topic,
      count,
      preferredRuntime,
      llmConfig
    });
  }

  async generateFlashcardsFromUrls(
    urls: string[],
    topic: string,
    count?: number,
    preferredRuntime?: string,
    llmConfig?: any
  ) {
    return this.post('/generate/from-content', {
      type: 'url',
      content: urls,
      topic,
      count,
      preferredRuntime,
      llmConfig
    });
  }

  /**
   * Get job status - supports both REST and GraphQL
   */
  async getJobStatus(jobId: string): Promise<JobStatus | null> {
    try {
      const job = await graphqlService.getJobStatus(jobId);
      if (!job) return null;
      // Convert to REST-compatible format
      return {
        id: job.id,
        status: job.status,
        result: job.result,
        error: job.error,
        progress: job.progress
      };
    } catch (error) {
      console.error('[API] GraphQL getJobStatus failed', error);
      throw error;
    }
  }

  /**
   * Polls a background job until completion or timeout.
   * Returns the job result (e.g., { cards, recommendedTopics }).
   */
  async waitForJobResult(jobId: string, options: { maxWaitMs?: number; pollIntervalMs?: number; onProgress?: (progress: number) => void } = {}) {
    const { pollIntervalMs = 2000, onProgress } = options;
    // Use configured timeout (default to 3m) unless overridden
    const maxWaitMs = options.maxWaitMs || configService.getJobTimeout();
    const start = Date.now();
    const hardCapMs = Math.max(maxWaitMs, 300000); // never wait more than 5 minutes
    let allowedWaitMs = maxWaitMs;

    let lastStatus: JobStatus | null = null;
    const expectedPolls = Math.max(1, Math.ceil(maxWaitMs / pollIntervalMs));
    let attempt = 0;
    let lastProgressAt = Date.now();

    while (Date.now() - start < allowedWaitMs) {
      attempt += 1;
      lastStatus = await this.getJobStatus(jobId);
      const status = (lastStatus?.status || '').toString().toLowerCase();

      if (typeof onProgress === 'function') {
        if (typeof lastStatus?.progress === 'number') {
          onProgress(lastStatus.progress);
          lastProgressAt = Date.now();
        } else {
          const elapsed = Date.now() - start;
          const timeProgress = Math.min(95, Math.round((elapsed / maxWaitMs) * 90) + 5);
          const attemptProgress = Math.min(95, Math.round((attempt / expectedPolls) * 90) + 5);
          onProgress(Math.max(5, Math.min(95, Math.max(timeProgress, attemptProgress))));
        }
      }

      if (status === 'completed' || status === 'succeeded') {
        if (typeof onProgress === 'function') onProgress(100);
        return lastStatus?.result;
      }

      if (status === 'failed') {
        throw new Error(lastStatus?.error || 'Job failed to complete');
      }

      if (status === 'not_found') {
        throw new Error('Job not found');
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      // If we recently saw progress, extend wait a bit (up to hard cap) to avoid premature timeout.
      const sinceProgress = Date.now() - lastProgressAt;
      // Allow up to 5 minutes of silence before giving up on extension
      if (sinceProgress < 300000 && allowedWaitMs < hardCapMs) {
        allowedWaitMs = Math.min(hardCapMs, allowedWaitMs + pollIntervalMs);
      }
    }

    if (typeof onProgress === 'function') onProgress(100);
    throw new Error(`Job ${jobId} timed out after ${Math.round(allowedWaitMs / 1000)}s`);
  }

  /**
   * Health check - GraphQL or REST
   */
  async healthCheck() {
    return graphqlService.healthCheck();
  }
}

export const apiService = new ApiService();
