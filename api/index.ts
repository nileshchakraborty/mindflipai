import dotenv from 'dotenv';
import { OllamaAdapter } from '../src/adapters/secondary/ollama/index.js';
import { WebLLMAdapter } from '../src/adapters/secondary/webllm/index.js';
import { SerperAdapter } from '../src/adapters/secondary/serper/index.js';
import { FileSystemAdapter } from '../src/adapters/secondary/fs/index.js';
import { StudyService } from '../src/core/services/StudyService.js';
import { MetricsService } from '../src/core/services/MetricsService.js';
import { ExpressServer } from '../src/adapters/primary/express/server.js';
import { CacheService } from '../src/core/services/CacheService.js';
import { QueueService } from '../src/core/services/QueueService.js';
import { FlashcardCacheService } from '../src/core/services/FlashcardCacheService.js';
import { WebLLMService } from '../src/core/services/WebLLMService.js';
import { QuizStorageService } from '../src/core/services/QuizStorageService.js';
import { FlashcardStorageService } from '../src/core/services/FlashcardStorageService.js';
import { UpstashVectorService } from '../src/core/services/UpstashVectorService.js';
import { Neo4jAdapter } from '../src/adapters/secondary/graph/Neo4jAdapter.js';
import { RAGService } from '../src/core/services/RAGService.js';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
// @ts-ignore
import swaggerUi from 'swagger-ui-express';
import YAML from 'yamljs';
import path from 'path';

dotenv.config();

let app;

try {
    // Initialize Cache Services (lightweight for serverless)
    const serperCache = new CacheService({ ttlSeconds: 3600, maxEntries: 50 });
    const llmCache = new CacheService({ ttlSeconds: 86400, maxEntries: 100 });
    let swaggerSpec: unknown = {};
    try {
        swaggerSpec = YAML.load(path.join(process.cwd(), 'swagger.yaml'));
    } catch (err) {
        console.warn('Swagger spec not available in serverless env:', (err as Error).message);
        swaggerSpec = { openapi: '3.0.0', info: { title: 'API', version: '1.0.0' } };
    }

    // Initialize Metrics Service
    const metricsService = new MetricsService('/tmp/.metrics'); // Use /tmp for serverless

    // Storage and caches (lightweight, in-memory for serverless)
    const quizStorage = new QuizStorageService();
    const flashcardStorage = new FlashcardStorageService();
    // Only initialize QueueService if Redis is configured (prevents crash on Vercel)
    const queueService = process.env.REDIS_URL ? new QueueService() : null;
    const flashcardCache = new FlashcardCacheService(3600);
    const webllmService = new WebLLMService(llmCache);

    // Initialize AI Adapters
    const aiAdapters = {
        ollama: new OllamaAdapter(llmCache),
        webllm: new WebLLMAdapter(llmCache)
    };

    // Initialize Other Adapters
    const serperAdapter = new SerperAdapter(serperCache);
    const fsAdapter = new FileSystemAdapter();

    // Initialize RAG Service (optional - requires cloud Neo4j Aura + Upstash Vector)
    let ragService: RAGService | undefined = undefined;
    const hasRagConfig = process.env.NEO4J_URI && process.env.UPSTASH_VECTOR_REST_URL;
    if (hasRagConfig) {
        try {
            console.log('🧠 Initializing RAG Service for Vercel...');
            const vectorService = new UpstashVectorService();
            const graphService = new Neo4jAdapter();
            await graphService.initialize();
            ragService = new RAGService(vectorService, graphService);
            await ragService.initialize();
            console.log('✅ RAG Service initialized');
        } catch (ragError: any) {
            console.warn('⚠️ RAG Service initialization failed (optional):', ragError.message);
            ragService = undefined;
        }
    } else {
        console.log('ℹ️ RAG Service disabled (NEO4J_URI or UPSTASH_VECTOR_REST_URL not set)');
    }

    // Initialize Core Service with Multiple Adapters, Metrics, and optional RAG
    const studyService = new StudyService(
        aiAdapters,
        serperAdapter,
        fsAdapter,
        metricsService,
        undefined, // webContextCache
        ragService
    );

    // Initialize Primary Adapter (Server) with Core Service and required services
    const expressServer = new ExpressServer(
        studyService,
        queueService,
        flashcardCache,
        webllmService,
        quizStorage,
        flashcardStorage
    );

    // Setup GraphQL and REST routes (no http listen in serverless)
    await expressServer.setupGraphQL({ skipWebSocket: true });
    expressServer.setupRoutes();

    app = expressServer.getApp().use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

    // Reconfigure Google OAuth callback to be host-relative in serverless
    const deriveCallbackUrl = (req: any) => {
        const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || process.env.VERCEL_URL || 'localhost:3000';
        const proto = req?.headers?.['x-forwarded-proto'] || 'https';
        return `${proto}://${host}/api/auth/google/callback`;
    };

    passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID || 'mock_client_id',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'mock_client_secret',
        callbackURL: '/api/auth/google/callback',
        passReqToCallback: true
    }, (req, _accessToken, _refreshToken, profile, done) => {
        (req as any)._callbackURL = deriveCallbackUrl(req);
        return done(null, profile);
    }));

} catch (error: any) {
    console.error('🔥 CRITICAL: Failed to initialize serverless function:', error);
    // Create a fallback app that returns the error
    const express = (await import('express')).default;
    app = express();
    app.use((_req, res) => {
        res.status(500).json({
            error: 'Serverless Initialization Failed',
            message: error.message,
            stack: error.stack
        });
    });
}

// Export the Express app for Vercel
export default app;
