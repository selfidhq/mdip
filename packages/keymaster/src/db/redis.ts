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
            
            // CRITICAL: Reduce retry aggressiveness
            sentinelRetryStrategy: (times) => {
                if (times > 5) {
                    console.error(`❌ Max sentinel retry attempts (${times}) reached - stopping retries`);
                    return null; // Stop retrying
                }
                // Much longer backoff: 5s, 10s, 15s, 20s, 25s
                const delay = times * 5000;
                console.log(`⏳ Sentinel retry ${times} in ${delay}ms`);
                return delay;
            },
            retryStrategy: (times) => {
                if (times > 5) {
                    console.error(`❌ Max redis retry attempts (${times}) reached - stopping retries`);
                    return null;
                }
                // Much longer backoff: 5s, 10s, 15s, 20s, 25s
                const delay = times * 5000;
                console.log(`⏳ Redis retry ${times} in ${delay}ms`);
                return delay;
            },
            
            // Increase timeouts to handle network instability
            connectTimeout: 30000, // 30 seconds instead of 10
            commandTimeout: 10000, // 10 seconds for commands
            
            // Keep connections alive to detect failures faster
            keepAlive: 10000, // Send keepalive every 10s
            
            // Only try to reconnect once per sentinel
            sentinelMaxConnections: 1,
            
            // Don't auto-reconnect on every error - be more conservative
            enableReadyCheck: true,
            autoResubscribe: false, // Disable auto-resubscribe
            autoResendUnfulfilledCommands: false, // Don't resend automatically
            
            // Add reconnection backoff
            reconnectOnError: (err) => {
                console.error('🔴 Redis error, evaluating reconnect:', err.message);
                // Only reconnect on specific errors
                const targetError = 'READONLY';
                if (err.message.includes(targetError)) {
                    return true; // Reconnect
                }
                return false; // Don't reconnect on other errors
            },
            
            lazyConnect: false,
        });

        // Event listeners with more detailed logging
        this.redis.on('connect', () => {
            console.log(`✅ [Instance #${this.instanceId}] Connected to Redis`);
        });

        this.redis.on('ready', () => {
            console.log(`🟢 [Instance #${this.instanceId}] Redis connection ready`);
        });

        this.redis.on('error', (err) => {
            console.error(`❌ [Instance #${this.instanceId}] Redis error:`, err.message);
        });

        this.redis.on('close', () => {
            console.warn(`🔌 [Instance #${this.instanceId}] Redis connection closed`);
        });

        this.redis.on('reconnecting', (delay) => {
            console.warn(`🔄 [Instance #${this.instanceId}] Redis reconnecting in ${delay}ms`);
        });

        this.redis.on('end', () => {
            console.warn(`🛑 [Instance #${this.instanceId}] Redis connection ended`);
        });

        this.redis.on('+switch-master', (data) => {
            console.log(`🔀 [Instance #${this.instanceId}] Redis master switched:`, data);
        });
        
        this.redis.on('+sentinel', (data) => {
            console.log(`👁️  [Instance #${this.instanceId}] Sentinel event:`, data);
        });

        this.redis.on('-sentinel', (data) => {
            console.warn(`⚠️  [Instance #${this.instanceId}] Sentinel down:`, data);
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
