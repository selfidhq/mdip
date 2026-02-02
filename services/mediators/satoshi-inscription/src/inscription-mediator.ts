import BtcClient, {Block, BlockVerbose, BlockHeader, BlockTxVerbose} from 'bitcoin-core';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { gunzipSync } from 'zlib';
import { BIP32Factory } from 'bip32';
import GatekeeperClient from '@mdip/gatekeeper/client';
import JsonFile from './db/jsonfile.js';
import JsonRedis from './db/redis.js';
import JsonMongo from './db/mongo.js';
import JsonSQLite from './db/sqlite.js';
import config from './config.js';
import { GatekeeperEvent, Operation } from '@mdip/gatekeeper/types';
import Inscription from '@mdip/inscription';
import {
    AccountKeys,
    MediatorDb,
    MediatorDbInterface,
    DiscoveredItem,
    DiscoveredInscribedItem,
    FundInput,
    InscribedKey,
    BlockVerbosity,
} from './types.js';
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
        const sentinelPassword = process.env.KC_REDIS_SENTINEL_PASSWORD;

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

let jsonPersister: MediatorDbInterface;
let importRunning = false;
let exportRunning = false;

async function loadDb(): Promise<MediatorDb> {
    const newDb: MediatorDb = {
        height: 0,
        time: "",
        blockCount: 0,
        blocksScanned: 0,
        blocksPending: 0,
        txnsScanned: 0,
        discovered: [],
    };

    const db = await jsonPersister.loadDb();

    return db || newDb;
}

async function getBlockTxCount(hash: string, header?: BlockHeader): Promise<number> {
    if (typeof header?.nTx === 'number') {
        return header.nTx;
    }

    const block = await btcClient.getBlock(hash, BlockVerbosity.JSON) as Block;
    return Array.isArray(block.tx) ? block.tx.length : 0;
}

async function resolveScanStart(blockCount: number): Promise<number> {
    const db = await loadDb();

    if (!db.hash) {
        return db.height ? db.height + 1 : config.startBlock;
    }

    let header: BlockHeader | undefined;
    try {
        header = await btcClient.getBlockHeader(db.hash) as BlockHeader;
    } catch {
        header = undefined;
    }

    if ((header?.confirmations ?? 0) > 0) {
        return db.height + 1;
    }

    console.log(`Reorg detected at height ${db.height}, rewinding to a confirmed block...`);

    let height = db.height;
    let hash = db.hash;
    let txnsToSubtract = 0;

    while (hash && height >= config.startBlock) {
        let currentHeader: BlockHeader;
        try {
            currentHeader = await btcClient.getBlockHeader(hash) as BlockHeader;
        } catch {
            break;
        }

        if ((currentHeader.confirmations ?? 0) > 0) {
            const resolvedHeight = currentHeader.height ?? height;
            const resolvedTime = currentHeader.time ? new Date(currentHeader.time * 1000).toISOString() : '';
            const resolvedHash = hash;
            const resolvedBlocksPending = blockCount - resolvedHeight;
            const resolvedTxnsToSubtract = txnsToSubtract;
            await jsonPersister.updateDb((data) => {
                data.height = resolvedHeight;
                data.hash = resolvedHash;
                data.time = resolvedTime;
                data.blocksScanned = Math.max(0, resolvedHeight - config.startBlock + 1);
                data.txnsScanned = Math.max(0, data.txnsScanned - resolvedTxnsToSubtract);
                data.blockCount = blockCount;
                data.blocksPending = resolvedBlocksPending;
            });
            return resolvedHeight + 1;
        }

        txnsToSubtract += await getBlockTxCount(hash, currentHeader);

        if (!currentHeader.previousblockhash) {
            break;
        }

        hash = currentHeader.previousblockhash;
        height = (currentHeader.height ?? height) - 1;
    }

    const fallbackHeight = config.startBlock;
    let fallbackHash = '';
    let fallbackTime = '';

    try {
        fallbackHash = await btcClient.getBlockHash(fallbackHeight);
        const fallbackHeader = await btcClient.getBlockHeader(fallbackHash) as BlockHeader;
        fallbackTime = fallbackHeader.time ? new Date(fallbackHeader.time * 1000).toISOString() : '';
    } catch {
        fallbackHash = '';
    }

    await jsonPersister.updateDb((data) => {
        data.height = fallbackHeight;
        if (fallbackHash) {
            data.hash = fallbackHash;
        }
        data.time = fallbackTime;
        data.blocksScanned = 0;
        data.txnsScanned = 0;
        data.blockCount = blockCount;
        data.blocksPending = blockCount - fallbackHeight;
    });

    return fallbackHeight + 1;
}

