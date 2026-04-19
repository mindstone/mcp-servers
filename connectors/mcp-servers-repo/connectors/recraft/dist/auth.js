let apiKey = process.env.RECRAFT_API_KEY || '';
export function getApiKey() {
    return apiKey;
}
export function isConfigured() {
    return apiKey.length > 0;
}
export function setApiKey(key) {
    apiKey = key;
}
//# sourceMappingURL=auth.js.map