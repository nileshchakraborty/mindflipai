export interface GraphEntity {
    id: string;
    label: string;
    properties: Record<string, any>;
}

export interface GraphRelation {
    sourceId: string;
    targetId: string;
    type: string;
    properties?: Record<string, any>;
}

export interface GraphStoreAdapter {
    initialize(): Promise<void>;
    close(): Promise<void>;

    /**
     * Add or merge entities and relationships
     */
    saveGraph(entities: GraphEntity[], relations: GraphRelation[]): Promise<void>;

    /**
     * Store result of a specific study/generation job
     */
    saveGenerationContext(topic: string, entities: GraphEntity[]): Promise<void>;

    /**
     * Find related concepts for a given concept/topic
     * @param concept The central concept
     * @param depth Number of hops (default 1)
     */
    findRelated(concept: string, depth?: number): Promise<{ entities: GraphEntity[], relations: GraphRelation[] }>;

    /**
     * Find path between two concepts
     */
    findPath(startConcept: string, endConcept: string): Promise<string[]>;
}
