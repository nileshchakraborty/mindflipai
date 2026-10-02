import { Queue, Worker, Job } from 'bullmq';
import { Redis } from 'ioredis';
import { LoggerService } from './LoggerService.js';


const logger = new LoggerService();

export interface GenerateJobData {
    topic: string;
    count: number;
    mode?: string;
    knowledgeSource?: string;
    runtime?: string;
    parentTopic?: string;
    userId?: string;
}

// In-memory Mock Job for local testing
class MockJob {
    id: string;
    data: GenerateJobData;
    progress: number = 0;
    returnvalue: any = null;
    failedReason: string | null = null;
    status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' = 'waiting';
    attemptsMade: number = 0;
    opts: any;

    constructor(data: GenerateJobData) {
        this.id = `local-job-${Date.now()}`;
        this.data = data;
        this.opts = { attempts: 3 };
    }

    async updateProgress(progress: number) {
        this.progress = progress;
        return Promise.resolve();
    }

    async getState() {
        return this.status;
    }
}

export class QueueService {
    // Union types to support both BullMQ and Mock implementations
    private generateQueue: Queue | any;
    private deadLetterQueue: Queue | any;
    private connection: Redis | null = null;
    private isLocal: boolean;

    // In-memory storage for local mode
    private localJobs: Map<string, MockJob> = new Map();
    private localProcessor: ((job: any) => Promise<any>) | null = null;

    constructor() {
        this.isLocal = process.env.USE_LOCAL_QUEUE === 'true';

        if (this.isLocal) {
            logger.info('⚠️ Using IN-MEMORY queue (Redis disabled via USE_LOCAL_QUEUE)');
            // Mock queues are just empty objects/maps in this simplified implementation
            // Real logic is handled by the methods below which check this.isLocal
            this.generateQueue = {};
            this.deadLetterQueue = {};
        } else {
            this.connection = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                maxRetriesPerRequest: null,
                lazyConnect: true
            });

            this.connection.on('error', (err) => {
                if ((err as any).code === 'ECONNREFUSED') {
                    logger.warn('Redis connection failed (ECONNREFUSED). Ensure Redis is running or expect in-memory fallback if configured.');
                } else {
                    logger.error('Redis connection error:', err);
                }
            });

