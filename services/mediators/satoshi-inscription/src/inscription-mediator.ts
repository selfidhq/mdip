import { Redis } from 'ioredis'
import { MediatorDb } from '../types.js';
import AbstractDB from "./abstract-db.js";
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
import { childLogger } from '@mdip/common/logger';
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
const READ_ONLY = config.exportInterval === 0;
const log = childLogger({ service: 'satoshi-inscription-mediator' });

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

        this.redis.on('ready', () => {
            console.log('JsonRedis: Redis connection ready');
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

    log.warn(`Reorg detected at height ${db.height}, rewinding to a confirmed block...`);

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
        });

        const orderedSlices = slices.filter(Boolean);
        if (orderedSlices.length === 0) {
            return;
        }

        const payload = Buffer.concat(orderedSlices);
        if (!payload.length) {
            return;
        }

        let ops: unknown;
        try {
            const marker = payload[0];
            let raw: Buffer;

            if (marker === 0x01) {
                // gzip(JSON)
                raw = gunzipSync(payload.subarray(1));
            } else if (marker === 0x00) {
                // plain JSON (utf8)
                raw = payload.subarray(1);
            } else {
                return;
            }

            ops = JSON.parse(raw.toString('utf8'));
        } catch (e) {
            log.warn(`bad payload at ${txid}:${index} – ${e}`);
            return;
        }

        const isOp = (o: any): o is Operation =>
            o && typeof o === 'object' &&
            ['create', 'update', 'delete'].includes(o.type);

        if (!Array.isArray(ops) || ops.some(o => !isOp(o))) {
            log.warn(`invalid Operation array at ${txid}:${index}`);
            return;
        }

        const events: GatekeeperEvent[] = ops.map((op, i) => ({
            registry : REGISTRY,
            time : timestamp,
            ordinal : [height, index, i],
            operation : op,
            blockchain : {
                height,
                index: index,
                txid,
                batch: '(witness)',
                opidx: i
            }
        }));

        await jsonPersister.updateDb((db) => {
            (db.discovered ??= []).push({ events });
        });
    }
    catch (error) {
        log.error({ error }, 'Error fetching txn');
    }
}

