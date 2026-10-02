import { GraphQLClient } from 'graphql-request';

/**
 * GraphQL Service for making GraphQL queries and mutations
 * Uses graphql-request for lightweight client-side GraphQL
 */
class GraphQLService {
  private client: GraphQLClient;
  private endpoint: string;

  constructor(endpoint: string = '/graphql') {
    // Resolve to absolute URL if in browser to prevent "Invalid URL" errors in Request constructor
    if (typeof window !== 'undefined' && endpoint.startsWith('/')) {
      this.endpoint = `${window.location.origin}${endpoint}`;
    } else {
      this.endpoint = endpoint;
    }

    this.client = new GraphQLClient(this.endpoint, {
      headers: this.getHeaders()
    });
  }

  /**
   * Get authorization headers
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    const token = localStorage.getItem('authToken');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const isTestAuth = localStorage.getItem('TEST_AUTH') === 'true';
    if (isTestAuth) {
      headers['x-test-auth'] = 'true';
    }

    return headers;
  }

  /**
   * Update client headers (e.g., after login)
   */
  updateHeaders(): void {
    this.client = new GraphQLClient(this.endpoint, {
      headers: this.getHeaders()
    });
  }

  /**
   * Execute a GraphQL query
   */
  async query<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      return await this.client.request<T>(query, variables);
    } catch (error: unknown) {
      const err = error as { response?: { errors?: { message?: string }[] }; message?: string };
      console.error('GraphQL Query Error:', err);
      throw new Error(err.response?.errors?.[0]?.message || err.message || 'GraphQL query failed');
    }
  }

  /**
   * Execute a GraphQL mutation
   */
  async mutate<T>(mutation: string, variables?: Record<string, unknown>): Promise<T> {
    try {
      return await this.client.request<T>(mutation, variables);
    } catch (error: unknown) {
      const err = error as { response?: { errors?: { message?: string }[] }; message?: string };
      console.error('GraphQL Mutation Error:', err);
      throw new Error(err.response?.errors?.[0]?.message || err.message || 'GraphQL mutation failed');
    }
  }

  /**
   * Health check query
   */
  async healthCheck(): Promise<{ health: { status: string; timestamp: string; service: string } }> {
    const query = `query { health }`;
    return this.query(query);
  }

  // Flashcard/Deck Queries

  /**
   * Get all decks
   */
  async getDecks(): Promise<{
    id: string;
    topic: string;
    cards: { id: string; front: string; back: string; topic: string }[];
    timestamp: string;
  }[]> {
    const query = `
      query {
        decks {
          id
          topic
          cards {
            id
            front
            back
            topic
          }
          timestamp
        }
      }
    `;
    const result = await this.query<{ decks: { id: string; topic: string; cards: { id: string; front: string; back: string; topic: string }[]; timestamp: string }[] }>(query);
    return result.decks;
  }

  /**
   * Get a specific deck by ID
   */
  async getDeck(id: string): Promise<{
    id: string;
    topic: string;
    cards: { id: string; front: string; back: string; topic: string }[];
    timestamp: string;
  } | null> {
    const query = `
      query GetDeck($id: ID!) {
        deck(id: $id) {
          id
          topic
          cards {
            id
            front
            back
            topic
          }
          timestamp
        }
      }
    `;
    const result = await this.query<{ deck: { id: string; topic: string; cards: { id: string; front: string; back: string; topic: string }[]; timestamp: string } | null }>(query, { id });
    return result.deck;
  }

  /**
   * Create a new deck
   */
  async createDeck(input: { topic: string; cards: { id: string; front: string; back: string; topic?: string }[] }): Promise<{
    id: string;
    topic: string;
    cards: { id: string; front: string; back: string; topic: string }[];
    timestamp: string;
  }> {
    const mutation = `
      mutation CreateDeck($input: DeckInput!) {
        createDeck(input: $input) {
          id
          topic
          cards {
            id
            front
            back
            topic
          }
          timestamp
        }
      }
    `;
    const result = await this.mutate<{ createDeck: { id: string; topic: string; cards: { id: string; front: string; back: string; topic: string }[]; timestamp: string } }>(mutation, { input });
    return result.createDeck;
  }

  /**
   * Delete a deck
   */
  async deleteDeck(id: string): Promise<boolean> {
    const mutation = `
      mutation DeleteDeck($id: ID!) {
        deleteDeck(id: $id)
      }
    `;
    const result = await this.mutate<{ deleteDeck: boolean }>(mutation, { id });
    return result.deleteDeck;
  }

  // Quiz Queries

  /**
   * Get quiz by ID
   */
  async getQuiz(id: string): Promise<{
    id: string;
    topic: string;
    questions: { id: string; question: string; options: string[]; correctAnswer: string; explanation?: string | null }[];
    mode: string;
    createdAt: string;
  } | null> {
    const query = `
      query GetQuiz($id: ID!) {
        quiz(id: $id) {
          id
          topic
          questions {
            id
            question
            options
            correctAnswer
            explanation
          }
          mode
          createdAt
        }
      }
    `;
    const result = await this.query<{ quiz: { id: string; topic: string; questions: { id: string; question: string; options: string[]; correctAnswer: string; explanation?: string | null }[]; mode: string; createdAt: string } | null }>(query, { id });
    return result.quiz;
  }

  /**
   * Get quiz history
   */
  async getQuizHistory(): Promise<{ quizId: string; score: number; total: number; timestamp: string }[]> {
    const query = `
      query {
        quizHistory {
          quizId
          score
          total
          timestamp
        }
      }
    `;
    const result = await this.query<{ quizHistory: { quizId: string; score: number; total: number; timestamp: string }[] }>(query);
    return result.quizHistory;
  }

  /**
   * Get all quizzes
   */
  async getAllQuizzes(): Promise<{ id: string; topic: string; questionCount: number; source: string; createdAt: string }[]> {
    const query = `
      query {
        allQuizzes {
          id
          topic
          questions {
            id
          }
          createdAt
        }
      }
    `;
    const result = await this.query<{ allQuizzes: { id: string; topic: string; questionCount: number; source: string; createdAt: string }[] }>(query);
    return result.allQuizzes;
  }

  /**
   * Create a quiz
   */
  async createQuiz(input: { topic?: string; cards?: { id: string; front: string; back: string; topic?: string }[]; cardIds?: string[]; count?: number }): Promise<{ id: string; topic: string; questionCount: number; source: string; createdAt: string }> {
    const mutation = `
      mutation CreateQuiz($input: QuizInput!) {
        createQuiz(input: $input) {
          id
          topic
          questions {
            id
            question
            options
            correctAnswer
          }
        }
      }
    `;
    const result = await this.mutate<{ createQuiz: { id: string; topic: string; questionCount: number; source: string; createdAt: string } }>(mutation, { input });
    return result.createQuiz;
  }

  /**
   * Submit quiz answers
   */
  async submitQuizAnswers(quizId: string, answers: { questionId: string; answer: string }[]): Promise<{ score: number; total: number; percentage: number; attemptId?: string }> {
    const mutation = `
      mutation SubmitQuizAnswer($quizId: ID!, $answers: [QuizAnswerInput!]!) {
        submitQuizAnswer(quizId: $quizId, answers: $answers) {
          quizId
          score
          total
          timestamp
        }
      }
    `;
    const result = await this.mutate<{ submitQuizAnswer: { score: number; total: number; percentage: number; attemptId?: string } }>(mutation, { quizId, answers });
    return result.submitQuizAnswer;
  }

  // Flashcard Generation

  /**
   * Generate flashcards
   */
  async generateFlashcards(input: {
    topic: string;
    count?: number;
    mode?: string;
    knowledgeSource?: string;
    parentTopic?: string;
    inputType?: string;
    content?: any;
  }): Promise<{ cards: { id: string; front: string; back: string; topic: string }[] }> {
    const mutation = `
      mutation GenerateFlashcards($input: GenerateInput!) {
        generateFlashcards(input: $input) {
          cards {
            id
            front
            back
            topic
          }
          jobId
          recommendedTopics
        }
      }
    `;
    const result = await this.mutate<{ generateFlashcards: { cards: { id: string; front: string; back: string; topic: string }[] } }>(mutation, { input });
    return result.generateFlashcards;
  }

  // Job Status

  /**
   * Get job status
   */
  async getJobStatus(id: string): Promise<{ id: string; status: string; progress?: number; result?: unknown; error?: string | null } | null> {
    const query = `
      query GetJob($id: ID!) {
        job(id: $id) {
          id
          status
          result
          error
          progress
        }
      }
    `;
    const result = await this.query<{ job: { id: string; status: string; progress?: number; result?: unknown; error?: string | null } | null }>(query, { id });
    return result.job;
  }
}

// Export singleton instance
export const graphqlService = new GraphQLService();
export { GraphQLService };
