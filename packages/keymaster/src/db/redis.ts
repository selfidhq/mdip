import { StoredWallet } from '../types.js';
import { AbstractBase } from './abstract-base.js';
import { Redis } from 'ioredis'

export default class WalletRedis extends AbstractBase {
    private static instance: WalletRedis | null = null;
    private static instanceCount = 0;
    
    private readonly walletKey: string;
    private readonly masterName: string;
    private readonly sentinelPort: number;
    private readonly sentinelHosts: Array<{host: string, port: number}>;
    private readonly password?: string;
    private readonly sentinelPassword?: string;
    private redis: Redis | null = null;
    private readonly instanceId: number;

    public static async create(walletKey: string = 'wallet'): Promise<WalletRedis> {
        // Singleton pattern - reuse existing instance if it exists and is healthy
        if (WalletRedis.instance && WalletRedis.instance.redis?.status === 'ready') {
            console.log(`♻️  Reusing existing WalletRedis instance #${WalletRedis.instance.instanceId}`);
            return WalletRedis.instance;
        }

        // Clean up dead instance if it exists
        if (WalletRedis.instance) {
            console.log(`🧹 Cleaning up dead WalletRedis instance #${WalletRedis.instance.instanceId}`);
            await WalletRedis.instance.disconnect();
        }

        console.log(`🆕 Creating new WalletRedis instance`);
        const wallet = new WalletRedis(walletKey);
        await wallet.connect();
        WalletRedis.instance = wallet;
        return wallet;
    }

    constructor(walletKey: string = 'wallet') {
        super();
        this.instanceId = ++WalletRedis.instanceCount;
        
        console.log(`🔵 Constructing WalletRedis instance #${this.instanceId}`);
        console.log(`📊 Total instances created: ${WalletRedis.instanceCount}`);
        
        // Sentinel configuration from environment variables
        const sentinelHost0 = process.env.KC_REDIS_SENTINEL_HOST_0;
        const sentinelHost1 = process.env.KC_REDIS_SENTINEL_HOST_1;
        const sentinelHost2 = process.env.KC_REDIS_SENTINEL_HOST_2;
        const sentinelPort = parseInt(process.env.KC_REDIS_SENTINEL_PORT || '26379');
        const masterName = process.env.KC_REDIS_MASTER_NAME || 'mymaster';
        const password = process.env.KC_REDIS_PASSWORD;
        const sentinelPassword = process.env.KC_REDIS_SENTINEL_PASSWORD;

        // DETAILED LOGGING
        console.log('=== Sentinel Connection Debug ===');
        console.log('Sentinel Hosts:', [sentinelHost0, sentinelHost1, sentinelHost2]);
        console.log('Redis Password exists:', !!password);
        console.log('Sentinel Password exists:', !!sentinelPassword);
        console.log('=================================');
        
        this.walletKey = walletKey;
        this.masterName = masterName;
        this.sentinelPort = sentinelPort;
        this.password = password;
        this.sentinelPassword = sentinelPassword;
        this.sentinelHosts = [
            { host: sentinelHost0!, port: sentinelPort },
            { host: sentinelHost1!, port: sentinelPort },
            { host: sentinelHost2!, port: sentinelPort }
        ];
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
        console.log(`🟢 connect() called on instance #${this.instanceId}`);
        // Don't create a new connection if already connected
        if (this.redis && this.redis.status === 'ready') {
            console.log('Redis already connected');
            return;
        }

        // Clean up any existing connection
        if (this.redis) {
            await this.disconnect();
        }

        this.redis = new Redis({
            sentinels: this.sentinelHosts,
            name: this.masterName,
            password: this.password,
            sentinelPassword: this.sentinelPassword,
            
            // Reduce aggressive retry behavior to avoid overwhelming Sentinel
            sentinelRetryStrategy: (times) => {
                // Cap retries at 10 attempts
                if (times > 10) {
                    console.error('Max sentinel retry attempts reached');
                    return null; // Stop retrying
                }
                // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
                const delay = Math.min(times * 1000, 30000);
                console.log(`Sentinel retry ${times} in ${delay}ms`);
                return delay;
            },
            retryStrategy: (times) => {
                // Cap retries at 10 attempts  
                if (times > 10) {
                    console.error('Max redis retry attempts reached');
                    return null; // Stop retrying
                }
                // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
                const delay = Math.min(times * 1000, 30000);
                console.log(`Redis retry ${times} in ${delay}ms`);
                return delay;
            },
            
            enableReadyCheck: true,
            maxRetriesPerRequest: 3,
            
            // Add connection timeout
            connectTimeout: 10000,
            
            // Reduce the number of commands sent to Sentinel
            sentinelMaxConnections: 3,
            
            // Enable auto-reconnect but with less aggressive behavior
            autoResubscribe: true,
            autoResendUnfulfilledCommands: true,
            
            // Add keep-alive to maintain stable connections
            keepAlive: 30000,
            
            // Prevent connection pool exhaustion
            lazyConnect: false,
        });

        // Event listeners
        this.redis.on('connect', () => {
            console.log('Connected to Redis');
        });

        this.redis.on('ready', () => {
            console.log('Redis connection ready');
        });

        this.redis.on('error', (err) => {
            console.error('Redis connection error:', err);
            console.error('Error name:', err.name);
            console.error('Error message:', err.message);
        });

        this.redis.on('+switch-master', (data) => {
            console.log('Redis master switched:', data);
        });
        
        this.redis.on('+sentinel', (data) => {
            console.log('Sentinel event:', data);
        });

        // Wait for connection to be ready
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Redis connection timeout'));
            }, 10000); // 10 second timeout

            this.redis!.once('ready', () => {
                clearTimeout(timeout);
                resolve();
            });
            
            this.redis!.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    async disconnect() {
        console.log(`🔴 disconnect() called on instance #${this.instanceId}`);
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
        // Clear singleton reference if this is the singleton instance
        if (WalletRedis.instance === this) {
            WalletRedis.instance = null;
        }
    }

    async saveWallet(wallet: StoredWallet, overwrite: boolean = false): Promise<boolean> {
        if (!this.redis) {
            throw new Error('Redis is not connected. Call connect() first or use WalletRedis.create().');
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
            throw new Error('Redis is not connected. Call connect() first or use WalletRedis.create().');
        }

        const walletJson = await this.redis.get(this.walletKey);
        if (!walletJson) {
            return null;
        }

        return JSON.parse(walletJson);
    }
}