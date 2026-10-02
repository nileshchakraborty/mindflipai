import type { GraphQLContext } from '../context.js';
import { requireAuth } from '../context.js';
import type { QuizQuestion, Flashcard } from '../../core/domain/models.js';
import type { Quiz as StoredQuiz, QuizQuestion as StoredQuizQuestion } from '../../core/services/QuizStorageService.js';

type CreateQuizInput = {
    topic?: string;
    count?: number;
    cards?: Array<{
        id: string;
        front: string;
        back: string;
        topic?: string;
    }>;
    cardIds?: string[];
};

type SubmitAnswersArgs = {
    quizId: string;
    answers: string[];
};

type QuizWithMode = StoredQuiz & { mode: string };

const withMode = (quiz: StoredQuiz | null): QuizWithMode | null => {
    if (!quiz) return null;
    return {
        ...quiz,
        mode: (quiz as unknown as { mode?: string }).mode ?? 'standard'
    };
};

export const quizResolvers = {
    Query: {
        quiz: async (_: unknown, { id }: { id: string }, context: GraphQLContext) => {
            const quiz = await context.quizStorage.getQuiz(id);
            if (!quiz) {
                throw new Error(`Quiz with id ${id} not found`);
            }
            return withMode(quiz);
        },

        quizHistory: async (_: unknown, __: unknown, context: GraphQLContext) => {
            const history = await context.quizStorage.getHistory();
            return history || [];
        },

        allQuizzes: async (_: unknown, __: unknown, context: GraphQLContext) => {
            const quizzes = await context.quizStorage.getAllQuizzes();
            return (quizzes || []).map(withMode);
        },

        queueStats: async (_: unknown, __: unknown, context: GraphQLContext) => {
            // Require auth for queue stats
            requireAuth(context);

            if (!context.queueService) {
                return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
            }

            const stats = await context.queueService.getStats();
            return stats;
        },

        job: async (_: unknown, { id }: { id: string }, context: GraphQLContext) => {
            // Require auth for job status
            requireAuth(context);

            if (!context.queueService) {
                throw new Error('Queue service not available');
            }

            const job = await context.queueService.getJob(id);
            if (!job) {
                throw new Error(`Job with id ${id} not found`);
            }
            return job;
        },
    },

    Mutation: {
        createQuiz: async (
            _: unknown,
            { input }: { input: CreateQuizInput },
            context: GraphQLContext
        ): Promise<ReturnType<GraphQLContext['quizStorage']['createQuiz']>> => {
            let questions: QuizQuestion[] = [];

            try {
                let cards = input.cards;

                // If cardIds provided, fetch them from storage
                if (input.cardIds && input.cardIds.length > 0 && (!cards || cards.length === 0)) {
                    const storedCards = await context.flashcardStorage.getFlashcardsByIds(input.cardIds);
                    if (storedCards.length > 0) {
                        cards = storedCards.map(c => ({
                            id: c.id,
                            front: c.front,
                            back: c.back,
                            topic: c.topic
                        }));
                    }
                }

                const hasCards = Array.isArray(cards) && cards.length > 0;
                const topic = input.topic ?? (hasCards ? cards![0]?.topic : undefined) ?? 'General Quiz';
                const desiredCount = input.count ?? (hasCards ? Math.min(cards!.length, 10) : 5);

                if (hasCards) {
                    const normalized: Flashcard[] = cards!.map((card) => ({
                        id: card.id,
                        front: card.front,
                        back: card.back,
                        topic: card.topic ?? topic,
                    }));
                    questions = await context.studyService.generateQuiz(topic, desiredCount, normalized);
                } else {
                    questions = await context.studyService.generateQuiz(topic, desiredCount);
                }
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                console.warn('Failed to generate quiz questions:', message);
                // Continue with empty questions or handle error
            }

            const storageQuestions: Array<Omit<StoredQuizQuestion, 'id'>> = questions.map((q) => ({
                question: q.question,
                options: [...q.options],
                correctAnswer: q.correctAnswer,
                explanation: q.explanation
            }));

            const quiz = await context.quizStorage.createQuiz({
                topic: input.topic ?? input.cards?.[0]?.topic ?? 'General Quiz',
                source: input.cards ? 'flashcards' : 'topic',
                questions: storageQuestions
            });

            return withMode(quiz) as QuizWithMode;
        },

        submitQuizAnswer: async (
            _: unknown,
            { quizId, answers }: SubmitAnswersArgs,
            context: GraphQLContext
        ): Promise<ReturnType<GraphQLContext['quizStorage']['submitAnswers']>> => {
            const normalizedAnswers = (answers || []).map((answer, idx) => (
                typeof answer === 'string'
                    ? { questionId: String(idx), answer }
                    : answer
            ));

            const result = await context.quizStorage.submitAnswers(quizId, normalizedAnswers as { questionId: string; answer: string }[]);
            return result;
        },
    },
};
