import type { ID, Timestamp, QuizSource } from './types.js';

export interface Flashcard {
  readonly id: ID;
  readonly front: string;  // question
  readonly back: string;   // answer
  readonly topic: string;
  readonly source?: {
    readonly filename?: string;
    readonly page?: number;
    readonly type?: string;
    readonly url?: string;
  };
  // Source tracking for generated flashcards
  readonly sourceType?: 'upload' | 'text' | 'urls' | 'ai';
  readonly sourceName?: string;
  readonly sourceUrls?: readonly string[];
}

export interface QuizQuestion {
  readonly id: ID;
  readonly question: string;
  readonly options: readonly string[];
  readonly correctAnswer: string;
  readonly explanation?: string;
}

export interface QuizResult {
  readonly id: ID;
  readonly timestamp: Timestamp;
  readonly score: number;
  readonly total: number;
  readonly topic: string;
  readonly results: readonly {
    readonly cardId: ID;
    readonly question: string;
    readonly userAnswer: string;
    readonly correctAnswer: string;
    readonly correct: boolean;
  }[];
}

export interface Deck {
  readonly id: ID;
  readonly topic: string;
  readonly timestamp: Timestamp;
  readonly cards: readonly Flashcard[];
  readonly source?: QuizSource;
}
