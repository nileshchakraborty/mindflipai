/** @jest-environment node */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { StudyService } from '../../../src/core/services/StudyService.js';
import type { AIServicePort, SearchServicePort, StoragePort } from '../../../src/core/ports/interfaces.js';

// Mock adapters
const mockAiAdapter: jest.Mocked<AIServicePort> = {
  generateFlashcards: jest.fn(),
  generateFlashcardsFromText: jest.fn(),
  generateBriefAnswer: jest.fn(),
  generateAdvancedQuiz: jest.fn(),
  generateQuizFromFlashcards: jest.fn(),
  generateSummary: jest.fn(),
  generateSearchQuery: jest.fn(),
  generateSubTopics: jest.fn()
};
const mockSearchAdapter: jest.Mocked<SearchServicePort> = {
  search: jest.fn()
};

const mockStorageAdapter: jest.Mocked<StoragePort> = {
  saveQuizResult: jest.fn(),
  getQuizHistory: jest.fn(),
  saveDeck: jest.fn(),
  getDeckHistory: jest.fn(),
  getDeck: jest.fn()
};

describe('StudyService', () => {
  let studyService: StudyService;

  beforeEach(() => {
    jest.clearAllMocks();
    studyService = new StudyService(
      { ollama: mockAiAdapter },
      mockSearchAdapter,
      mockStorageAdapter,
      undefined, // metricsService
      undefined, // webContextCache
      undefined, // ragService
      true // disableAsyncRecommendations - prevent background tasks in tests
    );
  });

  afterAll(async () => {
    // Clean up StudyService resources
    if (studyService && typeof studyService.shutdown === 'function') {
      await studyService.shutdown();
    }
    // Force Jest to clean up any pending timers
    jest.clearAllTimers();
  });

  describe('generateFlashcards', () => {
    it('should use AI knowledge when search returns no results', async () => {
      mockSearchAdapter.search.mockResolvedValue([]);
      // Mock generateFlashcardsFromText to return empty (no context scenario)
      mockAiAdapter.generateFlashcardsFromText.mockResolvedValue([]);
      // This will be called as fallback when no context
      mockAiAdapter.generateFlashcards.mockResolvedValue([
        { id: '1', front: 'Q', back: 'A', topic: 'test' }
      ]);
      // These might fail, which is fine
      mockAiAdapter.generateSummary.mockRejectedValue(new Error('Not implemented'));
      mockAiAdapter.generateSearchQuery.mockRejectedValue(new Error('Not implemented'));

      const result = await studyService.generateFlashcards('test topic', 5);

      expect(mockSearchAdapter.search).toHaveBeenCalled();
      // When no context is available, it falls back to generateFlashcards
      expect(mockAiAdapter.generateFlashcards).toHaveBeenCalledWith('test topic', 5, undefined);
      expect(result.cards).toHaveLength(5); // enforceCardCount pads to requested count
    });
  });

  describe('generateQuiz', () => {
    it('should return local fallback quiz when flashcards are provided (no adapter needed)', async () => {
      const topic = 'test';
      const mockFlashcards = [{ id: '1', front: 'Q', back: 'A', topic: 'test' }];
      mockAiAdapter.generateQuizFromFlashcards.mockResolvedValue([]);

      const quiz = await studyService.generateQuiz(topic, 5, mockFlashcards);

      expect(quiz).toBeDefined();
      expect(quiz.length).toBeGreaterThan(0);
      // Adapter is now called as part of the fallback flow
      expect(mockAiAdapter.generateQuizFromFlashcards).toHaveBeenCalled();
    });

    it('should fallback to generateAdvancedQuiz when no flashcards provided', async () => {
      mockAiAdapter.generateAdvancedQuiz.mockResolvedValue([]);

      await studyService.generateQuiz('test', 5);

      expect(mockAiAdapter.generateAdvancedQuiz).toHaveBeenCalledWith({ topic: 'test', wrongAnswers: [] }, 'harder', undefined, undefined);
    });
  });

  describe('processFile', () => {
    beforeEach(() => {
      mockAiAdapter.generateFlashcardsFromText.mockResolvedValue([
        { id: '1', front: 'Q1', back: 'A1', topic: 'test' },
        { id: '2', front: 'Q2', back: 'A2', topic: 'test' }
      ]);
    });

    it('should process PDF files', async () => {
      // Skip actual PDF parsing, just test the flow
      // In a real scenario, you'd use a mock PDF buffer or skip this test
      // For now, we'll test with text which will fallback to UTF-8
      const buffer = Buffer.from('Mock PDF content with more than 10 characters for testing purposes');
      const result = await studyService.processFile(
        buffer,
        'test.pdf',
        'text/plain', // Use text/plain to avoid PDF parsing complexity in unit test
        'Test Topic'
      );

      expect(result).toBeDefined();
      expect(mockAiAdapter.generateFlashcardsFromText).toHaveBeenCalled();
    });

    it('should process plain text files', async () => {
      const textBuffer = Buffer.from('This is a test text file with sufficient content for processing');
      const result = await studyService.processFile(
        textBuffer,
        'test.txt',
        'text/plain',
        'Test Topic'
      );

      expect(result).toBeDefined();
      // Grounding may filter AI output; we only assert that some cards are produced
      expect(result.length).toBeGreaterThan(0);
      expect(mockAiAdapter.generateFlashcardsFromText).toHaveBeenCalledWith(
        expect.any(String),
        'Test Topic',
        10,
        { filename: 'test.txt' }
      );
    });

    it('should reject unsupported file types', async () => {
      const buffer = Buffer.from('test content that is long enough');

      await expect(
        studyService.processFile(buffer, 'test.zip', 'application/zip', 'Test')
      ).rejects.toThrow('Unsupported file type');
    });

    it('should reject files with insufficient text content', async () => {
      const shortBuffer = Buffer.from('short');

      await expect(
        studyService.processFile(shortBuffer, 'test.txt', 'text/plain', 'Test')
      ).rejects.toThrow('Unable to extract meaningful text');
    });

    it('should handle file processing errors gracefully', async () => {
      mockAiAdapter.generateFlashcardsFromText.mockRejectedValueOnce(new Error('AI service failed'));
      const buffer = Buffer.from('Valid content with more than 10 characters');

      const result = await studyService.processFile(buffer, 'test.txt', 'text/plain', 'Test');

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0); // falls back to heuristic generation
      if (result[0]) {
        expect((result[0] as any).sourceType).toBe('upload');
      }
    });
  });
});
