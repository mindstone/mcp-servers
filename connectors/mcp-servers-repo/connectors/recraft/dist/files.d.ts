export interface ResolvedImageInput {
    source: string;
    filename: string;
    bytes: Buffer;
    mimeType: string;
}
export declare function resolveImageInput(input: string): Promise<ResolvedImageInput>;
export declare function buildMultipartForm(fields: Record<string, string | number | undefined>, fileEntries: Array<{
    fieldName: string;
    input: string;
}>): Promise<FormData>;
//# sourceMappingURL=files.d.ts.map