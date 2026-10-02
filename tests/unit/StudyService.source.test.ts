/**
 * @jest-environment node
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { StudyService } from '../../src/core/services/StudyService.js';
import type { Flashcard } from '../../src/core/domain/models.js';
import fs from 'fs';
import path from 'path';

// Mocks for heavy deps used in StudyService
jest.mock('pdf-parse', () => ({ default: jest.fn<any>().mockResolvedValue({ text: 'pdf text' }) }));
jest.mock('tesseract.js', () => ({ default: { recognize: jest.fn<any>().mockResolvedValue({ data: { text: 'image text' } }) } }));
jest.mock('mammoth', () => ({ default: { extractRawText: jest.fn<any>().mockResolvedValue({ value: 'doc text', messages: [] }) } }));
jest.mock('xlsx', () => ({
  read: jest.fn().mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } }),
  utils: {
    sheet_to_json: jest.fn().mockReturnValue([['Population', 'Data'], ['Value', '123']])
  }
}));

const mockCards: Flashcard[] = [{ id: '1', front: 'Q1', back: 'A1', topic: 'Topic' }];

const mockOllamaAdapter = {
  generateFlashcardsFromText: jest.fn<any>().mockResolvedValue(mockCards),
  generateAdvancedQuiz: jest.fn<any>().mockResolvedValue([{ question: 'q', correctAnswer: 'a' }]),
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

describe('StudyService source tagging & scope', () => {
  let service: StudyService;
  let studyServiceInstance: StudyService;

  beforeEach(() => {
    jest.clearAllMocks();
    studyServiceInstance = new StudyService(
      { ollama: mockOllamaAdapter as any },
      mockSearchAdapter as any,
      mockStorageAdapter as any,
      undefined, // metricsService
      undefined, // webContextCache
      undefined, // ragService
      true // disableAsyncRecommendations
    );
    service = studyServiceInstance;
  });

  it('tags upload-derived flashcards with sourceType upload', async () => {
    const result = await service.processFile(
      Buffer.from('hello world'),
      'file.txt',
      'text/plain',
      'Topic'
    );
    expect(result[0].sourceType).toBe('upload');
    expect(result[0].sourceName).toBe('file.txt');
  });

  it('tags pasted text flashcards with sourceType text', async () => {
    const result = await service.processRawText('some text content', 'Topic');
    expect(result[0].sourceType).toBe('text');
  });

  it('tags URL-derived flashcards with sourceType urls and sourceUrls', async () => {
    const urls = ['https://example.com'];
    jest.spyOn(service as any, 'scrapeMultipleSources').mockResolvedValue('content from url');
    const result = await service.processUrls(urls, 'Topic');
    expect(result[0].sourceType).toBe('urls');
    expect(result[0].sourceUrls).toEqual(urls);
  });

  it('harder quizzes from uploaded/pasted/urls do not fetch external context', async () => {
    const spy = jest.spyOn(service as any, 'getCachedOrFreshWebContext').mockImplementation(() => {
      throw new Error('should not be called');
    });
    const previousResults: any = { topic: 'Scoped', sourceType: 'upload' };
    const res = await service.generateAdvancedQuiz(previousResults, 'harder');
    expect(res).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it('processes XLSX test fixture and tags sourceType upload (integration-style)', async () => {
    const filePath = path.join(process.cwd(), 'tests/unit/test_data/xls/WPP2024_GEN_F01_DEMOGRAPHIC_INDICATORS_COMPACT.xlsx');
    const buffer = fs.readFileSync(filePath);

    // Mock xlsx parsing to return minimal text; rely on adapter call/metadata
    const textExtractor = jest.spyOn(studyServiceInstance as any, 'generateFallbackFlashcardsFromText').mockReturnValue([]);
    const grounder = jest.spyOn(studyServiceInstance as any, 'filterGroundedCards').mockImplementation((_text, cards) => cards);

    const cards = await service.processFile(
      buffer,
      'WPP2024_GEN_F01_DEMOGRAPHIC_INDICATORS_COMPACT.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Demo XLSX Topic'
    );

    expect(cards[0].sourceType).toBe('upload');
    expect(cards[0].sourceName).toContain('WPP2024');
    textExtractor.mockRestore();
    grounder.mockRestore();
  });
});
