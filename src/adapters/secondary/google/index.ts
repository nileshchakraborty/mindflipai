import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Flashcard, QuizQuestion } from '../../../core/domain/models.js';
import type { LLMAdapter } from '../../../core/services/AdapterManager.js';
import { randomUUID } from 'node:crypto';

export class GoogleAdapter implements LLMAdapter {
    readonly name = 'google';
    private client: GoogleGenerativeAI | null = null;
    private model!: string; // Definite assignment - initialized in constructor

    constructor() {
        const apiKey = process.env.GOOGLE_API_KEY;
        const model = process.env.GOOGLE_MODEL || 'gemini-1.5-pro';

        if (apiKey) {
            this.client = new GoogleGenerativeAI(apiKey);
            this.model = model;
        } else {
            console.log('[GoogleAdapter] No API key configured');
        }
    }

    async isAvailable(): Promise<boolean> {
        return this.client !== null;
    }

    async generateFlashcards(topic: string, count: number): Promise<Flashcard[]> {
        if (!this.client) {
            throw new Error('Google client not configured. Set GOOGLE_API_KEY environment variable.');
        }

        const prompt = `You are a helpful study assistant creating educational flashcards. You explain concepts clearly.

Create ${count} educational flashcards about: ${topic}

CRITICAL RULES:
1. Ask questions ABOUT the concepts
2. Provide explanatory answers in plain English  
3. NEVER copy code snippets as questions or answers
4. Questions must end with "?"
5. Answers must be 1-3 sentences explaining the concept

JSON FORMAT:
- Return ONLY: [{"question": "...", "answer": "..."}]
- No code blocks, no markdown, pure JSON array

Create ${count} flashcards now:`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        return this.parseFlashcards(text, count, topic);
    }

    async generateFlashcardsFromText(text: string, topic: string, count: number, _options?: { filename?: string }): Promise<Flashcard[]> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const prompt = `You are a helpful study assistant creating educational flashcards. You explain concepts clearly.

Text: ${text}

⚠️ TASK: Create ${count} educational flashcards about: ${topic}

⚠️ CRITICAL RULES:
1. Ask questions ABOUT the concepts in the text
2. Provide explanatory answers in plain English  
3. NEVER copy code snippets as questions or answers
4. Questions must end with "?"
5. Answers must be 1-3 sentences explaining the concept

JSON FORMAT:
- Return ONLY: [{"question": "...", "answer": "..."}]
- No code blocks, no markdown, pure JSON array

Create ${count} flashcards now:`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        return this.parseFlashcards(responseText, count, topic);
    }

    async generateQuiz(flashcards: Flashcard[], count: number): Promise<QuizQuestion[]> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const flashcardsText = flashcards.map((card, i) =>
            `${i + 1}. Q: ${card.front}\n   A: ${card.back}`
        ).join('\n\n');

        const prompt = `Based on these flashcards, create ${count} multiple-choice quiz questions.

Flashcards:
${flashcardsText}

RULES:
1. Create ${count} questions that test understanding of the flashcard concepts
2. Each question must have EXACTLY 4 options
3. All options must be plausible (no obvious wrong answers)
4. Options must be different from each other
5. Include the correct answer index (0-3)

JSON FORMAT:
[{
  "question": "...",
  "options": ["A", "B", "C", "D"],
  "correctAnswer": 2
}]

Return ONLY the JSON array:`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        return this.parseQuizQuestions(text, count);
    }

    async generateQuizFromFlashcards(flashcards: Flashcard[], count: number): Promise<QuizQuestion[]> {
        // Alias method required by interface - delegates to generateQuiz
        return this.generateQuiz(flashcards, count);
    }

    async generateAdvancedQuiz(previousResults: unknown, mode: 'harder' | 'remedial'): Promise<QuizQuestion[]> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const previousQuestionsText = (previousResults as any)?.questions?.map((q: any, i: number) =>
            `${i + 1}. ${q.question}\nCorrect answer: ${q.options[q.correctAnswer]}`
        ).join('\n\n') || '';

        let modeInstructions = '';
        if (mode === 'harder') {
            modeInstructions = 'Create MORE DIFFICULT questions that test deeper understanding.';
        } else {
            modeInstructions = 'Focus on the concepts from questions the user got wrong (remedial review).';
        }

        const prompt = `Generate 5 advanced quiz questions based on:

Previous questions:
${previousQuestionsText}

MODE: ${modeInstructions}

REQUIREMENTS:
- EXACTLY 4 options per question
- All options must be plausible
- Test deeper understanding
- Return JSON: [{"question": "...", "options": ["A","B","C","D"], "correctAnswer": 0-3}]`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        return this.parseQuizQuestions(text, 5);
    }

    async generateBriefAnswer(question: string, context: string): Promise<string> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const prompt = `Context: ${context}

Question: ${question}

Provide a brief, direct answer (1-2 sentences):`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    }

    async generateSubTopics(topic: string): Promise<string[]> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const prompt = `Generate 5 advanced sub-topics for deep learning about: ${topic}

Return as JSON array: ["subtopic1", "subtopic2", ...]`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        return this.parseStringArray(text);
    }

    async generateSearchQuery(topic: string, parentTopic?: string): Promise<string> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const prompt = parentTopic
            ? `Create a search query to find information about "${topic}" in the context of "${parentTopic}". Return only the query.`
            : `Create a search query to find information about "${topic}". Return only the query.`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    }

    async generateSummary(topic: string): Promise<string> {
        if (!this.client) {
            throw new Error('Google client not configured');
        }

        const prompt = `Provide a brief summary of: ${topic} (2-3 sentences)`;

        const model = this.client.getGenerativeModel({ model: this.model });
        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    }

    // Helper methods
    private parseFlashcards(text: string, _expectedCount: number, topic: string): Flashcard[] {
        try {
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (!jsonMatch) throw new Error('No JSON array found');

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) throw new Error('Response is not an array');

            return parsed.map(item => ({
                id: randomUUID(),
                front: item.question || item.q || item.front || '',
                back: item.answer || item.a || item.back || '',
                topic
            }));
        } catch (error) {
            console.error('[GoogleAdapter] Failed to parse flashcards:', error);
            return [];
        }
    }

    private parseQuizQuestions(text: string, _expectedCount: number): QuizQuestion[] {
        try {
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (!jsonMatch) throw new Error('No JSON array found');

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) throw new Error('Response is not an array');

            return parsed.map(item => {
                const correctIdx = item.correctAnswer ?? 0;
                return {
                    id: randomUUID(),
                    question: item.question || '',
                    options: item.options || [],
                    correctAnswer: item.options?.[correctIdx] || item.options?.[0] || ''
                };
            });
        } catch (error) {
            console.error('[GoogleAdapter] Failed to parse quiz questions:', error);
            return [];
        }
    }

    private parseStringArray(text: string): string[] {
        try {
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (!jsonMatch) throw new Error('No JSON array found');

            const parsed = JSON.parse(jsonMatch[0]);
            if (!Array.isArray(parsed)) throw new Error('Response is not an array');

            return parsed.filter(item => typeof item === 'string');
        } catch (error) {
            console.error('[GoogleAdapter] Failed to parse string array:', error);
            return [];
        }
    }
}
