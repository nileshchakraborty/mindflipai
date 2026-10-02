import { Index } from '@upstash/vector';
import { logger } from './LoggerService.js';

export interface VectorSearchResult {
    id: string;
    score: number;
    metadata: any;
}

/**
 * Upstash Vector service for semantic search
 * Stores and queries flashcard embeddings
 */
export class UpstashVectorService {
    private index: Index | null = null;
    private isInitialized = false;

    /**
     * Initialize from environment variables
     */
    async initialize(): Promise<void> {
        try {
            // Check for required environment variables first
            const url = process.env.UPSTASH_VECTOR_REST_URL;
            const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

            if (!url || !token) {
                logger.warn('⚠️  Upstash Vector not configured (missing UPSTASH_VECTOR_REST_URL or UPSTASH_VECTOR_REST_TOKEN). Vector search will be unavailable.');
                this.index = null;
                this.isInitialized = false;
                return;
            }

            // Upstash Vector automatically reads from env:
            // UPSTASH_VECTOR_REST_URL
            // UPSTASH_VECTOR_REST_TOKEN
            this.index = new Index();
            this.isInitialized = true;
            logger.info('✅ Upstash Vector initialized successfully');
        } catch (error: any) {
            logger.warn('⚠️  Upstash Vector initialization failed. Vector search will be unavailable.', error.message);
            this.index = null;
            this.isInitialized = false;
        }
    }

    /**
     * Upsert flashcard text for semantic search
     */
    async upsertFlashcard(
        flashcardId: string,
        text: string,
        metadata: Record<string, any>
    ): Promise<void> {
        if (!this.isInitialized || !this.index) return;

        try {
            await this.index.upsert({
                id: flashcardId,
                data: text, // Upstash handles embedding automatically
                metadata
            });

            logger.debug(`Indexed flashcard: ${flashcardId}`);
        } catch (error: any) {
            logger.warn(`Failed to index flashcard ${flashcardId}:`, error.message);
        }
    }

    /**
     * Batch upsert flashcards
     */
    async upsertFlashcards(
        items: Array<{ id: string; text: string; metadata: Record<string, any> }>
    ): Promise<void> {
        if (!this.isInitialized || !this.index) return;
        if (items.length === 0) return;

        try {
            await this.index.upsert(
                items.map(item => ({
                    id: item.id,
                    data: item.text,
                    metadata: item.metadata
                }))
            );
            logger.debug(`Batch indexed ${items.length} flashcards`);
        } catch (error: any) {
            logger.warn(`Failed to batch index flashcards:`, error.message);
        }
    }

    /**
     * Search for similar flashcards using semantic search
     */
    async searchSimilar(
        query: string,
        topK: number = 5
    ): Promise<VectorSearchResult[]> {
        if (!this.isInitialized || !this.index) return [];

        try {
            const results = await this.index.query({
                data: query,
                topK,
                includeVectors: false,
                includeMetadata: true
            });

            return results.map((result: any) => ({
                id: result.id,
                score: result.score,
                metadata: result.metadata || {}
            }));
        } catch (error: any) {
            logger.warn('Vector search failed:', error.message);
            return [];
        }
    }

    /**
     * Delete flashcard from vector index
     */
    async deleteFlashcard(flashcardId: string): Promise<void> {
        if (!this.isInitialized || !this.index) return;

        try {
            await this.index.delete(flashcardId);
            logger.debug(`Deleted flashcard from index: ${flashcardId}`);
        } catch (error: any) {
            logger.warn(`Failed to delete flashcard ${flashcardId}:`, error.message);
        }
    }

    /**
     * Check if service is available
     */
    isAvailable(): boolean {
        return this.isInitialized && this.index !== null;
    }
}
