import { StoredWallet, WalletBase } from '../types.js';
import { Redis } from 'ioredis';

export default class WalletRedis implements WalletBase {
    private static instance: WalletRedis | null = null;
    private static instanceCount = 0;
    
    private readonly walletKey: string;
    private readonly masterName: string;
    private readonly sentinelPort: number;
    private readonly sentinelHosts: Array<{host: string, port: number}>;
    private readonly password?: string;
    private readonly standaloneUrl: string;
    private redis: Redis | null = null;
    private readonly instanceId: number;
    private keepaliveInterval: NodeJS.Timeout | null = null;

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

        // Standalone alternative fallback configuration
        this.standaloneUrl = process.env.KC_REDIS_URL || 'redis://localhost:6379';
        
        this.walletKey = walletKey;
        this.masterName = masterName;
        this.sentinelPort = sentinelPort;
        this.password = password;
        
        this.sentinelHosts = [
            { host: sentinelHost0!, port: sentinelPort },
            { host: sentinelHost1!, port: sentinelPort },
            { host: sentinelHost2!, port: sentinelPort }
        ].filter(s => s.host); // Filter out unconfigured or empty hosts

        // DETAILED LOGGING
        console.log('=== Redis Connection Debug ===');
        if (this.sentinelHosts.length > 0) {
            console.log('Mode: Sentinel Cluster');
            console.log('Sentinel Hosts:', this.sentinelHosts.map(s => s.host));
            console.log('Master Name:', masterName);
        } else {
            console.log('Mode: Standalone Fallback');
            console.log('URL:', this.standaloneUrl);
        }
        console.log('Redis Password exists:', !!password);
        console.log('=================================');
    }

    // Getter that dynamically returns the current connection info
    get url(): string {
        if (this.redis && this.redis.options && this.redis.options.sentinels && this.redis.options.sentinels.length > 0) {
            const currentSentinel = this.redis.options.sentinels[0];
            return `sentinel://${currentSentinel.host}:${currentSentinel.port}/${this.masterName}`;
        }
        return this.sentinelHosts.length > 0 
            ? `sentinel://unknown:${this.sentinelPort}/${this.masterName}`
            : this.standaloneUrl;
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

        // Configuration behaviors shared between both connection patterns
        const clientOptions = {
            password: this.password,
            connectTimeout: 30000,
            commandTimeout: 10000,
            keepAlive: 5000,
            noDelay: true,
            enableReadyCheck: true,
            autoResubscribe: false,
            autoResendUnfulfilledCommands: false,
            maxRetriesPerRequest: 3,
            enableOfflineQueue: true,
            lazyConnect: false,
            retryStrategy: (times: number) => {
                if (times > 5) {
                    console.error(`❌ Max redis retry attempts (${times}) reached - stopping retries`);
                    return null;
                }
                const delay = times * 5000;
                console.log(`⏳ Redis retry ${times} in ${delay}ms`);
                return delay;
            },
            reconnectOnError: (err: Error) => {
                console.error('🔴 Redis error, evaluating reconnect:', err.message);
                if (err.message.includes('READONLY')) {
                    return true;
                }
                return false;
            },
        };

        if (this.sentinelHosts.length > 0) {
            this.redis = new Redis({
                ...clientOptions,
                sentinels: this.sentinelHosts,
                name: this.masterName,
                sentinelMaxConnections: 1,
                sentinelCommandTimeout: 10000,
                sentinelRetryStrategy: (times: number) => {
                    if (times > 5) {
                        console.error(`❌ Max sentinel retry attempts (${times}) reached - stopping retries`);
                        return null;
                    }
                    const delay = times * 5000;
                    console.log(`⏳ Sentinel retry ${times} in ${delay}ms`);
                    return delay;
                },
            });
        } else {
            this.redis = new Redis(this.standaloneUrl, clientOptions);
        }

        // Event listeners with detailed logging metrics
        this.redis.on('connect', () => {
            console.log(`✅ [Instance #${this.instanceId}] Connected to Redis`);
        });

        this.redis.on('ready', () => {
            console.log(`🟢 [Instance #${this.instanceId}] Redis connection ready`);
            // Start keepalive pings to prevent idle timeout
            this.startKeepalive();
        });

        this.redis.on('error', (err) => {
            console.error(`❌ [Instance #${this.instanceId}] Redis error:`, err.message);
        });

        this.redis.on('close', () => {
            console.warn(`🔌 [Instance #${this.instanceId}] Redis connection closed`);
            console.trace('Connection close stack trace:');
            this.stopKeepalive();
        });

        this.redis.on('reconnecting', (delay: number) => {
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
            }, 10000);

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
        
        this.stopKeepalive();
        
        if (this.redis) {
            await this.redis.quit();
            this.redis = null;
        }
        if (WalletRedis.instance === this) {
            WalletRedis.instance = null;
        }
    }

    private startKeepalive() {
        this.stopKeepalive();
        
        // Send PING every 30 seconds to bypass proxy and infrastructure idle limits
        this.keepaliveInterval = setInterval(async () => {
            if (this.redis && this.redis.status === 'ready') {
                try {
                    await this.redis.ping();
                    console.log(`💓 [Instance #${this.instanceId}] Keepalive ping successful`);
                } catch (error: any) {
                    console.error(`❌ [Instance #${this.instanceId}] Keepalive ping failed:`, error.message);
                }
            }
        }, 30000);
        
        console.log(`💓 [Instance #${this.instanceId}] Keepalive started (30s interval)`);
    }

    private stopKeepalive() {
        if (this.keepaliveInterval) {
            clearInterval(this.keepaliveInterval);
            this.keepaliveInterval = null;
            console.log(`💔 [Instance #${this.instanceId}] Keepalive stopped`);
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

    async loadWallet(): Promise<StoredWallet | null> {
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