async function fetchBlock(height: number, blockCount: number): Promise<void> {
    try {
        const blockHash = await btcClient.getBlockHash(height);
        const block = await btcClient.getBlock(blockHash, BlockVerbosity.JSON_TX_DATA) as BlockVerbose;
        const timestamp = new Date(block.time * 1000).toISOString();

        for (let i = 0; i < block.tx.length; i++) {
            const tx = block.tx[i];

            log.debug(`${height} ${String(i).padStart(4)} ${tx.txid}`);

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
    } catch (error) {
        log.error({ error }, 'Error fetching block');
    }
}

async function scanBlocks(): Promise<void> {
    let blockCount = await btcClient.getBlockCount();

    log.info(`current block height: ${blockCount}`);

    let start = await resolveScanStart(blockCount);

    for (let height = start; height <= blockCount; height++) {
        log.debug(`${height}/${blockCount} blocks (${(100 * height / blockCount).toFixed(2)}%)`);
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

    log.debug({ logObj }, 'inscription log');
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
        return -1;
    }

    if (db.pendingTaproot.commitTxid) {
        const mined = await checkPendingTxs([db.pendingTaproot.commitTxid]);
        if (mined >= 0) {
            await jsonPersister.updateDb((db) => {
                if (db.pendingTaproot) {
                    db.pendingTaproot.commitTxid = undefined;
                }
            });
        } else {
            log.debug(`pendingTaproot commitTxid ${db.pendingTaproot.commitTxid}`);
        }
    }

    if (db.pendingTaproot.revealTxids?.length) {
        const mined = await checkPendingTxs(db.pendingTaproot.revealTxids);
        if (mined >= 0) {
            await jsonPersister.updateDb((db) => {
                db.pendingTaproot = undefined;
            });
            return false;
        } else {
            log.debug(`pendingTaproot revealTxid ${db.pendingTaproot.revealTxids.at(-1)}`);
        }
    }

    return true;
}

async function replaceByFee(): Promise<boolean> {
    const db = await loadDb();

    if (!db.pendingTaproot?.revealTxids || !(await checkPendingTransactions())) {
        return false;
    }

    if (!config.rbfEnabled) {
        return true;
    }

    const blockCount = await btcClient.getBlockCount();
    if (db.pendingTaproot.blockCount + config.feeConf >= blockCount) {
        return true;
    }

    const { entry: revealEntry, txid: revealTxid } = await getEntryFromMempool(db.pendingTaproot.revealTxids);
    const revealHex = await btcClient.getRawTransaction(revealTxid, 0) as string;
    const commitHex = await extractCommitHex(revealHex);

    const feeResp = await btcClient.estimateSmartFee(config.feeConf, SMART_FEE_MODE);
    const estSatPerVByte = feeResp.feerate ? Math.ceil(feeResp.feerate * 1e5) : config.feeFallback;

    const currFeeSat = Math.round(revealEntry.fees.modified * 1e8);
    const curSatPerVb = Math.floor(currFeeSat / revealEntry.vsize);

    const utxos = await getUnspentOutputs();
    const keys = await getAccountXprvsFromCore();

    log.info('Bump Fees');

    const newRevealHex = await inscription.bumpTransactionFee(
        db.pendingTaproot.hdkeypath,
        utxos,
        curSatPerVb,
        estSatPerVByte,
        keys,
        commitHex,
        revealHex
    );
    const newRevealTxid = await btcClient.sendRawTransaction(newRevealHex);

    await jsonPersister.updateDb((db) => {
        if (db.pendingTaproot?.revealTxids?.length) {
            db.pendingTaproot.revealTxids.push(newRevealTxid);
            db.blockCount = blockCount;
        }
        const data = await this.redis.get(this.dbKey);

        if (!data) {
            return null;
    log.info(`Reveal TXID: ${newRevealTxid}`);

    return true;
}

async function checkExportInterval(): Promise<boolean> {
    const db = await loadDb();

    if (!db.lastExport) {
        await jsonPersister.updateDb((data) => {
            if (!data.lastExport) {
                data.lastExport = new Date().toISOString();
            }
        });
        return true;
    }

    const lastExport = new Date(db.lastExport).getTime();
    const now = Date.now();
    const elapsedMinutes = (now - lastExport) / (60 * 1000);

    return (elapsedMinutes < config.exportInterval);
}

async function fundWalletMessage() {
    const walletInfo = await btcClient.getWalletInfo();

    if (walletInfo.balance < config.feeMax) {
        const address = await btcClient.getNewAddress('funds', 'bech32m');
        log.warn(`Wallet has insufficient funds (${walletInfo.balance}). Send ${config.chain} to ${address}`);
    }
}

async function anchorBatch(): Promise<void> {

    if (await checkExportInterval()) {
        return;
    }

    if (await replaceByFee()) {
        return;
    }

    try {
        await fundWalletMessage();
    } catch (error) {
        log.error({ error }, 'Error generating new address');
        return;
    }

    const queue = await gatekeeper.getQueue(REGISTRY);

    if (queue.length === 0) {
        log.debug(`empty ${REGISTRY} queue`);
        return;
    }

    try {
        const taprootAddr = await btcClient.getNewAddress('', 'bech32m');
        const tapInfo = await btcClient.getAddressInfo(taprootAddr);
        if (!tapInfo.hdkeypath) {
            throw new Error("Taproot information missing hdkeypath");
        }
        const feeResp = await btcClient.estimateSmartFee(config.feeConf, SMART_FEE_MODE);
        const estSatPerVByte = feeResp.feerate ? Math.ceil(feeResp.feerate * 1e5) : config.feeFallback;
        const utxos = await getUnspentOutputs();
        const keys = await getAccountXprvsFromCore();
        const payload = Buffer.from(JSON.stringify(queue), 'utf8');

        const { commitHex, revealHex, batch } = await inscription.createTransactions(
            payload,
            tapInfo.hdkeypath,
            utxos,
            estSatPerVByte,
            keys,
        );

        log.debug({ batch }, 'export batch');

        const commitTxid = await btcClient.sendRawTransaction(commitHex);
        const revealTxid = await btcClient.sendRawTransaction(revealHex);

        log.info(`Commit TXID ${commitTxid}`);
        log.info(`Reveal TXID ${revealTxid}`);

        const ok = await gatekeeper.clearQueue(REGISTRY, batch);

        if (ok) {
            const blockCount = await btcClient.getBlockCount();
            await jsonPersister.updateDb(async (db) => {
                db.pendingTaproot = {
                    commitTxid: commitTxid,
                    revealTxids: [revealTxid],
                    hdkeypath: tapInfo.hdkeypath!,
                    blockCount
                };
                db.lastExport = new Date().toISOString();
            });
        }
    } catch (err) {
        log.error({ error: err }, 'Taproot anchor error');
    }
}

async function importLoop(): Promise<void> {
    if (importRunning) {
        setTimeout(importLoop, config.importInterval * 60 * 1000);
        log.debug(`import loop busy, waiting ${config.importInterval} minute(s)...`);
        return;
    }

    importRunning = true;

    try {
        await scanBlocks();
        await importBatches();
    } catch (error: any) {
        log.error({ error }, 'Error in importLoop');
    } finally {
        importRunning = false;
        log.debug(`import loop waiting ${config.importInterval} minute(s)...`);
        setTimeout(importLoop, config.importInterval * 60 * 1000);
    }
}

async function exportLoop(): Promise<void> {
    if (exportRunning) {
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
        log.debug(`Export loop busy, waiting ${config.exportInterval} minute(s)...`);
        return;
    }

    exportRunning = true;

    try {
        await anchorBatch();
    } catch (error) {
        log.error({ error }, 'Error in exportLoop');
    } finally {
        exportRunning = false;
        log.debug(`export loop waiting ${config.exportInterval} minute(s)...`);
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
    }
}

async function waitForChain() {
    let isReady = false;

    log.info(`Connecting to ${config.chain} node on ${config.host}:${config.port} using wallet '${config.wallet}'`);

    while (!isReady) {
        try {
            const blockchainInfo = await btcClient.getBlockchainInfo();
            log.debug({ blockchainInfo }, 'Blockchain Info');
            isReady = true;
        } catch (error) {
            log.debug(`Waiting for ${config.chain} node...`);
        }

        return JSON.parse(data) as MediatorDb;
    }
}

    if (READ_ONLY) {
        return true;
    }

    try {
        await btcClient.createWallet(config.wallet!);
        log.info(`Wallet '${config.wallet}' created successfully.`);
    } catch (error: any) {
        // If wallet already exists, log a message
        if (error.message.includes("already exists")) {
            log.info(`Wallet '${config.wallet}' already exists.`);
        } else {
            log.error({ error }, 'Error creating wallet');
            return false;
        }
    }

    try {
        const walletInfo = await btcClient.getWalletInfo();
        log.debug({ walletInfo }, 'Wallet Info');
    } catch (error) {
        log.error({ error }, 'Error fetching wallet info');
        return false;
    }

    try {
        await fundWalletMessage();
    } catch (error) {
        log.error({ error }, 'Error generating new address');
        return false;
    }

    return true;
}

async function addBlock(height: number, hash: string, time: number): Promise<void> {
    await gatekeeper.addBlock(REGISTRY, { hash, height, time });
}

async function syncBlocks(): Promise<void> {
    try {
        const latest = await gatekeeper.getBlock(REGISTRY);
        const currentMax = latest ? latest.height : config.startBlock;
        const blockCount = await btcClient.getBlockCount();

        log.info(`current block height: ${blockCount}`);

        for (let height = currentMax; height <= blockCount; height++) {
            const blockHash = await btcClient.getBlockHash(height);
            const block = await btcClient.getBlock(blockHash) as Block;
            log.debug(`${height}/${blockCount} blocks (${(100 * height / blockCount).toFixed(2)}%)`);
            await addBlock(height, blockHash, block.time);
        }
    } catch (error) {
        log.error({ error }, 'Error syncing blocks');
    }
}

async function main() {
    if (!READ_ONLY && !config.nodeID) {
        log.error('inscription-mediator must have a KC_NODE_ID configured');
        return;
    }

    const jsonFile = new JsonFile(REGISTRY);

    if (config.db === 'redis') {
        jsonPersister = await JsonRedis.create(REGISTRY);
    }
    else if (config.db === 'mongodb') {
        jsonPersister = await JsonMongo.create(REGISTRY);
    }
    else if (config.db === 'sqlite') {
        jsonPersister = await JsonSQLite.create(REGISTRY);
    }
    else {
        jsonPersister = jsonFile;
    }

    if (config.db !== 'json') {
        const jsonDb = await jsonPersister.loadDb();
        const fileDb = await jsonFile.loadDb();

        if (!jsonDb && fileDb) {
            await jsonPersister.saveDb(fileDb);
            log.info(`Database upgraded to ${config.db}`);
        }
        else {
            log.info(`Persisting to ${config.db}`);
        }
    }

    if (config.reimport) {
        const db = await loadDb();
        for (const item of db.discovered) {
            delete item.imported;
            delete item.processed;
            delete item.error;
        }
        await jsonPersister.saveDb(db);
    }

    const ok = await waitForChain();

    if (!ok) {
        return;
    }

    await gatekeeper.connect({
        url: config.gatekeeperURL,
        waitUntilReady: true,
        intervalSeconds: 5,
        chatty: true,
    });

    await syncBlocks();

    if (config.importInterval > 0) {
        log.info(`Importing operations every ${config.importInterval} minute(s)`);
        setTimeout(importLoop, config.importInterval * 60 * 1000);
    }

    if (!READ_ONLY) {
        log.info(`Exporting operations every ${config.exportInterval} minute(s)`);
        log.info(`Txn fees (${REGISTRY}): conf target: ${config.feeConf}, maximum: ${config.feeMax}, fallback Sat/Byte: ${config.feeFallback}`);
        setTimeout(exportLoop, config.exportInterval * 60 * 1000);
    }
}

main();
