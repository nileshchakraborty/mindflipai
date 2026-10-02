// Shared domain-level primitive aliases and literal unions

export type ID = string;
export type Timestamp = number;

export type Runtime = 'ollama' | 'webllm';
export type KnowledgeSource = 'ai-only' | 'web-only' | 'ai-web' | 'rag';
export type QuizMode = 'standard' | 'deep-dive';
export type QuizSource = 'flashcards' | 'topic';
export type JobStatus = 'COMPLETED' | 'FAILED' | 'PROCESSING' | 'not_found';
