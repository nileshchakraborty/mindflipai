import Anthropic from '@anthropic-ai/sdk';
import type { Flashcard, QuizQuestion } from '../../../core/domain/models.js';
import type { LLMAdapter } from '../../../core/services/AdapterManager.js';
import { randomUUID } from 'node:crypto';

export class AnthropicAdapter implements LLMAdapter {
    readonly name = 'anthropic';
    private client: Anthropic | null = null;
    private model!: string; // Definite assignment - initialized in constructor

    constructor() {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

        if (apiKey) {
            this.client = new Anthropic({ apiKey });
            this.model = model;
        } else {
            console.log('[AnthropicAdapter] No API key configured');
        }
    }

    async isAvailable(): Promise<boolean> {
        return this.client !== null;
    }

    async generateFlashcards(topic: string, count: number): Promise<Flashcard[]> {
        if (!this.client) {
            throw new Error('Anthropic client not configured. Set ANTHROPIC_API_KEY environment variable.');
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

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return this.parseFlashcards(content.text, count, topic);
    }

    async generateFlashcardsFromText(text: string, topic: string, count: number, _options?: { filename?: string }): Promise<Flashcard[]> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
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

✅ CORRECT EXAMPLE:
Q: "What is the purpose of the 'with' statement when working with files?"
A: "The 'with' statement ensures files are properly closed after use, even if errors occur. This prevents resource leaks."

❌ WRONG (DO NOT DO THIS):
Q: "with open(txt_file_path, 'r') as f:"
A: "for line in f: if ':' in line: question_list.append(line.rstrip())"

JSON FORMAT:
- Return ONLY: [{"question": "...", "answer": "..."}]
- No code blocks, no markdown, pure JSON array

Create ${count} flashcards now:`;

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return this.parseFlashcards(content.text, count, topic);
    }

    async generateQuiz(flashcards: Flashcard[], count: number): Promise<QuizQuestion[]> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
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

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return this.parseQuizQuestions(content.text, count);
    }

    async generateQuizFromFlashcards(flashcards: Flashcard[], count: number): Promise<QuizQuestion[]> {
        // Alias method required by interface - delegates to generateQuiz
        return this.generateQuiz(flashcards, count);
    }

    async generateAdvancedQuiz(previousResults: any, mode: 'harder' | 'remedial', _context?: string): Promise<QuizQuestion[]> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
        }

        const previousQuestionsText = previousResults?.questions?.map((q: any, i: number) =>
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

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return this.parseQuizQuestions(content.text, 5);
    }

    async generateBriefAnswer(question: string, context: string): Promise<string> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
        }

        const prompt = `Context: ${context}

Question: ${question}

Provide a brief, direct answer (1-2 sentences):`;

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return content.text.trim();
    }

    async generateSubTopics(topic: string): Promise<string[]> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
        }

        const prompt = `Generate 5 advanced sub-topics for deep learning about: ${topic}

Return as JSON array: ["subtopic1", "subtopic2", ...]`;

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return this.parseStringArray(content.text);
    }

    async generateSearchQuery(topic: string, parentTopic?: string): Promise<string> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
        }

        const prompt = parentTopic
            ? `Create a search query to find information about "${topic}" in the context of "${parentTopic}". Return only the query.`
            : `Create a search query to find information about "${topic}". Return only the query.`;

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 128,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return content.text.trim();
    }

    async generateSummary(topic: string): Promise<string> {
        if (!this.client) {
            throw new Error('Anthropic client not configured');
        }

        const prompt = `Provide a brief summary of: ${topic} (2-3 sentences)`;

        const message = await this.client.messages.create({
            model: this.model,
            max_tokens: 256,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = message.content[0];
        if (!content || content.type !== 'text') {
            throw new Error('Unexpected response type from Anthropic');
        }

        return content.text.trim();
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
            console.error('[AnthropicAdapter] Failed to parse flashcards:', error);
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
            console.error('[AnthropicAdapter] Failed to parse quiz questions:', error);
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
            console.error('[AnthropicAdapter] Failed to parse string array:', error);
            return [];
        }
    }
}
