import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { UpstashVectorService } from './UpstashVectorService.js';
import { Neo4jAdapter } from '../../adapters/secondary/graph/Neo4jAdapter.js';
import { LoggerService } from './LoggerService.js';
import type { GraphEntity } from '../../adapters/secondary/graph/GraphStoreAdapter.js';

export class RAGService {
    private vectorService: UpstashVectorService;
    private graphService: Neo4jAdapter;
    private logger: LoggerService;

    constructor(
        vectorService: UpstashVectorService,
        graphService: Neo4jAdapter
    ) {
        this.vectorService = vectorService;
        this.graphService = graphService;
        this.logger = new LoggerService();
    }

    async initialize() {
        await this.vectorService.initialize();
        await this.graphService.initialize();
    }

    /**
     * Process content for RAG: Chunk -> Vector Store -> (Simulated) Graph Extraction -> Graph Store
     */
    async ingestContent(topic: string, text: string, metadata: Record<string, any> = {}): Promise<void> {
        this.logger.info(`Starting RAG ingestion for topic: ${topic}`);

        // 1. Chunking
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 200,
        });
        const chunks = await splitter.createDocuments([text]);

        this.logger.info(`Split content into ${chunks.length} chunks`);

        // 2. Vector Storage
        const vectorItems = chunks.map((chunk, i) => ({
            id: `chunk-${topic}-${Date.now()}-${i}`,
            text: chunk.pageContent,
            metadata: {
                ...metadata,
                topic,
                chunkIndex: i,
                source: 'rag-ingestion'
            }
        }));

        await this.vectorService.upsertFlashcards(vectorItems);

        // 3. Graph Extraction (Placeholder / Simulation)
        // Real implementation would use an LLM here to extract entities
        const entities: GraphEntity[] = [
            { id: topic, label: 'Topic', properties: { name: topic } }
        ];
        // Create relationship to parent topic if exists
        // For now, just store the topic node to ensure connectivity

        await this.graphService.saveGenerationContext(topic, entities);

        this.logger.info(`RAG ingestion complete for: ${topic}`);
    }

    /**
     * Retrieve context using hybrid search (Vector + Graph)
     */
    async retrieveContext(query: string, limit: number = 3): Promise<string> {
        // 1. Vector Search
        const vectorResults = await this.vectorService.searchSimilar(query, limit);
        const vectorContext = vectorResults.map(r => r.metadata?.text || '').join('\n---\n');

        // 2. Graph Search (Context Expansion)
        // We search for the query string directly as a "concept" in the graph
        // In a real system, we'd extract entities from the query first using an LLM
        const related = await this.graphService.findRelated(query, 1);

        let graphContext = '';
        if (related.entities.length > 0) {
            const entityDesc = related.entities.map(e => `${e.label}: ${e.id} (${JSON.stringify(e.properties)})`).join('\n');
            const relDesc = related.relations.map(r => `${r.sourceId} -[${r.type}]-> ${r.targetId}`).join('\n');
            graphContext = `RELATED CONCEPTS:\n${entityDesc}\n\nRELATIONSHIPS:\n${relDesc}`;
        } else {
            graphContext = "No direct knowledge graph matches found.";
        }

        return `VECTOR CONTEXT:\n${vectorContext}\n\nGRAPH CONTEXT:\n${graphContext}`;
    }
}
