import { getNodeState } from '../config/node-state.js';

const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_HALF_OPEN_MAX = 1;
const CIRCUIT_OPEN_TIMEOUT_MS = 30_000;

export function getCircuitState(nodeId) {
  return getNodeState(nodeId).circuitState;
}

export function shouldAllowRequest(nodeId) {
  const state = getNodeState(nodeId);
  if (state.circuitState === 'closed') return true;
  if (state.circuitState === 'half-open') {
    if (state.circuitHalfOpenAllow) {
      state.circuitHalfOpenAllow = false;
      return true;
    }
    return false;
  }
  if (state.circuitState === 'open') {
    if (state.cooldownUntil <= Date.now()) {
      state.circuitState = 'half-open';
      state.circuitHalfOpenAllow = true;
      return true;
    }
    return false;
  }
  return true;
}

export function recordCircuitSuccess(nodeId) {
  const state = getNodeState(nodeId);
  if (state.circuitState === 'half-open') {
    state.circuitState = 'closed';
    state.circuitFailures = 0;
    state.circuitHalfOpenAllow = false;
  }
}

export function recordCircuitFailure(nodeId) {
  const state = getNodeState(nodeId);
  state.circuitFailures++;
  if (state.circuitState === 'half-open') {
    state.circuitState = 'open';
    state.cooldownUntil = Date.now() + CIRCUIT_OPEN_TIMEOUT_MS;
    state.circuitHalfOpenAllow = false;
  } else if (state.circuitFailures >= CIRCUIT_THRESHOLD && state.circuitState === 'closed') {
    state.circuitState = 'open';
    state.cooldownUntil = Date.now() + CIRCUIT_OPEN_TIMEOUT_MS;
    state.circuitHalfOpenAllow = false;
  }
}

export function resetCircuit(nodeId) {
  const state = getNodeState(nodeId);
  state.circuitState = 'closed';
  state.circuitFailures = 0;
  state.circuitHalfOpenAllow = false;
}