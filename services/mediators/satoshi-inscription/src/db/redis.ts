import { Redis } from 'ioredis'
import { MediatorDb } from '../types.js';
import AbstractDB from "./abstract-db.js";

export default class JsonRedis extends AbstractDB {
    private readonly dbKey: string;
    private readonly masterName: string;
    private readonly sentinelPort: number;
    private redis: Redis | null = null;

    static async create(registry: string): Promise<JsonRedis> {
        const json = new JsonRedis(registry);
        await json.connect();
        return json;
    }

    constructor(registry: string) {
        super();
        
        // Sentinel configuration from environment variables
        const sentinelHost0 = process.env.KC_REDIS_SENTINEL_HOST_0;
        const sentinelHost1 = process.env.KC_REDIS_SENTINEL_HOST_1;
        const sentinelHost2 = process.env.KC_REDIS_SENTINEL_HOST_2;
        const sentinelPort = parseInt(process.env.KC_REDIS_SENTINEL_PORT || '26379');
        const masterName = process.env.KC_REDIS_MASTER_NAME || 'mymaster';
        const password = process.env.KC_REDIS_PASSWORD;
        //const sentinelPassword = process.env.KC_REDIS_SENTINEL_PASSWORD;

        // DETAILED LOGGING
        console.log('=== Sentinel Connection Debug (JsonRedis) ===');
        console.log('Sentinel Hosts:', [sentinelHost0, sentinelHost1, sentinelHost2]);
        console.log('Redis Password exists:', !!password);
        //console.log('Sentinel Password exists:', !!sentinelPassword);
        console.log('=============================================');
        
        this.dbKey = `sat-mediator/${registry}`;
        this.masterName = masterName;
        this.sentinelPort = sentinelPort;
        
        this.redis = new Redis({
            sentinels: [
                { host: sentinelHost0, port: sentinelPort },
                { host: sentinelHost1, port: sentinelPort },
                { host: sentinelHost2, port: sentinelPort }
            ],
            name: masterName,
            password: password,
            //sentinelPassword: sentinelPassword,
            sentinelRetryStrategy: (times) => {
                // Retry connection to Sentinel
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            retryStrategy: (times) => {
                // Retry connection to Redis master
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            // Automatically reconnect on failover
            enableReadyCheck: true,
            maxRetriesPerRequest: 3,
        });

        // Event listeners for monitoring
        this.redis.on('connect', () => {
            console.log('JsonRedis: Connected to Redis');
        });

        this.redis.on('ready', () => {
            console.log('JsonRedis: Redis connection ready');
        });

        this.redis.on('error', (err) => {
            console.error('JsonRedis: Redis connection error:', err);
            console.error('Error name:', err.name);
            console.error('Error message:', err.message);
        });

        this.redis.on('+switch-master', (data) => {
            console.log('JsonRedis: Redis master switched:', data);
        });
        
        this.redis.on('+sentinel', (data) => {
            console.log('JsonRedis: Sentinel event:', data);
        });
    }

    // Getter that dynamically returns the current connection info
    get url(): string {
        if (this.redis && this.redis.options && this.redis.options.sentinels) {
            const currentSentinel = this.redis.options.sentinels[0];
            return `sentinel://${currentSentinel.host}:${currentSentinel.port}/${this.masterName}`;
        }
        return `sentinel://unknown:${this.sentinelPort}/${this.masterName}`;
    }

    async connect(): Promise<void> {
        // Connection is already established in constructor
        // Just ensure it's ready
        if (this.redis && this.redis.status !== 'ready') {
            await new Promise((resolve, reject) => {
                this.redis!.once('ready', resolve);
                this.redis!.once('error', reject);
            });
        }
    }

    async disconnect(): Promise<void> {
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
    }

    async saveDb(data: MediatorDb): Promise<boolean> {
        if (!this.redis) {
            throw new Error('Redis is not connected. Call connect() first or use JsonRedis.create().');
        }
        await this.redis.set(this.dbKey, JSON.stringify(data));
        return true;
    }

    async loadDb(): Promise<MediatorDb | null> {
        if (!this.redis) {
            throw new Error('Redis is not connected. Call connect() first or use JsonRedis.create().');
        }
        const data = await this.redis.get(this.dbKey);

        if (!data) {
            return null;
        }

        return JSON.parse(data) as MediatorDb;
    }
}