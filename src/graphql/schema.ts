export const typeDefs = `#graphql
  # Scalar types
  scalar JSON
  scalar DateTime

  # Flashcard types
  type Flashcard {
    id: ID!
    front: String!
    back: String!
    topic: String!
    createdAt: DateTime
  }

  type Deck {
    id: ID!
    topic: String!
    cards: [Flashcard!]!
    timestamp: Float!
    userId: String
  }

  # Quiz types
  type QuizQuestion {
    id: ID!
    question: String!
    options: [String!]!
    correctAnswer: String!
    explanation: String
  }

  type Quiz {
    id: ID!
    topic: String!
    questions: [QuizQuestion!]!
    mode: String!
    createdAt: DateTime!
  }

  type QuizResult {
    quizId: ID!
    score: Int!
    total: Int!
    answers: JSON!
    timestamp: Float!
  }

  # Job types for async operations
  type Job {
    id: ID!
    status: JobStatus!
    result: JSON
    error: String
    progress: Int
  }

  enum JobStatus {
    PENDING
    PROCESSING
    COMPLETED
    FAILED
  }

  # Dead Letter Queue Job
  type DLQJob {
    id: ID!
    originalJobId: ID!
    error: String!
    timestamp: Float!
    data: JSON
  }

  type DLQStats {
    count: Int!
    oldestTimestamp: Float
    newestTimestamp: Float
  }

  # Generation types
  type GenerateResult {
    cards: [Flashcard!]
    jobId: ID
    recommendedTopics: [String!]
  }

  # Input types
  input GenerateInput {
    topic: String!
    count: Int = 10
    mode: String = "standard"
    knowledgeSource: String = "ai-web"
    parentTopic: String
    inputType: String
    content: JSON
  }

  input DeckInput {
    topic: String!
    cards: [FlashcardInput!]!
  }

  input FlashcardInput {
    front: String!
    back: String!
    topic: String!
  }

  input QuizInput {
    cards: [FlashcardInput!]
    cardIds: [ID!]
    topic: String
    count: Int = 5
  }

  input QuizAnswerInput {
    questionId: ID!
    answer: String!
  }

  # Root Query type
  type Query {
    # Flashcards & Decks
    decks: [Deck!]!
    deck(id: ID!): Deck
    flashcards(topic: String): [Flashcard!]!
    
    # Quizzes
    quiz(id: ID!): Quiz
    quizHistory: [QuizResult!]!
    allQuizzes: [Quiz!]!
    
    # Jobs
    job(id: ID!): Job
    queueStats: JSON
    
    # Dead Letter Queue
    dlqStats: DLQStats!
    dlqJobs(limit: Int = 10): [DLQJob!]!
    
    # Health
    health: JSON!
  }

  # Root Mutation type
  type Mutation {
    # Flashcard operations
    generateFlashcards(input: GenerateInput!): GenerateResult!
    createDeck(input: DeckInput!): Deck!
    deleteDeck(id: ID!): Boolean!
    
    # Quiz operations
    createQuiz(input: QuizInput!): Quiz!
    submitQuizAnswer(quizId: ID!, answers: [QuizAnswerInput!]!): QuizResult!
    
    # DLQ operations
    retryDLQJob(dlqJobId: ID!): ID
    purgeDLQ: Int!
  }

  # Subscriptions for real-time updates
  type Subscription {
    """Subscribe to job status updates for async operations"""
    jobUpdated(jobId: ID!): Job!
  }
`;
