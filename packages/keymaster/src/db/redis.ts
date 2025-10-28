import { StoredWallet } from '../types.js';
import { AbstractBase } from './abstract-base.js';
import { Redis } from 'ioredis'

export default class WalletRedis extends AbstractBase {
    private readonly walletKey: string;
    private readonly masterName: string;
    private readonly sentinelPort: number;
    private redis: Redis | null

    public static async create(walletKey: string = 'wallet'): Promise<WalletRedis> {
        const wallet = new WalletRedis(walletKey);
        await wallet.connect();
        return wallet;
    }

    constructor(walletKey: string = 'wallet') {
        super();
        
        // Sentinel configuration from environment variables
        const sentinelHost0 = process.env.KC_REDIS_SENTINEL_HOST_0 || 'redis-sentinel-0.redis-sentinel-headless.demo.svc.cluster.local';
        const sentinelHost1 = process.env.KC_REDIS_SENTINEL_HOST_1 || 'redis-sentinel-1.redis-sentinel-headless.demo.svc.cluster.local';
        const sentinelHost2 = process.env.KC_REDIS_SENTINEL_HOST_2 || 'redis-sentinel-2.redis-sentinel-headless.demo.svc.cluster.local';
        const sentinelPort = parseInt(process.env.KC_REDIS_SENTINEL_PORT || '26379');
        const masterName = process.env.KC_REDIS_MASTER_NAME || 'mymaster';
        const password = process.env.KC_REDIS_PASSWORD;
        const password2 = process.env.KC_REDIS_SENTINEL_PASSWORD;
        
        this.walletKey = walletKey;
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
            sentinelPassword: password2, // If Sentinel also requires auth (not currently configured)
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

        // Optional: Event listeners
        this.redis.on('error', (err) => {
            console.error('Redis connection error:', err);
        });

        this.redis.on('+switch-master', (data) => {
            console.log('Redis master switched:', data);
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

    async disconnect() {
        if (this.redis) {
            await this.redis.quit()
            this.redis = null
        }
    }

    async saveWallet(wallet: StoredWallet, overwrite: boolean = false): Promise<boolean> {
        if (!this.redis) {
            throw new Error('Redis is not connected. Call connect() first or use WalletRedis.create().')
        }

        const exists = await this.redis.exists(this.walletKey);
        if (exists && !overwrite) {
            return false;
        }

        await this.redis.set(this.walletKey, JSON.stringify(wallet));
        return true;
    }

    async loadWallet(): Promise<StoredWallet> {
        if (!this.redis) {
            throw new Error('Redis is not connected. Call connect() first or use WalletRedis.create().')
        }

        const walletJson = await this.redis.get(this.walletKey);
        if (!walletJson) {
            return null;
        }

        return JSON.parse(walletJson);
    }
}