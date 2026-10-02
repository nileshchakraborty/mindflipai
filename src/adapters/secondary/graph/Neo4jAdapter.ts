import neo4j, { Driver, Session, ManagedTransaction } from 'neo4j-driver';
import type { GraphEntity, GraphRelation, GraphStoreAdapter } from './GraphStoreAdapter.js';
import { LoggerService } from '../../../core/services/LoggerService.js';

export class Neo4jAdapter implements GraphStoreAdapter {
    private driver: Driver | null = null;
    private logger: LoggerService;

    constructor() {
        this.logger = new LoggerService();
    }

    async initialize(): Promise<void> {
        const uri = process.env.NEO4J_URI;
        const user = process.env.NEO4J_USER;
        const password = process.env.NEO4J_PASSWORD;

        if (!uri || !user || !password) {
            this.logger.warn('Neo4j configuration missing. GraphDB features will be disabled.');
            return;
        }

        try {
            this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
            // Verify connection
            await this.driver.verifyConnectivity();
            this.logger.info('✅ Connected to Neo4j GraphDB');
        } catch (error: any) {
            this.logger.error('Failed to connect to Neo4j', error);
            this.driver = null;
        }
    }

    async close(): Promise<void> {
        if (this.driver) {
            await this.driver.close();
        }
    }

    private getSession(): Session | null {
        if (!this.driver) return null;
        return this.driver.session();
    }

    async saveGraph(entities: GraphEntity[], relations: GraphRelation[]): Promise<void> {
        const session = this.getSession();
        if (!session) return;

        try {
            await session.executeWrite(async (tx: ManagedTransaction) => {
                // 1. Merge Entities
                for (const entity of entities) {
                    await tx.run(
                        `
                        MERGE (e:Entity {id: $id})
                        SET e.label = $label, e += $props
                        `,
                        { id: entity.id, label: entity.label, props: entity.properties }
                    );
                }

                // 2. Merge Relations
                for (const rel of relations) {
                    const safeType = rel.type.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();

                    await tx.run(
                        `
                        MATCH (s:Entity {id: $sourceId})
                        MATCH (t:Entity {id: $targetId})
                        MERGE (s)-[r:${safeType}]->(t)
                        SET r += $props
                        `,
                        {
                            sourceId: rel.sourceId,
                            targetId: rel.targetId,
                            props: rel.properties || {}
                        }
                    );
                }
            });
        } catch (error) {
            this.logger.error('Failed to save graph data', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    async saveGenerationContext(topic: string, entities: GraphEntity[]): Promise<void> {
        const session = this.getSession();
        if (!session) return;

        try {
            // Link Topic to Entities
            await session.executeWrite(async (tx: ManagedTransaction) => {
                await tx.run(`MERGE (t:Topic {id: $topic})`, { topic });

                for (const entity of entities) {
                    await tx.run(
                        `
                        MATCH (t:Topic {id: $topic})
                        MATCH (e:Entity {id: $entityId})
                        MERGE (t)-[:MENTIONS]->(e)
                        `,
                        { topic, entityId: entity.id }
                    );
                }
            });
        } catch (error) {
            this.logger.error('Failed to save generation context', error);
        } finally {
            await session.close();
        }
    }

    async findRelated(concept: string, depth: number = 1): Promise<{ entities: GraphEntity[], relations: GraphRelation[] }> {
        const session = this.getSession();
        if (!session) return { entities: [], relations: [] };

        try {
            // Find neighbors up to depth
            const result = await session.run(
                `
                MATCH (start:Entity {id: $concept})-[r*1..${depth}]-(end:Entity)
                RETURN start, r, end
                LIMIT 50
                `,
                { concept }
            );

            const entities = new Map<string, GraphEntity>();
            const relations: GraphRelation[] = [];

            result.records.forEach(record => {
                const start = record.get('start').properties;
                const end = record.get('end').properties;
                // const paths = record.get('r'); // This is a list of relationships in the path

                entities.set(start.id, { id: start.id, label: start.label || 'Entity', properties: start });
                entities.set(end.id, { id: end.id, label: end.label || 'Entity', properties: end });

                // For simplicity in this basic query, we might just grab direct neighbors if depth=1
                // Handling variable path return in 'r' requires iteration
                const pathRels = record.get('r');
                if (Array.isArray(pathRels)) {
                    pathRels.forEach((rel: any) => {
                        relations.push({
                            sourceId: rel.startNodeElementId,
                            targetId: rel.endNodeElementId,
                            type: rel.type,
                            properties: rel.properties
                        });
                    });
                } else {
                    relations.push({
                        sourceId: (pathRels as any).startNodeElementId,
                        targetId: (pathRels as any).endNodeElementId,
                        type: (pathRels as any).type,
                        properties: (pathRels as any).properties
                    });
                }
            });

            return {
                entities: Array.from(entities.values()),
                relations
            };

        } catch (error) {
            this.logger.error('Failed to find related concepts', error);
            return { entities: [], relations: [] };
        } finally {
            await session.close();
        }
    }

    async findPath(startConcept: string, endConcept: string): Promise<string[]> {
        this.logger.info(`Find path requested for ${startConcept} -> ${endConcept}`);
        // Implementation placeholder
        return [];
    }
}
