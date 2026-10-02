import dotenv from 'dotenv';
import { StudyService } from './core/services/StudyService.js';
import { OllamaAdapter } from './adapters/secondary/ollama/index.js';
import { SerperAdapter } from './adapters/secondary/serper/index.js';
import { ExpressServer } from './adapters/primary/express/server.js';
import { LoggerService } from './core/services/LoggerService.js';
import { QueueService } from './core/services/QueueService.js';
import { FlashcardCacheService } from './core/services/FlashcardCacheService.js';
import { WebLLMService } from './core/services/WebLLMService.js';
import { QuizStorageService } from './core/services/QuizStorageService.js';
import { FlashcardStorageService } from './core/services/FlashcardStorageService.js';
import { RedisService } from './core/services/RedisService.js'; // Import RedisService
import { SupabaseService } from './core/services/SupabaseService.js';
import { LocalDbService } from './core/services/LocalDbService.js';
import { UpstashVectorService } from './core/services/UpstashVectorService.js';
import { InMemoryVectorService } from './core/services/InMemoryVectorService.js';
import { BlobStorageService } from './core/services/BlobStorageService.js';
import { CacheService } from './core/services/CacheService.js';
import { WebLLMAdapter } from './adapters/secondary/webllm/index.js';
import { FileSystemAdapter } from './adapters/secondary/fs/index.js';
import { MetricsService } from './core/services/MetricsService.js';
import { MCPClientWrapper } from './adapters/secondary/mcp/MCPClientWrapper.js';
import { HybridOllamaAdapter } from './adapters/secondary/ollama/HybridOllamaAdapter.js';
import { HybridSerperAdapter } from './adapters/secondary/serper/HybridSerperAdapter.js';
import { Neo4jAdapter } from './adapters/secondary/graph/Neo4jAdapter.js';
import { RAGService } from './core/services/RAGService.js';

dotenv.config();

// 1. Initialize Logger
const logger = new LoggerService();

// 2. Initialize Persistence Layer Variables
const isVercelDeployment = process.env.VERCEL === '1' || process.env.VERCEL_ENV !== undefined;
const useLocalDb = true; // process.env.USE_LOCAL_DB === 'true' || process.env.USE_SQLITE === 'true';
const useLocalVector = process.env.USE_LOCAL_VECTOR === 'true';

let redisService: RedisService | undefined = undefined; // Changed from null to undefined for optional param compat
let supabaseService: SupabaseService | LocalDbService | null = null;
let vectorService: UpstashVectorService | InMemoryVectorService | null = null;
let blobService: BlobStorageService | null = null;

// Initialize Redis EARLY if configured, so it can be passed to CacheService
if (process.env.REDIS_URL) {
    logger.info('🔌 Initializing Redis...');
    try {
        redisService = new RedisService();
        await redisService.connect(process.env.REDIS_URL);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.warn('Redis initialization failed, using in-memory cache:', message);
        redisService = undefined;
    }
} else {
    logger.info('REDIS_URL not set, using in-memory cache only');
}

// 3. Initialize Cache Services (with Redis if available)
const serperCache = new CacheService({
    ttlSeconds: parseInt(process.env.CACHE_SERPER_TTL_SECONDS || '3600'),
    maxEntries: parseInt(process.env.CACHE_SERPER_MAX_ENTRIES || '100'),
    redis: redisService
});

const llmCache = new CacheService({
    ttlSeconds: parseInt(process.env.CACHE_LLM_TTL_SECONDS || '86400'),
    maxEntries: parseInt(process.env.CACHE_LLM_MAX_ENTRIES || '500'),
    redis: redisService
});

logger.info('🗂️  Cache initialized:', {
    serper: { ttl: `${process.env.CACHE_SERPER_TTL_SECONDS || '3600'}s`, max: process.env.CACHE_SERPER_MAX_ENTRIES || '100' },
    llm: { ttl: `${process.env.CACHE_LLM_TTL_SECONDS || '86400'}s`, max: process.env.CACHE_LLM_MAX_ENTRIES || '500' },
    redis: !!redisService
});

const queueService = new QueueService();
const flashcardCache = new FlashcardCacheService(3600, redisService); // 1 hour TTL

logger.info('🛡️  Resilience services initialized');
logger.info('🌐 WebLLM service initialized');

// 4. Initialize Remaining Persistence Services
if (isVercelDeployment && !useLocalDb && !useLocalVector) {
    logger.info('🔌 Initializing external services (Vercel deployment detected)...');

    if (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL) {
        supabaseService = new SupabaseService();
        await supabaseService.initialize();
    } else {
        logger.info('Supabase credentials not set, using in-memory storage only');
    }

    if (process.env.UPSTASH_VECTOR_REST_URL) {
        vectorService = new UpstashVectorService();
        await vectorService.initialize();
    } else {
        logger.info('Upstash Vector credentials not set, semantic search disabled');
    }

    if (process.env.BLOB_READ_WRITE_TOKEN) {
        blobService = new BlobStorageService(process.env.BLOB_READ_WRITE_TOKEN);
    } else {
        logger.info('Blob storage token not set, file uploads disabled');
    }

    logger.info('✅ External services initialized');
} else {
    logger.info('💻 Local/dev mode overrides enabled - using lightweight services');

    if (useLocalDb || !isVercelDeployment) {
        supabaseService = new LocalDbService();
        await (supabaseService as LocalDbService).initialize();
    }

    if (useLocalVector || !isVercelDeployment) {
        vectorService = new InMemoryVectorService();
        await vectorService.initialize();
    }
}

