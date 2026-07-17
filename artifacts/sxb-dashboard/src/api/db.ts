import { ActivityLog } from "../types";

// db.ts - This file is kept for backward compatibility but all functions now return empty arrays
// All real data is fetched from the API via the ./client.ts apiRequest function

export const getClients = () => [];
export const saveClients = () => {};
export const getResellers = () => [];
export const saveResellers = () => {};
export const getServers = () => [];
export const saveServers = () => {};
export const getTokens = () => [];
export const saveTokens = () => {};
export const getVouchers = () => [];
export const saveVouchers = () => {};
export const getLogs = () => [];
export const saveLogs = () => {};
export const getCurrentUser = () => null;
export const saveCurrentUser = () => {};
export const logActivity = () => {};