async function extractOperations(txn: BlockTxVerbose, height: number, index: number, timestamp: string): Promise<void> {
    try {
        const txid = txn.txid;
        const slices: Buffer[] = [];

        txn.vin.forEach((vin, vinIdx) => {
            if (!vin.txinwitness || vin.txinwitness.length < 3) {
                return;
            }

            const tapScriptHex = vin.txinwitness[vin.txinwitness.length - 2];
            const buf = Buffer.from(tapScriptHex, 'hex');
            if (!buf.includes(PROTOCOL_TAG)) {
                return;
            }

            const decomp = bitcoin.script.decompile(buf) || [];
            const tagIdx = decomp.findIndex(
                el => Buffer.isBuffer(el) && (el as Buffer).equals(PROTOCOL_TAG)
            );
            if (tagIdx === -1) {
                return;
            }

            const chunkBufs: Buffer[] = [];
            for (let j = tagIdx + 1; j < decomp.length; j++) {
                const el = decomp[j];
                if (typeof el === 'number') {
                    break;
                }
                chunkBufs.push(el as Buffer);
            }

            if (chunkBufs.length) {
                slices[vinIdx] = Buffer.concat(chunkBufs);
            }
        // DETAILED LOGGING
        console.log('=== Sentinel Connection Debug (JsonRedis) ===');
        console.log('Sentinel Hosts:', [sentinelHost0, sentinelHost1, sentinelHost2]);
        console.log('Redis Password exists:', !!password);
        console.log('Sentinel Password exists:', !!sentinelPassword);
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
            sentinelPassword: sentinelPassword,
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

async function fetchBlock(height: number, blockCount: number): Promise<void> {
    try {
        const blockHash = await btcClient.getBlockHash(height);
        const block = await btcClient.getBlock(blockHash, BlockVerbosity.JSON_TX_DATA) as BlockVerbose;
        const timestamp = new Date(block.time * 1000).toISOString();

        for (let i = 0; i < block.tx.length; i++) {
            const tx = block.tx[i];

            console.log(height, String(i).padStart(4), tx.txid);

            const asm: string | undefined = tx.vout?.[0]?.scriptPubKey?.asm;
            if (!asm || !asm.startsWith('OP_RETURN 4d44495001')) {
                continue;
            }

            await extractOperations(tx, height, i, timestamp);
        }

        await jsonPersister.updateDb((db) => {
            db.height = height;
            db.hash = blockHash;
            db.time = timestamp;
            db.blocksScanned = height - config.startBlock + 1;
            db.txnsScanned += block.tx.length;
            db.blockCount = blockCount;
            db.blocksPending = blockCount - height;
        this.redis.on('ready', () => {
            console.log('JsonRedis: Redis connection ready');
        });

        this.redis.on('error', (err) => {
            console.error('JsonRedis: Redis connection error:', err);
            console.error('Error name:', err.name);
            console.error('Error message:', err.message);
        });

async function scanBlocks(): Promise<void> {
    let blockCount = await btcClient.getBlockCount();

    console.log(`current block height: ${blockCount}`);

    let start = await resolveScanStart(blockCount);

    for (let height = start; height <= blockCount; height++) {
        console.log(`${height}/${blockCount} blocks (${(100 * height / blockCount).toFixed(2)}%)`);
        await fetchBlock(height, blockCount);
        blockCount = await btcClient.getBlockCount();
    }
}

async function importBatch(item: DiscoveredInscribedItem) {
    if (item.imported && item.processed) {
        return;
    }

    const events = item.events;
    if (events.length === 0) {
        return;
    }

    let logObj: DiscoveredItem = {
        height: item.events[0].ordinal![0],
        index: item.events[0].blockchain!.index!,
        time: item.events[0].time,
        txid: item.events[0].blockchain!.txid!,
    };

    let update: DiscoveredInscribedItem = { ...item };

    try {
        update.imported  = await gatekeeper.importBatch(events);
        update.processed = await gatekeeper.processEvents();
        logObj = { ...logObj, imported: update.imported, processed: update.processed };
    } catch (error) {
        update.error = JSON.stringify(`Error importing inscribed batch: ${error}`);
        logObj = { ...logObj, error: update.error };
    }

    console.log(JSON.stringify(logObj, null, 4));
    return update;
}

function sameItem(a: InscribedKey, b: InscribedKey) {
    return a.height === b.height && a.index === b.index && a.txid === b.txid;
}

function keyFromItem(item: DiscoveredInscribedItem): InscribedKey {
    return {
        height: item.events[0]!.blockchain!.height!,
        index: item.events[0]!.blockchain!.index!,
        txid: item.events[0]!.blockchain!.txid!,
    };
}

async function importBatches(): Promise<boolean> {
    const db = await loadDb();

    for (const item of db.discovered ?? []) {
        const update = await importBatch(item);
        if (!update) {
            continue;
        }

        await jsonPersister.updateDb((db) => {
            const list = db.discovered ?? [];
            const idx = list.findIndex(d => sameItem(keyFromItem(d), keyFromItem(update)));
            if (idx >= 0) {
                list[idx] = update;
            }
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