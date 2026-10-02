import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { RAGService } from '../../src/core/services/RAGService.js';
import { UpstashVectorService } from '../../src/core/services/UpstashVectorService.js';
import { Neo4jAdapter } from '../../src/adapters/secondary/graph/Neo4jAdapter.js';

// Mocks
jest.mock('../../src/core/services/UpstashVectorService.js');
jest.mock('../../src/adapters/secondary/graph/Neo4jAdapter.js');
jest.mock('../../src/core/services/LoggerService.js');

describe('RAGService', () => {
    let ragService: RAGService;
    let mockVectorService: jest.Mocked<UpstashVectorService>;
    let mockGraphService: jest.Mocked<Neo4jAdapter>;

    beforeEach(() => {
        mockVectorService = {
            initialize: jest.fn<any>().mockResolvedValue(undefined),
            upsertFlashcards: jest.fn<any>().mockResolvedValue(undefined),
            searchSimilar: jest.fn<any>().mockResolvedValue([]),
            // Add other missing properties as 'unknown' if needed
        } as unknown as jest.Mocked<UpstashVectorService>;

        mockGraphService = {
            initialize: jest.fn<any>().mockResolvedValue(undefined),
            saveGraph: jest.fn<any>().mockResolvedValue(undefined),
            saveGenerationContext: jest.fn<any>().mockResolvedValue(undefined),
            findRelated: jest.fn<any>().mockResolvedValue({ entities: [], relations: [] }),
        } as unknown as jest.Mocked<Neo4jAdapter>;

        ragService = new RAGService(mockVectorService, mockGraphService);
    });

    describe('ingestContent', () => {
        it('should split text and store in vector and graph DBs', async () => {
            const topic = 'Photosynthesis';
            const text = 'Photosynthesis is the process used by plants to convert light energy into chemical energy. It occurs in chloroplasts.';

            await ragService.ingestContent(topic, text);

            // Verify Vector Storage
            expect(mockVectorService.upsertFlashcards).toHaveBeenCalledTimes(1);
            const vectorCalls = mockVectorService.upsertFlashcards.mock.calls[0]![0];
            expect(vectorCalls.length).toBeGreaterThan(0);
            expect(vectorCalls[0]).toHaveProperty('text');
            expect(vectorCalls[0].metadata!).toHaveProperty('topic', topic);

            // Verify Graph Storage
            expect(mockGraphService.saveGenerationContext).toHaveBeenCalledTimes(1);
            expect(mockGraphService.saveGenerationContext).toHaveBeenCalledWith(
                topic,
                expect.arrayContaining([
                    expect.objectContaining({ id: topic, label: 'Topic' })
                ])
            );
        });
    });

    describe('retrieveContext', () => {
        it('should return context string from vector and graph search', async () => {
            mockVectorService.searchSimilar.mockResolvedValue([
                { id: '1', score: 0.9, metadata: { text: 'Chunk 1' } },
                { id: '2', score: 0.8, metadata: { text: 'Chunk 2' } }
            ]);
            mockGraphService.findRelated.mockResolvedValue({
                entities: [{ id: 'id1', label: 'Entity1', properties: { prop: 'val' } }],
                relations: [{ sourceId: 'id1', targetId: 'id2', type: 'REL' }]
            });

            const result = await ragService.retrieveContext('query', 2);

            // Verify Vector Search
            expect(mockVectorService.searchSimilar).toHaveBeenCalledWith('query', 2);
            expect(result).toContain('VECTOR CONTEXT:');
            expect(result).toContain('Chunk 1');

            // Verify Graph Search
            expect(mockGraphService.findRelated).toHaveBeenCalledWith('query', 1);
            expect(result).toContain('GRAPH CONTEXT:');
            expect(result).toContain('RELATED CONCEPTS:');
            expect(result).toContain('Entity1: id1 ({"prop":"val"})');
            expect(result).toContain('RELATIONSHIPS:');
            expect(result).toContain('id1 -[REL]-> id2');
        });
    });
});
