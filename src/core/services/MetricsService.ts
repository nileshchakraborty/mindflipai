/**
 * MetricsService - Track and accumulate generation metrics
 * Enables analytics, A/B testing, and quality monitoring
 */

import fs from 'fs';
import path from 'path';

export interface GenerationMetric {
    runtime: 'ollama' | 'webllm';
    knowledgeSource: 'ai-only' | 'web-only' | 'ai-web' | 'rag';
    mode: 'standard' | 'deep-dive';
    topic: string;
    cardCount: number;
    duration: number;
    success: boolean;
    errorMessage?: string;
    timestamp: number;
    userId?: string; // Optional for future user tracking
}

export interface MetricFilters {
    runtime?: 'ollama' | 'webllm';
    knowledgeSource?: 'ai-only' | 'web-only' | 'ai-web' | 'rag';
    startDate?: number;
    endDate?: number;
    success?: boolean;
}

export interface MetricsSummary {
    totalGenerations: number;
    successRate: number;
    avgDuration: number;
    byRuntime: Record<string, number>;
    byKnowledgeSource: Record<string, number>;
    popularTopics: Array<{ topic: string; count: number }>;
}

export class MetricsService {
    private metrics: GenerationMetric[] = [];
    private metricsFile: string;
    private maxInMemory: number = 1000;

    constructor(metricsDir: string = '.metrics') {
        // Create metrics directory if it doesn't exist
        const metricsPath = path.isAbsolute(metricsDir)
            ? metricsDir
            : path.join(process.cwd(), metricsDir);

        if (!fs.existsSync(metricsPath)) {
            try {
                fs.mkdirSync(metricsPath, { recursive: true });
            } catch (error) {
                console.warn(`[MetricsService] Failed to create metrics directory at ${metricsPath}, using in-memory only.`, error);
                // Fallback to not using file persistence if mkdir fails
                this.metricsFile = '';
                this.loadRecentMetrics();
                return;
            }
        }

        this.metricsFile = metricsPath ? path.join(metricsPath, 'generations.jsonl') : '';

        // Load recent metrics into memory
        if (this.metricsFile) {
            this.loadRecentMetrics();
        }
    }

    /**
     * Record a generation event
     */
    recordGeneration(metric: Omit<GenerationMetric, 'timestamp'>): void {
        const fullMetric: GenerationMetric = {
            ...metric,
            timestamp: Date.now()
        };

        // Add to in-memory array
        this.metrics.push(fullMetric);

        // Keep only recent metrics in memory
        if (this.metrics.length > this.maxInMemory) {
            this.metrics = this.metrics.slice(-this.maxInMemory);
        }

        // Persist to file (JSONL format - one JSON object per line)
        this.persist(fullMetric);

        // Log summary
        console.log(`📊 Metric recorded: ${metric.runtime}/${metric.knowledgeSource} - ${metric.success ? '✅' : '❌'} (${metric.duration}ms)`);
    }

    /**
     * Get metrics with optional filtering
     */
    getMetrics(filters?: MetricFilters): GenerationMetric[] {
        let result = [...this.metrics];

        if (filters) {
            if (filters.runtime) {
                result = result.filter(m => m.runtime === filters.runtime);
            }
            if (filters.knowledgeSource) {
                result = result.filter(m => m.knowledgeSource === filters.knowledgeSource);
            }
            if (filters.startDate) {
                result = result.filter(m => m.timestamp >= filters.startDate!);
            }
            if (filters.endDate) {
                result = result.filter(m => m.timestamp <= filters.endDate!);
            }
            if (filters.success !== undefined) {
                result = result.filter(m => m.success === filters.success);
            }
        }

        return result;
    }

    /**
     * Get summary statistics
     */
    getSummary(filters?: MetricFilters): MetricsSummary {
        const metrics = this.getMetrics(filters);
        const total = metrics.length;

        if (total === 0) {
            return {
                totalGenerations: 0,
                successRate: 0,
                avgDuration: 0,
                byRuntime: {},
                byKnowledgeSource: {},
                popularTopics: []
            };
        }

        const successful = metrics.filter(m => m.success);
        const successRate = (successful.length / total) * 100;

        const totalDuration = successful.reduce((sum, m) => sum + m.duration, 0);
        const avgDuration = totalDuration / successful.length;

        const byRuntime: Record<string, number> = {};
        const byKnowledgeSource: Record<string, number> = {};
        const topicCounts: Record<string, number> = {};

        metrics.forEach(m => {
            byRuntime[m.runtime] = (byRuntime[m.runtime] || 0) + 1;
            byKnowledgeSource[m.knowledgeSource] = (byKnowledgeSource[m.knowledgeSource] || 0) + 1;
            topicCounts[m.topic] = (topicCounts[m.topic] || 0) + 1;
        });

        const popularTopics = Object.entries(topicCounts)
            .map(([topic, count]) => ({ topic, count }))
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);

        return {
            totalGenerations: total,
            successRate: Math.round(successRate * 100) / 100,
            avgDuration: Math.round(avgDuration),
            byRuntime,
            byKnowledgeSource,
            popularTopics
        };
    }

    /**
     * Persist metric to JSONL file
     */
    private persist(metric: GenerationMetric): void {
        if (!this.metricsFile) return;

        try {
            const line = JSON.stringify(metric) + '\n';
            fs.appendFileSync(this.metricsFile, line, 'utf-8');
        } catch (e) {
            console.error('Failed to persist metric:', e);
        }
    }

    /**
     * Load recent metrics from file into memory
     */
    private loadRecentMetrics(): void {
        try {
            if (!this.metricsFile || !fs.existsSync(this.metricsFile)) {
                return;
            }

            const content = fs.readFileSync(this.metricsFile, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);

            // Load last N metrics
            const recentLines = lines.slice(-this.maxInMemory);
            this.metrics = recentLines.map(line => JSON.parse(line) as GenerationMetric);

            console.log(`📊 Loaded ${this.metrics.length} recent metrics from disk`);
        } catch (e) {
            console.error('Failed to load metrics:', e);
            this.metrics = [];
        }
    }

    /**
     * Export all metrics to JSON file for analysis
     */
    exportToJSON(outputPath: string): void {
        try {
            const allMetrics = this.getAllMetricsFromFile();
            fs.writeFileSync(outputPath, JSON.stringify(allMetrics, null, 2), 'utf-8');
            console.log(`📊 Exported ${allMetrics.length} metrics to ${outputPath}`);
        } catch (e) {
            console.error('Failed to export metrics:', e);
        }
    }

    /**
     * Read all metrics from file (can be large)
     */
    private getAllMetricsFromFile(): GenerationMetric[] {
        try {
            if (!this.metricsFile || !fs.existsSync(this.metricsFile)) {
                return [];
            }

            const content = fs.readFileSync(this.metricsFile, 'utf-8');
            const lines = content.trim().split('\n').filter(l => l.length > 0);
            return lines.map(line => JSON.parse(line) as GenerationMetric);
        } catch (e) {
            console.error('Failed to read all metrics:', e);
            return [];
        }
    }
}