            this.generateQueue = new Queue('flashcard-generation', { connection: this.connection });
            this.deadLetterQueue = new Queue('flashcard-generation-dlq', { connection: this.connection });
        }

        logger.info('QueueService initialized');
    }

    async addGenerateJob(data: GenerateJobData): Promise<string> {
        if (this.isLocal) {
            const job = new MockJob(data);
            this.localJobs.set(job.id, job);

            // Process immediately (async) to simulate queue
            setTimeout(async () => {
                if (this.localProcessor) {
                    try {
                        job.status = 'active';
                        const result = await this.localProcessor(job);
                        job.returnvalue = result;
                        job.status = 'completed';
                        job.progress = 100;
                        this.emitLocalEvent('completed', job);
                    } catch (err: any) {
                        job.status = 'failed';
                        job.failedReason = err.message;
                        this.emitLocalEvent('failed', job, err);
                    }
                }
            }, 100);

            logger.info('Job added to in-memory queue', { jobId: job.id, topic: data.topic });
            return job.id;
        }

        const job = await this.generateQueue.add('generate', data, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 2000
            },
            removeOnComplete: {
                age: 3600,
                count: 100
            },
            removeOnFail: false
        });

        logger.info('Job added to queue', { jobId: job.id, topic: data.topic });
        return job.id!;
    }

    async getJobStatus(jobId: string): Promise<any> {
        if (this.isLocal) {
            const job = this.localJobs.get(jobId);
            if (!job) return { status: 'not_found' };

            return {
                status: job.status,
                progress: job.progress,
                result: job.returnvalue,
                error: job.failedReason,
                data: job.data
            };
        }

        const job = await this.generateQueue.getJob(jobId);
        if (!job) {
            return { status: 'not_found' };
        }

        const state = await job.getState();
        const progress = job.progress;
        let returnValue = job.returnvalue;

        // Parse stringified JSON if needed (common with Redis storage in BullMQ)
        if (typeof returnValue === 'string') {
            try {
                returnValue = JSON.parse(returnValue);
            } catch (e) {
                // If parsing fails, keep as string (might be a simple string result)
            }
        }
        const failedReason = job.failedReason;

        return {
            status: state,
            progress,
            result: returnValue,
            error: failedReason,
            data: job.data
        };
    }

    // Helper to simulate worker events for local mode
    private async emitLocalEvent(event: string, job: MockJob, err?: any) {
        // We replicate the logic from initWorker handlers here for local mode
        try {
            const { pubsub } = await import('../../graphql/resolvers/job.resolvers.js');

            if (event === 'completed') {
                logger.info('Job completed (local)', { jobId: job.id, topic: job.data.topic });
                await pubsub.publish(`JOB_UPDATED_${job.id}`, {
                    jobUpdated: {
                        id: job.id,
                        status: 'COMPLETED',
                        result: job.returnvalue,
                        progress: 100
                    }
                });
            } else if (event === 'failed') {
                logger.error('Job failed (local)', { jobId: job.id, error: err?.message });
                await pubsub.publish(`JOB_UPDATED_${job.id}`, {
                    jobUpdated: {
                        id: job.id,
                        status: 'FAILED',
                        error: err?.message,
                        progress: job.progress
                    }
                });
            }
        } catch (error) {
            logger.error(`Failed to publish local job event ${event}`, { error });
        }
    }

    initWorker(processor: (job: Job<GenerateJobData> | any) => Promise<any>) {
        if (this.isLocal) {
            this.localProcessor = processor;
            logger.info('Worker initialized for in-memory queue');
            return null; // No actual BullMQ worker
        }

        const worker = new Worker('flashcard-generation', processor, { connection: this.connection! });

        worker.on('completed', async (job) => {
            const processedOn = job.processedOn || job.timestamp;
            const finishedOn = job.finishedOn || Date.now();
            const duration = finishedOn - processedOn;
            const waitTime = processedOn - job.timestamp;
            logger.info('Job completed', {
                jobId: job.id,
                topic: job.data.topic,
                durationMs: duration,
                waitMs: waitTime
            });

            try {
                const { pubsub } = await import('../../graphql/resolvers/job.resolvers.js');
                const jobStatus = {
                    id: job.id,
                    status: 'COMPLETED',
                    result: job.returnvalue,
                    progress: 100
                };
                await pubsub.publish(`JOB_UPDATED_${job.id}`, { jobUpdated: jobStatus });
            } catch (error) {
                logger.error('Failed to publish job completion', { error });
            }
        });

        worker.on('failed', async (job, err) => {
            logger.error('Job failed', { jobId: job?.id, error: err.message });

            if (job) {
                try {
                    const { pubsub } = await import('../../graphql/resolvers/job.resolvers.js');
                    const jobStatus = {
                        id: job.id,
                        status: 'FAILED',
                        error: err.message,
                        progress: job.progress || 0
                    };
                    await pubsub.publish(`JOB_UPDATED_${job.id}`, { jobUpdated: jobStatus });
                } catch (error) {
                    logger.error('Failed to publish job failure', { error });
                }

                if (job.attemptsMade >= (job.opts.attempts || 1)) {
                    await this.deadLetterQueue.add('failed-job', {
                        originalJobId: job.id,
                        data: job.data,
                        error: err.message,
                        timestamp: Date.now()
                    });
                    logger.warn('Job moved to Dead Letter Queue', { jobId: job.id });
                }
            }
        });

        worker.on('progress', async (job, progress) => {
            logger.debug('Job progress', { jobId: job.id, progress });

            try {
                const { pubsub } = await import('../../graphql/resolvers/job.resolvers.js');
                const jobStatus = {
                    id: job.id,
                    status: 'PROCESSING',
                    progress: typeof progress === 'number' ? progress : 0
                };
                await pubsub.publish(`JOB_UPDATED_${job.id}`, { jobUpdated: jobStatus });
            } catch (error) {
                logger.error('Failed to publish job progress', { error });
            }
        });

        logger.info('Worker initialized for flashcard-generation queue');
        return worker;
    }

    async getQueueStats() {
        if (this.isLocal) {
            // Simplified stats for local mode
            return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
        }

        const [waiting, active, completed, failed, delayed] = await Promise.all([
            this.generateQueue.getWaitingCount(),
            this.generateQueue.getActiveCount(),
            this.generateQueue.getCompletedCount(),
            this.generateQueue.getFailedCount(),
            this.generateQueue.getDelayedCount()
        ]);

        return { waiting, active, completed, failed, delayed };
    }

    /**
     * GraphQL placeholder methods
     */
    async getStats() {
        return this.getQueueStats();
    }

    async getJob(id: string) {
        return this.getJobStatus(id);
    }

    /**
     * Get Dead Letter Queue statistics
     */
    async getDLQStats(): Promise<{ count: number; oldestTimestamp?: number; newestTimestamp?: number }> {
        if (this.isLocal) {
            return { count: 0 };
        }

        try {
            const jobs = await this.deadLetterQueue.getJobs(['waiting', 'delayed', 'active']);
            if (jobs.length === 0) {
                return { count: 0 };
            }

            const timestamps = jobs.map((j: any) => j.data?.timestamp || j.timestamp).filter(Boolean);
            return {
                count: jobs.length,
                oldestTimestamp: Math.min(...timestamps),
                newestTimestamp: Math.max(...timestamps)
            };
        } catch (error) {
            logger.error('Failed to get DLQ stats', { error });
            return { count: 0 };
        }
    }

    /**
     * Retry a job from the Dead Letter Queue
     * @param dlqJobId The ID of the job in the DLQ
     * @returns The new job ID in the main queue, or null if retry failed
     */
    async retryDLQJob(dlqJobId: string): Promise<string | null> {
        if (this.isLocal) {
            logger.warn('DLQ retry not supported in local mode');
            return null;
        }

        try {
            const dlqJob = await this.deadLetterQueue.getJob(dlqJobId);
            if (!dlqJob) {
                logger.warn('DLQ job not found', { dlqJobId });
                return null;
            }

            // Re-add original job to main queue
            const originalData = dlqJob.data.data as GenerateJobData;
            const newJobId = await this.addGenerateJob(originalData);

            // Remove from DLQ
            await dlqJob.remove();
            logger.info('DLQ job retried', { dlqJobId, newJobId });

            return newJobId;
        } catch (error) {
            logger.error('Failed to retry DLQ job', { dlqJobId, error });
            return null;
        }
    }

    /**
     * Purge all jobs from the Dead Letter Queue
     * @returns Number of jobs purged
     */
    async purgeDLQ(): Promise<number> {
        if (this.isLocal) {
            return 0;
        }

        try {
            const jobs = await this.deadLetterQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
            const count = jobs.length;

            await this.deadLetterQueue.obliterate({ force: true });
            logger.info('DLQ purged', { count });

            return count;
        } catch (error) {
            logger.error('Failed to purge DLQ', { error });
            return 0;
        }
    }

    /**
     * Get jobs from the Dead Letter Queue
     * @param limit Max number of jobs to return
     */
    async getDLQJobs(limit: number = 10): Promise<Array<{ id: string; originalJobId: string; error: string; timestamp: number; data: GenerateJobData }>> {
        if (this.isLocal) {
            return [];
        }

        try {
            const jobs = await this.deadLetterQueue.getJobs(['waiting', 'delayed'], 0, limit - 1);
            return jobs.map((j: any) => ({
                id: j.id,
                originalJobId: j.data.originalJobId,
                error: j.data.error,
                timestamp: j.data.timestamp,
                data: j.data.data
            }));
        } catch (error) {
            logger.error('Failed to get DLQ jobs', { error });
            return [];
        }
    }
}
