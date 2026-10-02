import { StateGraph, END, START } from "@langchain/langgraph";
import { RAGService } from "../services/RAGService.js";
import { LoggerService } from "../services/LoggerService.js";
import type { Flashcard } from "../domain/models.js";
import type { AIServicePort } from "../ports/interfaces.js";

const logger = new LoggerService();

interface RAGState {
    topic: string;
    count: number;
    context: string;
    flashcards: Flashcard[];
    error?: string;
}

export class RAGWorkflow {
    private graph;

    constructor(
        private ragService: RAGService,
        private aiAdapter: AIServicePort
    ) {
        const workflow = new StateGraph<RAGState>({
            channels: {
                topic: {
                    reducer: (x: string, y: string) => y ?? x,
                    default: () => ""
                },
                count: {
                    reducer: (x: number, y: number) => y ?? x,
                    default: () => 5
                },
                context: {
                    reducer: (x: string, y: string) => y ?? x,
                    default: () => ""
                },
                flashcards: {
                    reducer: (x: Flashcard[], y: Flashcard[]) => y ?? x,
                    default: () => []
                },
                error: {
                    reducer: (x?: string, y?: string) => y ?? x,
                    default: () => undefined
                }
            }
        });

        // 1. Retrieve Context
        workflow.addNode("retrieve", async (state: RAGState) => {
            try {
                logger.info(`RAG Workflow: Retrieving context for "${state.topic}"`);
                const context = await this.ragService.retrieveContext(state.topic, 5);
                return { context };
            } catch (error: any) {
                logger.warn("RAG Workflow: Retrieval failed", error);
                return { error: `Retrieval failed: ${error.message}` };
            }
        });

        // 2. Generate Flashcards
        workflow.addNode("generate", async (state: RAGState) => {
            if (state.error) return { error: state.error };

            try {
                logger.info(`RAG Workflow: Generating flashcards for "${state.topic}" with context length ${state.context.length}`);

                const promptContext = `
                Use the following retrieved context to generate accurate flashcards.
                
                ${state.context}
                `;

                // Use the generateFlashcardsFromText method which handles context-based generation
                const cards = await this.aiAdapter.generateFlashcardsFromText(
                    promptContext,
                    state.topic,
                    state.count
                );

                return { flashcards: cards };
            } catch (error: any) {
                logger.warn("RAG Workflow: Generation failed", error);
                return { error: `Generation failed: ${error.message}` };
            }
        });

        // Edges
        // @ts-ignore - LangGraph strictness
        workflow.addEdge(START, "retrieve");
        // @ts-ignore
        workflow.addEdge("retrieve", "generate");
        // @ts-ignore
        workflow.addEdge("generate", END);

        this.graph = workflow.compile();
    }

    async run(topic: string, count: number): Promise<Flashcard[]> {
        const result = await this.graph.invoke({
            topic,
            count,
            context: "",
            flashcards: [],
        });

        const state = result as unknown as RAGState;

        if (state.error) {
            throw new Error(state.error);
        }

        return state.flashcards;
    }
}
