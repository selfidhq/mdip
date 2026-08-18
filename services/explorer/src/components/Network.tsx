import React, { useEffect, useState } from "react";
import {
    Box,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography,
} from "@mui/material";
import {
    fetchNetworkMetricSnapshot,
    type NetworkMetricSnapshot,
} from "../api/searchClient.js";
import { readinessPollIntervalMs } from "../config.js";
import { useSnackbar } from "../contexts/SnackbarProvider.js";

function formatPeerId(peerId: string): string {
    return peerId.length > 20
        ? `${peerId.slice(0, 8)}…${peerId.slice(-8)}`
        : peerId || "Starting";
}

function formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : date.toISOString().replace("T", " ").slice(0, 19);
}

function formatCount(value: number | null): string {
    return value === null ? "Unknown" : value.toLocaleString();
}

function Network() {
    const { setError } = useSnackbar();
    const [searchParams, setSearchParams] = useSearchParams();
    const currentDate = today();
    const selectedDate = searchParams.get("date") || currentDate;
    const [snapshot, setSnapshot] = useState<NetworkMetricSnapshot | null>(null);
    const [message, setMessage] = useState("Loading network snapshot...");

    useEffect(() => {
        let ignore = false;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;

        setSnapshot(null);
        setMessage("Loading network snapshot...");

        function loadSnapshot() {
            fetchNetworkMetricSnapshot(selectedDate)
                .then(result => {
                    if (ignore) {
                        return;
                    }

                    if (!result) {
                        setMessage("No network snapshot exists for this date.");
                        return;
                    }

                    setSnapshot(result);
                })
                .catch(error => {
                    if (ignore) {
                        return;
                    }

                    if (error?.response?.status === 503) {
                        setMessage("Network metrics are rebuilding...");
                        retryTimer = setTimeout(loadSnapshot, readinessPollIntervalMs);
                        return;
                    }

                    setMessage("Unable to load the network snapshot.");
                    setError(error);
                });
        }

        loadSnapshot();

        return () => {
            ignore = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
            }
        };
    }, [setError]);

    return (
        <Box sx={{ ml: 1, mt: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>Network</Typography>

            {!status ? (
                <Typography>{message}</Typography>
            ) : (
                <>
                    <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mb: 3 }}>
                        {[
                            {
                                label: "Agent DIDs",
                                value: snapshot.agentDidCount,
                                prefixes: snapshot.agentDidCountsByPrefix,
                            },
                            {
                                label: "Credentials",
                                value: snapshot.credentialCount,
                                prefixes: snapshot.credentialDidCountsByPrefix,
                            },
                            { label: "Schemas in use", value: snapshot.schemas.length },
                        ].map(({ label, value, prefixes }) => (
                            <Box
                                key={label}
                                sx={{
                                    border: "1px solid",
                                    borderColor: "divider",
                                    borderRadius: 1,
                                    p: 2,
                                    minWidth: 220,
                                    flex: "1 1 220px",
                                }}
                            >
                                <Typography variant="overline">{label}</Typography>
                                <Typography variant="h4">{value.toLocaleString()}</Typography>
                            </Box>
                        ))}
                    </Box>

                    <Typography variant="h6" sx={{ mb: 1 }}>Schema usage</Typography>
                    {snapshot.schemas.length === 0 ? (
                        <Typography>No credential schemas were in use on this date.</Typography>
                    ) : (
                        <TableContainer sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell>Node</TableCell>
                                        <TableCell>Peer ID</TableCell>
                                        <TableCell align="right">Operations</TableCell>
                                        <TableCell>Last seen</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {snapshot.schemas.map((schema, index) => (
                                        <TableRow key={schema.schemaDid}>
                                            <TableCell>{index + 1}</TableCell>
                                            <TableCell>
                                                <Typography
                                                    component={RouterLink}
                                                    to={`/search?did=${encodeURIComponent(schema.schemaDid)}`}
                                                    title={schema.schemaDid}
                                                    sx={{
                                                        display: "block",
                                                        color: "primary.main",
                                                        fontFamily: "Courier, monospace",
                                                        overflow: "hidden",
                                                        textDecoration: "underline",
                                                        textOverflow: "ellipsis",
                                                        whiteSpace: "nowrap",
                                                    }}
                                                >
                                                    {schema.schemaDid}
                                                </Typography>
                                            </TableCell>
                                            <TableCell align="right">{formatCount(peer.operationCount)}</TableCell>
                                            <TableCell>{formatTimestamp(peer.lastSeen)}</TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </>
            )}
        </Box>
    );
}

export default Network;
