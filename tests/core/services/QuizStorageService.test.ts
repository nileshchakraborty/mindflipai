import { QuizStorageService } from '../../../src/core/services/QuizStorageService.js';

describe('QuizStorageService', () => {
    let service: QuizStorageService;

    beforeEach(() => {
        service = new QuizStorageService();
    });

    describe('createQuiz', () => {
        it('should create a quiz from topic', () => {
            const quiz = service.createQuiz({
                topic: 'JavaScript',
                source: 'topic',
                questions: [
                    {
                        question: 'What is a closure?',
                        options: ['A', 'B', 'C', 'D'],
                        correctAnswer: 0
                    }
                ]
            });

            expect(quiz).toBeDefined();
            expect(quiz.id).toBeDefined();
            expect(quiz.topic).toBe('JavaScript');
            expect(quiz.source).toBe('topic');
            expect(quiz.questions).toHaveLength(1);
            expect(quiz.createdAt).toBeInstanceOf(Date);
        });

        it('should create a quiz from flashcards', () => {
            const flashcardIds = ['fc-1', 'fc-2'];
            const quiz = service.createQuiz({
                topic: 'Python',
                source: 'flashcards',
                questions: [
                    {
                        question: 'What is Python?',
                        options: ['Language', 'Snake', 'Framework', 'Library'],
                        correctAnswer: 0
                    }
                ],
                sourceFlashcardIds: flashcardIds
            });

            expect(quiz.sourceFlashcardIds).toEqual(flashcardIds);
            expect(quiz.source).toBe('flashcards');
        });

        it('should assign unique IDs to each quiz', () => {
            const quiz1 = service.createQuiz({
                topic: 'Test1',
                source: 'topic',
                questions: []
            });

            const quiz2 = service.createQuiz({
                topic: 'Test2',
                source: 'topic',
                questions: []
            });

            expect(quiz1.id).not.toBe(quiz2.id);
        });
    });

    describe('getQuiz', () => {
        it('should return a quiz by ID', () => {
            const created = service.createQuiz({
                topic: 'TypeScript',
                source: 'topic',
                questions: []
            });

            const found = service.getQuiz(created.id);
            expect(found).toEqual(created);
        });

        it('should return undefined for non-existent quiz', () => {
            const found = service.getQuiz('non-existent-id');
            expect(found).toBeUndefined();
        });
    });

    describe('getAllQuizzes', () => {
        it('should return all quizzes', () => {
            service.createQuiz({ topic: 'Quiz1', source: 'topic', questions: [] });
            service.createQuiz({ topic: 'Quiz2', source: 'flashcards', questions: [] });

            const all = service.getAllQuizzes();
            expect(all).toHaveLength(2);
        });

        it('should return empty array when no quizzes exist', () => {
            const all = service.getAllQuizzes();
            expect(all).toEqual([]);
        });
    });

    describe('saveAttempt', () => {
        it('should save a quiz attempt', () => {
            const quiz = service.createQuiz({
                topic: 'Test Quiz',
                source: 'topic',
                questions: [
                    { question: 'Q1', options: ['A', 'B'], correctAnswer: 0 },
                    { question: 'Q2', options: ['A', 'B'], correctAnswer: 1 }
                ]
            });

            const attempt = service.saveAttempt(quiz.id, {
                answers: [0, 1],
                score: 2,
                totalQuestions: 2
            });

            expect(attempt).toBeDefined();
            expect(attempt.id).toBeDefined();
            expect(attempt.quizId).toBe(quiz.id);
            expect(attempt.score).toBe(2);
            expect(attempt.totalQuestions).toBe(2);
            expect(attempt.answers).toEqual([0, 1]);
            expect(attempt.completedAt).toBeInstanceOf(Date);
        });

        it('should throw error for non-existent quiz', () => {
            expect(() => {
                service.saveAttempt('non-existent', {
                    answers: [],
                    score: 0,
                    totalQuestions: 0
                });
            }).toThrow('Quiz not found');
        });
    });

    describe('getAttempts', () => {
        it('should return all attempts for a quiz', () => {
            const quiz = service.createQuiz({
                topic: 'Test',
                source: 'topic',
                questions: []
            });

            service.saveAttempt(quiz.id, { answers: [], score: 5, totalQuestions: 10 });
            service.saveAttempt(quiz.id, { answers: [], score: 7, totalQuestions: 10 });

            const attempts = service.getAttempts(quiz.id);
            expect(attempts).toHaveLength(2);
            expect(attempts[0].score).toBe(5);
            expect(attempts[1].score).toBe(7);
        });

        it('should return empty array for quiz with no attempts', () => {
            const quiz = service.createQuiz({
                topic: 'Test',
                source: 'topic',
                questions: []
            });

            const attempts = service.getAttempts(quiz.id);
            expect(attempts).toEqual([]);
        });

        it('should return empty array for non-existent quiz', () => {
            const attempts = service.getAttempts('non-existent');
            expect(attempts).toEqual([]);
        });
    });

    describe('quiz lifecycle', () => {
        it('should handle complete quiz creation and attempt workflow', () => {
            // Create quiz
            const quiz = service.createQuiz({
                topic: 'Complete Test',
                source: 'topic',
                questions: [
                    { question: 'Q1', options: ['A', 'B', 'C', 'D'], correctAnswer: 2 },
                    { question: 'Q2', options: ['A', 'B', 'C', 'D'], correctAnswer: 1 }
                ]
            });

            // Verify quiz created
            expect(service.getQuiz(quiz.id)).toEqual(quiz);

            // Submit attempt
            const attempt = service.saveAttempt(quiz.id, {
                answers: [2, 0], // Got first correct, second wrong
                score: 1,
                totalQuestions: 2
            });

            // Verify attempt saved
            const attempts = service.getAttempts(quiz.id);
            expect(attempts).toHaveLength(1);
            // The returned attempt and stored attempt share the saved timestamp.
            expect({ ...attempts[0], completedAt: undefined }).toEqual({ ...attempt, completedAt: undefined });
            expect(attempts[0].completedAt).toEqual(attempt.completedAt);

            // Verify in all quizzes list
            const allQuizzes = service.getAllQuizzes();
            expect(allQuizzes.find(q => q.id === quiz.id)).toEqual(quiz);
        });
    });
});
