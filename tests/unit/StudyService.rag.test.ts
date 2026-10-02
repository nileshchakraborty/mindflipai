/**
 * Integration tests for StudyService RAG flow
 * Uses real RAGWorkflow but mocks its dependencies
 * @jest-environment node
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { StudyService } from '../../src/core/services/StudyService.js';
import { RAGService } from '../../src/core/services/RAGService.js';
import type { Flashcard } from '../../src/core/domain/models.js';

// Mock dependencies that RAGWorkflow uses
jest.mock('../../src/core/services/RAGService.js');

// Mock heavy deps for file processing
jest.mock('pdf-parse', () => ({ default: jest.fn() }));
jest.mock('tesseract.js', () => ({ default: { recognize: jest.fn() } }));
jest.mock('mammoth', () => ({ default: { extractRawText: jest.fn() } }));
jest.mock('xlsx', () => ({ read: jest.fn(), utils: { sheet_to_json: jest.fn() } }));

const mockCards: Flashcard[] = [
    { id: '1', front: 'What is Physics?', back: 'Study of matter and energy', topic: 'Advanced Physics' }
];

describe('StudyService RAG Integration', () => {
    let service: StudyService;
    let mockRagService: jest.Mocked<RAGService>;

    const mockOllamaAdapter = {
        generateFlashcardsFromText: jest.fn<any>().mockResolvedValue(mockCards),
        generateAdvancedQuiz: jest.fn(),
        generateQuizFromFlashcards: jest.fn(),
        generateFlashcards: jest.fn(),
        generateSummary: jest.fn(),
        generateSubTopics: jest.fn(),
        generateSearchQuery: jest.fn(),
        generateBriefAnswer: jest.fn(),
    };

    const mockSearchAdapter = { search: jest.fn() };
    const mockStorageAdapter = {
        saveQuizResult: jest.fn(),
        getQuizHistory: jest.fn(),
        saveDeck: jest.fn(),
        getDeckHistory: jest.fn()
    };

    beforeEach(() => {
        jest.clearAllMocks();

        // Configure RAGService mock to return context
        mockRagService = {
            initialize: jest.fn<any>().mockResolvedValue(undefined),
            ingestContent: jest.fn<any>().mockResolvedValue(undefined),
            retrieveContext: jest.fn<any>().mockResolvedValue('VECTOR CONTEXT:\nPhysics is the study of matter.\n\nGRAPH CONTEXT:\nNo direct matches.')
        } as unknown as jest.Mocked<RAGService>;

        service = new StudyService(
            { ollama: mockOllamaAdapter as any },
            mockSearchAdapter as any,
            mockStorageAdapter as any,
            undefined, // metricsService
            undefined, // webContextCache
            mockRagService as any, // ragService
            true // disableAsyncRecommendations
        );
    });

    it('should retrieve context and generate flashcards using RAG', async () => {
        const topic = 'Advanced Physics';
        const count = 5;

        // Act
        const result = await service.generateFlashcards(topic, count, 'standard', 'rag', 'ollama');

        // Assert: RAGService.retrieveContext was called (via RAGWorkflow)
        expect(mockRagService.retrieveContext).toHaveBeenCalledWith(topic, expect.any(Number));

        // Assert: AI adapter was called with context (via RAGWorkflow -> generate node)
        expect(mockOllamaAdapter.generateFlashcardsFromText).toHaveBeenCalledWith(
            expect.stringContaining('VECTOR CONTEXT:'),
            topic,
            count
        );

        // Assert: Result contains cards
        expect(result.cards).toBeDefined();
        expect(result.cards.length).toBeGreaterThan(0);
    });

    it('should throw error if RAG service is not initialized', async () => {
        const serviceNoRag = new StudyService(
            { ollama: mockOllamaAdapter as any },
            mockSearchAdapter as any,
            mockStorageAdapter as any,
            undefined,
            undefined,
            undefined, // No RAG service
            true
        );

        await expect(serviceNoRag.generateFlashcards('Topic', 5, 'standard', 'rag', 'ollama'))
            .rejects.toThrow('RAG Service not initialized');
    });
});
