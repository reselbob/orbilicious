export type MockFetchResponseInit = {
    status?: number;
    json?: unknown;
    text?: string;
};

export function installMockFetch(handlers: Array<(input: string, init?: RequestInit) => MockFetchResponseInit | null>) {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string'
            ? input
            : input instanceof URL
                ? input.toString()
                : input.url;

        for (const handler of handlers) {
            const result = handler(url, init);
            if (result) {
                const status = result.status ?? 200;
                return {
                    ok: status >= 200 && status < 300,
                    status,
                    json: async () => result.json,
                    text: async () => result.text ?? JSON.stringify(result.json ?? {}),
                } as Response;
            }
        }

        throw new Error(`Unhandled fetch mock for ${url}`);
    }) as typeof fetch;

    return () => {
        globalThis.fetch = originalFetch;
    };
}