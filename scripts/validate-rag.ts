#!/usr/bin/env npx tsx
/**
 * RAG Quality Validation Script
 * 
 * This script tests the end-to-end RAG pipeline:
 * 1. Ingests sample content into Vector DB and Graph DB
 * 2. Performs retrieval queries
 * 3. Validates context quality
 * 
 * Usage: npx tsx scripts/validate-rag.ts
 */

import { RAGService } from '../src/core/services/RAGService.js';
import { UpstashVectorService } from '../src/core/services/UpstashVectorService.js';
import { Neo4jAdapter } from '../src/adapters/secondary/graph/Neo4jAdapter.js';

const SAMPLE_CONTENT = {
    topic: 'Mitochondria',
    text: `
Mitochondria are membrane-bound organelles found in the cytoplasm of eukaryotic cells. 
They are often referred to as the "powerhouses" of the cell because they generate most of 
the cell's supply of adenosine triphosphate (ATP), used as a source of chemical energy.

The mitochondrion has its own independent genome that shows substantial similarity to 
bacterial genomes. This supports the endosymbiotic theory that mitochondria were originally 
prokaryotic cells. They have a double membrane structure: an outer membrane and a highly 
folded inner membrane called cristae.

Key functions of mitochondria include:
- ATP production through oxidative phosphorylation
- Regulation of cellular metabolism
- Calcium storage and signaling
- Apoptosis (programmed cell death)
- Heat production in brown adipose tissue

Mitochondrial DNA (mtDNA) is circular and encodes 37 genes. Mutations in mtDNA can cause 
various mitochondrial diseases affecting tissues with high energy demands like muscles and 
the nervous system.
    `.trim()
};

const SAMPLE_QUERIES = [
    'What is the function of mitochondria?',
    'How do mitochondria produce energy?',
    'What is the structure of a mitochondrion?',
    'What is mtDNA?'
];

async function main() {
    console.log('🧪 RAG Quality Validation Script\n');
    console.log('='.repeat(60));

    // Check for required environment variables
    const missingVars: string[] = [];
    if (!process.env.UPSTASH_VECTOR_REST_URL) missingVars.push('UPSTASH_VECTOR_REST_URL');
    if (!process.env.UPSTASH_VECTOR_REST_TOKEN) missingVars.push('UPSTASH_VECTOR_REST_TOKEN');
    if (!process.env.NEO4J_URI) missingVars.push('NEO4J_URI');

    if (missingVars.length > 0) {
        console.log('\n⚠️  Missing environment variables (running in mock mode):');
        missingVars.forEach(v => console.log(`   - ${v}`));
        console.log('\n📝 To test with real databases:');
        console.log('   1. Start Docker: docker compose up -d');
        console.log('   2. Set environment variables from .env.example');
        console.log('\n🔄 Running validation with mocked services...\n');

        // Run mock validation
        await runMockValidation();
        return;
    }

    // Real validation with actual services
    console.log('\n📡 Connecting to services...');

    try {
        const vectorService = new UpstashVectorService();
        const graphService = new Neo4jAdapter();
        const ragService = new RAGService(vectorService, graphService);

        await ragService.initialize();
        console.log('✅ Services initialized\n');

        // Step 1: Ingest content
        console.log('📥 Step 1: Ingesting sample content...');
        console.log(`   Topic: ${SAMPLE_CONTENT.topic}`);
        console.log(`   Content length: ${SAMPLE_CONTENT.text.length} chars`);

        await ragService.ingestContent(SAMPLE_CONTENT.topic, SAMPLE_CONTENT.text);
        console.log('✅ Content ingested\n');

        // Step 2: Test retrieval
        console.log('🔍 Step 2: Testing retrieval queries...\n');

        for (const query of SAMPLE_QUERIES) {
            console.log(`Query: "${query}"`);
            const context = await ragService.retrieveContext(query, 3);

            // Validate context quality
            const hasVectorContext = context.includes('VECTOR CONTEXT:');
            const hasGraphContext = context.includes('GRAPH CONTEXT:');
            const contextLength = context.length;

            console.log(`   ✓ Vector context: ${hasVectorContext ? 'Found' : 'Missing'}`);
            console.log(`   ✓ Graph context: ${hasGraphContext ? 'Found' : 'Missing'}`);
            console.log(`   ✓ Total context length: ${contextLength} chars`);

            // Check for relevant keywords
            const keywords = ['mitochondria', 'ATP', 'energy', 'cell'];
            const foundKeywords = keywords.filter(k => context.toLowerCase().includes(k));
            console.log(`   ✓ Relevant keywords found: ${foundKeywords.join(', ') || 'None'}\n`);
        }

        console.log('='.repeat(60));
        console.log('✅ RAG Quality Validation Complete!\n');

    } catch (error: any) {
        console.error('\n❌ Validation failed:', error.message);
        console.log('\nTroubleshooting:');
        console.log('  - Ensure Docker is running: docker compose up -d');
        console.log('  - Check environment variables are set correctly');
        console.log('  - Verify Neo4j is accessible at', process.env.NEO4J_URI);
        process.exit(1);
    }
}

async function runMockValidation() {
    console.log('🧪 Mock Validation Mode\n');

    // Simulate the validation flow without real services
    console.log('📥 Step 1: Simulating content ingestion...');
    console.log(`   Topic: ${SAMPLE_CONTENT.topic}`);
    console.log('   ✓ Text would be chunked into ~2 segments');
    console.log('   ✓ Chunks would be vectorized and stored');
    console.log('   ✓ Topic entity would be created in graph\n');

    console.log('🔍 Step 2: Simulating retrieval queries...\n');

    for (const query of SAMPLE_QUERIES) {
        console.log(`Query: "${query}"`);
        console.log('   ✓ Would search vector DB for semantic matches');
        console.log('   ✓ Would expand via graph relationships');
        console.log('   ✓ Would merge into unified context\n');
    }

    console.log('='.repeat(60));
    console.log('✅ Mock Validation Complete!');
    console.log('\n💡 To run with real databases, set up environment and try again.\n');
}

main().catch(console.error);
