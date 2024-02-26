import axios from 'axios';

const URL = 'http://localhost:3000';
const connectionError = `Can't connect to gatekeeper. Is server running on ${URL}?`;

function throwError(error) {
    if (error.response) {
        throw error.response.data;
    }

    throw error.message;
}

export async function start() {
}

export async function stop() {
}

export async function createDID(txn) {
    try {
        const response = await axios.post(`${URL}/did/`, txn);
        return response.data;
    }
    catch (error) {
        throwError(error);
    }
}

export async function resolveDID(did, asof = null) {
    try {
        if (asof) {
            const response = await axios.get(`${URL}/did/${did}?asof=${asof}`);
            return response.data;
        }
        else {
            const response = await axios.get(`${URL}/did/${did}`);
            return response.data;
        }
    }
    catch (error) {
        throwError(error);
    }
}

export async function updateDID(txn) {
    try {
        const response = await axios.post(`${URL}/did/${txn.did}`, txn);
        return response.data;
    }
    catch (error) {
        throwError(error);
    }
}

export async function deleteDID(txn) {
    try {
        const response = await axios.delete(`http://localhost:3000/did/${txn.did}`, { data: txn });
        return response.data;
    }
    catch (error) {
        throwError(error);
    }
}

export async function exportDID(did) {
    try {
        const response = await axios.get(`http://localhost:3000/export/${did}`);
        return response.data;
    }
    catch (error) {
        throwError(error);
    }
}

export async function importDID(txns) {
    try {
        const response = await axios.post(`http://localhost:3000/import/`, txns);
        return response.data;
    }
    catch (error) {
        throwError(error);
    }
}