// Initialize Domain Services with Persistence
const localDb = (supabaseService instanceof LocalDbService) ? supabaseService : undefined;
const quizStorage = new QuizStorageService(localDb);
const flashcardStorage = new FlashcardStorageService();

logger.info('💾 Storage services initialized');
async function initializeMCP(): Promise<MCPClientWrapper | null> {
    logger.info('🔌 Initializing MCP Server...');
    try {
        const mcpClient = new MCPClientWrapper();
        await mcpClient.connect();
        const healthy = await mcpClient.healthCheck();
        if (!healthy) {
            logger.warn('⚠️  MCP server unhealthy, using direct adapters');
            return null;
        }
        logger.info('✅ MCP client connected and healthy');
        return mcpClient;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.warn('⚠️  MCP initialization failed, using direct adapters:', { error: message });
        return null;
    }
}

const mcpClient = await initializeMCP();
const useMCP = mcpClient !== null;

// Initialize GraphDB
const neo4jAdapter = new Neo4jAdapter();
await neo4jAdapter.initialize();

// Initialize RAG Service
let ragService: RAGService | undefined;
if (vectorService && neo4jAdapter) {
    // Check if we have valid Upstash logic (ignoring type mismatch for InMemory for now, assuming vectorService is sufficient interface)
    ragService = new RAGService(vectorService as any, neo4jAdapter);
    await ragService.initialize();
    logger.info('🧠 RAG Service initialized');
}

const metricsService = new MetricsService('.metrics');
logger.info('📊 Metrics service initialized');

import { MockLLMAdapter } from './adapters/secondary/mock/MockLLMAdapter.js';

// Initialize AI Adapters
const directOllamaAdapter = new OllamaAdapter(llmCache);
const ollamaAdapter = new HybridOllamaAdapter(mcpClient, directOllamaAdapter, useMCP);

const webllmService = new WebLLMService(llmCache);
const webllmAdapter = new WebLLMAdapter(llmCache, webllmService);
webllmAdapter.setWebLLMService(webllmService);

const mockAdapter = new MockLLMAdapter();
const useMockBackend = false;

const aiAdapters = {
    ollama: useMockBackend ? mockAdapter : ollamaAdapter,
    webllm: webllmAdapter,
    mock: mockAdapter
};

logger.info(`🤖 AI adapters initialized (MCP: ${useMCP ? 'enabled' : 'disabled'}): ${Object.keys(aiAdapters).join(', ')}`);

const directSerperAdapter = new SerperAdapter(serperCache);
const serperAdapter = new HybridSerperAdapter(mcpClient, directSerperAdapter, useMCP);
const fsAdapter = new FileSystemAdapter();

// Create web context cache (24hr TTL for web scraping results)
const webContextCache = new CacheService<string>({
    ttlSeconds: 86400,
    maxEntries: 100,
    redis: redisService
});
logger.info('🌐 Web context cache initialized (24hr TTL)');

const studyService = new StudyService(aiAdapters, serperAdapter, fsAdapter, metricsService, webContextCache, ragService);
logger.info('🎓 Study service initialized with cache-first web search');

// Initialize Queue Worker
queueService.initWorker(async (job) => {
    logger.info('Processing job', { jobId: job.id, topic: job.data.topic });

    try {
        await job.updateProgress(5);

        const result = await studyService.generateFlashcards(
            job.data.topic,
            job.data.count,
            (job.data.mode as 'standard' | 'deep-dive') || 'standard',
            (job.data.knowledgeSource as 'ai-only' | 'web-only' | 'ai-web') || 'ai-web',
            (job.data.runtime as 'ollama' | 'webllm') || 'ollama',
            job.data.parentTopic
        );

        await job.updateProgress(70);

        // Store result in cache (NOW AWAITED)
        await flashcardCache.set(
            job.data.topic,
            job.data.count,
            result,
            job.data.mode,
            job.data.knowledgeSource
        );

        if (job.data.mode === 'deep-dive' && result.recommendedTopics && result.recommendedTopics.length > 0) {
            logger.info('Queueing recommended topics', { count: result.recommendedTopics.length });

            for (const recommendedTopic of result.recommendedTopics.slice(0, 3)) {
                try {
                    await queueService.addGenerateJob({
                        topic: recommendedTopic,
                        count: 5,
                        mode: 'standard',
                        knowledgeSource: job.data.knowledgeSource,
                        runtime: job.data.runtime,
                        parentTopic: job.data.topic
                    });
                } catch (err: unknown) {
                    logger.warn('Failed to queue recommended topic', { topic: recommendedTopic });
                }
            }
        }

        await job.updateProgress(100);
        return result;
    } catch (err) {
        try { await job.updateProgress(0); } catch (_) { /* ignore */ }
        throw err;
    }
});

logger.info('⚙️  Queue worker initialized');

// Create Express server with all services
const server = new ExpressServer(
    studyService,
    queueService,
    flashcardCache,
    webllmService,
    quizStorage,
    flashcardStorage,
    redisService || undefined, // Pass undefined if null to match updated constructor if needed, or null if expected
    supabaseService,
    vectorService,
    blobService,
    directOllamaAdapter // Pass adapter for warmup functionality
);

const PORT = parseInt(process.env.PORT || '3000', 10);
await server.start(PORT);

logger.info(`🚀 Server started on port ${PORT}`);
