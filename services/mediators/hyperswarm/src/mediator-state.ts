import type { HyperswarmConnection } from 'hyperswarm';
import type { OperationSyncStore } from './db/types.js';
import type {
    NegotiatedPeerCapabilities,
    SyncMode,
} from './negentropy/protocol.js';

export interface MediatorMainOptions {
    syncStore?: OperationSyncStore;
    startLoops?: boolean;
}

export interface NodeInfo {
    name: string;
    ipfs: any;
}

export interface ConnectionInfo {
    connection: HyperswarmConnection;
    peerName: string;
    nodeName: string;
    did: string;
    lastSeen: number;
    capabilities: NegotiatedPeerCapabilities;
    syncMode: SyncMode | 'unknown';
    syncStarted: boolean;
    lastNegentropyAttemptAt: number;
    negentropySynced: boolean;
    orderedCatchupAttempted: boolean;
    initialPingSent: boolean;
    initialPingPromise: Promise<void>;
    initialInboundMessageReceived: boolean;
    peerTransportFramingVersion: number | null;
    legacyTransportQuarantined: boolean;
    inboundBuffer: Buffer;
    inboundReceiveChain: Promise<void>;
}

export interface MalformedPeerState {
    strikes: number;
    firstSeenAt: number;
    lastSeenAt: number;
    cooldownUntil: number;
    lastReason: string;
    rejectedConnections: number;
    lastRejectLogAt: number;
}

export type PeerSessionMode = SyncMode | 'ordered_catchup';

export interface PeerSyncSession {
    sessionId: string;
    peerKey: string;
    mode: PeerSessionMode;
    initiator: boolean;
    windows: ReconciliationWindow[];
    windowIndex: number;
    windowId: string | null;
    currentWindowStats: NegentropyWindowStats | null;
    currentWindowSnapshot: NegentropyWindowSnapshot | null;
    currentWindowEngine: NegentropyWindowEngine | null;
    startedAt: number;
    lastActivity: number;
    pendingHaveIds: Set<string>;
    pendingNeedIds: Set<string>;
    unresolvedNeedIds: Set<string>;
    unresolvedOperations: Map<string, Operation>;
    rounds: number;
    maxRounds: number;
    reconciliationComplete: boolean;
    localClosed: boolean;
    receivedPushIds: Set<string>;
    receivedKnownPushIds: Set<string>;
    provenStoredPushIds: Set<string>;
    receivedPushMaxCursor: SyncStoreCursor | null;
    remoteWindowCappedByRecords: boolean;
    remoteWindowLastCursor: SyncStoreCursor | null;
    orderedCatchupCursor: SyncStoreOrderedCursor | null;
    orderedCatchupPendingImports: number;
    orderedCatchupRequestOutstanding: boolean;
    orderedCatchupTerminalReason: 'ordered_catchup_complete' | 'ordered_catchup_done' | null;
    orderedCatchupImportsAborted: boolean;
}

export interface ImportQueueTask {
    name: string;
    node?: string;
    data: Operation[];
    queueGossip?: boolean;
    orderedCatchupSession?: PeerSyncSession;
}

export interface ImportQueueResult {
    knownIds: string[];
    persistedIds: string[];
    retryable: boolean;
}

export interface ConnectionInfoOptions {
    connection: HyperswarmConnection;
    peerName: string;
    nodeName?: string;
    now?: number;
    requireInitialPing?: boolean;
}

export function createConnectionInfo(options: ConnectionInfoOptions): ConnectionInfo {
    const now = options.now ?? Date.now();

    return {
        connection: options.connection,
        peerName: options.peerName,
        nodeName: options.nodeName ?? 'anon',
        did: '',
        lastSeen: now,
        capabilities: {
            advertised: false,
            negentropy: false,
            version: null,
            orderedCatchup: false,
            orderedCatchupVersion: null,
            orderedCatchupReady: false,
            operationCount: null,
            orderedOperationCount: null,
            latestSignedTimestamp: null,
        },
        syncMode: 'unknown',
        syncStarted: false,
        lastNegentropyAttemptAt: 0,
        negentropySynced: false,
        orderedCatchupAttempted: false,
        initialPingSent: options.requireInitialPing !== true,
        initialPingPromise: Promise.resolve(),
        initialInboundMessageReceived: false,
        peerTransportFramingVersion: null,
        legacyTransportQuarantined: false,
        inboundBuffer: Buffer.alloc(0),
        inboundReceiveChain: Promise.resolve(),
    };
}
