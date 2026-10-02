import type { StudyUseCase, AIServicePort, SearchServicePort, StoragePort } from '../ports/interfaces.js';
import type { Flashcard, QuizQuestion, QuizResult, Deck } from '../domain/models.js';
import type { KnowledgeSource, Runtime, QuizMode } from '../domain/types.js';
import { MetricsService } from './MetricsService.js';
import { appProperties } from '../../config/properties.js';
import { CacheService } from './CacheService.js';
import { FlashcardGenerationGraph } from '../workflows/FlashcardGenerationGraph.js';
import { ensureSupportedFileType } from '../../utils/fileType.js';
// @ts-ignore
import pdfParse from 'pdf-parse';
// @ts-ignore
import Tesseract from 'tesseract.js';
// @ts-ignore
import mammoth from 'mammoth';
import { RAGWorkflow } from '../workflows/RAGWorkflow.js';
import { RAGService } from './RAGService.js';


import * as cheerio from 'cheerio';
import axios from 'axios';
import http from 'http';
import https from 'https';
import xlsx from 'xlsx';

// ... existing imports ...

export class StudyService implements StudyUseCase {
  async processFile(file: Buffer, filename: string, mimeType: string, topic: string): Promise<Flashcard[]> {
    // Normalize and validate mime type
    mimeType = ensureSupportedFileType(mimeType, filename);

    // Basic type guard
    // ensureSupportedFileType throws if unsupported; no additional guard needed

    let text = '';

    try {
      if (mimeType === 'application/pdf') {
        const data = await pdfParse(file);
        text = data.text;
      } else if (mimeType.startsWith('image/')) {
        const result = await Tesseract.recognize(file);
        text = result.data.text;
      } else if (
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimeType === 'application/msword' ||
        filename.endsWith('.doc') ||
        filename.endsWith('.docx')
      ) {
        const result = await mammoth.extractRawText({ buffer: file });
        text = result.value;
        if (result.messages.length > 0) {
          console.warn('[StudyService] Mammoth warnings:', result.messages);
        }
      } else if (
        mimeType === 'application/vnd.ms-excel' ||
        mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        filename.endsWith('.xls') ||
        filename.endsWith('.xlsx')
      ) {
        const workbook = xlsx.read(file, { type: 'buffer' });
        const sheets: string[] = [];

        workbook.SheetNames.forEach(sheetName => {
          const sheet = workbook.Sheets[sheetName];
          if (!sheet) return;
          // rows as arrays, coerce to text
          const rows: any[][] = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
          const limitedRows = rows.slice(0, appProperties.XLS_MAX_ROWS_PER_SHEET); // configurable row limit
          const lines = limitedRows
            .map(r => r.map(c => String(c || '')).join('\t'))
            .filter(line => line.trim().length > 0);
          if (lines.length > 0) {
            sheets.push(`SHEET: ${sheetName}\n` + lines.join('\n'));
          }
        });

        text = sheets.join('\n\n---\n\n');
        // Trim extremely large text to keep within LLM prompt budget
        if (text.length > appProperties.MAX_EXTRACT_TEXT_CHARS) {
          text = text.slice(0, appProperties.MAX_EXTRACT_TEXT_CHARS);
        }
      } else if (mimeType === 'text/plain') {
        text = file.toString('utf-8');
      } else {
        // Fallback: treat as utf-8 text
        text = file.toString('utf-8');
      }

      if (!text || text.trim().length < 10) {
        throw new Error('Unable to extract meaningful text');
      }

      console.log(`[StudyService] Processed ${mimeType} file (${filename}): ${text.length} characters extracted`);

      const sourceMeta: any = { sourceType: 'upload', sourceName: filename };

      // Optional: Ingest into RAG system if available
      if (this.ragService) {
        try {
          await this.ragService.ingestContent(topic, text, { filename, mimeType });
          console.log(`[StudyService] Ingested content for topic "${topic}" into RAG.`);
        } catch (ingestErr) {
          console.warn('[StudyService] RAG Ingestion failed (non-blocking):', ingestErr);
        }
      }

      // Primary generation
      try {
        const cards = await this.getAdapter('ollama').generateFlashcardsFromText(text, topic, 10, { filename });
        const grounded = this.filterGroundedCards(text, cards || []);
        if (grounded.length > 0) return grounded.map((c: Flashcard) => ({ ...c, ...sourceMeta }));
      } catch (genErr) {
        console.warn('[StudyService] Primary generation from text failed, attempting fallback.', genErr);
      }

      // Fallback: quick heuristic flashcards from the text itself
      const fallback = this.generateFallbackFlashcardsFromText(text, topic, 6, sourceMeta);
      if (fallback.length === 0) {
        throw new Error('No flashcards generated from the uploaded file. Please try a different file or format.');
      }
      return fallback;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[StudyService] File processing failed for ${filename} (${mimeType}):`, message);
      throw new Error(message);
    }
  }

  // @ts-ignore - Will be used when graph is wired into generation flow
  private flashcardGraph: FlashcardGenerationGraph;
  private disableAsyncRecommendations: boolean;
  private inFlightControllers = new Set<AbortController>();

  private getAdapter(runtime: string): any {
    // If aiAdapters is a map keyed by runtime, return that entry.
    const possible = (this.aiAdapters as any)[runtime];
    if (possible) return possible;

    // Fallback: If the requested runtime doesn't exist, try 'ollama' as default
    const ollamaFallback = (this.aiAdapters as any)['ollama'];
    if (ollamaFallback) {
      console.warn(`[StudyService] Adapter '${runtime}' not found, falling back to 'ollama'`);
      return ollamaFallback;
    }

    // Last resort: For tests, assume aiAdapters itself is the adapter
    if (typeof (this.aiAdapters as any).generateSummary === 'function') {
      return this.aiAdapters;
    }

    throw new Error(`No AI adapter found for runtime '${runtime}' and no fallback available`);
  }

  constructor(
    private aiAdapters: Record<string, AIServicePort>,
    private searchAdapter: SearchServicePort,
    private storageAdapter: StoragePort,
    private metricsService?: MetricsService,
    private webContextCache?: CacheService<string>,
    private ragService?: RAGService,
    disableAsyncRecommendations: boolean = process.env.NODE_ENV === 'test'
  ) {
    this.disableAsyncRecommendations = disableAsyncRecommendations;
    // Initialize FlashcardGenerationGraph with Ollama adapter for resilient generation
    this.flashcardGraph = new FlashcardGenerationGraph(
      this.getAdapter('ollama') as any // Cast as adapter type flexibility
    );
  }

  /**
   * Generate flashcards for a topic using the configured AI/runtime pipeline.
   * Returns the requested count (or padded fallbacks) and optional recommendations.
   */
  async generateFlashcards(
    topic: string,
    count: number,
    mode: QuizMode = 'standard',
    knowledgeSource: KnowledgeSource = 'ai-web',
    runtime: Runtime = 'ollama',
    parentTopic?: string,
    llmConfig?: any
  ): Promise<{ cards: Flashcard[], recommendedTopics?: string[] }> {
    const desiredCount = Math.max(1, count || 1);
    const startTime = Date.now();
    const adapter = this.getAdapter(runtime);
    if (!adapter) {
      throw new Error(`Unknown runtime: ${runtime}. Available: ${Object.keys(this.aiAdapters).join(', ')}`);
    }

    try {
      const result = await this.doGenerateFlashcards(topic, desiredCount, mode, knowledgeSource, adapter, parentTopic, llmConfig);
      const validated = await this.validateAndRepairFlashcards(result.cards, desiredCount, topic, adapter);
      const adjustedCards = this.enforceCardCount(validated, desiredCount, topic);

      // Record success metrics
      if (this.metricsService) {
        this.metricsService.recordGeneration({
          runtime,
          knowledgeSource,
          mode,
          topic,
          cardCount: Math.min(desiredCount, adjustedCards.length),
          duration: Date.now() - startTime,
          success: true
        });
      }

      // Trigger async recommendations generation (fire-and-forget) — skip in tests
      if (!this.disableAsyncRecommendations) {
        const t = setTimeout(() => {
          void this.generateRecommendationsAsync(topic).catch(err => {
            console.warn('[StudyService] Failed to generate recommendations:', err);
          });
        }, 0);
        // Ensure this timer won't keep the process alive if everything else is done
        if (typeof t.unref === 'function') t.unref();
      }

      return { ...result, cards: adjustedCards };
    } catch (error: any) {
      // Fallback: if Ollama is unreachable (e.g., ENOTFOUND), retry once with WebLLM runtime
      const message = (error as Error)?.message || '';
      const isDns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message);
      if (runtime === 'ollama' && isDns && this.getAdapter('webllm')) {
        console.warn('⚠️ Ollama unreachable, falling back to WebLLM runtime');
        try {
          const webResult = await this.doGenerateFlashcards(topic, desiredCount, mode, knowledgeSource, this.getAdapter('webllm'), parentTopic);
          const validated = await this.validateAndRepairFlashcards(webResult.cards, desiredCount, topic, this.getAdapter('webllm'));
          const adjustedCards = this.enforceCardCount(validated, desiredCount, topic);
          if (this.metricsService) {
            this.metricsService.recordGeneration({
              runtime: 'webllm',
              knowledgeSource,
              mode,
              topic,
              cardCount: Math.min(desiredCount, adjustedCards.length),
              duration: Date.now() - startTime,
              success: true
            });
          }
          return { ...webResult, cards: adjustedCards };
        } catch (fallbackError: any) {
          // if fallback also fails, keep original error for clarity
          console.error('WebLLM fallback failed:', fallbackError?.message || fallbackError);
        }
      }

      // Record failure metrics
      if (this.metricsService) {
        this.metricsService.recordGeneration({
          runtime,
          knowledgeSource,
          mode,
          topic,
          cardCount: 0,
          duration: Date.now() - startTime,
          success: false,
          errorMessage: error.message
        });
      }
      throw error;
    }
  }

  private async doGenerateFlashcards(
    topic: string,
    count: number,
    mode: QuizMode,
    knowledgeSource: KnowledgeSource,
    _aiAdapter: AIServicePort,
    parentTopic?: string,
    llmConfig?: any
  ): Promise<{ cards: Flashcard[], recommendedTopics?: string[] }> {
    if (mode === 'deep-dive') {
      return this.generateDeepDiveFlashcards(topic, count, llmConfig);
    }

    console.log(`\n=== Starting Knowledge Retrieval for: "${topic}" (Mode: ${knowledgeSource}) ===`);

    // Parallel Execution for Mixed Mode
    let aiSummary = '';
    let scrapedContent = '';

    if (knowledgeSource === 'ai-only') {
      console.log('1. Generating flashcards from AI knowledge (ai-only mode)...');
      try {
        const adapter = _aiAdapter as any;
        let cards = await adapter.generateFlashcards(topic, count, llmConfig);
        cards = await this.validateAndRepairFlashcards(cards, count, topic, adapter);
        cards = this.enforceCardCount(cards, count, topic);
        return { cards };
      } catch (e) {
        throw new Error(`Failed to generate flashcards from AI knowledge: ${(e as Error).message}`);
      }
    } else if (knowledgeSource === 'rag') {
      if (!this.ragService) throw new Error('RAG Service not initialized');
      console.log('1. RAG Mode: Retrieving from Knowledge Graph & Vector Store...');
      const workflow = new RAGWorkflow(this.ragService, _aiAdapter);
      const cards = await workflow.run(topic, count);
      return { cards };
    } else if (knowledgeSource === 'web-only') {
      console.log('1. Fetching web context (web-only mode)...');
      scrapedContent = await this.getCachedOrFreshWebContext(topic, parentTopic);
    } else {
      // ai-web: Run in parallel
      console.log('1. Fetching AI Summary & Web Context in parallel...');
      const adapter = _aiAdapter as any;

      const [summaryResult, webResult] = await Promise.all([
        // Task A: AI Summary
        (async () => {
          try {
            const s = await adapter.generateSummary(topic, llmConfig);
            console.log('   AI Summary:', s.substring(0, 100) + '...');
            return s;
          } catch (e) {
            console.warn('   Failed to get AI summary:', (e as Error).message);
            return '';
          }
        })(),
        // Task B: Web Context
        this.getCachedOrFreshWebContext(topic, parentTopic)
      ]);

      aiSummary = summaryResult;
      scrapedContent = webResult;
    }

    // Step 3: Synthesize & Generate
    console.log('3. Synthesizing context and generating flashcards...');
    let combinedContext = '';
    if (aiSummary) {
      combinedContext += `AI KNOWLEDGE SUMMARY:\n${aiSummary}\n\n`;
    }
    if (scrapedContent) {
      combinedContext += `WEB CONTENT:\n${scrapedContent}\n\n`;
    }

    let cards: Flashcard[] = [];
    if (combinedContext) {
      // Use the text-based generation with our rich context
      const adapter = _aiAdapter as any;
      cards = await adapter.generateFlashcardsFromText(combinedContext, topic, count, undefined, llmConfig);
    }

    // Fallback or Initial Attempt if no context:
    // If context generation failed OR yielded 0 cards, try basic generation
    if (!cards || cards.length === 0) {
      console.log('   Context-based generation returned empty/null, falling back to basic generation.');
      const adapter = _aiAdapter as any;
      cards = await adapter.generateFlashcards(topic, count, llmConfig);
    }

    cards = await this.validateAndRepairFlashcards(cards, count, topic, this.getAdapter('ollama'));
    cards = this.enforceCardCount(cards, count, topic);
    return { cards };
  }

  private async generateDeepDiveFlashcards(topic: string, count: number, llmConfig?: any): Promise<{ cards: Flashcard[], recommendedTopics?: string[] }> {
    console.log(`\n=== Starting DEEP DIVE Knowledge Retrieval for: "${topic}" ===`);

    // 1. Generate Sub-topics
    console.log('1. Identifying advanced sub-topics...');
    let subTopics: string[] = [];
    try {
      subTopics = await this.getAdapter('ollama').generateSubTopics(topic, llmConfig);
      console.log(`   Identified ${subTopics.length} sub-topics:`, subTopics.join(', '));
    } catch (e) {
      console.warn('   Failed to generate sub-topics, falling back to standard mode.');
      return this.generateFlashcards(topic, count, 'standard', undefined, undefined, undefined, llmConfig);
    }

    if (subTopics.length === 0) {
      return this.generateFlashcards(topic, count, 'standard', undefined, undefined, undefined, llmConfig);
    }

    // 2. Select ONLY the first sub-topic for immediate processing
    const currentSubTopic = subTopics[0];
    const remainingTopics = subTopics.slice(1);
    console.log(`2. Processing PRIMARY sub-topic: "${currentSubTopic}"`);
    console.log(`   (Remaining ${remainingTopics.length} topics will be recommended)`);

    // 3. Research the single sub-topic
    let combinedContext = '';
    try {
      // Refine Query
      const query = await this.getAdapter('ollama').generateSearchQuery(currentSubTopic, topic); // Pass parent topic context
      console.log(`   Refined Query: "${query}"`);

      // Search
      const results = await this.searchAdapter.search(query);

      // Take top 3 unique sources (increased from 2 since we only do 1 topic)
      const uniqueDomains = new Set();
      const topSources = results.filter(r => {
        try {
          const h = new URL(r.link).hostname;
          if (uniqueDomains.has(h)) return false;
          uniqueDomains.add(h);
          return true;
        } catch { return false; }
      }).slice(0, 2); // Limit Deep Dive sources to 2 for speed

      // Scrape
      const urls = topSources.map(r => r.link);
      const content = await this.scrapeMultipleSources(urls);

      combinedContext = `DEEP DIVE TOPIC: ${currentSubTopic} (Parent: ${topic})\n${content}\n---\n`;
    } catch (e) {
      console.warn(`   x Failed to research sub-topic "${currentSubTopic}": ${(e as Error).message}`);
    }

    // 4. Generate Flashcards
    console.log('3. Generating advanced flashcards from aggregated context...');
    const cards = await this.getAdapter('ollama').generateFlashcardsFromText(combinedContext, currentSubTopic, count);

    return {
      cards,
      recommendedTopics: remainingTopics
    };
  }

  private async scrapeMultipleSources(urls: string[]): Promise<string> {
    const axiosInstance = axios.create({
      timeout: 3000,
      httpAgent: new http.Agent({ keepAlive: false }),
      httpsAgent: new https.Agent({ keepAlive: false }),
    });

    const scrapePromises = urls.map(async (url) => {
      const controller = new AbortController();
      this.inFlightControllers.add(controller);
      try {
        console.log(`   - Scraping: ${url}`);
        const res = await axiosInstance.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          },
          signal: controller.signal
        });

        const $ = cheerio.load(res.data);
        $('script, style, nav, footer, header').remove();
        let text = $('body').text().replace(/\s+/g, ' ').trim();
        return `SOURCE (${url}):\n${text.substring(0, 2000)}\n---\n`;
      } catch (e) {
        // axios throws when aborted or timed out
        console.warn(`   x Failed to scrape ${url}: ${(e as any).message}`);
        return '';
      } finally {
        this.inFlightControllers.delete(controller);
      }
    });

    const results = await Promise.all(scrapePromises);
    return results.join('\n');
  }

  /**
   * Cache-first web context retrieval
   * Checks cache first, performs fresh search if miss
   */
  private async getCachedOrFreshWebContext(topic: string, parentTopic?: string): Promise<string> {
    const cacheKey = `web-context:${topic}`;

    //Check cache first
    if (this.webContextCache) {
      const cached = await this.webContextCache.get(cacheKey);
      if (cached) {
        console.log(`[Cache Hit] Using cached web context for: ${topic}`);
        return cached;
      }
    }

    // Cache miss - perform fresh search
    console.log(`[Cache Miss] Fetching fresh web context for: ${topic}`);

    // Step 1: Generate search query
    let searchQuery = topic;
    try {
      searchQuery = await this.getAdapter('ollama').generateSearchQuery(topic, parentTopic);
      console.log(`   Refined Query: "${searchQuery}"`);
    } catch (e) {
      console.warn('   Failed to refine query, using original topic.');
    }

    // Step 2: Search web
    const searchResults = await this.searchAdapter.search(searchQuery);
    console.log(`   Found ${searchResults.length} results.`);

    // Step 3: Filter for unique domains
    const uniqueDomains = new Set();
    const diverseSources = searchResults.filter(result => {
      try {
        const hostname = new URL(result.link).hostname;
        if (uniqueDomains.has(hostname)) {
          return false;
        }
        uniqueDomains.add(hostname);
        return true;
      } catch (e) {
        return false;
      }
    });

    const topSources = diverseSources.slice(0, 3);
    console.log(`   Selected top ${topSources.length} unique sources for scraping.`);

    // Step 4: Scrape content
    let webContext = '';
    if (topSources.length > 0) {
      const urls = topSources.map(r => r.link);
      webContext = await this.scrapeMultipleSources(urls);
      console.log(`   Total scraped content: ${webContext.length} chars.`);
    }

    // Store in cache
    if (this.webContextCache && webContext) {
      await this.webContextCache.set(cacheKey, webContext);
    }

    return webContext;
  }

  async processRawText(text: string, topic: string): Promise<Flashcard[]> {
    if (!text || text.trim().length === 0) return [];
    const sourceMeta: any = { sourceType: 'text' };
    try {
      const cards = await this.getAdapter('ollama').generateFlashcardsFromText(text, topic, 10, { filename: 'raw-text' });
      const grounded = this.filterGroundedCards(text, cards || []);
      if (grounded.length > 0) return grounded.map((c: Flashcard) => ({ ...c, ...sourceMeta }));
    } catch (err) {
      console.warn('[StudyService] Primary raw-text generation failed, using fallback.', err);
    }
    return this.generateFallbackFlashcardsFromText(text, topic, 6, sourceMeta);
  }

  /**
   * Very simple fallback to ensure some flashcards are returned even when the LLM fails.
   */
  private generateFallbackFlashcardsFromText(text: string, topic: string, count: number, meta: any = {}): Flashcard[] {
    const sentences = text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .filter(s => s.trim().length > 0)
      .slice(0, Math.max(count * 2, 10)); // take more to ensure variety

    const cards: Flashcard[] = [];
    for (let i = 0; i < count; i++) {
      const idx = i % sentences.length;
      const sentence = sentences[idx] || `Provide one key fact about ${topic}.`;
      cards.push({
        id: `fallback-${Date.now()}-${i}`,
        front: `What is a key idea related to "${topic}"?`,
        back: sentence.length > 220 ? sentence.slice(0, 217) + '...' : sentence,
        topic,
        ...meta
      } as any);
    }
    return cards;
  }

  /**
   * Filter out hallucinated cards by requiring overlap with source text.
   */
  private filterGroundedCards(sourceText: string, cards: Flashcard[]): Flashcard[] {
    if (!cards || cards.length === 0) return [];

    const tokens = this.extractTokens(sourceText);
    if (tokens.size === 0) return [];

    const grounded: Flashcard[] = [];
    for (const card of cards) {
      const qTokens = this.extractTokens((card as any).question || (card as any).front || '');
      const aTokens = this.extractTokens((card as any).answer || (card as any).back || '');
      const qOverlap = this.countOverlap(tokens, qTokens);
      const aOverlap = this.countOverlap(tokens, aTokens);
      // Require both sides to have some overlap, and combined overlap to be meaningful
      if (qOverlap >= 1 && aOverlap >= 1 && (qOverlap + aOverlap) >= 3) {
        grounded.push(card);
      }
    }
    return grounded;
  }

  private extractTokens(text: string): Set<string> {
    const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'with', 'by', 'from', 'at', 'as', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'these', 'those', 'it', 'its', 'their', 'his', 'her', 'our', 'your', 'my', 'we', 'you', 'they']);
    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w))
    );
  }

  private countOverlap(source: Set<string>, target: Set<string>): number {
    let count = 0;
    target.forEach(t => {
      if (source.has(t)) count++;
    });
    return count;
  }

  async processUrls(urls: string[], topic: string): Promise<Flashcard[]> {
    if (!urls || urls.length === 0) return [];

    const content = await this.scrapeMultipleSources(urls);
    if (!content) throw new Error('Failed to scrape content from provided URLs');

    const sourceMeta: any = { sourceType: 'urls', sourceUrls: urls };
    try {
      const cards = await this.getAdapter('ollama').generateFlashcardsFromText(content, topic, 10, { filename: 'urls-content' });
      const grounded = this.filterGroundedCards(content, cards || []);
      if (grounded.length > 0) return grounded.map((c: Flashcard) => ({ ...c, ...sourceMeta }));
    } catch (err) {
      console.warn('[StudyService] URL-based generation failed, using fallback.', err);
    }

    const fallback = this.generateFallbackFlashcardsFromText(content, topic, 6, sourceMeta);
    if (fallback.length === 0) throw new Error('No flashcards generated from provided URLs.');
    return fallback;
  }

  async getBriefAnswer(question: string, context: string): Promise<string> {
    return this.getAdapter('ollama').generateBriefAnswer(question, context);
  }

  /**
   * Build a quiz either from existing flashcards or directly from a topic.
   * Respects a preferred runtime order and falls back to local generation when needed.
   */
  async generateQuiz(
    topic: string,
    count: number,
    flashcards?: Flashcard[],
    preferredRuntime: 'ollama' | 'webllm' = 'ollama',
    llmConfig?: any
  ): Promise<QuizQuestion[]> {
    const sanitizeQuestions = (qs: QuizQuestion[] | null): QuizQuestion[] | null => {
      if (!qs) return null;
      const bannedPhrases = [
        'provided code snippet',
        'given code snippet',
        'above code snippet',
        'following code snippet',
        'this code snippet'
      ];
      const filtered = qs.filter(q => {
        const text = `${q.question || ''}`.toLowerCase();
        return !bannedPhrases.some(p => text.includes(p));
      });
      if (filtered.length === 0) return null;
      return filtered;
    };

    const ensureCount = (qs: QuizQuestion[] | null, fallback: () => QuizQuestion[]): QuizQuestion[] => {
      let result = qs && qs.length ? [...qs] : [];
      if (!result.length) {
        result = fallback();
      }
      if (count && result.length > count) {
        result = result.slice(0, count);
      }
      if (count && result.length < count) {
        const needed = count - result.length;
        const extra = fallback().slice(0, needed);
        result = [...result, ...extra];
        if (result.length > count) {
          result = result.slice(0, count);
        }
      }
      return result;
    };

    const order = preferredRuntime === 'webllm'
      ? ['webllm', 'ollama']
      : ['ollama', 'webllm'];

    const tryAdapters = async (fn: (adapter: any) => Promise<QuizQuestion[]>) => {
      for (const runtime of order) {
        try {
          const adapter = this.getAdapter(runtime);
          if (adapter && typeof adapter === 'object') {
            return await fn(adapter);
          }
        } catch (err: any) {
          console.warn(`[StudyService] ${runtime} quiz generation failed:`, err?.message);
        }
      }
      return null;
    };

    const qualityGate = (questions: QuizQuestion[] | null): QuizQuestion[] | null => {
      if (!questions || questions.length === 0) return null;
      // Basic quality checks: require question and correctAnswer populated
      const valid = questions.filter(q => q?.question && q?.correctAnswer);
      if (valid.length < Math.max(1, Math.floor((questions.length || 1) * 0.5))) {
        return null;
      }
      return valid;
    };

    // 1) Flashcard-based quiz
    if (flashcards && flashcards.length > 0) {
      console.log('Generating quiz from', flashcards.length, 'flashcards');

      // Try primary
      const primaryResult = await tryAdapters((adapter) => adapter.generateQuizFromFlashcards(flashcards, count, llmConfig).then(qualityGate).then((qs: QuizQuestion[] | null) => sanitizeQuestions(qs)));
      if (primaryResult === null || primaryResult?.length === 0) {
        console.warn('[StudyService] Primary quiz generation returned empty/null result');
      }

      // Quality failed or generation failed; try secondary for validation
      const secondaryResult = !primaryResult
        ? await tryAdapters((adapter) => adapter.generateQuizFromFlashcards(flashcards, count, llmConfig).then(qualityGate).then((qs: QuizQuestion[] | null) => sanitizeQuestions(qs)))
        : null;
      if (secondaryResult && secondaryResult.length > 0) {
        console.log(`[StudyService] Secondary quiz generation succeeded: ${secondaryResult.length} questions`);
      }

      const filled = ensureCount(primaryResult || secondaryResult, () =>
        this.generateQuizFallbackFromFlashcards(flashcards, count)
      );
      return filled;
    }

    // 2) Topic-based quiz
    console.log(`[StudyService] Generating topic-based quiz for: ${topic}`);
    const primaryResult = await tryAdapters((adapter) => adapter.generateAdvancedQuiz({ topic, wrongAnswers: [] }, 'harder', undefined, llmConfig).then(qualityGate).then((qs: QuizQuestion[] | null) => sanitizeQuestions(qs)));
    if (primaryResult === null || primaryResult?.length === 0) {
      console.warn('[StudyService] Primary topic quiz generation returned empty/null result');
    } else {
      console.log(`[StudyService] Primary topic quiz generation succeeded: ${primaryResult.length} questions`);
    }

    const secondaryResult = !primaryResult
      ? await tryAdapters((adapter) => adapter.generateAdvancedQuiz({ topic, wrongAnswers: [] }, 'harder', undefined, llmConfig).then(qualityGate).then((qs: QuizQuestion[] | null) => sanitizeQuestions(qs)))
      : null;
    if (secondaryResult && secondaryResult.length > 0) {
      console.log(`[StudyService] Secondary topic quiz generation succeeded: ${secondaryResult.length} questions`);
    }

    const filled = ensureCount(primaryResult || secondaryResult, () =>
      this.generateQuizFallbackFromTopic(topic, count)
    );
    return filled;
  }

  async generateAdvancedQuiz(previousResults: any, mode: 'harder' | 'remedial', llmConfig?: any): Promise<QuizQuestion[]> {
    console.log('[StudyService.generateAdvancedQuiz] START');
    console.log('[StudyService.generateAdvancedQuiz] Mode:', mode);
    console.log('[StudyService.generateAdvancedQuiz] Previous results:', JSON.stringify(previousResults, null, 2));

    let context = '';

    // For "Harder" mode, get web context (cache-first)
    const userProvidedScope = !!(
      previousResults?.sourceType === 'upload' ||
      previousResults?.sourceType === 'text' ||
      previousResults?.inputSource === 'upload' ||
      previousResults?.uploadedFileName ||
      (previousResults as any)?.sourceUrls?.length ||
      previousResults?.providedContext
    );

    if (mode === 'harder' && previousResults.topic && !userProvidedScope) {
      try {
        console.log(`[StudyService] Getting web context for advanced quiz on: ${previousResults.topic}`);
        context = await this.getCachedOrFreshWebContext(previousResults.topic); // TODO: pass llmConfig here if searching uses LLM
        console.log(`[StudyService] Web context retrieved, length: ${context.length} chars`);
        console.log('[StudyService] Added web context to advanced quiz generation.');
      } catch (e) {
        console.error('[StudyService] Web context retrieval ERROR:', e);
        console.warn('[StudyService] Web context retrieval failed for advanced quiz, proceeding without context:', e);
      }
    } else {
      console.log(`[StudyService] Skipping web context - mode: ${mode}, has topic: ${!!previousResults.topic}`);
    }

    console.log('[StudyService] Calling adapter.generateAdvancedQuiz with context length:', context.length);
    const result = await this.getAdapter('ollama').generateAdvancedQuiz(previousResults, mode, context, llmConfig);
    console.log('[StudyService.generateAdvancedQuiz] COMPLETE - Generated', result.length, 'questions');

    return result;
  }

  async saveQuizResult(result: QuizResult): Promise<string> {
    await this.storageAdapter.saveQuizResult(result);
    return result.id;
  }

  async getQuizHistory(): Promise<QuizResult[]> {
    return this.storageAdapter.getQuizHistory();
  }

  async saveDeck(deck: Deck): Promise<void> {
    await this.storageAdapter.saveDeck(deck);
  }

  async getDeckHistory(): Promise<Deck[]> {
    return this.storageAdapter.getDeckHistory();
  }

  async getDeck(id: string): Promise<Deck | null> {
    return this.storageAdapter.getDeck(id);
  }
  /**
   * Local fallback: build simple MCQs from flashcards without LLM.
   */
  private generateQuizFallbackFromFlashcards(flashcards: Flashcard[], count: number): QuizQuestion[] {
    const pool = flashcards.slice();
    const questions: QuizQuestion[] = [];
    const take = Math.min(count || 5, pool.length);

    const shuffle = <T>(arr: T[]) => arr.sort(() => Math.random() - 0.5);

    for (let i = 0; i < take; i++) {
      const card = pool[i % pool.length];
      const otherCards = pool.filter((c) => c.id !== card?.id);
      let distractors = shuffle(otherCards).slice(0, 3).map((c) => c.back);

      // Ensure 4 options by padding with generic distractors if needed
      const genericDistractors = [
        "None of the above",
        "All of the above",
        "Depends on the context",
        "Not applicable"
      ];

      let added = 0;
      while (distractors.length < 3 && added < genericDistractors.length) {
        const generic = genericDistractors[added];
        if (generic && !distractors.includes(generic)) {
          distractors.push(generic);
        }
        added++;
      }

      const options = shuffle([card?.back || '', ...distractors]);

      questions.push({
        id: `fallback-${card?.id || i}`,
        question: card?.front?.endsWith('?') ? card.front : `${card?.front}?`,
        options,
        correctAnswer: card?.back || '',
        explanation: 'Based on your existing flashcard content.'
      });
    }

    return questions;
  }

  /**
   * Local fallback: generic topic questions when LLM is unavailable.
   */
  private generateQuizFallbackFromTopic(topic: string, count: number): QuizQuestion[] {
    const questions: QuizQuestion[] = [];
    const take = Math.max(count || 5, 3);
    for (let i = 0; i < take; i++) {
      questions.push({
        id: `fallback-topic-${i}`,
        question: `What is a key fact about ${topic}?`,
        options: [
          `${topic} is an important concept in its field.`,
          `${topic} is a random string.`,
          `${topic} refers to a historical place.`,
          `${topic} is unrelated to learning.`
        ],
        correctAnswer: `${topic} is an important concept in its field.`,
        explanation: 'Fallback question generated without AI service.'
      });
    }
    return questions;
  }

  private isCardValid(card: Flashcard): boolean {
    if (!card) return false;
    const q = (card.front || (card as any).question || '').trim();
    const a = (card.back || (card as any).answer || '').trim();
    if (!q || !a) return false;
    const noise = /json.dumps|JSON_START|function|def\s|#|```|class\s|import\s/;
    return !noise.test(q + a) && q.length >= 4 && a.length >= 3;
  }

  private normalizeCards(raw: any[]): Flashcard[] {
    return (raw || []).map((c, i) => ({
      id: c.id || `card-${Date.now()}-${i}`,
      front: (c.front || c.question || '').trim(),
      back: (c.back || c.answer || '').trim(),
      topic: (c as any).topic
    }));
  }

  private async validateAndRepairFlashcards(cards: Flashcard[], count: number, topic: string, adapter: any): Promise<Flashcard[]> {
    const desired = Math.max(1, count || 1);
    let normalized = this.normalizeCards(cards).filter(c => this.isCardValid(c));
    if (normalized.length >= desired) return normalized;

    if (adapter?.generateFlashcardsFromText) {
      try {
        const prompt = `Fix and return EXACTLY ${desired} flashcards in JSON. Each object must have 'question' and 'answer'. Topic: ${topic}. Here is possibly malformed data:\n${JSON.stringify(cards, null, 2)}`;
        const repaired = await adapter.generateFlashcardsFromText(prompt, topic, desired);
        normalized = this.normalizeCards(repaired).filter(c => this.isCardValid(c));
        if (normalized.length >= desired) return normalized;
      } catch (e) {
        console.warn('[StudyService] Repair via adapter failed:', (e as any)?.message);
      }
    }

    return normalized;
  }

  /** Ensure flashcard count matches user request, padding simple Q/A when too few are returned. */
  private enforceCardCount(cards: Flashcard[], count: number, topic: string): Flashcard[] {
    const desired = Math.max(1, count || 1);
    let trimmed = cards.slice(0, desired);

    if (trimmed.length < desired) {
      const needed = desired - trimmed.length;
      for (let i = 0; i < needed; i++) {
        trimmed.push({
          id: `fallback-${Date.now()}-${i}`,
          front: `What is a key fact about ${topic}?`,
          back: `${topic} is an important concept to understand.`,
          topic
        } as Flashcard);
      }
    }

    return trimmed;
  }

  /**
   * Generate recommendations asynchronously (fire-and-forget)
   * Generates recommended quiz topics and learning paths based on web context
   */
  private async generateRecommendationsAsync(topic: string): Promise<void> {
    try {
      console.log(`[StudyService] Generating async recommendations for: ${topic}`);

      // Get web context for the topic (will use cache if available)
      const webContext = await this.getCachedOrFreshWebContext(topic);

      // Generate recommendations using AI
      const prompt = `Based on the following content about "${topic}", suggest:
1. Three related quiz topics that would help deepen understanding
2. Three recommended learning paths or next topics to study

Content:
${webContext.substring(0, 3000)}

Respond in JSON format:
{
  "recommendedQuizzes": ["topic1", "topic2", "topic3"],
  "recommendedLearning": ["path1", "path2", "path3"]
}`;

      const response = await this.getAdapter('ollama').generateBriefAnswer(
        'Generate recommendations',
        prompt
      );

      // Parse the AI response
      if (!response || typeof response !== 'string') {
        console.warn('[StudyService] Invalid response from AI for recommendations');
        return;
      }
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const recommendations = JSON.parse(jsonMatch[0]);

        // Store in cache
        if (this.webContextCache) {
          await this.webContextCache.set(
            `recommendations:${topic}`,
            JSON.stringify(recommendations)
          );
          console.log(`[StudyService] Cached recommendations for: ${topic}`);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.warn(`[StudyService] Recommendation generation failed for ${topic}:`, message);
    }
  }

  /**
   * Shutdown: abort in-flight network requests and allow tests to force cleanup.
   */
  async shutdown(): Promise<void> {
    // Abort any pending HTTP requests we started
    for (const c of Array.from(this.inFlightControllers)) {
      try { c.abort(); } catch { /* ignore */ }
      this.inFlightControllers.delete(c);
    }

    // If FlashcardGenerationGraph exposes a stop/close API, call it.
    try {
      if (this.flashcardGraph && typeof (this.flashcardGraph as any).shutdown === 'function') {
        await (this.flashcardGraph as any).shutdown();
      }
    } catch (e) {
      // swallow - shutdown best-effort
    }
  }

}
